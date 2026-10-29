#!/bin/bash
# Installs Crafty Accounting on a Mac and starts it, or updates an existing install.
#
#   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/koder-guy/crafty-accounting/main/install.sh)"
#
# It installs Homebrew (if missing), Node 22 and git, downloads the app to
# ~/crafty-accounting, builds it and runs it in the background with launchd, so it
# starts again when you sign in to the Mac. Running it again updates the app and
# keeps your data and settings.
#
# Optional settings, given as environment variables before the command:
#   CRAFTY_DIR             where to install (default ~/crafty-accounting)
#   CRAFTY_PORT            port to serve on (default 3000)
#   CRAFTY_ADMIN_NAME      first person's sign-in name (default Admin)
#   CRAFTY_ADMIN_PASSWORD  their password (default: a random one, printed at the end)
#   CRAFTY_BRANCH          branch or tag to install (default main)
#   CRAFTY_REPO            git URL to install from
#   GITHUB_TOKEN           a GitHub token, needed while the repository is private

set -euo pipefail

REPO="${CRAFTY_REPO:-https://github.com/koder-guy/crafty-accounting.git}"
BRANCH="${CRAFTY_BRANCH:-main}"
DIR="${CRAFTY_DIR:-$HOME/crafty-accounting}"
LABEL="local.crafty-accounting"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"

bold=$'\033[1m'; green=$'\033[32m'; red=$'\033[31m'; reset=$'\033[0m'
step() { printf '\n%s==> %s%s\n' "$bold" "$1" "$reset"; }
fail() { printf '\n%sError: %s%s\n' "$red" "$1" "$reset" >&2; exit 1; }

[ "$(uname -s)" = "Darwin" ] || fail "this installer is for macOS. On Linux, use Docker Compose as described in the README."
[ "$(id -u)" -ne 0 ] || fail "run this as your normal user, not with sudo."

# git with the token, if one was given, for a private repository.
git_auth() {
  if [ -n "${GITHUB_TOKEN:-}" ]; then
    local basic
    basic="$(printf 'x-access-token:%s' "$GITHUB_TOKEN" | base64 | tr -d '\n')"
    git -c "http.https://github.com/.extraheader=Authorization: Basic $basic" "$@"
  else
    git "$@"
  fi
}

# ---- Homebrew ----
step "Checking for Homebrew"
for brew_bin in /opt/homebrew/bin/brew /usr/local/bin/brew; do
  if [ -x "$brew_bin" ]; then eval "$("$brew_bin" shellenv)"; break; fi
done
if ! command -v brew >/dev/null 2>&1; then
  echo "Installing Homebrew (it asks for your Mac password and may install Apple's command line tools)."
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  for brew_bin in /opt/homebrew/bin/brew /usr/local/bin/brew; do
    if [ -x "$brew_bin" ]; then eval "$("$brew_bin" shellenv)"; break; fi
  done
  command -v brew >/dev/null 2>&1 || fail "Homebrew didn't install. See https://brew.sh and run this again."
else
  echo "Homebrew is installed."
fi

# ---- Node 22 and git ----
step "Installing Node 22 and git"
brew list node@22 >/dev/null 2>&1 || brew install node@22
git --version >/dev/null 2>&1 || brew install git
NODE_BIN="$(brew --prefix)/opt/node@22/bin"
export PATH="$NODE_BIN:$PATH"
echo "Node $(node --version), $(git --version)."

# ---- The app ----
if [ -d "$DIR/.git" ]; then
  step "Updating the app in $DIR"
  git_auth -C "$DIR" fetch --depth 1 origin "$BRANCH" || fail "couldn't download the app from GitHub. If the repository is private, set GITHUB_TOKEN."
  git -C "$DIR" checkout -q -B "$BRANCH" FETCH_HEAD
elif [ -e "$DIR" ] && [ -n "$(ls -A "$DIR" 2>/dev/null)" ]; then
  fail "$DIR already exists and isn't an install of the app. Move it away, or choose another folder with CRAFTY_DIR."
else
  step "Downloading the app to $DIR"
  git_auth clone -q --depth 1 --branch "$BRANCH" "$REPO" "$DIR" || fail "couldn't download the app from GitHub. If the repository is private, set GITHUB_TOKEN."
fi
cd "$DIR"

# ---- Settings ----
ENV_FILE="$DIR/.env"
NEW_PASSWORD=""
if [ ! -f "$ENV_FILE" ]; then
  step "Writing settings to $ENV_FILE"
  ADMIN_NAME="${CRAFTY_ADMIN_NAME:-Admin}"
  NEW_PASSWORD="${CRAFTY_ADMIN_PASSWORD:-$(openssl rand -hex 3)-$(openssl rand -hex 3)-$(openssl rand -hex 3)}"
  umask 077
  cat > "$ENV_FILE" <<EOF
