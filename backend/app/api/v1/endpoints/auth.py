"""
Auth endpoints — Login, Register, Refresh, Logout, Me.
JWT + Refresh Tokens (HTTP-Only Cookies).
"""

import secrets
import time
from urllib.parse import urlencode, urlsplit, urlunsplit

import httpx
from fastapi import APIRouter, Depends, HTTPException, Response, Request, status
from fastapi.responses import RedirectResponse
from sqlalchemy import func, or_, select
from sqlalchemy.ext.asyncio import AsyncSession

from app.database import get_db
from app.core.security import (
    hash_password,
    verify_password,
    create_access_token,
    create_refresh_token,
    decode_token,
)
from app.models.user import User, UserRole
from app.schemas.auth import LoginRequest, RegisterRequest, TokenResponse
from app.schemas.user import UserRead
from app.schemas.common import MessageResponse
from app.api.deps import get_current_user
from app.config import settings

router = APIRouter(prefix="/auth", tags=["Authentication"])

# Basit bellek-içi kaba kuvvet (brute-force) koruması — excel.py'deki
# _pending_diffs ile AYNI desen: tek process/tek event loop varsayımıyla
# güvenli (bkz. oradaki gerekçe), ekstra kilitlemeye gerek yok. Önceden bu uç
# noktada HİÇBİR deneme sınırı yoktu — parola sınırsızca denenebiliyordu.
_LOGIN_ATTEMPT_WINDOW_SECONDS = 15 * 60
_LOGIN_ATTEMPT_MAX = 8
_failed_login_attempts_by_username: dict[str, list[float]] = {}
_failed_login_attempts_by_ip: dict[str, list[float]] = {}


def _count_recent_attempts(bucket: dict[str, list[float]], key: str, now: float) -> int:
    attempts = [t for t in bucket.get(key, []) if now - t < _LOGIN_ATTEMPT_WINDOW_SECONDS]
    bucket[key] = attempts
    return len(attempts)


def _cleanup_stale_login_attempts(now: float) -> None:
    """Pencereden tamamen çıkmış anahtarları temizler — aksi halde hiç tekrar
    denenmeyen (bu yüzden _count_recent_attempts tarafından bir daha
    budanmayan) kullanıcı adı/IP'ler sözlüklerde sonsuza dek birikirdi."""
    for bucket in (_failed_login_attempts_by_username, _failed_login_attempts_by_ip):
        stale_keys = [
            key for key, attempts in bucket.items()
            if not any(now - t < _LOGIN_ATTEMPT_WINDOW_SECONDS for t in attempts)
        ]
        for key in stale_keys:
            bucket.pop(key, None)


def _set_refresh_cookie(response: Response, refresh_token: str) -> None:
    response.set_cookie(
        key="refresh_token",
        value=refresh_token,
        httponly=True,
        secure=settings.COOKIE_SECURE,
        samesite="lax",
        max_age=settings.JWT_REFRESH_TOKEN_EXPIRE_DAYS * 24 * 60 * 60,
        path="/api/auth",
    )


def _authentik_is_configured() -> bool:
    return all(
        [
            settings.AUTHENTIK_ENABLED,
            settings.AUTHENTIK_ISSUER_URL,
            settings.AUTHENTIK_INTERNAL_URL,
            settings.AUTHENTIK_CLIENT_ID,
            settings.AUTHENTIK_CLIENT_SECRET,
        ]
    )


def _authentik_redirect_uri(request: Request) -> str:
    if settings.AUTHENTIK_REDIRECT_URI:
        return settings.AUTHENTIK_REDIRECT_URI
    return str(request.url_for("authentik_callback"))


def _authentik_host_header() -> str:
    return urlsplit(settings.AUTHENTIK_ISSUER_URL).netloc


async def _authentik_discovery() -> dict:
    internal_url = settings.AUTHENTIK_INTERNAL_URL
    if not internal_url.endswith("/"):
        internal_url = f"{internal_url}/"
    discovery_url = f"{internal_url}.well-known/openid-configuration"
    async with httpx.AsyncClient(timeout=10.0) as client:
        response = await client.get(
            discovery_url,
            headers={"Host": _authentik_host_header()},
        )
        response.raise_for_status()
        return response.json()


