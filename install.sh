#!/bin/bash
# Installs Crafty Accounting on macOS or Linux and starts it, or updates an existing install.
#
#   /bin/bash -c 'read -rsp "GitHub token: " GITHUB_TOKEN && echo && export GITHUB_TOKEN && /bin/bash -c "$(curl -fsSL -H "Authorization: Bearer $GITHUB_TOKEN" https://raw.githubusercontent.com/koder-guy/crafty-accounting/main/install.sh)"'
#
# The repository is private, so it needs a GitHub token that can read it: a
# fine-grained personal access token for koder-guy/crafty-accounting with
# Contents: Read-only. The command above asks for it once and passes it on; run
# any other way, the script asks for it itself unless GITHUB_TOKEN is set. It's
# only used for the downloads and isn't saved. To update, run
# ~/crafty-accounting/crafty update.
#
# Everything goes in ~/crafty-accounting: its own copy of Node 22 (from nodejs.org),
# the app, your settings (.env) and your books (data/). Nothing is installed system
# wide and it needs no administrator password. Running it again updates the app and
# keeps your data and settings. It doesn't make the app start automatically; start
# and stop it with ~/crafty-accounting/crafty.
#
# Needs curl and tar, which macOS and most Linux distributions have.
#
# Optional settings, given as environment variables before the command:
#   CRAFTY_DIR             where to install (default ~/crafty-accounting)
#   CRAFTY_PORT            port to serve on (default 3000)
#   CRAFTY_ADMIN_NAME      first person's sign-in name (default Admin)
#   CRAFTY_ADMIN_PASSWORD  their password (default: a random one, printed at the end)
#   CRAFTY_BRANCH          branch or tag to install (default main)
#   CRAFTY_TARBALL         URL of the app's source .tar.gz, instead of GitHub's for CRAFTY_BRANCH
#   GITHUB_TOKEN           token for downloading from the private repository (see above)

set -euo pipefail

BRANCH="${CRAFTY_BRANCH:-main}"
# GitHub's API serves a private repository's source to a token (redirecting to a
# short-lived download link); its public archive URLs don't take one.
TARBALL="${CRAFTY_TARBALL:-https://api.github.com/repos/koder-guy/crafty-accounting/tarball/$BRANCH}"
DIR="${CRAFTY_DIR:-$HOME/crafty-accounting}"
NODE_DIST="https://nodejs.org/dist/latest-v22.x"

bold=$'\033[1m'; green=$'\033[32m'; red=$'\033[31m'; reset=$'\033[0m'
step() { printf '\n%s==> %s%s\n' "$bold" "$1" "$reset"; }
fail() { printf '\n%sError: %s%s\n' "$red" "$1" "$reset" >&2; exit 1; }

[ "$(id -u)" -ne 0 ] || fail "run this as your normal user, not as root or with sudo."
for tool in curl tar; do
  command -v "$tool" >/dev/null 2>&1 || fail "$tool is needed. Install it with your package manager (e.g. sudo apt install $tool) and run this again."
done

# ---- GitHub token, for the private repository ----
# The HTTP status GitHub gives the token for the repository: 200 if it can read it.
token_status() {
  curl -sS -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $1" \
    https://api.github.com/repos/koder-guy/crafty-accounting 2>/dev/null || true
}
if [ -z "${CRAFTY_TARBALL:-}" ]; then
  if [ -n "${GITHUB_TOKEN:-}" ]; then
    status="$(token_status "$GITHUB_TOKEN")"
    [ "$status" = 200 ] || fail "GitHub didn't accept GITHUB_TOKEN for koder-guy/crafty-accounting (HTTP $status). Check it can read the repository and hasn't expired."
  elif (: </dev/tty) 2>/dev/null; then
    echo "The app is in a private GitHub repository. Paste a GitHub token that can read"
    echo "koder-guy/crafty-accounting (it won't be shown) and press Enter."
    for attempt in 1 2 3; do
      printf 'GitHub token: '
      read -rs GITHUB_TOKEN </dev/tty || true
      echo
      [ -n "$GITHUB_TOKEN" ] || continue
      status="$(token_status "$GITHUB_TOKEN")"
      [ "$status" = 200 ] && break
      echo "GitHub didn't accept that token (HTTP $status). Check it can read the repository and hasn't expired."
      GITHUB_TOKEN=""
    done
    [ -n "$GITHUB_TOKEN" ] || fail "no working GitHub token. See \"Quick install\" in the README for how to make one."
  else
    fail "GITHUB_TOKEN isn't set and there's no terminal to ask for it. The repository is private, so the download needs a GitHub token; see the README."
  fi
