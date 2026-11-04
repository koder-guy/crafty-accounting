#!/bin/bash
# Installs Crafty Accounting on macOS or Linux and starts it, or updates an existing install.
#
#   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/koder-guy/crafty-accounting/main/install.sh)"
#
# To update, run ~/crafty-accounting/crafty update.
#
# Everything goes in ~/crafty-accounting: its own copy of Node 22 (from nodejs.org),
# the app, your settings (.env) and your books (data/). Nothing is installed system
# wide and it needs no administrator password. Running it again updates the app and
# keeps your data and settings. It doesn't make the app start automatically; start
# and stop it with ~/crafty-accounting/crafty.
#
# It serves the app over HTTPS through Caddy (from GitHub's caddyserver/caddy releases,
# also kept in ~/crafty-accounting), with a private certificate for your home network.
#
# Needs curl and tar, which macOS and most Linux distributions have.
#
# Optional settings, given as environment variables before the command:
#   CRAFTY_DIR             where to install (default ~/crafty-accounting)
#   CRAFTY_PORT            port the app itself listens on (default 3000)
#   CRAFTY_HTTPS           true or false: HTTPS through Caddy (default true for a new
#                          install; give it to switch an existing install either way)
#   CRAFTY_HTTP_PORT       with HTTPS, Caddy's ports (default 80 and 443 where this user
#   CRAFTY_HTTPS_PORT      may use them and they're free, else 8080 and 8443)
#   CRAFTY_BRANCH          branch or tag to install (default: the latest release)
#   CRAFTY_TARBALL         URL of the app's source .tar.gz, instead of GitHub's for CRAFTY_BRANCH
#   CRAFTY_REPO            GitHub repository to install from (default koder-guy/crafty-accounting)

set -euo pipefail

REPO="${CRAFTY_REPO:-koder-guy/crafty-accounting}"
DIR="${CRAFTY_DIR:-$HOME/crafty-accounting}"
NODE_DIST="https://nodejs.org/dist/latest-v22.x"
CADDY_VERSION="2.11.8"

bold=$'\033[1m'; green=$'\033[32m'; red=$'\033[31m'; reset=$'\033[0m'
step() { printf '\n%s==> %s%s\n' "$bold" "$1" "$reset"; }
fail() { printf '\n%sError: %s%s\n' "$red" "$1" "$reset" >&2; exit 1; }

[ "$(id -u)" -ne 0 ] || fail "run this as your normal user, not as root or with sudo."
for tool in curl tar; do
  command -v "$tool" >/dev/null 2>&1 || fail "$tool is needed. Install it with your package manager (e.g. sudo apt install $tool) and run this again."
done

case "$(uname -s)" in
  Darwin) OS=darwin ;;
  Linux) OS=linux ;;
  *) fail "this installer is for macOS and Linux. Docker Compose (see the README) runs anywhere else." ;;
esac
case "$(uname -m)" in
  x86_64 | amd64) ARCH=x64 ;;
  arm64 | aarch64) ARCH=arm64 ;;
  *) fail "Node 22 isn't available for this processor ($(uname -m)). Docker Compose (see the README) may work instead." ;;
esac
if [ "$OS" = linux ] && ldd --version 2>&1 | grep -qi musl; then
  fail "this Linux uses musl (Alpine?), which nodejs.org has no Node build for. Use Docker Compose (see the README)."
fi

# The newest release tag (vX.Y.Z), or main if the repository has none. Installs follow
# releases so the version the app shows is the code it runs.
latest_release() {
  local tags
  tags="$(curl -fsSL -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/$REPO/tags?per_page=100")" \
    || fail "couldn't find the latest release on GitHub. Run this again, or give CRAFTY_BRANCH (e.g. CRAFTY_BRANCH=main)."
  printf '%s\n' "$tags" | sed -n 's/.*"name": *"\(v[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)".*/\1/p' \
    | sort -t. -k1.2,1n -k2,2n -k3,3n | tail -n 1 | grep . || echo main
}

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}
sha512() {
  if command -v sha512sum >/dev/null 2>&1; then sha512sum "$1" | cut -d' ' -f1; else shasum -a 512 "$1" | cut -d' ' -f1; fi
}