def _replace_url_origin(url: str, origin_url: str) -> str:
    parsed_url = urlsplit(url)
    parsed_origin = urlsplit(origin_url)
    return urlunsplit(
        (
            parsed_origin.scheme,
            parsed_origin.netloc,
            parsed_url.path,
            parsed_url.query,
            parsed_url.fragment,
        )
    )


def _authentik_browser_url(url: str) -> str:
    return _replace_url_origin(url, settings.AUTHENTIK_ISSUER_URL)


def _authentik_backend_url(url: str) -> str:
    return _replace_url_origin(url, settings.AUTHENTIK_INTERNAL_URL)


def _frontend_authentik_callback_url(access_token: str) -> str:
    query = urlencode({"access_token": access_token})
    separator = "&" if "?" in settings.AUTHENTIK_FRONTEND_CALLBACK_URL else "?"
    return f"{settings.AUTHENTIK_FRONTEND_CALLBACK_URL}{separator}{query}"


def _frontend_authentik_error_url(message: str) -> str:
    query = urlencode({"error": message})
    separator = "&" if "?" in settings.AUTHENTIK_FRONTEND_CALLBACK_URL else "?"
    return f"{settings.AUTHENTIK_FRONTEND_CALLBACK_URL}{separator}{query}"


def _role_from_authentik_claims(claims: dict) -> tuple[UserRole, bool]:
    configured_default = settings.AUTHENTIK_DEFAULT_ROLE.upper()
    default_role = UserRole.__members__.get(configured_default, UserRole.VIEWER)
    groups = claims.get(settings.AUTHENTIK_GROUPS_CLAIM) or []
    if isinstance(groups, str):
        groups = [groups]
    group_names = {str(group) for group in groups}
    if settings.AUTHENTIK_ADMIN_GROUP in group_names:
        return UserRole.ADMIN, True
    if settings.AUTHENTIK_PLANNER_GROUP in group_names:
        return UserRole.PLANNER, True
    return default_role, False


def _normalize_claim(value: object | None, max_length: int | None = None) -> str | None:
    if value is None:
        return None
    normalized = str(value).strip()
    if not normalized:
        return None
    if max_length is not None:
        return normalized[:max_length]
    return normalized


def _email_from_authentik_claims(claims: dict) -> str | None:
    email = _normalize_claim(claims.get("email"), 255)
    if email and "@" in email:
        return email.lower()
    return None


def _subject_from_authentik_claims(claims: dict) -> str | None:
    return _normalize_claim(claims.get("sub"), 255)


def _username_from_authentik_claims(claims: dict) -> str:
    username = _normalize_claim(
        claims.get("preferred_username")
        or claims.get("nickname")
        or _email_from_authentik_claims(claims)
        or claims.get("sub"),
        100,
    )
    if not username:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Authentik user profile did not include a usable username",
        )
    return str(username)[:100]


async def _get_or_create_authentik_user(
    claims: dict,
    db: AsyncSession,
) -> User:
    username = _username_from_authentik_claims(claims)
    email = _email_from_authentik_claims(claims)
    subject = _subject_from_authentik_claims(claims)
    conditions = []
    if subject:
        conditions.append(User.authentik_subject == subject)
    if email:
        conditions.append(func.lower(User.email) == email.lower())
    conditions.append(func.lower(User.username) == username.lower())

    result = await db.execute(select(User).where(or_(*conditions)).limit(1))
    user = result.scalar_one_or_none()
    role, has_explicit_role = _role_from_authentik_claims(claims)

    if user:
        if subject and user.authentik_subject != subject:
            user.authentik_subject = subject
        if email and user.email != email:
            user.email = email
        if has_explicit_role and user.role != role:
            user.role = role
        if settings.AUTHENTIK_AUTO_APPROVE and not user.is_approved:
            user.is_approved = True
        await db.flush()
        await db.refresh(user)
        return user

    user = User(
        username=username,
        email=email,
        authentik_subject=subject,
        hashed_password=hash_password(secrets.token_urlsafe(32)),
        role=role,
        is_approved=settings.AUTHENTIK_AUTO_APPROVE,
    )
    db.add(user)
    await db.flush()
    await db.refresh(user)
    return user


