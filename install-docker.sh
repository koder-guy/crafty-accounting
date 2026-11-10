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
# be there; the books are in the crafty-data Docker volume.
# Docker restarts the containers when Docker itself starts (restart: unless-stopped
# in docker-compose.yml).
#
# Optional settings, given as environment variables before the command:
#   CRAFTY_DIR             where to install (default ~/crafty-accounting)
#   CRAFTY_HTTP_PORT       HTTP port (default 80, or 8080 if 80 is taken)
#   CRAFTY_HTTPS_PORT      HTTPS port (default 443, or 8443 if 443 is taken)
#   CRAFTY_SITE_IP         the IP address you'll browse to, on a new install (default: asked when
#                          this computer's network address and public address differ)
#   CRAFTY_DOMAIN          a domain name to open the app at too, on a new install (default: asked;
#                          it's added to the app's Addresses, in Settings → HTTPS Certificate)
#   CRAFTY_BRANCH          branch or tag to install (default: the latest release)
#   CRAFTY_TARBALL         URL of the app's source .tar.gz, instead of GitHub's for CRAFTY_BRANCH
#   CRAFTY_PROJECT         Docker Compose project name (default crafty-accounting)
#   CRAFTY_REPO            GitHub repository to install from (default koder-guy/crafty-accounting)

set -euo pipefail