# install-docker.sh uses the same folder by default, laid out differently.
if [ -f "$DIR/docker-compose.yml" ] || grep -qs '^# Written by install-docker.sh' "$DIR/.env"; then
  fail "$DIR has the Docker install. Update that with $DIR/install-docker.sh, or put this one somewhere else with CRAFTY_DIR."
fi

mkdir -p "$DIR"
cd "$DIR"

# ---- The app, built next to the running copy so a failed update leaves it working ----
if [ -n "${CRAFTY_REEXEC:-}" ] && [ -d app.new ]; then
  # Already downloaded by the installer that started this one (below).
  BRANCH="${CRAFTY_BRANCH_LABEL:-${CRAFTY_BRANCH:-the new version}}"
else
  if [ -n "${CRAFTY_BRANCH:-}" ]; then BRANCH="$CRAFTY_BRANCH"; elif [ -n "${CRAFTY_TARBALL:-}" ]; then BRANCH="from $CRAFTY_TARBALL"; else BRANCH="$(latest_release)"; fi
  TARBALL="${CRAFTY_TARBALL:-https://github.com/$REPO/archive/$BRANCH.tar.gz}"
  step "Downloading the app ($BRANCH)"
  rm -rf app.new && mkdir app.new
  curl -fsSL "$TARBALL" | tar -xz -C app.new --strip-components=1 || fail "couldn't download the app ($BRANCH) from $TARBALL."
  # Carry on with the installer that came with it, so an update sets things up the way
  # the new version expects (`crafty update` starts this from the version being replaced).
  if [ -f app.new/install.sh ]; then
    CRAFTY_REEXEC=1 CRAFTY_DIR="$DIR" CRAFTY_BRANCH_LABEL="$BRANCH" exec /bin/bash app.new/install.sh
  fi
fi

# ---- Node 22 ----
step "Checking Node 22"
NODE_FILE="$(curl -fsSL "$NODE_DIST/SHASUMS256.txt" | awk -v f="-$OS-$ARCH.tar.gz" '$2 ~ /^node-v22\./ && substr($2, length($2) - length(f) + 1) == f { print $2 }')" \
  || fail "couldn't reach nodejs.org."
[ -n "$NODE_FILE" ] || fail "nodejs.org has no Node 22 for $OS-$ARCH."
NODE_VERSION="${NODE_FILE#node-}"; NODE_VERSION="${NODE_VERSION%%-*}"
if [ -x node/bin/node ] && [ "$(node/bin/node --version)" = "$NODE_VERSION" ]; then
  echo "Node $NODE_VERSION is up to date."
else
  echo "Downloading Node $NODE_VERSION."
  rm -rf node.download && mkdir node.download
  curl -fSL --progress-bar -o "node.download/$NODE_FILE" "$NODE_DIST/$NODE_FILE"
  expected="$(curl -fsSL "$NODE_DIST/SHASUMS256.txt" | awk -v f="$NODE_FILE" '$2 == f { print $1 }')"
  [ "$(sha256 "node.download/$NODE_FILE")" = "$expected" ] || fail "the Node download didn't match its checksum. Run this again."
  tar -xzf "node.download/$NODE_FILE" -C node.download --strip-components=1
  rm "node.download/$NODE_FILE"
  rm -rf node && mv node.download node
fi
export PATH="$DIR/node/bin:$PATH"

step "Installing packages (this takes a minute or two)"
# better-sqlite3, esbuild and fsevents ship ready-built binaries. Without
# --ignore-scripts, npm ci compiles better-sqlite3 anyway, which needs a compiler.
(cd app.new && npm ci --ignore-scripts --no-audit --no-fund --loglevel=error) || fail "installing packages failed (see above)."

step "Building the app"
(cd app.new && npm run build --silent >/dev/null) || fail "the build failed (see above)."

