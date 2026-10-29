#!/bin/bash
# Installs Crafty Accounting with Docker Compose (the app plus Caddy for HTTPS) on
# macOS or Linux and starts it, or updates an existing install.
#
#   /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/koder-guy/crafty-accounting/main/install-docker.sh)"
#
# The repository is public, so no token is needed. Should it be made private
# again, the script asks for a GitHub token that can read it (a fine-grained
# personal access token with Contents: Read-only) unless GITHUB_TOKEN is set; the
# token is only used for the downloads and isn't saved. To update, run
# ~/crafty-accounting-docker/install-docker.sh again.
#
# Needs Docker with Compose: Docker Desktop (or OrbStack) on a Mac. On Linux it
# offers to install Docker with Docker's own script (get.docker.com) if it's missing.
# The source, settings (.env) and automatic backups (backups/) go in
# ~/crafty-accounting-docker; the books are in the crafty-data Docker volume.
# Docker restarts the containers when Docker itself starts (restart: unless-stopped
# in docker-compose.yml).
#
# Optional settings, given as environment variables before the command:
#   CRAFTY_DIR             where to install (default ~/crafty-accounting-docker)
#   CRAFTY_HTTP_PORT       HTTP port (default 80, or 8080 if 80 is taken)
#   CRAFTY_HTTPS_PORT      HTTPS port (default 443, or 8443 if 443 is taken)
#   CRAFTY_ADMIN_NAME      first person's sign-in name (default Admin)
#   CRAFTY_ADMIN_PASSWORD  their password (default: a random one, printed at the end)
#   CRAFTY_BRANCH          branch or tag to install (default main)
#   CRAFTY_TARBALL         URL of the app's source .tar.gz, instead of GitHub's for CRAFTY_BRANCH
#   CRAFTY_PROJECT         Docker Compose project name (default crafty-accounting)
#   CRAFTY_REPO            GitHub repository to install from (default koder-guy/crafty-accounting)
#   GITHUB_TOKEN           token for downloading from the private repository (see above)

set -euo pipefail

# Everything is in main, so bash has read the whole script before an update
# replaces this file.
main() {
  local REPO="${CRAFTY_REPO:-koder-guy/crafty-accounting}"
  local BRANCH="${CRAFTY_BRANCH:-main}"
  # GitHub's API serves a private repository's source to a token (redirecting to a
  # short-lived download link); its public archive URLs don't take one.
  local TARBALL="${CRAFTY_TARBALL:-https://api.github.com/repos/$REPO/tarball/$BRANCH}"
  # Run as an install's own install-docker.sh (to update it), that install is the default.
  local default_dir="$HOME/crafty-accounting-docker" here
  if [ -f "${BASH_SOURCE[0]:-}" ]; then
    here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    grep -qs '^# Written by install-docker.sh' "$here/.env" && default_dir="$here"
  fi
  local DIR="${CRAFTY_DIR:-$default_dir}"

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

  get_token
  check_docker

  # ---- The app's source ----
  step "Downloading the app ($BRANCH)"
  mkdir -p "$DIR"
  local src
  src="$(mktemp -d)"
  local auth=()
  [ -n "${GITHUB_TOKEN:-}" ] && auth=(-H "Authorization: Bearer $GITHUB_TOKEN")
  # The token goes only to GitHub's API: curl drops the header when following the redirect.
  curl -fsSL ${auth[@]+"${auth[@]}"} "$TARBALL" | tar -xz -C "$src" --strip-components=1 \
    || { rm -rf "$src"; fail "couldn't download the app ($BRANCH). Check that GITHUB_TOKEN can read $REPO and hasn't expired."; }
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
}

step() { printf '\n%s==> %s%s\n' "$bold" "$1" "$reset"; }
fail() { printf '\n%sError: %s%s\n' "$red" "$1" "$reset" >&2; exit 1; }
env_value() { sed -n "s/^$1=//p" "$DIR/.env" | tail -n 1; }
port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
compose() { $DOCKER_CMD compose "$@"; }

# The HTTP status GitHub gives for reading the repository, with the token if one
# is given: 200 if it can.
repo_status() {
  local auth=()
  [ -n "${1:-}" ] && auth=(-H "Authorization: Bearer $1")
  curl -sS -o /dev/null -w '%{http_code}' ${auth[@]+"${auth[@]}"} "https://api.github.com/repos/$REPO" 2>/dev/null || true
}

get_token() {
  [ -z "${CRAFTY_TARBALL:-}" ] || return 0
  local status
  if [ -n "${GITHUB_TOKEN:-}" ]; then
    status="$(repo_status "$GITHUB_TOKEN")"
    if [ "$status" != 200 ]; then
      [ "$(repo_status)" = 200 ] || fail "GitHub didn't accept GITHUB_TOKEN for $REPO (HTTP $status). Check it can read the repository and hasn't expired."
      echo "GitHub didn't accept GITHUB_TOKEN, but $REPO is public, so carrying on without it."
      GITHUB_TOKEN=""
    fi
  elif [ "$(repo_status)" = 200 ]; then
    : # A public repository: no token needed.
  elif (: </dev/tty) 2>/dev/null; then
    echo "The app is in a private GitHub repository. Paste a GitHub token that can read"
    echo "$REPO (it won't be shown) and press Enter."
    local attempt
    for attempt in 1 2 3; do
      printf 'GitHub token: '
      read -rs GITHUB_TOKEN </dev/tty || true
      echo
      [ -n "$GITHUB_TOKEN" ] || continue
      status="$(repo_status "$GITHUB_TOKEN")"
      [ "$status" = 200 ] && break
      echo "GitHub didn't accept that token (HTTP $status). Check it can read the repository and hasn't expired."
      GITHUB_TOKEN=""
    done
    [ -n "$GITHUB_TOKEN" ] || fail "no working GitHub token. Make a fine-grained token for $REPO with Contents: Read-only."
  else
    fail "GITHUB_TOKEN isn't set and there's no terminal to ask for it. The repository is private, so the download needs a GitHub token (fine-grained, Contents: Read-only)."
  fi
}

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