# Everything is in main, so bash has read the whole script before an update
# replaces this file.
main() {
  local REPO="${CRAFTY_REPO:-koder-guy/crafty-accounting}"
  # Run as an install's own install-docker.sh (to update it), that install is the default.
  local default_dir="$HOME/crafty-accounting" here
  if [ -f "${BASH_SOURCE[0]:-}" ]; then
    here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
    is_docker_install "$here" && default_dir="$here"
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

  # install.sh uses the same folder by default, laid out differently.
  if [ -x "$DIR/crafty" ] && [ -d "$DIR/app" ] && ! is_docker_install "$DIR"; then
    fail "$DIR has the install made without Docker (install.sh). Update that with $DIR/crafty update, or put this one somewhere else with CRAFTY_DIR."
  fi

  check_docker

  # ---- The app's source ----
  local BRANCH TARBALL
  if [ -n "${CRAFTY_BRANCH:-}" ]; then BRANCH="$CRAFTY_BRANCH"; elif [ -n "${CRAFTY_TARBALL:-}" ]; then BRANCH="from $CRAFTY_TARBALL"; else BRANCH="$(latest_release "$REPO")"; fi
  TARBALL="${CRAFTY_TARBALL:-https://github.com/$REPO/archive/$BRANCH.tar.gz}"
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
  local HOST_NAME="" LAN_IP="" DOMAIN_NAME=""
  if [ "$OS" = darwin ]; then
    HOST_NAME="$(scutil --get LocalHostName 2>/dev/null || true)"
    LAN_IP="$(ipconfig getifaddr en0 2>/dev/null || ipconfig getifaddr en1 2>/dev/null || true)"
  else
    LAN_IP="$(hostname -I 2>/dev/null | awk '{ print $1 }' || true)"
    [ -n "$LAN_IP" ] || LAN_IP="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{ for (i = 1; i < NF; i++) if ($i == "src") print $(i + 1) }' || true)"
  fi
  # This computer's address on its own network, whichever address is chosen below to browse to.
  local NETWORK_IP="$LAN_IP"

  # ---- Settings ----
  local ENV_FILE="$DIR/.env" NEW_INSTALL=0
  if [ ! -f "$ENV_FILE" ]; then
    step "Writing settings to $ENV_FILE"
    local http_port="${CRAFTY_HTTP_PORT:-}" https_port="${CRAFTY_HTTPS_PORT:-}"
    if [ -z "$http_port" ]; then
      http_port=80; port_busy 80 && http_port=8080
    fi
    if [ -z "$https_port" ]; then
      https_port=443; port_busy 443 && https_port=8443
    fi
    if [ -n "${CRAFTY_SITE_IP:-}" ]; then LAN_IP="$CRAFTY_SITE_IP"; else LAN_IP="$(choose_site_ip "$LAN_IP")"; fi
    DOMAIN_NAME="$(ask_domain)"
    local site="localhost"
    [ -n "$HOST_NAME" ] && site="$site, $HOST_NAME.local"
    [ -n "$LAN_IP" ] && site="$site, $LAN_IP"
    NEW_INSTALL=1
    (umask 077 && cat > "$ENV_FILE" <<EOF
# Written by install-docker.sh. See "Configuration" in the README for every setting.
# Apply changes with:  cd $DIR && docker compose up -d

COMPOSE_PROJECT_NAME=${CRAFTY_PROJECT:-crafty-accounting}

SESSION_SECRET=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')

# HTTPS: the addresses you browse to, and a private certificate for them (see the
# README). If this computer's IP address changes, update SITE_ADDRESS.
SITE_ADDRESS=$site
SITE_IP=${LAN_IP:-localhost}
HTTP_PORT=$http_port
HTTPS_PORT=$https_port

MAX_UPLOAD_MB=20
BACKUP_HOST_DIR=./backups
TZ=Europe/London

# This folder, so Settings -> Updates can show the command that updates it.
CRAFTY_DIR=$DIR
EOF
    )
    if [ -n "$DOMAIN_NAME" ]; then
      printf '\n# Added to the app'"'"'s Addresses (Settings -> HTTPS Certificate) when it first starts; change them there.\nCRAFTY_ADDRESSES=%s\n' "$DOMAIN_NAME" >> "$ENV_FILE"
    fi
  else
    echo "Keeping the existing settings in $ENV_FILE."
    # Installs from before Settings -> Updates.
    if ! grep -q '^CRAFTY_DIR=' "$ENV_FILE"; then
      printf '\n# This folder, so Settings -> Updates can show the command that updates it.\nCRAFTY_DIR=%s\n' "$DIR" >> "$ENV_FILE"
    fi
    # Installs from before SITE_IP: browsing by IP address failed the TLS handshake.
    if ! grep -q '^SITE_IP=' "$ENV_FILE"; then
      local site_ip
      site_ip="$(env_value SITE_ADDRESS | tr ',' '\n' | tr -d ' ' | grep -E '^[0-9]+(\.[0-9]+){3}$' | head -n 1 || true)"
      if [ -n "$site_ip" ]; then
        printf '\n# The IP address in SITE_ADDRESS that browsers use.\nSITE_IP=%s\n' "$site_ip" >> "$ENV_FILE"
        echo "Added SITE_IP=$site_ip, so browsing to https://$site_ip works."
      fi
    fi
    # A domain with a Let's Encrypt certificate was set in .env up to 1.10.72 (TLS_ISSUER, then
    # TLS_MODE, DOMAIN and CLOUDFLARE_API_TOKEN); it's set up in the app now.
    local old_domain=""
    case "$(env_value TLS_MODE)" in letsencrypt | cloudflare) old_domain="$(env_value DOMAIN)" ;; esac
    case "$(env_value TLS_ISSUER)" in "" | internal) ;; *) old_domain="$(env_value SITE_ADDRESS)" ;; esac
    local name
    for name in TLS_ISSUER TLS_MODE DOMAIN CLOUDFLARE_API_TOKEN; do delete_env "$name"; done
    if [ -n "$old_domain" ]; then
      echo "A domain with a Let's Encrypt certificate ($old_domain) is now set up in the app, in"
      echo "Settings → HTTPS Certificate, using Cloudflare's DNS. Its settings in .env have been"
      echo "removed; enter the domain and API token there again."
    fi
  fi
  ensure_network_ip "$NETWORK_IP"
  local HTTPS_PORT
  HTTPS_PORT="$(env_value HTTPS_PORT)"; HTTPS_PORT="${HTTPS_PORT:-443}"

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
  local names
  names="$(served_names "$(env_value SITE_ADDRESS)" "$NETWORK_IP")"
  local i
  for i in $(seq 1 60); do
    if https_here "$HTTPS_PORT" "$names" /api/health -fsSk --max-time 5 >/dev/null; then printf ' ready.\n'; break; fi
    printf '.'; sleep 2
  done
  https_here "$HTTPS_PORT" "$names" /api/health -fsSk --max-time 5 >/dev/null \
    || fail "the app didn't answer over HTTPS on port $HTTPS_PORT. See: cd $DIR && docker compose logs"
  # The app adds the domain to its Addresses as it starts, after Caddy has read their folder.
  if [ -n "$DOMAIN_NAME" ]; then
    compose restart caddy >/dev/null
    for i in $(seq 1 30); do
      https_here "$HTTPS_PORT" "$names" /api/health -fsSk --max-time 5 >/dev/null && break
      sleep 1
    done
  fi

  # A domain on Cloudflare set up in Settings → HTTPS Certificate: the site block the app writes for Caddy.
  local DOMAIN
  DOMAIN="$(compose exec -T caddy sed -n '/^[^#[:space:]].* {$/{s/ {$//p;q;}' /tls/domain.caddy 2>/dev/null || true)"

  # Caddy's private certificate authority, for devices to trust, unless a certificate of
  # your own is in use for SITE_ADDRESS (uploaded in Settings → HTTPS Certificate).
  local CERT="" CUSTOM_CERT=""
  if [ "$(env_value TLS_CUSTOM | tr 'A-Z' 'a-z')" != off ] && compose exec -T caddy test -s /tls/cert.pem >/dev/null 2>&1; then
    CUSTOM_CERT=1
  elif compose cp caddy:/data/caddy/pki/authorities/local/root.crt "$DIR/crafty-root.crt" >/dev/null 2>&1; then
    CERT="$DIR/crafty-root.crt"
  fi

  # ---- How to connect ----
  local port_suffix=""
  [ "$HTTPS_PORT" = 443 ] || port_suffix=":$HTTPS_PORT"
  printf '\n%s%sCrafty Accounting is running.%s\n\n' "$bold" "$green" "$reset"
  echo "Open it in a web browser:"
  [ -z "$DOMAIN" ] || echo "  With your domain:       https://$DOMAIN$port_suffix"
  [ -z "$DOMAIN_NAME" ] || echo "  At your domain name:    https://$DOMAIN_NAME$port_suffix  (once DNS or your router points it here)"
  local addr label="On this computer:     "
  for addr in $(env_value SITE_ADDRESS | tr ',' ' '); do
    [ -z "$DOMAIN" ] || [ "${addr%%:*}" != "${DOMAIN%%:*}" ] || continue
    echo "  $label  https://$addr$port_suffix"
    case "$label" in On*) label="Other devices at home:" ;; *) label="                      " ;; esac
  done
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
  if [ -n "$DOMAIN" ]; then
    echo
    echo "Your domain's certificate is from Let's Encrypt, which browsers already trust."
    echo "To check it or change it: Settings → HTTPS Certificate in the app."
  fi
  if [ -n "$CUSTOM_CERT" ]; then
    echo
    echo "HTTPS uses the certificate uploaded in Settings → HTTPS Certificate. If browsers"
    echo "can't open the app with it, add TLS_CUSTOM=off to $DIR/.env and run this again."
  fi
  if [ -n "$CERT" ]; then
    echo
    if [ -n "$DOMAIN" ]; then
      echo "The other addresses use a certificate private to this install, so browsers warn"
      echo "about them until each device trusts it once. The certificate is $CERT"
    else
      echo "The certificate is private to this install, so browsers warn about it until"
      echo "each device trusts it once. The certificate is $CERT"
    fi
    if [ "$OS" = darwin ]; then
      echo "To trust it on this Mac (asks for your password):"
      echo "  sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain \"$CERT\""
      local other=""
      cert_served "$HTTPS_PORT" "$CERT" "$(served_names "$(env_value SITE_ADDRESS)" "$NETWORK_IP")" && other="$(other_address "$(env_value SITE_ADDRESS)" "$HTTPS_PORT")"
      [ -n "$other" ] && echo "Other devices can download it from https://$other/crafty-root.crt"
      echo "For other devices, see \"HTTPS\" in the README."
    else
      local other="" show_pem="$NEW_INSTALL"
      cert_served "$HTTPS_PORT" "$CERT" "$(served_names "$(env_value SITE_ADDRESS)" "$NETWORK_IP")" && other="$(other_address "$(env_value SITE_ADDRESS)" "$HTTPS_PORT")"
      [ -n "$other" ] || show_pem=1
      cert_help "$CERT" "$other" "$show_pem"
    fi
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

