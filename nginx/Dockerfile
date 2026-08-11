# -------------------------------------------------------
# Nginx production image:
# SADECE frontend build'ını barındırır.
# nginx.conf host'tan volume olarak mount edilir —
# böylece HTTP → HTTPS geçişinde rebuild gerekmez.
# -------------------------------------------------------

# Stage 1 — Build React frontend
FROM node:20-alpine AS frontend-builder

WORKDIR /frontend

COPY frontend/package.json frontend/package-lock.json ./
RUN npm ci --frozen-lockfile

COPY frontend/ .
RUN npm run build

# Stage 2 — nginx + built frontend assets
FROM nginx:1.25-alpine

# Default nginx config'ini kaldır (host'tan mount edilecek)
RUN rm -f /etc/nginx/conf.d/default.conf

# Statik dosyaları image'a bake et
COPY --from=frontend-builder /frontend/dist /usr/share/nginx/html

# Hem 80 hem 443 açık
EXPOSE 80 443

CMD ["nginx", "-g", "daemon off;"]
