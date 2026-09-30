#!/usr/bin/env bash
# Install Spark Lens as a systemd user service on this machine.
#
#   deploy/install.sh              build, install and (re)start the service
#   deploy/install.sh --uninstall  stop and remove the service
#
# The unit is generated rather than shipped because it has to point at this
# checkout and at the Node binary in use (often under a version manager).
set -euo pipefail

UNIT=spark-lens.service
UNIT_DIR="${XDG_CONFIG_HOME:-$HOME/.config}/systemd/user"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if [ "${1:-}" = "--uninstall" ]; then
    systemctl --user disable --now "$UNIT" 2>/dev/null || true
    rm -f "$UNIT_DIR/$UNIT"
    systemctl --user daemon-reload
    echo "Removed $UNIT"
    exit 0
fi

NODE="$(command -v node)" || { echo "node not found on PATH" >&2; exit 1; }
major="$("$NODE" -p 'process.versions.node.split(".")[0]')"
[ "$major" -ge 24 ] || { echo "Node 24 or newer is required (found $("$NODE" -v))" >&2; exit 1; }

cd "$ROOT"
if command -v pnpm >/dev/null 2>&1; then
    pnpm install --frozen-lockfile
    pnpm build
else
    npm install
    npm run build
fi

mkdir -p "$UNIT_DIR"
cat > "$UNIT_DIR/$UNIT" <<UNIT_EOF
[Unit]
Description=Spark Lens dashboard
After=network-online.target
Wants=network-online.target

[Service]
WorkingDirectory=$ROOT
ExecStart=$NODE $ROOT/server/main.ts
# The collectors call ssh and the agent CLIs (opencode, orca) found on PATH.
Environment=PATH=$PATH
Restart=on-failure
RestartSec=5

[Install]
WantedBy=default.target
UNIT_EOF

systemctl --user daemon-reload
systemctl --user enable "$UNIT" >/dev/null
systemctl --user restart "$UNIT"
echo "Installed $UNIT_DIR/$UNIT"
systemctl --user --no-pager --lines=0 status "$UNIT" || true

if ! loginctl show-user "$USER" 2>/dev/null | grep -q '^Linger=yes'; then
    echo
    echo "Note: run 'sudo loginctl enable-linger $USER' to keep the service running while logged out."
fi