# The SHA-256 fingerprint of certificate $1, as AB:CD:… (what Keychain Access and openssl show).
cert_fingerprint() {
  local sum="sha256sum"
  command -v sha256sum >/dev/null 2>&1 || sum="shasum -a 256"
  grep -v -- '-----' "$1" | tr -d '\r\n' | base64 -d 2>/dev/null | $sum | cut -d' ' -f1 \
    | tr 'a-f' 'A-F' | sed 's/../&:/g; s/:$//'
}

# The names this computer's Caddy answers HTTPS for, one per line, to check it by: localhost,
# this computer's own address ($2) and each address in SITE_ADDRESS ($1). localhost alone isn't
# enough: SITE_ADDRESS may leave it out, and then Caddy has no certificate for it.
served_names() {
  { printf '%s\n%s\n' localhost "$2"; printf '%s' "$1" | tr ',' '\n'; } \
    | sed 's/^ *//;s/ *$//;s#^[a-z]*://##;s/:[0-9]*$//' | grep . | awk '!seen[$0]++'
}

# Fetches path $3 from Caddy on HTTPS port $1 of this computer, by the first of the names in $2
# that answers (each connecting here, whatever its DNS says), to stdout; curl's options follow.
https_here() {
  local port="$1" names="$2" path="$3" name
  shift 3
  for name in $names; do
    curl "$@" --connect-to "$name:$port:127.0.0.1:$port" "https://$name:$port$path" 2>/dev/null && return 0
  done
  return 1
}

