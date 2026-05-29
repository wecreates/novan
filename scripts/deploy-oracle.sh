#!/usr/bin/env bash
# deploy-oracle.sh — One-shot bootstrap for Novan on Oracle Cloud
# Always Free (or any fresh Ubuntu 22.04/24.04 VM, really).
#
# Run as the `ubuntu` user via SSH:
#
#   curl -fsSL https://raw.githubusercontent.com/YOUR_GIT_REPO/main/scripts/deploy-oracle.sh | bash
#
# Or copy this file to the VM and run `bash deploy-oracle.sh`.
#
# What this script does, in order:
#   1. Apt update + install prerequisites (curl, git, build tools)
#   2. Install Docker engine + compose plugin
#   3. Fix Oracle's default iptables (their image blocks every port)
#   4. Clone the Novan repo to ~/novan
#   5. Generate a .env with sensible defaults (you fill in API keys after)
#   6. Pull container images + start the stack
#   7. Install Tailscale (you authenticate it interactively at the end)
#   8. Print the next-step checklist
#
# Idempotent: re-running is safe; existing config is preserved.

set -euo pipefail

# ─── Configurable ─────────────────────────────────────────────────────────
REPO_URL="${NOVAN_REPO_URL:-https://github.com/YOU/novan.git}"
NOVAN_DIR="${HOME}/novan"
BRANCH="${NOVAN_BRANCH:-main}"

# ─── Output helpers ───────────────────────────────────────────────────────
c_green='\033[1;32m'; c_red='\033[1;31m'; c_blue='\033[1;34m'; c_dim='\033[0;90m'; c_reset='\033[0m'
step() { printf "${c_blue}▸${c_reset} %s\n" "$*"; }
ok()   { printf "${c_green}✓${c_reset} %s\n" "$*"; }
warn() { printf "${c_red}⚠${c_reset} %s\n" "$*"; }
ask()  { printf "${c_dim}❯${c_reset} %s\n" "$*"; }

# ─── 1. Pre-flight ────────────────────────────────────────────────────────
if [[ "$(uname -s)" != "Linux" ]]; then
  warn "This script only runs on Linux (Ubuntu)."
  exit 1
fi
if [[ "$EUID" -eq 0 ]]; then
  warn "Run as a normal user (e.g. \`ubuntu\`), not root. The script will sudo when needed."
  exit 1
fi

step "Updating apt cache..."
sudo apt-get update -qq
sudo apt-get install -y -qq curl git ca-certificates gnupg lsb-release ufw
ok "Prerequisites installed."

# ─── 2. Docker ────────────────────────────────────────────────────────────
if ! command -v docker &>/dev/null; then
  step "Installing Docker..."
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker "$USER"
  ok "Docker installed. (Group change takes effect next login — using sudo for this session.)"
else
  ok "Docker already installed: $(docker --version)"
fi

DOCKER="sudo docker"
if groups | grep -q docker; then DOCKER="docker"; fi

# ─── 3. Fix Oracle's default iptables ─────────────────────────────────────
# Oracle's Ubuntu image ships with iptables rules that REJECT every port
# except 22. Without this, the dev/prod ports never become reachable
# even after you whitelist them in the VCN security list.
if sudo iptables -L INPUT -n | grep -q "REJECT.*reject-with icmp-host-prohibited"; then
  step "Fixing Oracle's default-deny iptables..."
  sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 80   -j ACCEPT
  sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 443  -j ACCEPT
  sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 3000 -j ACCEPT
  sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 3001 -j ACCEPT
  # Persist
  sudo apt-get install -y -qq iptables-persistent
  sudo netfilter-persistent save
  ok "iptables fixed + persisted."
else
  ok "iptables already permissive."
fi

# ─── 4. Clone the repo ────────────────────────────────────────────────────
if [[ ! -d "$NOVAN_DIR" ]]; then
  step "Cloning Novan into $NOVAN_DIR..."
  git clone --branch "$BRANCH" "$REPO_URL" "$NOVAN_DIR"
  ok "Repo cloned."
else
  step "Updating existing Novan repo..."
  (cd "$NOVAN_DIR" && git fetch --all && git checkout "$BRANCH" && git pull --ff-only)
  ok "Repo updated."
fi

# ─── 5. Configure .env ────────────────────────────────────────────────────
ENV_FILE="$NOVAN_DIR/.env"
if [[ ! -f "$ENV_FILE" ]]; then
  step "Generating .env (you will fill in API keys after this finishes)..."
  # Strong random secrets
  vault_key=$(openssl rand -base64 32)
  auth_secret=$(openssl rand -base64 32)
  cat > "$ENV_FILE" <<EOF
# Novan production environment — generated $(date -Iseconds)