# Written by install.sh. See .env.example and the README for every setting.
# Restart the app after changing anything:
#   launchctl kickstart -k gui/\$(id -u)/$LABEL

# The first person to sign in. Used only until someone exists; after that,
# change names and passwords in Settings → People.
ADMIN_NAME=$ADMIN_NAME
ADMIN_PASSWORD=$NEW_PASSWORD
SESSION_SECRET=$(openssl rand -hex 32)

PORT=${CRAFTY_PORT:-3000}
DATA_DIR=$DIR/data
CLIENT_DIST=$DIR/client/dist
TZ=Europe/London

# Served over plain HTTP on your own network.
COOKIE_SECURE=false
TRUST_PROXY=false

# Making Tax Digital (see "Connecting to HMRC" in the README).
HMRC_CLIENT_ID=
HMRC_CLIENT_SECRET=
HMRC_ENV=sandbox
EOF
  umask 022
else
  echo "Keeping the existing settings in $ENV_FILE."
fi
PORT="$(sed -n 's/^PORT=//p' "$ENV_FILE" | tail -n 1)"
PORT="${PORT:-3000}"
ADMIN_NAME="$(sed -n 's/^ADMIN_NAME=//p' "$ENV_FILE" | tail -n 1)"
ADMIN_NAME="${ADMIN_NAME:-Admin}"

# ---- Build ----
step "Installing packages (this takes a minute or two)"
npm ci --no-audit --no-fund --loglevel=error

step "Building the app"
npm run build --silent >/dev/null

# ---- Run in the background ----
step "Starting the app"
launchctl bootout "gui/$(id -u)/$LABEL" >/dev/null 2>&1 || true

# Something else on the port would stop the app starting.
if lsof -nP -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  fail "port $PORT is already in use by another program. Set PORT in $ENV_FILE to a free port (or give CRAFTY_PORT on a new install) and run this again."
fi

mkdir -p "$DIR/logs" "$(dirname "$PLIST")"
cat > "$PLIST" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE_BIN/node</string>
    <string>--env-file=$ENV_FILE</string>
    <string>$DIR/server/dist/index.js</string>
  </array>
  <key>WorkingDirectory</key><string>$DIR</string>
  <key>EnvironmentVariables</key>
  <dict><key>NODE_ENV</key><string>production</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>$DIR/logs/crafty.log</string>
  <key>StandardErrorPath</key><string>$DIR/logs/crafty.log</string>
</dict>
</plist>
EOF

# launchd can take a moment to let go of the old copy.
for _ in 1 2 3 4 5; do
  launchctl bootstrap "gui/$(id -u)" "$PLIST" 2>/dev/null && break
  sleep 1
done

printf 'Waiting for the app'
for _ in $(seq 1 30); do
  if curl -fsS "http://localhost:$PORT/api/health" >/dev/null 2>&1; then
    printf ' ready.\n'
    break
  fi
  printf '.'
  sleep 1
done
curl -fsS "http://localhost:$PORT/api/health" >/dev/null 2>&1 \
  || fail "the app didn't start. The last lines of $DIR/logs/crafty.log:
$(tail -n 20 "$DIR/logs/crafty.log" 2>/dev/null)"

# ---- How to connect ----
HOST_NAME="$(scutil --get LocalHostName 2>/dev/null || true)"
LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)"

printf '\n%s%sCrafty Accounting is running.%s\n\n' "$bold" "$green" "$reset"
echo "Open it in a web browser:"
echo "  On this Mac:            http://localhost:$PORT"
[ -n "$HOST_NAME" ] && echo "  Other devices at home:  http://$HOST_NAME.local:$PORT"
[ -n "$LAN_IP" ] && echo "                          http://$LAN_IP:$PORT"
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
cat <<EOF

The app starts by itself when you sign in to this Mac. Your books are in
$DIR/data, with daily backups in $DIR/data/backups.
If macOS asks whether "node" may accept incoming connections, choose Allow so
other devices can reach it.

  Update:     run the same install command again
  Restart:    launchctl kickstart -k gui/\$(id -u)/$LABEL
  Stop:       launchctl bootout gui/\$(id -u)/$LABEL
  Start:      launchctl bootstrap gui/\$(id -u) $PLIST
  Log:        $DIR/logs/crafty.log
EOF
