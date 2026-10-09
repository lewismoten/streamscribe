#!/usr/bin/env bash
# Stream Scribe agent installer, served by the hub with this agent's details filled in (lib/agent-routes.php):
#   curl -fsSL '<hub>/api.php/agent-install?token=…' | bash
# For Debian-based Linux with systemd (Raspberry Pi OS (64-bit), Debian, Ubuntu), or macOS with Homebrew. Run it as
# the user the agent should run as (on Linux it asks for sudo where it must). It installs ffmpeg and Node.js 24 (apt,
# or Homebrew), puts the agent in ~/streamscribe, its data in ~/streamscribe-data, joins the hub with this one-time
# token, and sets up the agent's service (systemd's streamscribe-agent, or a launchd agent on a Mac, which also keeps
# the Mac from sleeping while it runs), which restarts if it stops and starts when the machine does (on a Mac, when
# the user logs in). Running it again (with a new command) updates the agent and gives it a new key; its other
# settings are kept. It shows each step as it goes and keeps a log (~/streamscribe-install.log); if a step fails, it
# says which and prints the log's last lines. To share the recordings of another agent on this machine (one run from a
# copy of the repository, say), give that agent's settings file:
#   curl -fsSL '<hub>/api.php/agent-install?token=…' | STREAMSCRIBE_SHARE_FROM=~/path/to/config.local.js bash
set -euo pipefail

HUB=@HUB@
TOKEN=@TOKEN@
AGENT_ID=@AGENT_ID@
AGENT_NAME=@AGENT_NAME@
INSTALL_DIR="${STREAMSCRIBE_DIR:-$HOME/streamscribe}"
DATA_DIR="${STREAMSCRIBE_DATA:-$HOME/streamscribe-data}"
SERVICE=streamscribe-agent
UNIT_DIR="${STREAMSCRIBE_UNIT_DIR:-/etc/systemd/system}"
LABEL="${STREAMSCRIBE_LABEL:-com.streamscribe.agent}"
PLIST_DIR="${STREAMSCRIBE_LAUNCHD_DIR:-$HOME/Library/LaunchAgents}"
case "$(uname -s)" in Darwin) OS=mac ;; *) OS=linux ;; esac

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
# Package installs never stop to ask: this script arrives through a pipe, so nobody can answer a prompt (Ubuntu's
# "pending kernel upgrade" and "restart services" questions from needrestart, a changed config file). apt also waits
# for another install (such as automatic updates) to finish rather than failing on its lock.
QUIET_ENV=(env DEBIAN_FRONTEND=noninteractive NEEDRESTART_MODE=a NEEDRESTART_SUSPEND=1)
APT_OPTIONS=(-o DPkg::Lock::Timeout=600 -o Dpkg::Options::=--force-confdef -o Dpkg::Options::=--force-confold)
apt_get() { $SUDO "${QUIET_ENV[@]}" apt-get "${APT_OPTIONS[@]}" "$@" < /dev/null; }

step "Checking this machine"
if [ "$OS" = mac ]; then
  # Homebrew installs ffmpeg and Node.js; it's installed by hand once (it asks questions a piped script can't answer).
  for BREW in "$(command -v brew || true)" /opt/homebrew/bin/brew /usr/local/bin/brew; do [ -x "$BREW" ] && break; done
  [ -x "$BREW" ] || fail "This installer needs Homebrew on a Mac: install it from https://brew.sh, then run the same install command again."
  eval "$("$BREW" shellenv)"
  note "$(sw_vers -productName) $(sw_vers -productVersion) · $(uname -m) · $(sysctl -n hw.ncpu) CPUs · $(sysctl -n hw.memsize | awk '{printf "%.1f GB memory", $1 / 1073741824}')"
  note "Homebrew $("$BREW" --version | head -1 | awk '{print $2}') in $(brew --prefix)"
  FREE_GB=$(df -Pk "$HOME" | awk 'NR == 2 {printf "%d", $4 / 1048576}')
  note "${FREE_GB} GB free in $HOME"
  [ "$FREE_GB" -lt 2 ] && warn "Less than 2 GB free: installing may fail, and recordings need much more."