@router.post(
    "/register",
    response_model=UserRead,
    status_code=status.HTTP_201_CREATED,
    summary="Register a new user",
)
async def register(
    body: RegisterRequest,
    db: AsyncSession = Depends(get_db),
) -> UserRead:
    """Create a new user account."""
    # Check for existing username
    result = await db.execute(select(User).where(User.username == body.username))
    if result.scalar_one_or_none():
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Username already exists",
        )

    user = User(
        username=body.username,
        hashed_password=hash_password(body.password),
        role=UserRole.VIEWER,
        is_approved=False,
    )
    db.add(user)
    await db.flush()
    await db.refresh(user)

    return UserRead.model_validate(user)


@router.post(
    "/login",
    response_model=TokenResponse,
    summary="Login and receive JWT tokens",
)
async def login(
    body: LoginRequest,
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
) -> TokenResponse:
    """Authenticate user and return access token. Refresh token is set as HTTP-Only cookie."""
    now = time.time()
    client_ip = request.client.host if request.client else "unknown"
    username_key = body.username.strip().lower()

    _cleanup_stale_login_attempts(now)

    # Kullanıcı adı VE IP bazında AYRI AYRI izlenir: yalnızca kullanıcı adı
    # bazlı olsaydı bir saldırgan bilinen bir kullanıcı adını kasıtlı olarak
    # kilitleyip gerçek sahibini dışarıda bırakabilirdi (DoS); yalnızca IP
    # bazlı olsaydı NAT/paylaşımlı IP arkasındaki birden çok gerçek kullanıcı
    # birbirini kilitleyebilirdi. IP sınırı kasıtlı olarak daha gevşek (çoklu
    # kullanıcı adı denemesini engeller ama meşru paylaşımlı-IP trafiğini
    # daha az cezalandırır).
    if (
        _count_recent_attempts(_failed_login_attempts_by_username, username_key, now) >= _LOGIN_ATTEMPT_MAX
        or _count_recent_attempts(_failed_login_attempts_by_ip, client_ip, now) >= _LOGIN_ATTEMPT_MAX * 3
    ):
        raise HTTPException(
            status_code=status.HTTP_429_TOO_MANY_REQUESTS,
            detail="Çok fazla başarısız giriş denemesi. Lütfen birkaç dakika sonra tekrar deneyin.",
        )

    result = await db.execute(select(User).where(User.username == body.username))
    user = result.scalar_one_or_none()

    if not user or not verify_password(body.password, user.hashed_password):
        _failed_login_attempts_by_username.setdefault(username_key, []).append(now)
        _failed_login_attempts_by_ip.setdefault(client_ip, []).append(now)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid username or password",
        )

    if not user.is_approved:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Your account is pending admin approval.",
        )

    # Başarılı giriş — bu kullanıcı adı için sayaç sıfırlanır (IP sayacına
    # kasıtlı olarak dokunulmaz: aynı IP'den az önce başka bir kullanıcı adıyla
    # yapılmış başarısız denemeler hâlâ şüpheli sayılmaya devam eder).
    _failed_login_attempts_by_username.pop(username_key, None)

    access_token = create_access_token(user.id, user.role.value)
    refresh_token = create_refresh_token(user.id)

    # Set refresh token as HTTP-Only cookie
    _set_refresh_cookie(response, refresh_token)

    return TokenResponse(access_token=access_token)


@router.get(
    "/authentik/login",
    summary="Start Authentik OIDC login",
)
async def authentik_login(request: Request) -> RedirectResponse:
    """Redirect the browser to Authentik's authorization endpoint."""
    if not _authentik_is_configured():
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Authentik login is not configured",
        )

    try:
        discovery = await _authentik_discovery()
    except httpx.HTTPError as exc:
        raise HTTPException(
            status_code=status.HTTP_502_BAD_GATEWAY,
            detail="Could not reach Authentik discovery endpoint",
        ) from exc

    state = secrets.token_urlsafe(32)
    params = {
        "client_id": settings.AUTHENTIK_CLIENT_ID,
        "redirect_uri": _authentik_redirect_uri(request),
        "response_type": "code",
        "scope": settings.AUTHENTIK_SCOPE,
        "state": state,
    }
    authorization_endpoint = _authentik_browser_url(
        discovery["authorization_endpoint"]
    )
    redirect = RedirectResponse(url=f"{authorization_endpoint}?{urlencode(params)}")
    redirect.set_cookie(
        key="authentik_state",
        value=state,
        httponly=True,
        secure=settings.COOKIE_SECURE,
        samesite="lax",
        max_age=600,
        path="/api/auth/authentik",
    )
    return redirect