# ---- Settings ----
ENV_FILE="$DIR/.env"
NEW_INSTALL=0
if [ ! -f "$ENV_FILE" ]; then
  step "Writing settings to $ENV_FILE"
  NEW_INSTALL=1
  SESSION_SECRET="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
  (umask 077 && cat > "$ENV_FILE" <<EOF
# Written by install.sh. See "Configuration" in the README for every setting.
# Restart the app after changing anything:  $DIR/crafty restart

SESSION_SECRET=$SESSION_SECRET

PORT=${CRAFTY_PORT:-3000}
DATA_DIR=$DIR/data
TZ=Europe/London

# true when HTTPS is on (the installer sets them).
COOKIE_SECURE=false
TRUST_PROXY=false
EOF
  )
else
  echo "Keeping the existing settings in $ENV_FILE."
fi
env_value() { sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1; }
# Sets KEY=VALUE in .env, replacing the line if it's there (keeping the file's permissions).
set_env() {
  if grep -q "^$1=" "$ENV_FILE"; then
    awk -v k="$1" -v v="$2" 'index($0, k "=") == 1 { print k "=" v; next } { print }' "$ENV_FILE" > "$ENV_FILE.tmp"
    cat "$ENV_FILE.tmp" > "$ENV_FILE" && rm -f "$ENV_FILE.tmp"
  else
    printf '%s=%s\n' "$1" "$2" >> "$ENV_FILE"
  fi
}
PORT="$(env_value PORT)"; PORT="${PORT:-3000}"
port_free() { node -e "require('net').createServer().once('error', () => process.exit(1)).listen($1, () => process.exit(0))"; }

# This computer's addresses on the home network.
if [ "$OS" = darwin ]; then
  HOST_NAME="$(scutil --get LocalHostName 2>/dev/null || true)"
  LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)"
else
  HOST_NAME=""
  LAN_IP="$(hostname -I 2>/dev/null | awk '{ print $1 }' || true)"
  [ -n "$LAN_IP" ] || LAN_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{ for (i = 1; i < NF; i++) if ($i == "src") print $(i + 1) }' || true)"
fi

# ---- HTTPS ----
# On for a new install unless CRAFTY_HTTPS=false; an existing install keeps what it has
# unless CRAFTY_HTTPS says otherwise.
HTTPS="$(env_value HTTPS)"
WANT_HTTPS="${CRAFTY_HTTPS:-}"
[ -n "$WANT_HTTPS" ] || { [ "$NEW_INSTALL" = 1 ] && WANT_HTTPS=true; } || WANT_HTTPS="${HTTPS:-false}"
if [ "$WANT_HTTPS" = true ] && [ "$HTTPS" != true ]; then
  step "Setting up HTTPS"
  # Ports below 1024 need extra permission on Linux; this user may not have it.
  http_port="${CRAFTY_HTTP_PORT:-}" https_port="${CRAFTY_HTTPS_PORT:-}"
  if [ -z "$http_port" ]; then http_port=80; port_free 80 || http_port=8080; fi
  if [ -z "$https_port" ]; then https_port=443; port_free 443 || https_port=8443; fi
  site="localhost"
  [ -n "$HOST_NAME" ] && site="$site, $HOST_NAME.local"
  [ -n "$LAN_IP" ] && site="$site, $LAN_IP"
  if [ -z "$(env_value SITE_ADDRESS)" ]; then
    printf '\n# HTTPS through Caddy (see "HTTPS" in the README): the addresses you browse to, and a\n# private certificate for them. If this computer'"'"'s IP address changes, update SITE_ADDRESS.\n' >> "$ENV_FILE"
    set_env SITE_ADDRESS "$site"
    set_env SITE_IP "${LAN_IP:-localhost}"
    set_env TLS_ISSUER internal
  fi
  set_env HTTP_PORT "$http_port"
  set_env HTTPS_PORT "$https_port"
  # The app itself answers only on this computer, behind Caddy.
  set_env HOST 127.0.0.1
  set_env COOKIE_SECURE true
  set_env TRUST_PROXY true
  set_env HTTPS true
  echo "Caddy will serve https on port $https_port (and redirect http on port $http_port)."
elif [ "$WANT_HTTPS" != true ] && [ "$HTTPS" = true ]; then
  step "Switching HTTPS off"
  set_env HTTPS false
  set_env HOST ""
  set_env COOKIE_SECURE false
  set_env TRUST_PROXY false
