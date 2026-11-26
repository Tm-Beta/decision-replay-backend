#!/usr/bin/env bash
# Idempotent Ubuntu 24.04 VPS preparation script for So I Chose ($4/mo DigitalOcean friendly)
set -euo pipefail

echo "[1/5] Ensuring 2 GB Swapfile for low-memory droplet safety..."
if [ ! -f /swapfile ]; then
  sudo fallocate -l 2G /swapfile
  sudo chmod 600 /swapfile
  sudo mkswap /swapfile
  sudo swapon /swapfile
  echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab >/dev/null
  echo 'vm.swappiness=20' | sudo tee /etc/sysctl.d/99-soichose-swap.conf >/dev/null
  sudo sysctl -p /etc/sysctl.d/99-soichose-swap.conf >/dev/null
fi

echo "[2/5] Configuring UFW firewall (SSH, HTTP 80, HTTPS 443 only)..."
sudo ufw allow OpenSSH >/dev/null
sudo ufw allow 80,443/tcp >/dev/null
sudo ufw --force enable

echo "[3/5] Installing Docker Engine & Nginx if missing..."
if ! command -v docker >/dev/null 2>&1; then
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker "$USER"
fi
if ! command -v nginx >/dev/null 2>&1; then
  sudo apt-get update -y && sudo apt-get install -y nginx
fi

echo "[4/5] Preparing /opt/soichose and /etc/ssl/cloudflare..."
sudo mkdir -p /opt/soichose/backups /etc/ssl/cloudflare
sudo chown -R "$USER:$USER" /opt/soichose
sudo chmod 700 /etc/ssl/cloudflare

echo "[5/5] Next steps on VPS:"
echo "  1. Save Cloudflare Origin Cert + Key at /etc/ssl/cloudflare/soichose.{pem,key} (chmod 600 .key)"
echo "  2. Copy deploy/nginx/soichose.conf to /etc/nginx/sites-available/soichose.conf, symlink to sites-enabled/, sudo nginx -t && sudo systemctl reload nginx"
echo "  3. Copy deploy/docker-compose.prod.yml & deploy/.env.production.example -> /opt/soichose/.env and fill secrets"
echo "  4. Authenticate GHCR (`echo \$CR_PAT | docker login ghcr.io -u Tm-Beta --password-stdin`) and run:"
echo "     cd /opt/soichose && docker compose -f docker-compose.prod.yml up -d"