# Whether Caddy, on HTTPS port $1 of this computer, serves certificate $2 at /crafty-root.crt,
# by any of the names in $3. A version whose Caddyfile doesn't would answer with the app's page.
cert_served() {
  https_here "$1" "$3" /crafty-root.crt -fsSk --max-time 10 | cmp -s - "$2"
}

# How to get certificate $1 onto other devices, served by Caddy at https://$2/crafty-root.crt
# ($2 empty when the only address is this computer's own, or Caddy doesn't serve it). When
# $3 = 1 (a new install, or nothing to download it from) it also prints the certificate
# itself, to copy into a file.
cert_help() {
  local cert="$1" addr="$2" show_pem="$3" fp
  fp="$(cert_fingerprint "$cert")"
  echo "Its SHA-256 fingerprint is"
  echo "  $fp"
  if [ -n "$addr" ]; then
    echo
    echo "To trust it on a Mac, paste this into Terminal there. It downloads the certificate,"
    echo "checks the fingerprint, and asks for the Mac's password:"
    echo
    echo "  curl -fsSk https://$addr/crafty-root.crt -o /tmp/crafty-root.crt && openssl x509 -in /tmp/crafty-root.crt -noout -fingerprint -sha256 | grep -q '$fp' && sudo security add-trusted-cert -d -r trustRoot -k /Library/Keychains/System.keychain /tmp/crafty-root.crt && echo Trusted. || echo Not trusted."
    echo
    echo "On other devices, open https://$addr/crafty-root.crt (past the warning) and"
    echo "install it, checking the fingerprint (see \"HTTPS\" in the README)."
  fi
  if [ "$show_pem" = 1 ]; then
    echo
    if [ -n "$addr" ]; then echo "Or copy the certificate from here into a file named crafty-root.crt:"
    else echo "To get it onto another device, copy it from here into a file named crafty-root.crt:"; fi
    echo
    cat "$cert"
  fi
}