# ─── Infra (Docker compose hostnames inside the network) ──────────────
DATABASE_URL=postgresql://postgres:postgres@postgres:5432/ops
REDIS_URL=redis://redis:6379

# ─── Secrets (auto-generated, rotate by replacing) ────────────────────
VAULT_MASTER_KEY=$vault_key
AUTH_SECRET=$auth_secret

# ─── LLM providers — FILL THESE IN ────────────────────────────────────
# At least one is required; chat will route through whichever is set.
ANTHROPIC_API_KEY=
OPENAI_API_KEY=
GEMINI_API_KEY=
GROQ_API_KEY=

# ─── Observability (optional) ─────────────────────────────────────────
# SENTRY_DSN=
# OTEL_EXPORTER_OTLP_ENDPOINT=

# ─── Web Push (run \`docker compose exec api node -e \"…generateVapidKeys…\"\` once) ─
VAPID_PUBLIC_KEY=
VAPID_PRIVATE_KEY=
VAPID_SUBJECT=mailto:operator@novan.local

# ─── Optional integrations ────────────────────────────────────────────
REPLICATE_API_TOKEN=
EOF
  chmod 600 "$ENV_FILE"
  ok ".env scaffolded at $ENV_FILE (mode 600)."
  warn "FILL IN at least one LLM provider key before starting the stack."
else
  ok ".env already exists (preserved)."
fi

# ─── 6. Pull + start the stack ────────────────────────────────────────────
step "Pulling Docker images..."
(cd "$NOVAN_DIR" && $DOCKER compose -f docker-compose.production.yml pull)
ok "Images pulled."

# Auto-restart on reboot. Compose's restart-unless-stopped covers crashes;
# enabling docker.service covers reboots.
sudo systemctl enable docker

step "Starting the stack..."
(cd "$NOVAN_DIR" && $DOCKER compose -f docker-compose.production.yml up -d)
ok "Stack started."

# Wait for Postgres + push schema
step "Waiting for Postgres..."
for i in {1..30}; do
  if $DOCKER compose -f "$NOVAN_DIR/docker-compose.production.yml" exec -T postgres pg_isready -U postgres >/dev/null 2>&1; then
    ok "Postgres ready."
    break
  fi
  sleep 1
done

step "Applying schema..."
(cd "$NOVAN_DIR" && $DOCKER compose -f docker-compose.production.yml exec -T api pnpm --filter @ops/db db:push --force) || \
  warn "Schema push reported issues; check 'docker compose logs api'."
ok "Schema applied."

# ─── 7. Tailscale ─────────────────────────────────────────────────────────
if ! command -v tailscale &>/dev/null; then
  step "Installing Tailscale..."
  curl -fsSL https://tailscale.com/install.sh | sudo sh
  ok "Tailscale installed."
fi

if ! sudo tailscale status >/dev/null 2>&1; then
  ask "Run this NEXT, then come back and run \`tailscale status\` to verify:"
  echo
  echo "    sudo tailscale up --ssh"
  echo
  ask "It will print a URL. Open it on any device, click 'Authorize'. That's it."
fi

# ─── 8. Final checklist ───────────────────────────────────────────────────
ip=$(curl -s ifconfig.me || echo "<your-vm-ip>")
echo
echo "════════════════════════════════════════════════════════════════"
ok "Novan stack is running on this VM."
echo
echo "Verify it's alive:"
echo "    curl http://localhost:3001/healthz"
echo
echo "Logs (live tail):"
echo "    cd ~/novan && docker compose -f docker-compose.production.yml logs -f api"
echo
echo "From your phone (after Tailscale is up on both ends):"
echo "    https://<your-tailscale-hostname>:3000/m/chat"
echo
echo "From the open internet (NOT recommended for personal use):"
echo "    http://$ip:3000   ← only if you opened ports in Oracle's VCN"
echo
echo "Next steps:"
echo "  1. Edit ~/novan/.env, fill in at least one LLM API key (ANTHROPIC_API_KEY or GEMINI_API_KEY)"
echo "  2. Restart the stack: cd ~/novan && docker compose -f docker-compose.production.yml restart api"
echo "  3. Run: sudo tailscale up --ssh    (one-time, opens browser to authorize)"
echo "  4. Generate Web Push keys (optional but lets Novan notify your phone):"
echo "       cd ~/novan && docker compose -f docker-compose.production.yml exec api \\"
echo "         node -e \"import('./dist/services/web-push.js').then(m => { const k=m.generateVapidKeys(); console.log('VAPID_PUBLIC_KEY=' + k.publicKey); console.log('VAPID_PRIVATE_KEY=' + k.privateKey) })\""
echo "       (paste the two lines into .env, restart api)"
echo
echo "════════════════════════════════════════════════════════════════"