fi

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

sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1; else shasum -a 256 "$1" | cut -d' ' -f1; fi
}

mkdir -p "$DIR"
cd "$DIR"

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

# ---- The app, built next to the running copy so a failed update leaves it working ----
step "Downloading the app ($BRANCH)"
rm -rf app.new && mkdir app.new
# The token goes only to GitHub's API: curl drops the header when following the redirect.
auth=()
[ -n "${GITHUB_TOKEN:-}" ] && auth=(-H "Authorization: Bearer $GITHUB_TOKEN")
curl -fsSL ${auth[@]+"${auth[@]}"} "$TARBALL" | tar -xz -C app.new --strip-components=1 \
  || fail "couldn't download the app ($BRANCH). Check that GITHUB_TOKEN can read koder-guy/crafty-accounting and hasn't expired."

step "Installing packages (this takes a minute or two)"
# better-sqlite3, esbuild and fsevents ship ready-built binaries. Without
# --ignore-scripts, npm ci compiles better-sqlite3 anyway, which needs a compiler.
(cd app.new && npm ci --ignore-scripts --no-audit --no-fund --loglevel=error) || fail "installing packages failed (see above)."

step "Building the app"
(cd app.new && npm run build --silent >/dev/null) || fail "the build failed (see above)."

# ---- Settings ----
ENV_FILE="$DIR/.env"
NEW_PASSWORD=""
if [ ! -f "$ENV_FILE" ]; then
  step "Writing settings to $ENV_FILE"
  ADMIN_NAME="${CRAFTY_ADMIN_NAME:-Admin}"
  NEW_PASSWORD="${CRAFTY_ADMIN_PASSWORD:-$(od -An -N9 -tx1 /dev/urandom | tr -d ' \n' | sed 's/\(......\)\(......\)/\1-\2-/')}"
  SESSION_SECRET="$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')"
  (umask 077 && cat > "$ENV_FILE" <<EOF
# Written by install.sh. See app/.env.example and the README for every setting.
# Restart the app after changing anything:  $DIR/crafty restart

# The first person to sign in. Used only until someone exists; after that,
# change names and passwords in Settings → People.
ADMIN_NAME=$ADMIN_NAME
ADMIN_PASSWORD=$NEW_PASSWORD
SESSION_SECRET=$SESSION_SECRET

PORT=${CRAFTY_PORT:-3000}
DATA_DIR=$DIR/data
TZ=Europe/London

# Served over plain HTTP on your own network.
COOKIE_SECURE=false
TRUST_PROXY=false

# Making Tax Digital (see "Connecting to HMRC" in the README).
HMRC_CLIENT_ID=
HMRC_CLIENT_SECRET=
HMRC_ENV=sandbox
EOF
  )
else
  echo "Keeping the existing settings in $ENV_FILE."
fi
PORT="$(sed -n 's/^PORT=//p' "$ENV_FILE" | tail -n 1)"; PORT="${PORT:-3000}"
ADMIN_NAME="$(sed -n 's/^ADMIN_NAME=//p' "$ENV_FILE" | tail -n 1)"; ADMIN_NAME="${ADMIN_NAME:-Admin}"

# ---- Start and stop script ----
# Written to a new file and moved into place: `crafty update` is still reading the old one.
cat > "$DIR/crafty.new" <<'EOF'
#!/bin/sh
# Starts and stops Crafty Accounting:  crafty start | stop | restart | status | log | update
DIR="$(cd "$(dirname "$0")" && pwd)"
PID_FILE="$DIR/crafty.pid"
LOG="$DIR/logs/crafty.log"
PORT="$(sed -n 's/^PORT=//p' "$DIR/.env" | tail -n 1)"; PORT="${PORT:-3000}"

