# Deploy Novan to Oracle Cloud Always Free

Step-by-step. Frustration-engineered out wherever possible. The Oracle UI changes a few times a year; if a button is renamed, the *intent* of each step is what matters — match by purpose, not exact text.

**Time budget:** 45 minutes end to end.
**Monthly cost:** $0 (you'll get a CC verification charge of $0–$1 that refunds).
**What you need handy:** valid credit card, mobile phone for SMS, ~10 GB free in `~/Downloads` for the SSH key.

---

## Part A — Oracle account (15 min, can't be automated)

1. Open <https://signup.oraclecloud.com>.
2. Pick a **Home Region** geographically closest to you. **This cannot be changed later.** US-Ashburn or US-Phoenix have the most ARM Always-Free capacity right now; pick one of those if you're in the Americas. EU-Frankfurt for Europe.
3. Fill in personal info. Use a real address (matches your CC billing).
4. SMS verification — they'll text you a 6-digit code.
5. Credit card — **they hold $0.50–$1 for identity, then refund within 7 days**. They will not charge you for Always Free resources. If you're paranoid, use a virtual card from privacy.com.
6. Wait for the dashboard. Sometimes instant, sometimes 30 min. They'll email you.

**Common gotcha:** if signup hangs at "verifying", clear cookies + try a different browser. The flow is famously buggy on Safari.

---

## Part B — Create the VM (10 min)

1. Top-left hamburger → **Compute** → **Instances**.
2. Click **Create Instance**.
3. **Name:** `novan`
4. **Image and shape** → click **Edit** → **Change image**:
   - Image: **Canonical Ubuntu 24.04**
5. Click **Change shape**:
   - Shape series: **Ampere**
   - Shape name: **VM.Standard.A1.Flex**
   - OCPUs: **4** (the max free)
   - Memory: **24 GB** (the max free)
   - Click **Select shape**.
6. **Networking** → leave defaults (Oracle creates a VCN + subnet automatically).
7. **Add SSH keys** → choose **Generate a key pair for me** → click **Save private key** and **Save public key**. **DO NOT skip downloading the private key — you cannot retrieve it later.**
8. **Boot volume** → leave defaults (50 GB).
9. Click **Create**.

**Common gotcha #1 — "Out of host capacity":** Oracle's free ARM tier is famously oversubscribed. If you hit this error, click Create again. And again. Sometimes for 24 hours. The exponential-backoff retry trick: keep a browser tab open and click Create every 10 minutes. Or switch to a different Availability Domain (AD-1 vs AD-2 vs AD-3 in the same region) — they have separate capacity pools.

**Common gotcha #2 — region wrong:** if you can't get capacity in your region after a day, deleting the tenant and re-signing up with a different home region is the nuclear option. Painful but works.

Once the VM is **Running**, note its **Public IP** (right side of the instance page).

---

## Part C — Open ports in the VCN (3 min)

Oracle's default firewall blocks all ports except 22. You need to open 3000 (web) and 3001 (API) — only temporarily for first-time setup; after Tailscale is configured you can close them again.

1. From the instance page, click the **subnet** link (under "Primary VNIC").
2. Click the **Default Security List**.
3. Click **Add Ingress Rules**:
   - Source CIDR: `0.0.0.0/0`
   - IP Protocol: TCP
   - Destination Port Range: `3000`
   - Description: `Novan web (temp until Tailscale)`
4. **Add Ingress Rules** again for port `3001` (API).
5. Save.

---

## Part D — SSH in + bootstrap (15 min, mostly waiting)

On your laptop (Windows PowerShell):

```powershell
# Move the SSH key you downloaded to a sane place + fix permissions
mkdir -Force $HOME\.ssh
Move-Item $HOME\Downloads\ssh-key-*.key $HOME\.ssh\novan.key
icacls $HOME\.ssh\novan.key /inheritance:r
icacls $HOME\.ssh\novan.key /grant:r "$env:USERNAME:(R)"

# SSH in (replace IP)
ssh -i $HOME\.ssh\novan.key ubuntu@<PUBLIC_IP>
```

You're now on the VM. Run the bootstrap:

```bash
# Set your repo URL (replace with your actual git remote)
export NOVAN_REPO_URL="https://github.com/YOUR_GITHUB_USER/ops-platform.git"

# Run the one-shot bootstrap
curl -fsSL "${NOVAN_REPO_URL%.git}/raw/main/scripts/deploy-oracle.sh" | bash
```

If your repo is private, instead:

```bash
git clone https://github.com/YOUR_GITHUB_USER/ops-platform.git ~/novan
bash ~/novan/scripts/deploy-oracle.sh
```

The script will:
- Install Docker + Compose
- Fix Oracle's iptables (this is the one that always bites people)
- Pull images (~5 minutes)
- Start Postgres, Redis, the API, and the web UI
- Push the database schema
- Install Tailscale
- Print final checklist

---

## Part E — Fill in API keys (3 min)

```bash
nano ~/novan/.env
```

Find the LLM section, paste in **at least one** of:
- `ANTHROPIC_API_KEY=sk-ant-...`
- `OPENAI_API_KEY=sk-...`
- `GEMINI_API_KEY=...`
- `GROQ_API_KEY=gsk_...`

(`Ctrl+O`, Enter, `Ctrl+X` to save in nano.)

Restart the API to pick up the keys:

```bash
cd ~/novan
docker compose -f docker-compose.production.yml restart api
```

---

## Part F — Tailscale for phone access (3 min)

```bash
sudo tailscale up --ssh
```

It prints a URL like `https://login.tailscale.com/a/XXXXXX`. Open that on **any device** (laptop, phone), log in (or sign up — also free for personal), click Authorize. The VM is now on your Tailscale network.

Note the VM's Tailscale name (something like `novan.tail-scale.ts.net`). On your phone:

1. Install the Tailscale app (App Store / Play Store)
2. Log in with the same account
3. Browser → `https://<vm-tailscale-name>:3000/m/chat`
4. Tap menu → **Add to Home Screen**

The Novan icon is now on your phone home screen. Tap it to open the chat anywhere your phone has data.

---

## Part G — Lock it down (optional but recommended)

Once Tailscale works, close the public ports you opened in Part C:

1. Back to Oracle Console → **Networking** → **VCNs** → your VCN → **Security Lists** → **Default Security List**.
2. Delete the `0.0.0.0/0` rules for ports 3000 and 3001.

Your VM is now only reachable via Tailscale. Drastically reduced attack surface.

---

## How to verify everything works

From any device on your Tailscale network:

```bash
# Health
curl http://<vm-tailscale-name>:3001/healthz
# Expected: {"status":"ok","timestamp":...}

# Web UI
open http://<vm-tailscale-name>:3000
# Expected: Novan dashboard loads
```

From your phone (PWA):

- Tap the Novan icon on home screen
- Send "hi" in the chat
- Expected: streaming reply from whichever LLM provider you configured

---

## Maintenance

**Update Novan:**
```bash
cd ~/novan && git pull
docker compose -f docker-compose.production.yml pull
docker compose -f docker-compose.production.yml up -d
```

**Logs:**
```bash
cd ~/novan && docker compose -f docker-compose.production.yml logs -f api
```

**Restart everything:**
```bash
cd ~/novan && docker compose -f docker-compose.production.yml restart
```

**Full backup of the DB:**
```bash
cd ~/novan && docker compose -f docker-compose.production.yml exec postgres \
  pg_dump -U postgres ops | gzip > "novan-backup-$(date +%F).sql.gz"
```

**If everything is broken and you want to start over:**
```bash
cd ~/novan && docker compose -f docker-compose.production.yml down -v
bash ~/novan/scripts/deploy-oracle.sh
```

---

## Why you'll be glad you used Oracle

Your laptop can be off, asleep, lost in a couch cushion — Novan keeps running. Push notifications still hit your phone. Cron jobs keep ticking. The brain runs 24/7, costs you $0/month, and your data never leaves a server you control. The 45 minutes of setup once is the only friction.

---

## Last-mile help

If a specific step fails: copy the exact error + which part you were in (B-4, D-step-3, etc.), paste it back. I can usually identify the specific Oracle UI change or VM gotcha from the error text.