else
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
    # (On some systems, Ubuntu among them, reading it needs permission: try without, then with sudo if it won't ask.)
    THROTTLED=$(vcgencmd get_throttled 2>/dev/null | sed -n 's/^throttled=//p' || true)
    if [ -z "$THROTTLED" ]; then THROTTLED=$($SUDO -n vcgencmd get_throttled 2>/dev/null | sed -n 's/^throttled=//p' || true); fi
    if ! [[ "$THROTTLED" =~ ^0x[0-9a-fA-F]+$ ]]; then note "Power: couldn't check (vcgencmd needs permission here)"
    elif (( THROTTLED & 0x1 )); then warn "Under-voltage right now ($THROTTLED): use the official power supply; the install may stop or the Pi reset."
    elif (( THROTTLED & 0x10000 )); then warn "This Pi has had under-voltage since it started ($THROTTLED): check the power supply."
    else note "Power: OK"; fi
  fi
  # Interrupted package installs (a reset, a lost connection) are finished first.
  if [ -n "$($SUDO dpkg --audit 2>/dev/null)" ] || [ -n "$(ls -A /var/lib/dpkg/updates 2>/dev/null)" ]; then
    warn "A package install was interrupted earlier: finishing it (dpkg --configure -a)"
    $SUDO "${QUIET_ENV[@]}" dpkg --force-confdef --force-confold --configure -a < /dev/null
    apt_get -f install -y
  fi
fi

if [ "$OS" = mac ]; then
  step "Installing ffmpeg (Homebrew; this can take several minutes)"
  if command -v ffmpeg >/dev/null; then note "Already installed"; else brew install ffmpeg < /dev/null; fi
else
  step "Installing ffmpeg and tools (this can take several minutes on a Raspberry Pi)"
  apt_get update
  # Without recommended extras: ffmpeg would otherwise bring desktop packages (icons, sound, GTK) a headless machine
  # doesn't need.
  apt_get install -y --no-install-recommends ca-certificates curl ffmpeg tar
fi
note "$(ffmpeg -version | head -1)"

step "Installing Node.js 24"
NODE_MAJOR=0
if command -v node >/dev/null; then NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"; fi
if [ "$NODE_MAJOR" -lt 24 ] && [ "$OS" = mac ]; then
  # Homebrew's own Node.js (the latest), used by the agent even if an older one (nvm, say) comes first in PATH.
  if brew list --formula node >/dev/null 2>&1; then brew upgrade node < /dev/null || true; else brew install node < /dev/null; fi
  PATH="$(brew --prefix node)/bin:$PATH"
elif [ "$NODE_MAJOR" -lt 24 ]; then
  note "Adding the NodeSource package source"
  curl -fsSL https://deb.nodesource.com/setup_24.x -o /tmp/nodesource-setup.sh
  $SUDO "${QUIET_ENV[@]}" bash /tmp/nodesource-setup.sh < /dev/null
  apt_get install -y --no-install-recommends nodejs
else
  note "Already installed"