# The first address in SITE_ADDRESS ($1) that other devices can use, with the HTTPS port
# ($2) unless it's 443 or the address has one.
other_address() {
  local addr
  for addr in $(printf '%s' "$1" | tr ',' ' '); do
    case "$addr" in localhost | localhost:* | 127.* | ::1 | "[::1]" | "[::1]":*) continue ;; esac
    case "$addr" in *:[0-9]*) echo "$addr" ;; *) if [ "${2:-443}" = 443 ]; then echo "$addr"; else echo "$addr:$2"; fi ;; esac
    return
  done
}

# This computer's public IPv4 address, as Cloudflare sees it (its 1.1.1.1 trace page); empty offline.
public_ip() {
  curl -4 -fsS --max-time 5 https://1.1.1.1/cdn-cgi/trace 2>/dev/null | sed -n 's/^ip=//p' || true
}

# Whether $1 is an IPv4 address.
is_ip() {
  printf '%s' "$1" | grep -Eq '^([0-9]{1,3}\.){3}[0-9]{1,3}$'
}

# Whether $1 is a domain name, such as books.example.co.uk or crafty.local.
is_domain() {
  printf '%s' "$1" | grep -Eq '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]([a-z0-9-]{0,61}[a-z0-9])?$'
}

# On a new install, a domain name to open the app at too (CRAFTY_DOMAIN answers in advance):
# the app adds it to its Addresses (Settings → HTTPS Certificate) when it first starts. Asked on
# the terminal; empty when skipped, or when there's no terminal to ask on.
ask_domain() {
  local answer
  if [ -n "${CRAFTY_DOMAIN:-}" ]; then
    answer="$(printf '%s' "$CRAFTY_DOMAIN" | tr -d ' ' | tr 'A-Z' 'a-z' | sed -E 's#^https?://##;s#/.*$##;s/\.$//')"
    if is_domain "$answer"; then printf '%s' "$answer"; else echo "Ignoring CRAFTY_DOMAIN: \"$CRAFTY_DOMAIN\" isn't a domain name." >&2; fi
    return 0
  fi
  (: </dev/tty) 2>/dev/null || return 0
  {
    echo
    printf '%sA domain name for the app (optional)%s\n' "$bold" "$reset"
    echo "  Such as books.example.co.uk, if you'll point one at this computer in DNS or on your router."
    echo "  Press Enter to skip. Addresses can be added or removed later in Settings → HTTPS Certificate."
  } >/dev/tty
  while :; do
    printf 'Domain name: ' >/dev/tty
    IFS= read -r answer </dev/tty || answer=""
    answer="$(printf '%s' "$answer" | tr -d ' ' | tr 'A-Z' 'a-z' | sed -E 's#^https?://##;s#/.*$##;s/\.$//')"
    [ -n "$answer" ] || return 0
    if is_domain "$answer"; then printf '%s' "$answer"; return 0; fi
    echo "That isn't a domain name, such as books.example.co.uk." >/dev/tty
  done
}

