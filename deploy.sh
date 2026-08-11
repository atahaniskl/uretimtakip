#!/usr/bin/env bash
# =============================================================
# DPS — Production Deploy Script
# =============================================================
# Kullanım:
#   İlk kurulum: bash deploy.sh
#   Güncelleme:  bash deploy.sh
# =============================================================
set -euo pipefail

COMPOSE_FILE="docker-compose.prod.yml"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

cd "$PROJECT_DIR"

# .env yükle (NGINX_HTTP_PORT vb. için)
set -a; source .env 2>/dev/null || true; set +a

echo ""
echo "╔══════════════════════════════════════╗"
echo "║  DPS — Production Deploy             ║"
echo "╚══════════════════════════════════════╝"
echo ""

# ─────────────────────────────────────────
# 1. .env kontrolü
# ─────────────────────────────────────────
if [[ ! -f ".env" ]]; then
  echo "❌  .env bulunamadı!  →  cp .env.example .env"
  exit 1
fi

if grep -q "CHANGE_ME" .env; then
  echo "❌  .env içinde CHANGE_ME değerleri var — tüm şifreleri doldurun."
  exit 1
fi
echo "✅  .env doğrulandı."

# ─────────────────────────────────────────
# 2. Aktif nginx config seç
#    Setup-ssl sonrası nginx.active.conf = nginx.https.conf olur.
#    İlk kurulumda nginx.http.conf kullanılır.
# ─────────────────────────────────────────
if [[ ! -f "nginx/nginx.active.conf" ]]; then
  echo "📋  nginx.active.conf bulunamadı — HTTP-only config kopyalanıyor..."
  cp nginx/nginx.http.conf nginx/nginx.active.conf
fi

# ─────────────────────────────────────────
# 3. Build
# ─────────────────────────────────────────
echo ""
echo "🔨 Image'lar build ediliyor..."
docker compose -f "$COMPOSE_FILE" build --parallel

# ─────────────────────────────────────────
# 4. Graceful restart
# ─────────────────────────────────────────
echo ""
echo "🛑 Eski servisler durduruluyor..."
docker compose -f "$COMPOSE_FILE" down --remove-orphans || true

echo ""
echo "🚀 Servisler başlatılıyor..."
docker compose -f "$COMPOSE_FILE" up -d

# ─────────────────────────────────────────
# 5. Backend sağlık kontrolü
# ─────────────────────────────────────────
echo ""
echo "⏳ Backend hazır olana kadar bekleniyor..."
READY=0
for i in $(seq 1 40); do
  if docker compose -f "$COMPOSE_FILE" exec -T backend \
      python -c "import httpx; httpx.get('http://localhost:8000/api/health', timeout=3)" \
      2>/dev/null; then
    READY=1
    echo ""
    echo "✅ Backend hazır!"
    break
  fi
  echo -n "."
  sleep 3
done

if [[ $READY -eq 0 ]]; then
  echo ""
  echo "⚠️  Backend 120 saniyede yanıt vermedi!"
  echo "   docker compose -f $COMPOSE_FILE logs backend"
  exit 1
fi

# ─────────────────────────────────────────
# 6. Alembic — veritabanı migration
#    İlk kurulumda tüm tablolar oluşturulur.
#    Güncellemelerde yeni migration'lar uygulanır.
# ─────────────────────────────────────────
echo ""
echo "🗄️  Veritabanı migration çalıştırılıyor (alembic upgrade head)..."
docker compose -f "$COMPOSE_FILE" exec -T \
  -e PYTHONPATH=/app \
  backend \
  alembic upgrade head

echo "✅ Migration tamamlandı."

# ─────────────────────────────────────────
# 7. Durum özeti
# ─────────────────────────────────────────
echo ""
echo "📦 Çalışan servisler:"
docker compose -f "$COMPOSE_FILE" ps

# Aktif protokolü göster
if [[ -f "nginx/nginx.active.conf" ]] && grep -q "listen 443" nginx/nginx.active.conf 2>/dev/null; then
  PROTO="https"
  PORT="${NGINX_HTTPS_PORT:-443}"
else
  PROTO="http"
  PORT="${NGINX_HTTP_PORT:-80}"
fi

echo ""
echo "═══════════════════════════════════════════════"
echo "  ✅ Deploy tamamlandı!"
echo ""
echo "  Uygulama: ${PROTO}://${DOMAIN_NAME:-$(hostname -I | awk '{print $1}')}:${PORT}"
echo "  Loglar:   docker compose -f $COMPOSE_FILE logs -f"
echo ""
if [[ "$PROTO" == "http" ]]; then
  echo "  💡 HTTPS kurmak için:  bash setup-ssl.sh"
fi
echo "═══════════════════════════════════════════════"