fi
NODE_BIN="$(command -v node)"
note "Node $(node --version) ($NODE_BIN)"

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
// The agent's settings: its hub, key, id, and name (kept: anything else already set, such as sources). With
// STREAMSCRIBE_SHARE_FROM (another agent's config.local.js on this machine), it takes that agent's settings but its
// identity (sources, data folder, tools, transcription), with folders made absolute, so it has the same recordings.
import fs from 'fs';
import path from 'path';
import { pathToFileURL } from 'url';
const [file, dataDir] = process.argv.slice(2);
const reply = JSON.parse(process.env.STREAMSCRIBE_REPLY);
const load = async (from) => (await import(pathToFileURL(from).href + '?' + Date.now())).default || {};
let settings = {};
if (fs.existsSync(file)) settings = await load(file);
const shareFrom = process.env.STREAMSCRIBE_SHARE_FROM ? path.resolve(process.env.STREAMSCRIBE_SHARE_FROM) : '';
if (shareFrom) {
  if (!fs.existsSync(shareFrom)) throw new Error(`STREAMSCRIBE_SHARE_FROM: no such file: ${shareFrom}`);
  const other = await load(shareFrom);
  const home = path.dirname(shareFrom);
  const absolute = (value) => (value ? path.resolve(home, String(value).replace(/^~(?=\/|$)/, process.env.HOME)) : value);
  const { recorder: { hubUrl, key, id, name, ...recorderRest } = {}, ...rest } = other;
  settings = { ...settings, ...rest, recorder: { ...(settings.recorder || {}), ...recorderRest } };
  settings.dataDir = absolute(other.dataDir || 'data');
  if (other.stateDir) settings.stateDir = absolute(other.stateDir);
  settings.sources = (other.sources || []).map((source) => ({
    ...source,
    ...(source.storageDir ? { storageDir: absolute(source.storageDir) } : {}),
    ...(source.liveStorageDir ? { liveStorageDir: absolute(source.liveStorageDir) } : {})
  }));
  settings.transcription = {
    ...(other.transcription || {}),
    correctionsFile: absolute(other.transcription?.correctionsFile || 'transcription-corrections.local.json')
  };
  console.log(`      Shares the files of ${id || name || shareFrom}: ${settings.dataDir}`);
  console.log(`      Sources: ${settings.sources.map((source) => source.key).join(', ') || 'none'}`);
}
settings.dataDir ??= dataDir;
settings.sources ??= [];
settings.recorder = { ...(settings.recorder || {}), hubUrl: reply.hubUrl, key: reply.key, id: reply.agentId, name: reply.name };
fs.writeFileSync(file, `export default ${JSON.stringify(settings, null, 2)};\n`, { mode: 0o600 });
JS

note "Joined; settings in $INSTALL_DIR/config.local.js"

if [ "$OS" = mac ]; then
  step "Setting up the $LABEL launchd agent"
  mkdir -p "$PLIST_DIR" "$DATA_DIR/logs"
  PLIST="$PLIST_DIR/$LABEL.plist"
  AGENT_LOG="$DATA_DIR/logs/agent.log"
  # caffeinate -i keeps the Mac from sleeping (when idle) while the agent runs; PATH finds Homebrew's tools.
  cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>/usr/bin/caffeinate</string><string>-i</string>
    <string>$NODE_BIN</string><string>bin/recorder.js</string>
  </array>
  <key>WorkingDirectory</key><string>$INSTALL_DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>ExitTimeOut</key><integer>120</integer>
  <key>StandardOutPath</key><string>$AGENT_LOG</string>
  <key>StandardErrorPath</key><string>$AGENT_LOG</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(dirname "$NODE_BIN"):$(brew --prefix)/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
    <key>NODE_ENV</key><string>production</string>
  </dict>
</dict>
</plist>
PLIST
  plutil -lint "$PLIST" >/dev/null || fail "The launchd file didn't check out: $PLIST"
  note "$PLIST: restarts if it stops, starts when you log in"
  DOMAIN="gui/$(id -u)"
  launchctl bootout "$DOMAIN/$LABEL" 2>/dev/null || true
  sleep 1
  launchctl bootstrap "$DOMAIN" "$PLIST" \
    || fail "launchd didn't take the agent; over ssh, someone must be logged in to this Mac (or run the command in Terminal on it)."

  step "Checking that it runs"
  sleep 5
  if launchctl print "$DOMAIN/$LABEL" 2>/dev/null | grep -q 'state = running'; then
    printf '\n\033[1;32mDone: %s is running and should show as online on the hub'"'"'s Agents page within a minute.\033[0m\n' "$AGENT_NAME"
  else
    tail -n 20 "$AGENT_LOG" 2>/dev/null || true
    fail "The agent didn't start; see above, or: tail -n 50 $AGENT_LOG"
  fi
  echo "  Logs:     tail -f $AGENT_LOG"
  echo "  Restart:  launchctl kickstart -k $DOMAIN/$LABEL"
  echo "  Stop:     launchctl bootout $DOMAIN/$LABEL"
  echo "  Settings: $CONFIG"
  echo "  This log: $LOG"
  exit 0
fi

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
# Updates installed along the way (a new kernel, say) may want a restart; the agent starts again by itself after one.
if [ -f /var/run/reboot-required ]; then
  printf '\n\033[1;33mThe system has updates waiting for a restart (%s). Restart when convenient: sudo reboot\033[0m\n' "$(tr '\n' ' ' < /var/run/reboot-required.pkgs 2>/dev/null | head -c 120)"
fi
