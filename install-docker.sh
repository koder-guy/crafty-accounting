#!/bin/bash
# Installs Crafty Accounting with Docker Compose (the app plus Caddy for HTTPS) on
# macOS or Linux and starts it, or updates an existing install.
#
#   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/koder-guy/crafty-accounting/main/install-docker.sh)"
#
# To update, run ~/crafty-accounting/install-docker.sh again.
#
# Needs Docker with Compose: Docker Desktop (or OrbStack) on a Mac. On Linux it
# offers to install Docker with Docker's own script (get.docker.com) if it's missing.
# The source, settings (.env) and automatic backups (backups/) go in
# ~/crafty-accounting, the same folder install.sh uses, so only one of the two can
# be there; the books are in the crafty-data Docker volume. An install in the old
# folder, ~/crafty-accounting-docker, is moved there.
# Docker restarts the containers when Docker itself starts (restart: unless-stopped
# in docker-compose.yml).
#
# Optional settings, given as environment variables before the command:
#   CRAFTY_DIR             where to install (default ~/crafty-accounting)
#   CRAFTY_HTTP_PORT       HTTP port (default 80, or 8080 if 80 is taken)
#   CRAFTY_HTTPS_PORT      HTTPS port (default 443, or 8443 if 443 is taken)
#   CRAFTY_ADMIN_NAME      first person's sign-in name (default Admin)
#   CRAFTY_ADMIN_PASSWORD  their password (default: a random one, printed at the end)
#   CRAFTY_BRANCH          branch or tag to install (default main)
#   CRAFTY_TARBALL         URL of the app's source .tar.gz, instead of GitHub's for CRAFTY_BRANCH
#   CRAFTY_PROJECT         Docker Compose project name (default crafty-accounting)
#   CRAFTY_REPO            GitHub repository to install from (default koder-guy/crafty-accounting)

set -euo pipefail

