#!/bin/bash
# One-time VPS setup: Docker, pnpm, git, firewall, swap
# Run as root on a fresh Ubuntu 22.04 / Debian 12 VPS
# Usage: curl -fsSL https://raw.githubusercontent.com/.../vps-setup.sh | bash
set -euo pipefail

DOMAIN="${DOMAIN:-}"
EMAIL="${EMAIL:-admin@example.com}"

echo "=== ops-platform VPS setup ==="

# ─── System updates ───────────────────────────────────────────────────────────
apt-get update -y
apt-get upgrade -y
apt-get install -y curl git wget unzip ufw fail2ban

# ─── Swap (2GB — helps on small VPS) ─────────────────────────────────────────
if [ ! -f /swapfile ]; then
  fallocate -l 2G /swapfile
  chmod 600 /swapfile
  mkswap /swapfile
  swapon /swapfile
  echo '/swapfile none swap sw 0 0' >> /etc/fstab
  echo "vm.swappiness=10" >> /etc/sysctl.conf
fi

# ─── Docker ───────────────────────────────────────────────────────────────────
if ! command -v docker &> /dev/null; then
  curl -fsSL https://get.docker.com | sh
  systemctl enable docker
  systemctl start docker
fi

# Docker Compose v2
if ! docker compose version &> /dev/null; then
  mkdir -p /usr/local/lib/docker/cli-plugins
  COMPOSE_VER=$(curl -s https://api.github.com/repos/docker/compose/releases/latest | grep tag_name | cut -d'"' -f4)
  curl -SL "https://github.com/docker/compose/releases/download/${COMPOSE_VER}/docker-compose-linux-x86_64" \
    -o /usr/local/lib/docker/cli-plugins/docker-compose
  chmod +x /usr/local/lib/docker/cli-plugins/docker-compose
fi

# ─── Firewall ─────────────────────────────────────────────────────────────────
ufw allow OpenSSH
ufw allow 80/tcp
ufw allow 443/tcp
# Grafana only internal (via nginx proxy on :9091)
ufw --force enable

# ─── Create ops user ──────────────────────────────────────────────────────────
if ! id ops &> /dev/null; then
  useradd -m -s /bin/bash ops
  usermod -aG docker ops
fi

# ─── Clone repo ───────────────────────────────────────────────────────────────
REPO_DIR="/home/ops/ops-platform"
if [ ! -d "$REPO_DIR" ]; then
  echo "Clone your repo to $REPO_DIR manually or set up deploy key."
fi

# ─── SSL via Let's Encrypt (manual step) ──────────────────────────────────────
if [ -n "$DOMAIN" ]; then
  echo ""
  echo "=== SSL Setup ==="
  echo "Run after nginx starts:"
  echo "  docker run --rm -v /etc/letsencrypt:/etc/letsencrypt -v /var/www/certbot:/var/www/certbot \\"
  echo "    certbot/certbot certonly --webroot -w /var/www/certbot \\"
  echo "    -d $DOMAIN --email $EMAIL --agree-tos --non-interactive"
fi

echo ""
echo "=== VPS setup complete ==="
echo "Next: copy .env to $REPO_DIR, run: cd $REPO_DIR && bash scripts/deploy-vps.sh"
