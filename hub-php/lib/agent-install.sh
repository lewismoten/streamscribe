#!/usr/bin/env bash
# Stream Scribe agent installer, served by the hub with this agent's details filled in (lib/agent-routes.php):
#   curl -fsSL '<hub>/api.php/agent-install?token=…' | bash
# For Debian-based Linux with systemd: Raspberry Pi OS (64-bit), Debian, Ubuntu. Run it as the user the agent should
# run as (it asks for sudo where it must). It installs ffmpeg and Node.js 24, puts the agent in ~/streamscribe, its
# data in ~/streamscribe-data, joins the hub with this one-time token, and sets up the streamscribe-agent service,
# which restarts if it stops and starts when the machine does. Running it again (with a new command) updates the
# agent and gives it a new key; its other settings are kept. It shows each step as it goes and keeps a log
# (~/streamscribe-install.log); if a step fails, it says which and prints the log's last lines.
set -euo pipefail

HUB=@HUB@
TOKEN=@TOKEN@
AGENT_ID=@AGENT_ID@
AGENT_NAME=@AGENT_NAME@
INSTALL_DIR="${STREAMSCRIBE_DIR:-$HOME/streamscribe}"
DATA_DIR="${STREAMSCRIBE_DATA:-$HOME/streamscribe-data}"
SERVICE=streamscribe-agent
UNIT_DIR="${STREAMSCRIBE_UNIT_DIR:-/etc/systemd/system}"

LOG="${STREAMSCRIBE_LOG:-$HOME/streamscribe-install.log}"
STEP=0
STEPS=7
STEP_NAME="starting"

# Everything is shown and also kept in the log, so a failure can be read (or pasted) afterwards.
: > "$LOG"
exec > >(tee -a "$LOG") 2>&1

step() { STEP=$((STEP + 1)); STEP_NAME="$*"; printf '\n\033[1;36m[%s/%s] %s\033[0m\n' "$STEP" "$STEPS" "$*"; }
note() { printf '      %s\n' "$*"; }
warn() { printf '\033[1;33m      ! %s\033[0m\n' "$*"; }
fail() { printf '\n\033[1;31m%s\033[0m\n' "$*"; exit 1; }
# On any failure: which step, and where the whole story is.
on_error() {
  local code=$?
  printf '\n\033[1;31mThe install stopped at step %s/%s (%s), exit code %s.\033[0m\n' "$STEP" "$STEPS" "$STEP_NAME" "$code"
  printf 'The log is %s. Fix what it says above (or paste the lines above), then run the same install command\n' "$LOG"
  printf 'again: finished steps go quickly the second time.\n'
}
trap on_error ERR

if [ "$(id -u)" -eq 0 ]; then SUDO=""; else SUDO="sudo"; fi
RUN_AS="$(id -un)"
# apt waits for another install (such as automatic updates) to finish rather than failing on its lock.
APT="$SUDO apt-get -o DPkg::Lock::Timeout=600"

step "Checking this machine"
command -v apt-get >/dev/null || fail "This installer is for Debian-based Linux (Raspberry Pi OS, Debian, Ubuntu)."
command -v systemctl >/dev/null || fail "This installer needs systemd."
note "$(. /etc/os-release 2>/dev/null && echo "$PRETTY_NAME") · $(uname -m) · $(nproc 2>/dev/null) CPUs · $(awk '/MemTotal/ {printf "%.1f GB memory", $2 / 1048576}' /proc/meminfo 2>/dev/null)"
[ -r /proc/device-tree/model ] && note "$(tr -d '\0' < /proc/device-tree/model)"
FREE_GB=$(df -Pk "$HOME" | awk 'NR == 2 {printf "%d", $4 / 1048576}')
note "${FREE_GB} GB free in $HOME"
[ "$FREE_GB" -lt 2 ] && warn "Less than 2 GB free: installing may fail, and recordings need much more."
case "$(uname -m)" in armv6l|armv7l) warn "This is a 32-bit system; Node.js 24 may not install. A 64-bit OS (Raspberry Pi 4 or 5) is best." ;; esac
# A Raspberry Pi that is short of power can lose its network or reset partway through an install.
if command -v vcgencmd >/dev/null; then
  THROTTLED=$(vcgencmd get_throttled 2>/dev/null | cut -d= -f2 || echo 0x0)
  if [ "$((THROTTLED & 0x1))" -ne 0 ]; then warn "Under-voltage right now ($THROTTLED): use the official power supply; the install may stop or the Pi reset."
  elif [ "$((THROTTLED & 0x10000))" -ne 0 ]; then warn "This Pi has had under-voltage since it started ($THROTTLED): check the power supply."
  else note "Power: OK"; fi
fi
# Interrupted package installs (a reset, a lost connection) are finished first.
if [ -n "$($SUDO dpkg --audit 2>/dev/null)" ] || [ -n "$(ls -A /var/lib/dpkg/updates 2>/dev/null)" ]; then
  warn "A package install was interrupted earlier: finishing it (dpkg --configure -a)"
  $SUDO dpkg --configure -a
  $APT -f install -y
fi

step "Installing ffmpeg and tools (this can take several minutes on a Raspberry Pi)"
$APT update
$APT install -y ca-certificates curl ffmpeg tar
note "$(ffmpeg -version | head -1)"

step "Installing Node.js 24"
NODE_MAJOR=0
if command -v node >/dev/null; then NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"; fi
if [ "$NODE_MAJOR" -lt 24 ]; then
  note "Adding the NodeSource package source"
  if [ -n "$SUDO" ]; then curl -fsSL https://deb.nodesource.com/setup_24.x | sudo -E bash -
  else curl -fsSL https://deb.nodesource.com/setup_24.x | bash -; fi
  $APT install -y nodejs
else
  note "Already installed"
fi
note "Node $(node --version)"

step "Downloading the agent into $INSTALL_DIR"
mkdir -p "$INSTALL_DIR" "$DATA_DIR"
curl -fSL --progress-bar "$HUB/agent-download?token=$TOKEN" -o "$INSTALL_DIR/.download.tgz"
tar -xzf "$INSTALL_DIR/.download.tgz" -C "$INSTALL_DIR"
rm -f "$INSTALL_DIR/.download.tgz"
note "Version $(node -p "require('$INSTALL_DIR/package.json').version")"

step "Joining the hub as $AGENT_ID ($AGENT_NAME)"
REPLY="$(curl -fsS -X POST -H 'content-type: application/json' --data "{\"token\":\"$TOKEN\"}" "$HUB/agent-enroll")" \
  || fail "The hub didn't accept the install command: it may have expired or already been used. Make a new one on the Agents page (Reinstall command)."
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

note "Joined; settings in $INSTALL_DIR/config.local.js"

step "Setting up the $SERVICE service"
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
note "$UNIT_DIR/$SERVICE.service: restarts if it stops, starts with the machine"
$SUDO systemctl daemon-reload
$SUDO systemctl enable "$SERVICE" >/dev/null 2>&1
$SUDO systemctl restart "$SERVICE"

step "Checking that it runs"
sleep 5
if systemctl is-active --quiet "$SERVICE"; then
  printf '\n\033[1;32mDone: %s is running and should show as online on the hub'"'"'s Agents page within a minute.\033[0m\n' "$AGENT_NAME"
else
  systemctl --no-pager --lines=20 status "$SERVICE" || true
  fail "The service didn't start; see above, or: journalctl -u $SERVICE -n 50"
fi
echo "  Logs:     journalctl -u $SERVICE -f"
echo "  Restart:  sudo systemctl restart $SERVICE"
echo "  Settings: $CONFIG"
echo "  This log: $LOG"
