#!/bin/bash
# R146.278 — daily Docker prune instead of weekly.
# Build cache grew to 30 GB / 73% disk in 1 week because the existing
# crontab line was weekly + 72h-only filter. Daily + 24h filter holds
# growth flat. Persistent=true so missed runs catch up after reboot.
set -euo pipefail

cat > /etc/systemd/system/novan-docker-prune.service <<'EOF'
[Unit]
Description=Novan daily Docker prune (R146.278)
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
ExecStart=/usr/bin/docker builder prune -af --filter until=24h
ExecStart=/usr/bin/docker image prune -af --filter until=72h
StandardOutput=append:/var/log/docker-prune.log
StandardError=append:/var/log/docker-prune.log
EOF

cat > /etc/systemd/system/novan-docker-prune.timer <<'EOF'
[Unit]
Description=Novan daily Docker prune timer (R146.278)

[Timer]
OnCalendar=*-*-* 04:15:00
Persistent=true
RandomizedDelaySec=600

[Install]
WantedBy=timers.target
EOF

# Disable the weekly crontab entries
if crontab -l 2>/dev/null | grep -q 'docker builder prune\|docker image prune'; then
  crontab -l | grep -v 'docker builder prune' | grep -v 'docker image prune' | crontab -
  echo "[install] removed weekly docker prune lines from crontab"
fi

systemctl daemon-reload
systemctl enable --now novan-docker-prune.timer
echo "[install] novan-docker-prune.timer enabled — next run:"
systemctl list-timers novan-docker-prune.timer --no-pager