fi
HTTPS="$(env_value HTTPS)"
HTTPS_PORT="$(env_value HTTPS_PORT)"; HTTPS_PORT="${HTTPS_PORT:-443}"

if [ "$HTTPS" = true ]; then
  step "Checking Caddy $CADDY_VERSION"
  if [ -x caddy/caddy ] && caddy/caddy version 2>/dev/null | grep -q "^v$CADDY_VERSION "; then
    echo "Caddy $CADDY_VERSION is up to date."
  else
    case "$OS" in darwin) caddy_os=mac ;; *) caddy_os=linux ;; esac
    case "$ARCH" in x64) caddy_arch=amd64 ;; *) caddy_arch=arm64 ;; esac
    caddy_file="caddy_${CADDY_VERSION}_${caddy_os}_${caddy_arch}.tar.gz"
    caddy_url="https://github.com/caddyserver/caddy/releases/download/v$CADDY_VERSION"
    echo "Downloading Caddy $CADDY_VERSION."
    rm -rf caddy.download && mkdir caddy.download
    curl -fSL --progress-bar -o "caddy.download/$caddy_file" "$caddy_url/$caddy_file" || fail "couldn't download Caddy from $caddy_url."
    expected="$(curl -fsSL "$caddy_url/caddy_${CADDY_VERSION}_checksums.txt" | awk -v f="$caddy_file" '$2 == f { print $1 }')"
    [ -n "$expected" ] && [ "$(sha512 "caddy.download/$caddy_file")" = "$expected" ] || fail "the Caddy download didn't match its checksum. Run this again."
    tar -xzf "caddy.download/$caddy_file" -C caddy.download caddy
    mkdir -p caddy
    mv caddy.download/caddy caddy/caddy.new && mv caddy/caddy.new caddy/caddy
    rm -rf caddy.download
  fi
fi

# ---- Start and stop script ----
# Written to a new file and moved into place: `crafty update` is still reading the old one.
cat > "$DIR/crafty.new" <<'EOF'
#!/bin/sh
# Starts and stops Crafty Accounting:  crafty start | stop | restart | status | log | update
# With HTTPS=true in .env, Caddy runs in front of the app (see "HTTPS" in the README).
DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$DIR/.env"
APP_PID="$DIR/crafty.pid"
CADDY_PID="$DIR/caddy.pid"
LOG="$DIR/logs/crafty.log"
CADDY_LOG="$DIR/logs/caddy.log"
setting() { sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1; }
PORT="$(setting PORT)"; PORT="${PORT:-3000}"
HTTPS="$(setting HTTPS)"
HTTPS_PORT="$(setting HTTPS_PORT)"; HTTPS_PORT="${HTTPS_PORT:-443}"
if [ "$HTTPS" = true ]; then
  if [ "$HTTPS_PORT" = 443 ]; then URL="https://localhost"; else URL="https://localhost:$HTTPS_PORT"; fi
else
  URL="http://localhost:$PORT"
fi

running() { [ -f "$1" ] && kill -0 "$(cat "$1")" 2>/dev/null; }

# Starts a program in a session of its own (detached), so closing the terminal doesn't
# stop it (nohup isn't enough):  detach LOG PID_FILE COMMAND ARGS...
detach() {
  "$DIR/node/bin/node" -e '
    const { spawn } = require("node:child_process");
    const fs = require("node:fs");
    const [log, pidFile, command, ...args] = process.argv.slice(1);
    const out = fs.openSync(log, "a");
    const child = spawn(command, args, { detached: true, stdio: ["ignore", out, out] });
    fs.writeFileSync(pidFile, String(child.pid));
    child.unref();
  ' "$@"
}

# Waits up to 30 seconds for a check to pass while the process runs.
wait_for() {
  i=0
  while [ $i -lt 30 ]; do
    eval "$2" && return 0
    running "$1" || return 1
    i=$((i + 1)); sleep 1
  done
  return 1
}

