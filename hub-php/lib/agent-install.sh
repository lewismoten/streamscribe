#!/usr/bin/env bash
# Stream Scribe agent installer, served by the hub with this agent's details filled in (lib/agent-routes.php):
#   curl -fsSL '<hub>/api.php/agent-install?token=…' | bash
# For Debian-based Linux with systemd: Raspberry Pi OS (64-bit), Debian, Ubuntu. Run it as the user the agent should
# run as (it asks for sudo where it must). It installs ffmpeg and Node.js 24, puts the agent in ~/streamscribe, its
# data in ~/streamscribe-data, joins the hub with this one-time token, and sets up the streamscribe-agent service,
# which restarts if it stops and starts when the machine does. Running it again (with a new command) updates the
# agent and gives it a new key; its other settings are kept.
set -euo pipefail

HUB=@HUB@
TOKEN=@TOKEN@
AGENT_ID=@AGENT_ID@
AGENT_NAME=@AGENT_NAME@
INSTALL_DIR="${STREAMSCRIBE_DIR:-$HOME/streamscribe}"
DATA_DIR="${STREAMSCRIBE_DATA:-$HOME/streamscribe-data}"
SERVICE=streamscribe-agent
UNIT_DIR="${STREAMSCRIBE_UNIT_DIR:-/etc/systemd/system}"

say() { printf '\n\033[1;36m==> %s\033[0m\n' "$*"; }
fail() { printf '\n\033[1;31m%s\033[0m\n' "$*" >&2; exit 1; }

if [ "$(id -u)" -eq 0 ]; then SUDO=""; else SUDO="sudo"; fi
RUN_AS="$(id -un)"
command -v apt-get >/dev/null || fail "This installer is for Debian-based Linux (Raspberry Pi OS, Debian, Ubuntu)."
command -v systemctl >/dev/null || fail "This installer needs systemd."

say "Installing what the agent needs (ffmpeg, Node.js 24)"
$SUDO apt-get update -qq
$SUDO apt-get install -y -qq ca-certificates curl ffmpeg tar >/dev/null
NODE_MAJOR=0
if command -v node >/dev/null; then NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"; fi
if [ "$NODE_MAJOR" -lt 24 ]; then
  if [ -n "$SUDO" ]; then curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash - >/dev/null
  else curl -fsSL https://deb.nodesource.com/setup_24.x | bash - >/dev/null; fi
  $SUDO apt-get install -y -qq nodejs >/dev/null
fi
node --version

say "Downloading the agent into $INSTALL_DIR"
mkdir -p "$INSTALL_DIR" "$DATA_DIR"
curl -fsSL "$HUB/agent-download?token=$TOKEN" | tar -xz -C "$INSTALL_DIR"

say "Joining the hub as $AGENT_ID ($AGENT_NAME)"
REPLY="$(curl -fsS -X POST -H 'content-type: application/json' --data "{\"token\":\"$TOKEN\"}" "$HUB/agent-enroll")" \
  || fail "The hub didn't accept the install command (it may have expired or been used). Make a new one on the Agents page."
CONFIG="$INSTALL_DIR/config.local.js"
STREAMSCRIBE_REPLY="$REPLY" node --input-type=module - "$CONFIG" "$DATA_DIR" <<'JS'
// The agent's settings: its hub, key, id, and name (kept: anything else already set, such as sources).
import fs from 'fs';
import { pathToFileURL } from 'url';
const [file, dataDir] = process.argv.slice(2);
const reply = JSON.parse(process.env.STREAMSCRIBE_REPLY);
let settings = {};
if (fs.existsSync(file)) settings = (await import(pathToFileURL(file).href + '?' + Date.now())).default || {};
settings.dataDir ??= dataDir;
settings.sources ??= [];
settings.recorder = { ...(settings.recorder || {}), hubUrl: reply.hubUrl, key: reply.key, id: reply.agentId, name: reply.name };
fs.writeFileSync(file, `export default ${JSON.stringify(settings, null, 2)};\n`, { mode: 0o600 });
JS

say "Setting up the $SERVICE service"
$SUDO tee "$UNIT_DIR/$SERVICE.service" >/dev/null <<UNIT
[Unit]
Description=Stream Scribe agent ($AGENT_ID)
After=network-online.target
Wants=network-online.target

[Service]
Type=simple
User=$RUN_AS
WorkingDirectory=$INSTALL_DIR
ExecStart=$(command -v node) bin/recorder.js
Restart=always
RestartSec=10
KillSignal=SIGINT
TimeoutStopSec=120
Environment=NODE_ENV=production

[Install]
WantedBy=multi-user.target
UNIT
$SUDO systemctl daemon-reload
$SUDO systemctl enable "$SERVICE" >/dev/null 2>&1
$SUDO systemctl restart "$SERVICE"
sleep 5
if systemctl is-active --quiet "$SERVICE"; then
  say "Done: $AGENT_NAME is running and should show as online on the hub's Agents page."
else
  systemctl --no-pager --lines=20 status "$SERVICE" || true
  fail "The service didn't start; see above, or: journalctl -u $SERVICE -n 50"
fi
echo "  Logs:     journalctl -u $SERVICE -f"
echo "  Restart:  sudo systemctl restart $SERVICE"
echo "  Settings: $CONFIG"