# Everything is in main, so bash has read the whole script before an update
# replaces this file.
main() {
  local REPO="${CRAFTY_REPO:-koder-guy/crafty-accounting}"
  local BRANCH="${CRAFTY_BRANCH:-main}"
  local TARBALL="${CRAFTY_TARBALL:-https://github.com/$REPO/archive/$BRANCH.tar.gz}"
  local NEW_DIR="$HOME/crafty-accounting" OLD_DIR="$HOME/crafty-accounting-docker" MOVE_FROM=""
  # Run as an install's own install-docker.sh (to update it), that install is the default.
  local default_dir="$NEW_DIR" here
  if [ -f "${BASH_SOURCE[0]:-}" ]; then
    here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    is_docker_install "$here" && default_dir="$here"
  fi
  local DIR="${CRAFTY_DIR:-$default_dir}"
  # Installs used to go in ~/crafty-accounting-docker: move one to the new folder if that's free.
  if [ -z "${CRAFTY_DIR:-}" ] && { [ "$DIR" = "$NEW_DIR" ] || [ "$DIR" = "$OLD_DIR" ]; } \
    && is_docker_install "$OLD_DIR" && ! is_docker_install "$NEW_DIR"; then
    if [ -z "$(ls -A "$NEW_DIR" 2>/dev/null)" ]; then
      MOVE_FROM="$OLD_DIR"
      DIR="$NEW_DIR"
    else
      DIR="$OLD_DIR"
      echo "$NEW_DIR is already in use, so updating the install in $OLD_DIR where it is."
    fi
  fi

  bold=$'\033[1m'; green=$'\033[32m'; red=$'\033[31m'; reset=$'\033[0m'

  [ "$(id -u)" -ne 0 ] || fail "run this as your normal user, not as root or with sudo."
  for tool in curl tar; do
    command -v "$tool" >/dev/null 2>&1 || fail "$tool is needed. Install it with your package manager (e.g. sudo apt install $tool) and run this again."
  done
  case "$(uname -s)" in
    Darwin) OS=darwin ;;
    Linux) OS=linux ;;
    *) fail "this installer is for macOS and Linux." ;;
  esac

  # install.sh uses the same folder by default, laid out differently.
  if [ -x "$DIR/crafty" ] && [ -d "$DIR/app" ] && ! is_docker_install "$DIR"; then
    fail "$DIR has the install made without Docker (install.sh). Update that with $DIR/crafty update, or put this one somewhere else with CRAFTY_DIR."
  fi

  check_docker

  if [ -n "$MOVE_FROM" ]; then
    step "Moving the install from $MOVE_FROM to $DIR"
    # The books stay in their Docker volumes; only the containers go, and they're recreated below.
    (cd "$MOVE_FROM" && compose down) || fail "couldn't stop the containers in $MOVE_FROM (see above)."
    rmdir "$DIR" 2>/dev/null || true
    mv "$MOVE_FROM" "$DIR" || fail "couldn't move $MOVE_FROM to $DIR."
    sed -i.bak "s|cd $MOVE_FROM \&\&|cd $DIR \&\&|" "$DIR/.env" && rm -f "$DIR/.env.bak"
  fi

  # ---- The app's source ----
  step "Downloading the app ($BRANCH)"
  mkdir -p "$DIR"
  local src
  src="$(mktemp -d)"
  curl -fsSL "$TARBALL" | tar -xz -C "$src" --strip-components=1 \
    || { rm -rf "$src"; fail "couldn't download the app ($BRANCH) from $TARBALL."; }
  cp -R "$src/." "$DIR/"
  rm -rf "$src"
  chmod +x "$DIR/install-docker.sh"
  cd "$DIR"

  # ---- Addresses ----
  local HOST_NAME="" LAN_IP=""
  if [ "$OS" = darwin ]; then
    HOST_NAME="$(scutil --get LocalHostName 2>/dev/null || true)"
    LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)"
  else
    LAN_IP="$(hostname -I 2>/dev/null | awk '{ print $1 }' || true)"
    [ -n "$LAN_IP" ] || LAN_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{ for (i = 1; i < NF; i++) if ($i == "src") print $(i + 1) }' || true)"
  fi

  # ---- Settings ----
  local ENV_FILE="$DIR/.env" NEW_PASSWORD=""
  if [ ! -f "$ENV_FILE" ]; then
    step "Writing settings to $ENV_FILE"
    local http_port="${CRAFTY_HTTP_PORT:-}" https_port="${CRAFTY_HTTPS_PORT:-}"
    if [ -z "$http_port" ]; then
      http_port=80; port_busy 80 && http_port=8080
    fi
    if [ -z "$https_port" ]; then
      https_port=443; port_busy 443 && https_port=8443
    fi
    local site="localhost"
    [ -n "$HOST_NAME" ] && site="$site, $HOST_NAME.local"
    [ -n "$LAN_IP" ] && site="$site, $LAN_IP"
    NEW_PASSWORD="${CRAFTY_ADMIN_PASSWORD:-$(od -An -N9 -tx1 /dev/urandom | tr -d ' \n' | sed 's/\(......\)\(......\)/\1-\2-/')}"
    (umask 077 && cat > "$ENV_FILE" <<EOF
# Written by install-docker.sh. See .env.example and the README for every setting.
# Apply changes with:  cd $DIR && docker compose up -d

COMPOSE_PROJECT_NAME=${CRAFTY_PROJECT:-crafty-accounting}

# The first person to sign in. Used only until someone exists; after that,
# change names and passwords in Settings → People.
ADMIN_NAME=${CRAFTY_ADMIN_NAME:-Admin}
ADMIN_PASSWORD=$NEW_PASSWORD
SESSION_SECRET=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')

# HTTPS: the addresses you browse to, and a private certificate for them (see the
# README). If this computer's IP address changes, update SITE_ADDRESS.
SITE_ADDRESS=$site
TLS_ISSUER=internal
HTTP_PORT=$http_port
HTTPS_PORT=$https_port

MAX_UPLOAD_MB=20
BACKUP_HOST_DIR=./backups
TZ=Europe/London

# Making Tax Digital (see "Connecting to HMRC" in the README).
HMRC_CLIENT_ID=
HMRC_CLIENT_SECRET=
HMRC_ENV=sandbox
EOF
    )
  else
    echo "Keeping the existing settings in $ENV_FILE."
  fi
  local HTTPS_PORT ADMIN_NAME
  HTTPS_PORT="$(env_value HTTPS_PORT)"; HTTPS_PORT="${HTTPS_PORT:-443}"
  ADMIN_NAME="$(env_value ADMIN_NAME)"; ADMIN_NAME="${ADMIN_NAME:-Admin}"

  # ---- Build and start ----
  step "Building the app (the first time takes a few minutes)"
  compose build

  # The app runs as UID 1000 in its container and writes backups to this folder.
  mkdir -p "$DIR/backups"
  if [ "$OS" = linux ] && [ "$(stat -c %u "$DIR/backups")" != 1000 ]; then
    compose run --rm --no-deps --user root --entrypoint chown crafty-accounting 1000:1000 /backups
  fi

  step "Starting the app"
  compose up -d
  printf 'Waiting for the app'
  local i
  for i in $(seq 1 60); do
    if curl -fsSk "https://localhost:$HTTPS_PORT/api/health" >/dev/null 2>&1; then printf ' ready.\n'; break; fi
    printf '.'; sleep 2
  done
  curl -fsSk "https://localhost:$HTTPS_PORT/api/health" >/dev/null 2>&1 \
    || fail "the app didn't answer on https://localhost:$HTTPS_PORT. See: cd $DIR && docker compose logs"

  # Caddy's private certificate authority, for devices to trust.
  local CERT=""
  if [ "$(env_value TLS_ISSUER)" = internal ] \
    && compose cp caddy:/data/caddy/pki/authorities/local/root.crt "$DIR/crafty-root.crt" >/dev/null 2>&1; then
    CERT="$DIR/crafty-root.crt"
  fi

  # ---- How to connect ----
  local port_suffix=""
  [ "$HTTPS_PORT" = 443 ] || port_suffix=":$HTTPS_PORT"
  printf '\n%s%sCrafty Accounting is running.%s\n\n' "$bold" "$green" "$reset"
  echo "Open it in a web browser:"
  local addr label="On this computer:     "
  for addr in $(env_value SITE_ADDRESS | tr ',' ' '); do
    echo "  $label  https://$addr$port_suffix"
    case "$label" in On*) label="Other devices at home:" ;; *) label="                      " ;; esac
  done
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
  cat <<EOF