start_app() {
  running "$APP_PID" && return 0
  (cd "$DIR/app" && export NODE_ENV=production && detach "$LOG" "$APP_PID" "$DIR/node/bin/node" "--env-file=$ENV_FILE" server/dist/index.js) || return 1
  wait_for "$APP_PID" 'curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1' && return 0
  echo "Crafty Accounting didn't start. The end of $LOG:" >&2
  tail -n 20 "$LOG" >&2
  return 1
}

start_caddy() {
  running "$CADDY_PID" && return 0
  [ -x "$DIR/caddy/caddy" ] || { echo "Caddy isn't installed. Run: $DIR/crafty update" >&2; return 1; }
  (
    # Caddy reads these in the Caddyfile; its certificates are kept in caddy/data.
    # Off port 443, each address carries the port, or Caddy's http->https redirect leaves it out.
    site="$(setting SITE_ADDRESS)"
    if [ "$HTTPS_PORT" != 443 ]; then
      site="$(printf '%s' "$site" | tr ',' '\n' | awk -v p="$HTTPS_PORT" 'NF { a = $1; if (a !~ /:[0-9]+$/) a = a ":" p; out = out (out ? ", " : "") a } END { print out }')"
    fi
    export SITE_ADDRESS="$site" SITE_IP="$(setting SITE_IP)" TLS_ISSUER="$(setting TLS_ISSUER)"
    export CADDY_HTTP_PORT="$(setting HTTP_PORT)" CRAFTY_OTHER_ADDRESSES="https://:$HTTPS_PORT" CRAFTY_UPSTREAM="127.0.0.1:$PORT"
    export CRAFTY_ENV_PLACE="at $ENV_FILE" CRAFTY_APPLY="$DIR/crafty restart"
    export XDG_DATA_HOME="$DIR/caddy/data" XDG_CONFIG_HOME="$DIR/caddy/config"
    detach "$CADDY_LOG" "$CADDY_PID" "$DIR/caddy/caddy" run --config "$DIR/app/Caddyfile" --adapter caddyfile
  ) || return 1
  # Any answer at all over HTTPS means Caddy is serving (the certificate isn't checked).
  wait_for "$CADDY_PID" '[ "$(curl -sk -o /dev/null -w "%{http_code}" "https://localhost:$HTTPS_PORT/api/health" 2>/dev/null)" != 000 ]' && return 0
  echo "Caddy (HTTPS) didn't start. The end of $CADDY_LOG:" >&2
  tail -n 20 "$CADDY_LOG" >&2
  return 1
}

start() {
  mkdir -p "$DIR/logs"
  if running "$APP_PID" && { [ "$HTTPS" != true ] || running "$CADDY_PID"; }; then
    echo "Crafty Accounting is already running at $URL"; return 0
  fi
  if start_app && { [ "$HTTPS" != true ] || start_caddy; }; then
    echo "Crafty Accounting is running at $URL"; return 0
  fi
  stop >/dev/null
  return 1
}

stop_one() {
  running "$1" || { rm -f "$1"; return 1; }
  pid="$(cat "$1")"
  kill "$pid"
  i=0
  while kill -0 "$pid" 2>/dev/null && [ $i -lt 20 ]; do i=$((i + 1)); sleep 0.5; done
  kill -0 "$pid" 2>/dev/null && kill -9 "$pid"
  rm -f "$1"
}

stop() {
  # Caddy too, even if HTTPS has just been switched off.
  stop_one "$CADDY_PID"
  if stop_one "$APP_PID"; then echo "Crafty Accounting stopped."; else echo "Crafty Accounting isn't running."; fi
}

status() {
  if ! running "$APP_PID"; then echo "Not running."; return 1; fi
  if [ "$HTTPS" = true ] && ! running "$CADDY_PID"; then
    echo "The app is running (process $(cat "$APP_PID")) but Caddy, for HTTPS, isn't. Run: $DIR/crafty restart"; return 1
  fi
  echo "Running (process $(cat "$APP_PID")) at $URL"
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  restart) stop && start ;;
  status) status || exit 1 ;;
  log) if [ "$HTTPS" = true ]; then tail -n 50 -f "$LOG" "$CADDY_LOG"; else tail -n 50 -f "$LOG"; fi ;;
  update)
    # A copy of the installer that came with the app, since the update replaces the app.
    cp "$DIR/app/install.sh" "$DIR/.install.sh" || exit 1
    CRAFTY_DIR="$DIR" exec /bin/bash "$DIR/.install.sh" ;;
  *) echo "Usage: $0 start | stop | restart | status | log | update" >&2; exit 2 ;;
