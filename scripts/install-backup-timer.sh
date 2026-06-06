#!/bin/bash
# R146.273 — switch nightly pg_dump from user crontab to systemd timer
# with Persistent=true. If the machine is asleep/off at 03:30, the timer
# runs the missed job on next boot — fixes the gap that staled the
# brain.health backup signal mid-session.
set -euo pipefail

cat > /etc/systemd/system/novan-backup.service <<'EOF'
[Unit]
Description=Novan nightly pg_dump backup (R146.273)
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
ExecStart=/root/novan/scripts/backup-postgres.sh
StandardOutput=append:/var/log/novan-backup.log
StandardError=append:/var/log/novan-backup.log
EOF

cat > /etc/systemd/system/novan-backup.timer <<'EOF'
[Unit]
Description=Novan nightly backup timer (R146.273)

[Timer]
OnCalendar=*-*-* 03:30:00
Persistent=true
RandomizedDelaySec=600

[Install]
WantedBy=timers.target
EOF

# Disable the crontab line if present (idempotent grep + crontab -)
if crontab -l 2>/dev/null | grep -q backup-postgres.sh; then
  crontab -l | grep -v backup-postgres.sh | crontab -
  echo "[install] removed backup-postgres.sh from user crontab"
fi

systemctl daemon-reload
systemctl enable --now novan-backup.timer
echo "[install] novan-backup.timer enabled — next run:"
systemctl list-timers novan-backup.timer --no-pager
