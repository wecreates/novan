#!/usr/bin/env bash
# R146.225 — Install logrotate config for Novan-related logs.
# /var/log/novan-applier.log grows unbounded; rotate daily, keep 14 days.
# Also rotates /var/log/docker-prune.log (R197 weekly auto-prune).
#
# Usage (on droplet, as root):
#   bash /root/novan/scripts/install-logrotate.sh

set -euo pipefail

cat > /etc/logrotate.d/novan <<'CONF'
/var/log/novan-applier.log /var/log/docker-prune.log {
    daily
    rotate 14
    missingok
    notifempty
    compress
    delaycompress
    copytruncate
    su root root
}
CONF

# Validate
logrotate --debug /etc/logrotate.d/novan 2>&1 | tail -5

echo "logrotate config installed at /etc/logrotate.d/novan"
echo "next rotation: /etc/cron.daily/logrotate (host cron drives it)"