esac
EOF
chmod +x "$DIR/crafty.new"
mv "$DIR/crafty.new" "$DIR/crafty"

# ---- Swap in the new build and start it ----
step "Starting the app"
"$DIR/crafty" stop >/dev/null
port_free "$PORT" || fail "port $PORT is already in use by another program. Set PORT in $ENV_FILE to a free port (or give CRAFTY_PORT on a new install) and run this again."
rm -rf app.old
[ -d app ] && mv app app.old
mv app.new app
rm -rf app.old
if [ "$HTTPS" = true ]; then
  "$DIR/crafty" start >/dev/null || fail "the app didn't start (see above). The logs are in $DIR/logs."
else
  "$DIR/crafty" start >/dev/null || fail "the app didn't start. See $DIR/logs/crafty.log."
fi

# Caddy's private certificate authority, for devices to trust.
CERT=""
if [ "$HTTPS" = true ] && [ "$(env_value TLS_ISSUER)" = internal ] && [ -f caddy/data/caddy/pki/authorities/local/root.crt ]; then
  cp caddy/data/caddy/pki/authorities/local/root.crt "$DIR/crafty-root.crt"
  CERT="$DIR/crafty-root.crt"
fi

# ---- How to connect ----
printf '\n%s%sCrafty Accounting is running.%s\n\n' "$bold" "$green" "$reset"
echo "Open it in a web browser:"
label="On this computer:     "
if [ "$HTTPS" = true ]; then
  port_suffix=""
  [ "$HTTPS_PORT" = 443 ] || port_suffix=":$HTTPS_PORT"
  for addr in $(env_value SITE_ADDRESS | tr ',' ' '); do
    echo "  $label  https://$addr$port_suffix"
    case "$label" in On*) label="Other devices at home:" ;; *) label="                      " ;; esac
  done
else
  echo "  $label  http://localhost:$PORT"
  label="Other devices at home:"
  if [ -n "$HOST_NAME" ]; then echo "  $label  http://$HOST_NAME.local:$PORT"; label="                      "; fi
  if [ -n "$LAN_IP" ]; then echo "  $label  http://$LAN_IP:$PORT"; fi
fi
echo
if [ "$NEW_INSTALL" = 1 ]; then
  echo "Sign in with:"
  echo "  Username:  Admin"
  echo "  Password:  admin"
  echo
  echo "You'll be asked to choose your own password straight away."
else
  echo "Sign in with your existing username and password."
fi
if [ -n "$CERT" ]; then
  echo
  echo "The certificate is private to this install, so browsers warn about it until"
  echo "each device trusts it once. The certificate is $CERT"
  if [ "$OS" = darwin ]; then
    echo "To trust it on this Mac (asks for your password):"
    echo "  sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain \"$CERT\""
  fi
  echo "For other devices, see \"HTTPS\" in the README."
fi
echo
echo "It keeps running after you close this window, until you stop it or restart"
echo "the computer. It doesn't start by itself; after a restart, run:"
echo "  $DIR/crafty start"
echo
echo "  Stop / restart:  $DIR/crafty stop   (or restart, status, log)"
echo "  Update:          $DIR/crafty update"
echo "  Settings:        $ENV_FILE"
echo "  Your books:      $DIR/data (daily backups in data/backups)"
if [ "$HTTPS" = true ]; then listener="caddy"; ports="$(env_value HTTP_PORT) $HTTPS_PORT"; else listener="node"; ports="$PORT"; fi
if [ "$OS" = darwin ]; then
  echo
  echo "If macOS asks whether \"$listener\" may accept incoming connections, choose Allow so"
  echo "other devices can reach it."
elif command -v ufw >/dev/null 2>&1; then
  echo
  echo "If other devices can't connect and the ufw firewall is on, allow the ports:"
  for p in $ports; do echo "  sudo ufw allow $p/tcp"; done
fi