running() { [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; }

start() {
  if running; then echo "Crafty Accounting is already running (process $(cat "$PID_FILE"))."; return 0; fi
  mkdir -p "$DIR/logs"
  cd "$DIR/app" || exit 1
  # In a session of its own (detached), so closing the terminal doesn't stop it; nohup isn't enough.
  NODE_ENV=production "$DIR/node/bin/node" -e '
    const { spawn } = require("node:child_process");
    const fs = require("node:fs");
    const [node, envFile, log, pidFile] = process.argv.slice(1);
    const out = fs.openSync(log, "a");
    const child = spawn(node, ["--env-file=" + envFile, "server/dist/index.js"], { detached: true, stdio: ["ignore", out, out] });
    fs.writeFileSync(pidFile, String(child.pid));
    child.unref();
  ' "$DIR/node/bin/node" "$DIR/.env" "$LOG" "$PID_FILE"
  i=0
  while [ $i -lt 30 ]; do
    if curl -fsS "http://localhost:$PORT/api/health" >/dev/null 2>&1; then
      echo "Crafty Accounting is running at http://localhost:$PORT"; return 0
    fi
    running || break
    i=$((i + 1)); sleep 1
  done
  echo "Crafty Accounting didn't start. The end of $LOG:" >&2
  tail -n 20 "$LOG" >&2
  stop >/dev/null
  return 1
}

stop() {
  if ! running; then rm -f "$PID_FILE"; echo "Crafty Accounting isn't running."; return 0; fi
  pid="$(cat "$PID_FILE")"
  kill "$pid"
  i=0
  while kill -0 "$pid" 2>/dev/null && [ $i -lt 20 ]; do i=$((i + 1)); sleep 0.5; done
  kill -0 "$pid" 2>/dev/null && kill -9 "$pid"
  rm -f "$PID_FILE"
  echo "Crafty Accounting stopped."
}

case "${1:-}" in
  start) start ;;
  stop) stop ;;
  restart) stop && start ;;
  status) if running; then echo "Running (process $(cat "$PID_FILE")) at http://localhost:$PORT"; else echo "Not running."; exit 1; fi ;;
  log) tail -n 50 -f "$LOG" ;;
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
port_free() { node -e "require('net').createServer().once('error', () => process.exit(1)).listen($PORT, () => process.exit(0))"; }
port_free || fail "port $PORT is already in use by another program. Set PORT in $ENV_FILE to a free port (or give CRAFTY_PORT on a new install) and run this again."
rm -rf app.old
[ -d app ] && mv app app.old
mv app.new app
rm -rf app.old
"$DIR/crafty" start >/dev/null || fail "the app didn't start. See $DIR/logs/crafty.log."

# ---- How to connect ----
if [ "$OS" = darwin ]; then
  HOST_NAME="$(scutil --get LocalHostName 2>/dev/null || true)"
  LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)"
else
  HOST_NAME=""
  LAN_IP="$(hostname -I 2>/dev/null | awk '{ print $1 }' || true)"
  [ -n "$LAN_IP" ] || LAN_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{ for (i = 1; i < NF; i++) if ($i == "src") print $(i + 1) }' || true)"
fi

printf '\n%s%sCrafty Accounting is running.%s\n\n' "$bold" "$green" "$reset"
echo "Open it in a web browser:"
echo "  On this computer:       http://localhost:$PORT"
label="Other devices at home:"
if [ -n "$HOST_NAME" ]; then echo "  $label  http://$HOST_NAME.local:$PORT"; label="                      "; fi
if [ -n "$LAN_IP" ]; then echo "  $label  http://$LAN_IP:$PORT"; fi
echo
if [ -n "$NEW_PASSWORD" ]; then
  echo "Sign in with:"
  echo "  Name:      $ADMIN_NAME"
  echo "  Password:  $NEW_PASSWORD"
  echo
  echo "Change the password in Settings → People after signing in. Until then it's"
  echo "also in $ENV_FILE."
else
  echo "Sign in with your existing name and password."
fi
echo
echo "It keeps running after you close this window, until you stop it or restart"
echo "the computer. It doesn't start by itself; after a restart, run:"
echo "  $DIR/crafty start"
echo
echo "  Stop / restart:  $DIR/crafty stop   (or restart, status, log)"
echo "  Update:          $DIR/crafty update   (asks for the GitHub token)"
echo "  Your books:      $DIR/data (daily backups in data/backups)"
if [ "$OS" = darwin ]; then
  echo
  echo "If macOS asks whether \"node\" may accept incoming connections, choose Allow so"
  echo "other devices can reach it."
elif command -v ufw >/dev/null 2>&1; then
  echo
  echo "If other devices can't connect and the ufw firewall is on, allow the port:"
  echo "  sudo ufw allow $PORT/tcp"
fi