@router.get(
    "/authentik/callback",
    name="authentik_callback",
    summary="Complete Authentik OIDC login",
)
async def authentik_callback(
    request: Request,
    db: AsyncSession = Depends(get_db),
) -> RedirectResponse:
    """Handle Authentik callback, create local JWTs, and return to the SPA."""
    if not _authentik_is_configured():
        return RedirectResponse(
            _frontend_authentik_error_url("Authentik is not configured")
        )

    code = request.query_params.get("code")
    state = request.query_params.get("state")
    expected_state = request.cookies.get("authentik_state")
    if not code or not state or state != expected_state:
        return RedirectResponse(_frontend_authentik_error_url("Invalid Authentik state"))

    try:
        discovery = await _authentik_discovery()
        async with httpx.AsyncClient(timeout=10.0) as client:
            token_response = await client.post(
                _authentik_backend_url(discovery["token_endpoint"]),
                data={
                    "grant_type": "authorization_code",
                    "code": code,
                    "redirect_uri": _authentik_redirect_uri(request),
                    "client_id": settings.AUTHENTIK_CLIENT_ID,
                    "client_secret": settings.AUTHENTIK_CLIENT_SECRET,
                },
                headers={
                    "Accept": "application/json",
                    "Host": _authentik_host_header(),
                },
            )
            token_response.raise_for_status()
            token_payload = token_response.json()
            authentik_access_token = token_payload["access_token"]

            userinfo_response = await client.get(
                _authentik_backend_url(discovery["userinfo_endpoint"]),
                headers={
                    "Authorization": f"Bearer {authentik_access_token}",
                    "Host": _authentik_host_header(),
                },
            )
            userinfo_response.raise_for_status()
            claims = userinfo_response.json()
    except (httpx.HTTPError, KeyError):
        return RedirectResponse(_frontend_authentik_error_url("Authentik login failed"))

    user = await _get_or_create_authentik_user(claims, db)
    if not user.is_approved:
        return RedirectResponse(
            _frontend_authentik_error_url("Your account is pending admin approval")
        )

    access_token = create_access_token(user.id, user.role.value)
    refresh_token = create_refresh_token(user.id)
    redirect = RedirectResponse(_frontend_authentik_callback_url(access_token))
    _set_refresh_cookie(redirect, refresh_token)
    redirect.delete_cookie(
        key="authentik_state",
        path="/api/auth/authentik",
    )
    return redirect


@router.post(
    "/refresh",
    response_model=TokenResponse,
    summary="Refresh access token using refresh cookie",
)
async def refresh_token(
    request: Request,
    response: Response,
    db: AsyncSession = Depends(get_db),
) -> TokenResponse:
    """Use the HTTP-Only refresh token cookie to obtain a new access token."""
    token = request.cookies.get("refresh_token")
    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Refresh token not found",
        )

    payload = decode_token(token)
    if payload is None or payload.get("type") != "refresh":
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Invalid or expired refresh token",
        )

    user_id = payload.get("sub")
    result = await db.execute(select(User).where(User.id == user_id))
    user = result.scalar_one_or_none()

    if not user:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="User not found",
        )

    # Issue new token pair
    new_access_token = create_access_token(user.id, user.role.value)
    new_refresh_token = create_refresh_token(user.id)

    _set_refresh_cookie(response, new_refresh_token)

    return TokenResponse(access_token=new_access_token)


@router.post(
    "/logout",
    response_model=MessageResponse,
    summary="Logout and clear refresh cookie",
)
async def logout(response: Response) -> MessageResponse:
    """Clear the refresh token cookie."""
    response.delete_cookie(
        key="refresh_token",
        path="/api/auth",
    )
    response.delete_cookie(
        key="authentik_state",
        path="/api/auth/authentik",
    )
    return MessageResponse(message="Successfully logged out")


@router.get(
    "/me",
    response_model=UserRead,
    summary="Get current authenticated user",
)
async def get_me(
    current_user: User = Depends(get_current_user),
) -> UserRead:
    """Return the currently authenticated user's profile."""
    return UserRead.model_validate(current_user)
