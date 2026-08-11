#!/usr/bin/env bash
# =============================================================
# DPS — SSL Kurulum Scripti (Let's Encrypt / Certbot)
# =============================================================
# Kullanım:
#   bash setup-ssl.sh
#
# Ön koşullar:
#   1. bash deploy.sh ile sistem HTTP'de çalışıyor olmalı
#   2. .env içinde DOMAIN_NAME doldurulmuş olmalı
#      DOMAIN_NAME=planlama.example.com
#   3. DNS'te A kaydı sunucu IP'sine yönlendirilmiş olmalı
#      (Let's Encrypt domain'i doğrular — yanlış DNS = hata)
# =============================================================
set -euo pipefail

COMPOSE_FILE="docker-compose.prod.yml"
PROJECT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$PROJECT_DIR"

# .env yükle
set -a; source .env; set +a

echo ""
echo "╔══════════════════════════════════════╗"
echo "║  DPS — SSL / HTTPS Kurulum           ║"
echo "╚══════════════════════════════════════╝"
echo ""

# ─────────────────────────────────────────
# Kontroller
# ─────────────────────────────────────────
if [[ -z "${DOMAIN_NAME:-}" || "$DOMAIN_NAME" == "localhost" ]]; then
  echo "❌  .env içinde DOMAIN_NAME ayarlanmamış!"
  echo "    DOMAIN_NAME=planlama.example.com  şeklinde ekleyin."
  exit 1
fi

if [[ -z "${SSL_EMAIL:-}" ]]; then
  echo "❌  .env içinde SSL_EMAIL ayarlanmamış!"
  echo "    SSL_EMAIL=admin@example.com  şeklinde ekleyin."
  exit 1
fi

echo "🌐 Domain  : $DOMAIN_NAME"
echo "📧 E-posta : $SSL_EMAIL"
echo ""

# DNS doğrulaması (basit)
RESOLVED_IP=$(dig +short "$DOMAIN_NAME" 2>/dev/null | tail -1 || true)
SERVER_IP=$(curl -s --max-time 5 https://api.ipify.org 2>/dev/null || hostname -I | awk '{print $1}')

echo "🔍 DNS kontrolü..."
echo "   Domain IP  : ${RESOLVED_IP:-'çözümlenemedi'}"
echo "   Sunucu IP  : $SERVER_IP"
echo ""

if [[ -n "$RESOLVED_IP" && "$RESOLVED_IP" != "$SERVER_IP" ]]; then
  echo "⚠️  Uyarı: DNS henüz bu sunucuya yönlenmemiş olabilir."
  echo "   Let's Encrypt domaini doğrulayamayabilir."
  read -rp "   Devam etmek istiyor musunuz? (y/N): " CONFIRM
  [[ "$CONFIRM" =~ ^[Yy]$ ]] || exit 1
fi

# ─────────────────────────────────────────
# Sistem HTTP modunda çalışıyor olmalı
# ─────────────────────────────────────────
cp nginx/nginx.http.conf nginx/nginx.active.conf
docker compose -f "$COMPOSE_FILE" exec -T nginx nginx -s reload 2>/dev/null || \
  docker compose -f "$COMPOSE_FILE" restart nginx
echo "✅ Nginx HTTP moduna geçirildi (ACME challenge için)."
sleep 3

# ─────────────────────────────────────────
# Sertifika al (certbot)
# ─────────────────────────────────────────
echo ""
echo "🔐 Let's Encrypt sertifikası alınıyor..."

docker compose -f "$COMPOSE_FILE" run --rm certbot \
  certonly \
  --webroot \
  --webroot-path=/var/www/certbot \
  --email "$SSL_EMAIL" \
  --agree-tos \
  --no-eff-email \
  -d "$DOMAIN_NAME"

echo "✅ Sertifika başarıyla alındı!"

# ─────────────────────────────────────────
# HTTPS nginx config'ini aktif et
# ─────────────────────────────────────────
echo ""
echo "⚙️  HTTPS nginx config aktif ediliyor..."

# nginx.https.conf içindeki ${DOMAIN_NAME}'i gerçek domain ile değiştir
sed "s/\${DOMAIN_NAME}/$DOMAIN_NAME/g" \
  nginx/nginx.https.conf > nginx/nginx.active.conf

echo "✅ nginx.active.conf → HTTPS moduna güncellendi."

# Nginx'i yeniden yükle
docker compose -f "$COMPOSE_FILE" exec -T nginx nginx -s reload || \
  docker compose -f "$COMPOSE_FILE" restart nginx

echo "✅ Nginx HTTPS modunda başlatıldı."

# ─────────────────────────────────────────
# .env'e HTTPS portunu ekle (yoksa)
# ─────────────────────────────────────────
if ! grep -q "NGINX_HTTPS_PORT" .env; then
  echo "NGINX_HTTPS_PORT=443" >> .env
fi

echo ""
echo "════════════════════════════════════════════════"
echo "  🔒 HTTPS kurulumu tamamlandı!"
echo ""
echo "  Uygulama: https://${DOMAIN_NAME}"
echo ""
echo "  Sertifika yenileme otomatik çalışır"
echo "  (certbot servisi her 12 saatte kontrol eder)"
echo "════════════════════════════════════════════════"