# The address browsers will use for this computer, given its address on its own network ($1).
# That's usually it, but a cloud server has a private address (often 10.x) and is reached by its
# public one, and a server at home can have ports forwarded to it. When the two differ, the
# person is asked (on the terminal), unless there's no terminal to ask on.
choose_site_ip() {
  local lan="$1" public answer
  public="$(public_ip)"
  if [ -z "$public" ] || [ "$public" = "$lan" ] || ! (: </dev/tty) 2>/dev/null; then
    printf '%s' "${lan:-$public}"
    return
  fi
  if [ -z "$lan" ]; then
    printf '%s' "$public"
    return
  fi
  {
    echo
    printf '%sWhich address will you use to connect to the app?%s\n' "$bold" "$reset"
    echo "  1) $lan  - the LAN address"
    echo "  2) $public  - the WAN address"
    echo "  Or type another IPv4 address. (It can be changed later: SITE_ADDRESS and SITE_IP in .env.)"
  } >/dev/tty
  while :; do
    printf 'Choose 1 or 2, or type an address: ' >/dev/tty
    IFS= read -r answer </dev/tty || answer=1
    answer="$(printf '%s' "$answer" | tr -d ' ')"
    case "$answer" in
      1) printf '%s' "$lan"; return ;;
      2) printf '%s' "$public"; return ;;
      *) if [ -n "$answer" ] && is_ip "$answer"; then printf '%s' "$answer"; return; fi ;;
    esac
    echo "That isn't 1, 2 or an IP address." >/dev/tty
  done
}

step() { printf '\n%s==> %s%s\n' "$bold" "$1" "$reset"; }
fail() { printf '\n%sError: %s%s\n' "$red" "$1" "$reset" >&2; exit 1; }
env_value() { sed -n "s/^$1=//p" "$DIR/.env" | tail -n 1; }

# The app always opens at this computer's address on its network ($1), as well as at any domain:
# adds it to SITE_ADDRESS if it isn't there (say, the router handed out another), and makes it
# SITE_IP unless that's an IP address already (browsers send no name for an IP address, so
# Caddy answers those with SITE_IP's certificate). Run on every install and update.
ensure_network_ip() {
  local ip="$1" site
  is_ip "$ip" || return 0
  site="$(env_value SITE_ADDRESS)"
  if ! printf '%s' "$site" | tr ',' '\n' | sed 's/^ *//;s/ *$//;s#^[a-z]*://##;s/:[0-9]*$//' | grep -qxF "$ip"; then
    set_env SITE_ADDRESS "${site:-localhost}, $ip"
    echo "Added $ip to SITE_ADDRESS, so the app opens at this computer's network address too."
  fi
  if ! is_ip "$(env_value SITE_IP)"; then
    set_env SITE_IP "$ip"
    echo "Set SITE_IP to $ip, so browsing to the app by its IP address gets the right certificate."
  fi
}
# Sets KEY=VALUE in .env, replacing the line if it's there (keeping the file's permissions).
set_env() {
  local env_file="$DIR/.env"
  if grep -q "^$1=" "$env_file"; then
    awk -v k="$1" -v v="$2" 'index($0, k "=") == 1 { print k "=" v; next } { print }' "$env_file" > "$env_file.tmp"
    cat "$env_file.tmp" > "$env_file" && rm -f "$env_file.tmp"
  else
    printf '%s=%s\n' "$1" "$2" >> "$env_file"
  fi
}
delete_env() {
  local env_file="$DIR/.env"
  grep -q "^$1=" "$env_file" || return 0
  grep -v "^$1=" "$env_file" > "$env_file.tmp"
  cat "$env_file.tmp" > "$env_file" && rm -f "$env_file.tmp"
}
port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }
compose() { $DOCKER_CMD compose "$@"; }

# The newest release tag (vX.Y.Z) of repository $1, or main if it has none. Installs
# follow releases so the version the app shows is the code it runs.
latest_release() {
  local tags
  tags="$(curl -fsSL -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/$1/tags?per_page=100")" \
    || fail "couldn't find the latest release on GitHub. Run this again, or give CRAFTY_BRANCH (e.g. CRAFTY_BRANCH=main)."
  printf '%s\n' "$tags" | sed -n 's/.*"name": *"\(v[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)".*/\1/p' \
    | sort -t. -k1.2,1n -k2,2n -k3,3n | tail -n 1 | grep . || echo main
}

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