Docker starts it again whenever Docker itself starts.

  Stop:        cd $DIR && $DOCKER_CMD compose stop
  Start:       cd $DIR && $DOCKER_CMD compose start
  Log:         cd $DIR && $DOCKER_CMD compose logs -f
  Update:      $DIR/install-docker.sh
  Settings:    $ENV_FILE
  Backups:     $DIR/backups (daily); the books are in the crafty-data Docker volume
EOF
  if [ -n "$MOVE_FROM" ]; then
    echo
    echo "The install moved from $MOVE_FROM to $DIR. In a terminal still in the old folder, run: cd $DIR"
  fi
}

step() { printf '\n%s==> %s%s\n' "$bold" "$1" "$reset"; }
fail() { printf '\n%sError: %s%s\n' "$red" "$1" "$reset" >&2; exit 1; }
env_value() { sed -n "s/^$1=//p" "$DIR/.env" | tail -n 1; }
port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
compose() { $DOCKER_CMD compose "$@"; }

# Whether a folder holds an install made by this script.
is_docker_install() { grep -qs '^# Written by install-docker.sh' "$1/.env"; }

# Sets DOCKER_CMD to "docker", or "sudo docker" on Linux when this user can't use Docker directly.
check_docker() {
  step "Checking Docker"
  if ! command -v docker >/dev/null 2>&1; then
    if [ "$OS" = darwin ]; then
      fail "Docker isn't installed. Install Docker Desktop (https://www.docker.com/products/docker-desktop/) or OrbStack, start it, and run this again."
    fi
    local answer=""
    if (: </dev/tty) 2>/dev/null; then
      printf 'Docker isn'"'"'t installed. Install it now with Docker'"'"'s own script (get.docker.com, needs sudo)? [y/N] '
      read -r answer </dev/tty || true
    fi
    case "$answer" in
      y | Y | yes | Yes) curl -fsSL https://get.docker.com | sudo sh || fail "Docker didn't install (see above)." ;;
      *) fail "Docker isn't installed. See https://docs.docker.com/engine/install/ and run this again." ;;
    esac
  fi
  if docker info >/dev/null 2>&1; then
    DOCKER_CMD="docker"
  elif [ "$OS" = linux ] && sudo docker info >/dev/null 2>&1; then
    DOCKER_CMD="sudo docker"
    echo "Using sudo for Docker (your user isn't in the docker group)."
  elif [ "$OS" = darwin ]; then
    fail "Docker isn't running. Start Docker Desktop (or OrbStack), wait for it to finish starting, and run this again."
  else
    fail "Docker isn't running. Start it (e.g. sudo systemctl start docker) and run this again."
  fi
  $DOCKER_CMD compose version >/dev/null 2>&1 || fail "Docker Compose isn't installed. See https://docs.docker.com/compose/install/ and run this again."
  echo "$($DOCKER_CMD --version)."
}

main "$@"
