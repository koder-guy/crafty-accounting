#!/bin/bash
# Installs Crafty Accounting on a Linux server, or updates it. Run it as root:
#
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/koder-guy/crafty-accounting/main/install.sh)"
#
# As root it:
#   - creates the crafty account if it doesn't exist; that account owns and runs everything;
#   - carries on as that account: downloads the latest release, its own Node 22 and Caddy
#     (for HTTPS) into ~crafty/crafty-accounting, builds the app and writes the settings (.env);
#   - sets up two systemd services, started now and on every boot: crafty-accounting (the
#     app, which answers only on this computer) and crafty-caddy (HTTPS on ports 80 and 443,
#     which only Caddy is allowed to use).
# Running it again updates everything and keeps the books and settings.
#
# Run as the crafty account (`~/crafty-accounting/crafty update`, or Settings → Updates in
# the app), it updates the app, Node and Caddy without root and restarts the services.
#
# Needs systemd and glibc (Debian, Ubuntu, Fedora and most others; not Alpine), on Intel/AMD
# or ARM. On a Mac, or a Linux without systemd, use install-docker.sh instead.
#
# Optional settings, given as environment variables before the command:
#   CRAFTY_USER            the account (default crafty)
#   CRAFTY_HTTP_PORT       Caddy's ports (default 80 and 443)
#   CRAFTY_HTTPS_PORT
#   CRAFTY_PORT            port the app listens on behind Caddy, on a new install (default 3000)
#   CRAFTY_SITE_IP         the IP address you'll browse to, on a new install (default: asked when
#                          this computer's network address and public address differ)
#   CRAFTY_BRANCH          branch or tag to install (default: the latest release)
#   CRAFTY_TARBALL         URL of the app's source .tar.gz, instead of GitHub's for CRAFTY_BRANCH
#   CRAFTY_REPO            GitHub repository to install from (default koder-guy/crafty-accounting)

set -euo pipefail

REPO="${CRAFTY_REPO:-koder-guy/crafty-accounting}"
NODE_DIST="https://nodejs.org/dist/latest-v22.x"
CADDY_VERSION="2.11.8"
# Caddy is built with the caddy-dns/cloudflare module (for a domain on Cloudflare) by this
# repository's "Caddy with Cloudflare DNS" workflow, which publishes it as a release when
# either version here changes. Keep Dockerfile.caddy's module version in step.
CADDY_DNS_CLOUDFLARE="0.2.4"
CADDY_RELEASE="caddy-$CADDY_VERSION-cloudflare-$CADDY_DNS_CLOUDFLARE"
CADDY_REPO="koder-guy/crafty-accounting"
# Bump when the service files below change: an update without root then says to rerun as root.
SERVICES_VERSION=1
APP_SERVICE=crafty-accounting
CADDY_SERVICE=crafty-caddy

bold=$'\033[1m'; green=$'\033[32m'; red=$'\033[31m'; reset=$'\033[0m'
step() { printf '\n%s==> %s%s\n' "$bold" "$1" "$reset"; }
fail() { printf '\n%sError: %s%s\n' "$red" "$1" "$reset" >&2; exit 1; }

[ "$(uname -s)" = Linux ] || fail "this installer is for Linux servers. On a Mac, use install-docker.sh (see the README)."
case "$(uname -m)" in
  x86_64 | amd64) ARCH=x64 ;;
  arm64 | aarch64) ARCH=arm64 ;;
  *) fail "Node 22 isn't available for this processor ($(uname -m)). Docker (install-docker.sh, see the README) may work instead." ;;
esac
if ldd --version 2>&1 | grep -qi musl; then
  fail "this Linux uses musl (Alpine?), which nodejs.org has no Node build for. Use install-docker.sh (see the README)."
fi

# The newest release tag (vX.Y.Z), or main if the repository has none. Installs follow
# releases so the version the app shows is the code it runs.
latest_release() {
  local tags
  tags="$(curl -fsSL -H 'Accept: application/vnd.github+json' "https://api.github.com/repos/$REPO/tags?per_page=100")" \
    || fail "couldn't find the latest release on GitHub. Run this again, or give CRAFTY_BRANCH (e.g. CRAFTY_BRANCH=main)."
  # Every tag name, however GitHub lays out its reply (it can come on one line), newest last.
  printf '%s' "$tags" | grep -o '"name": *"v[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*"' \
    | grep -o 'v[0-9][0-9.]*' | sort -V | tail -n 1 | grep . || echo main
}

# The version in an app folder's source, e.g. 1.9.1.
# Empty, not an error, when there's none (a new install).
app_version() { sed -n "s/^export const APP_VERSION = '\(.*\)';/\1/p" "$1/shared/src/index.ts" 2>/dev/null || true; }

sha256() { sha256sum "$1" | cut -d' ' -f1; }
sha512() { sha512sum "$1" | cut -d' ' -f1; }

# Whether something is listening on a local port.
port_busy() { (exec 3<>"/dev/tcp/127.0.0.1/$1") 2>/dev/null; }

# This computer's address on the home network.
lan_ip() {
  local ip
  ip="$(hostname -I 2>/dev/null | awk '{ print $1 }' || true)"
  [ -n "$ip" ] || ip="$(ip -4 route get 1.1.1.1 2>/dev/null | awk '{ for (i = 1; i < NF; i++) if ($i == "src") print $(i + 1) }' || true)"
  printf '%s' "$ip"
}

# This computer's public IPv4 address, as Cloudflare sees it (its 1.1.1.1 trace page); empty offline.
public_ip() {
  curl -4 -fsS --max-time 5 https://1.1.1.1/cdn-cgi/trace 2>/dev/null | sed -n 's/^ip=//p' || true
}

# Whether $1 is an IPv4 address.
is_ip() {
  printf '%s' "$1" | grep -Eq '^([0-9]{1,3}\.){3}[0-9]{1,3}$'
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

# This script's own text, to hand to the crafty account.
this_script() {
  if [ -n "${BASH_EXECUTION_STRING:-}" ]; then
    printf '%s\n' "$BASH_EXECUTION_STRING"
  elif [ -f "${BASH_SOURCE[0]:-}" ]; then
    cat "${BASH_SOURCE[0]}"
  else
    return 1
  fi
}

# Puts the previous build back after a failed start. Fails if there's none.
roll_back() {
  local dir="$1"
  [ -d "$dir/app.old" ] || return 1
  rm -rf "$dir/app.failed"
  mv "$dir/app" "$dir/app.failed" && mv "$dir/app.old" "$dir/app"
}

# =====================================================================================
# As root: the account, then the rest as that account, then the services.
# =====================================================================================
root_main() {
  local user="${CRAFTY_USER:-crafty}"
  [ -d /run/systemd/system ] || fail "this needs systemd, which this Linux isn't running. Use install-docker.sh (see the README)."
  if ! command -v tar >/dev/null 2>&1 || ! command -v curl >/dev/null 2>&1; then
    step "Installing curl and tar"
    if command -v apt-get >/dev/null 2>&1; then apt-get update -qq && apt-get install -y -qq curl tar ca-certificates >/dev/null
    elif command -v dnf >/dev/null 2>&1; then dnf install -y -q curl tar
    elif command -v zypper >/dev/null 2>&1; then zypper -q install -y curl tar
    else fail "curl and tar are needed. Install them with your package manager and run this again."
    fi
  fi

  if ! id -u "$user" >/dev/null 2>&1; then
    step "Creating the $user account"
    useradd --create-home --shell /bin/bash "$user"
    echo "It has no password, so nobody can sign in to it directly. As root, switch to it with: su - $user"
  fi
  local home dir new_install=1
  home="$(getent passwd "$user" | cut -d: -f6)"
  dir="$home/crafty-accounting"
  [ -f "$dir/.env" ] && new_install=0
  # So `crafty log` can read the services' logs.
  if getent group systemd-journal >/dev/null 2>&1; then usermod -aG systemd-journal "$user"; fi
  # The address to browse to, asked here as the account can't use this terminal.
  local site_ip="${CRAFTY_SITE_IP:-}"
  if [ "$new_install" = 1 ] && [ -z "$site_ip" ]; then site_ip="$(choose_site_ip "$(lan_ip)")"; fi

  # The download, build and settings belong to the account, so it does that part itself.
  local script
  script="$(mktemp)"
  this_script > "$script" || { rm -f "$script"; fail "run this with bash -c \"\$(curl -fsSL ...)\" as shown in the README, or as a file; not piped into bash."; }
  chmod 644 "$script"
  step "Continuing as $user"
  if ! runuser -u "$user" -- env -i HOME="$home" USER="$user" LOGNAME="$user" SHELL=/bin/bash \
    PATH=/usr/local/bin:/usr/bin:/bin LANG="${LANG:-C.UTF-8}" TERM="${TERM:-dumb}" \
    CRAFTY_PHASE=user CRAFTY_REPO="$REPO" CRAFTY_BRANCH="${CRAFTY_BRANCH:-}" CRAFTY_TARBALL="${CRAFTY_TARBALL:-}" \
    CRAFTY_HTTP_PORT="${CRAFTY_HTTP_PORT:-}" CRAFTY_HTTPS_PORT="${CRAFTY_HTTPS_PORT:-}" CRAFTY_PORT="${CRAFTY_PORT:-}" \
    CRAFTY_SITE_IP="$site_ip" /bin/bash "$script"; then
    rm -f "$script"
    fail "setting up as $user didn't finish (see above). Anything already running is unchanged."
  fi
  rm -f "$script"

  step "Setting up the services"
  write_services "$user" "$dir"
  systemctl daemon-reload
  systemctl enable "$APP_SERVICE" "$CADDY_SERVICE" >/dev/null 2>&1
  # The ports must be free for Caddy (its own earlier run aside).
  systemctl stop "$CADDY_SERVICE" 2>/dev/null || true
  local env_file="$dir/.env" p
  for p in "$(sed -n 's/^HTTP_PORT=//p' "$env_file" | tail -n 1)" "$(sed -n 's/^HTTPS_PORT=//p' "$env_file" | tail -n 1)"; do
    if port_busy "$p"; then
      fail "port $p is already in use by another program (a web server?). Stop it, or choose other ports with CRAFTY_HTTP_PORT and CRAFTY_HTTPS_PORT, and run this again."
    fi
  done
  if ! "$dir/crafty" restart; then
    roll_back "$dir" && "$dir/crafty" restart >/dev/null 2>&1 \
      && fail "the new version didn't start, so the previous one is running again. See: $dir/crafty log"
    fail "the app didn't start. See: $dir/crafty log"
  fi
  rm -rf "$dir/app.old"

  # Caddy's private certificate authority, for devices to trust (unless a certificate of
  # your own is in use for SITE_ADDRESS, uploaded in Settings → HTTPS Certificate).
  local cert="" ca="$dir/caddy/data/caddy/pki/authorities/local/root.crt"
  if ! custom_cert_in_use "$dir" && [ -f "$ca" ]; then
    cp "$ca" "$dir/crafty-root.crt" && chown "$user": "$dir/crafty-root.crt"
    cert="$dir/crafty-root.crt"
  fi
  summary "$user" "$dir" "$cert" "$new_install"
}

write_services() {
  local user="$1" dir="$2"
  cat > "/etc/systemd/system/$APP_SERVICE.service" <<EOF
# Written by Crafty Accounting's install.sh (services $SERVICES_VERSION). Run the installer again rather than editing.
[Unit]
Description=Crafty Accounting
After=network-online.target
Wants=network-online.target

[Service]
User=$user
WorkingDirectory=$dir
ExecStart=$dir/crafty app
Restart=always
RestartSec=2
# An update from Settings → Updates is started by the app and restarts it, so it must outlive it.
KillMode=process

[Install]
WantedBy=multi-user.target
EOF
  cat > "/etc/systemd/system/$CADDY_SERVICE.service" <<EOF
# Written by Crafty Accounting's install.sh (services $SERVICES_VERSION). Run the installer again rather than editing.
[Unit]
Description=Crafty Accounting HTTPS (Caddy)
After=network-online.target $APP_SERVICE.service
Wants=network-online.target

[Service]
User=$user
WorkingDirectory=$dir
ExecStart=$dir/crafty caddy
Restart=always
RestartSec=2
# Ports 80 and 443, and nothing more.
AmbientCapabilities=CAP_NET_BIND_SERVICE
CapabilityBoundingSet=CAP_NET_BIND_SERVICE
NoNewPrivileges=true

[Install]
WantedBy=multi-user.target
EOF
}

# Whether Caddy in install folder $1 serves a certificate uploaded in Settings → HTTPS Certificate
# (the app writes it to caddy/custom; TLS_CUSTOM=off in .env makes Caddy ignore it).
custom_cert_in_use() {
  [ "$(sed -n 's/^TLS_CUSTOM=//p' "$1/.env" | tail -n 1 | tr 'A-Z' 'a-z')" != off ] \
    && [ -s "$1/caddy/custom/cert.pem" ] && [ -s "$1/caddy/custom/key.pem" ]
}

# The domain on Cloudflare set up in Settings → HTTPS Certificate for the install in folder $1,
# with its port off 443, from the site block the app writes for Caddy; empty if none.
domain_in_use() {
  local custom
  custom="$(sed -n 's/^CRAFTY_TLS_DIR=//p' "$1/.env" | tail -n 1)"
  sed -n '/^[^#[:space:]].* {$/{s/ {$//p;q;}' "${custom:-$1/caddy/custom}/domain.caddy" 2>/dev/null || true
}

# The SHA-256 fingerprint of certificate $1, as AB:CD:… (what Keychain Access and openssl show).
cert_fingerprint() {
  local sum="sha256sum"
  command -v sha256sum >/dev/null 2>&1 || sum="shasum -a 256"
  grep -v -- '-----' "$1" | tr -d '\r\n' | base64 -d 2>/dev/null | $sum | cut -d' ' -f1 \
    | tr 'a-f' 'A-F' | sed 's/../&:/g; s/:$//'
}

# Whether Caddy, on HTTPS port $1 of this computer, serves certificate $2 at /crafty-root.crt.
# A version whose Caddyfile doesn't would answer with the app's page instead.
cert_served() {
  curl -fsSk --max-time 10 "https://localhost:$1/crafty-root.crt" 2>/dev/null | cmp -s - "$2"
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

summary() {
  local user="$1" dir="$2" cert="$3" new_install="$4" env_file="$2/.env" https_port suffix="" label="On this computer:     " addr
  https_port="$(sed -n 's/^HTTPS_PORT=//p' "$env_file" | tail -n 1)"
  [ "${https_port:-443}" = 443 ] || suffix=":$https_port"
  printf '\n%s%sCrafty Accounting is running.%s\n\n' "$bold" "$green" "$reset"
  echo "Open it in a web browser:"
  local domain
  domain="$(domain_in_use "$dir")"
  [ -z "$domain" ] || echo "  With your domain:       https://$domain"
  for addr in $(sed -n 's/^SITE_ADDRESS=//p' "$env_file" | tail -n 1 | tr ',' ' '); do
    [ -z "$domain" ] || [ "${addr%%:*}" != "${domain%%:*}" ] || continue
    echo "  $label  https://$addr$suffix"
    case "$label" in On*) label="Other devices at home:" ;; *) label="                      " ;; esac
  done
  echo
  if [ "$new_install" = 1 ]; then
    echo "Sign in with:"
    echo "  Username:  Admin"
    echo "  Password:  admin"
    echo
    echo "You'll be asked to choose your own password straight away."
  else
    echo "Sign in with your existing username and password."
  fi
  if [ -n "$domain" ]; then
    echo
    echo "Your domain's certificate is from Let's Encrypt, which browsers already trust."
    echo "To check it or change it: Settings → HTTPS Certificate in the app."
  fi
  if custom_cert_in_use "$dir"; then
    echo
    echo "HTTPS uses the certificate uploaded in Settings → HTTPS Certificate. If browsers"
    echo "can't open the app with it, add TLS_CUSTOM=off to $env_file and run $dir/crafty restart."
  fi
  if [ -n "$cert" ]; then
    echo
    if [ -n "$domain" ]; then
      echo "The other addresses use a certificate private to this install, so browsers warn"
      echo "about them until each device trusts it once (see \"HTTPS\" in the README)."
      echo "It's $cert"
    else
      echo "The certificate is private to this install, so browsers warn about it until each"
      echo "device trusts it once (see \"HTTPS\" in the README). It's $cert"
    fi
    local other="" show_pem="$new_install"
    if cert_served "${https_port:-443}" "$cert"; then
      other="$(other_address "$(sed -n 's/^SITE_ADDRESS=//p' "$env_file" | tail -n 1)" "$https_port")"
    else
      show_pem=1
    fi
    [ -n "$other" ] || show_pem=1
    cert_help "$cert" "$other" "$show_pem"
  fi
  cat <<EOF

It runs as the $user account, starts by itself when this computer starts, and
starts again if it stops.

  Status / log:  $dir/crafty status   (or log)
  Restart:       systemctl restart $APP_SERVICE $CADDY_SERVICE
  Update:        Settings → Updates in the app, or run this installer again
  Settings:      $env_file  (then: $dir/crafty restart)
  Your books:    $dir/data (daily backups in data/backups)
EOF
  if command -v ufw >/dev/null 2>&1 && ufw status 2>/dev/null | grep -q "Status: active"; then
    echo
    echo "The ufw firewall is on. If other devices can't connect, allow the ports:"
    echo "  ufw allow $(sed -n 's/^HTTP_PORT=//p' "$env_file" | tail -n 1)/tcp && ufw allow ${https_port:-443}/tcp"
  fi
}

# =====================================================================================
# As the crafty account: the app, Node, Caddy and the settings.
#   CRAFTY_PHASE=user: started by root_main, which then sets up and starts the services.
#   Otherwise (crafty update, Settings → Updates): an update, restarting the services itself.
# =====================================================================================
user_main() {
  DIR="$HOME/crafty-accounting"
  local by_root=0
  [ "${CRAFTY_PHASE:-}" = user ] && by_root=1
  if [ "$by_root" = 0 ] && [ ! -f "/etc/systemd/system/$APP_SERVICE.service" ]; then
    fail "this install isn't set up as a service yet. Run the installer once as root (see the README):
  bash -c \"\$(curl -fsSL https://raw.githubusercontent.com/$REPO/main/install.sh)\""
  fi
  # install-docker.sh uses the same folder name, laid out differently.
  if [ -f "$DIR/docker-compose.yml" ] || grep -qs '^# Written by install-docker.sh' "$DIR/.env"; then
    fail "$DIR has the Docker install. Update that with $DIR/install-docker.sh."
  fi
  mkdir -p "$DIR"
  cd "$DIR"

  # ---- The app, built next to the running copy so a failed update leaves it working ----
  local branch tarball
  if [ -n "${CRAFTY_REEXEC:-}" ] && [ -d app.new ]; then
    branch="${CRAFTY_BRANCH_LABEL:-${CRAFTY_BRANCH:-the new version}}"
  else
    if [ -n "${CRAFTY_BRANCH:-}" ]; then branch="$CRAFTY_BRANCH"; elif [ -n "${CRAFTY_TARBALL:-}" ]; then branch="from $CRAFTY_TARBALL"; else branch="$(latest_release)"; fi
    tarball="${CRAFTY_TARBALL:-https://github.com/$REPO/archive/$branch.tar.gz}"
    step "Downloading the app ($branch)"
    rm -rf app.new && mkdir app.new
    curl -fsSL "$tarball" | tar -xz -C app.new --strip-components=1 || fail "couldn't download the app ($branch) from $tarball."
    # Never back to an older version by accident: only when asked for by name.
    local running new
    running="$(app_version app)"; new="$(app_version app.new)"
    if [ -n "$running" ] && [ -n "$new" ] && [ "$new" != "$running" ] && [ -z "${CRAFTY_BRANCH:-}${CRAFTY_TARBALL:-}" ] \
      && [ "$(printf '%s\n%s\n' "$running" "$new" | sort -V | tail -n 1)" = "$running" ]; then
      rm -rf app.new
      fail "the newest release found ($new) is older than the version running ($running), so nothing was changed. To install it anyway, give CRAFTY_BRANCH=v$new."
    fi
    # Carry on with the installer that came with it, so the update is set up the way the
    # new version expects (`crafty update` starts the outgoing version's copy).
    if [ -f app.new/install.sh ] && grep -q '^user_main()' app.new/install.sh && ! cmp -s "${BASH_SOURCE[0]}" app.new/install.sh; then
      CRAFTY_REEXEC=1 CRAFTY_BRANCH_LABEL="$branch" exec /bin/bash app.new/install.sh
    fi
  fi

  # ---- Node 22 ----
  step "Checking Node 22"
  local node_file node_version expected
  node_file="$(curl -fsSL "$NODE_DIST/SHASUMS256.txt" | awk -v f="-linux-$ARCH.tar.gz" '$2 ~ /^node-v22\./ && substr($2, length($2) - length(f) + 1) == f { print $2 }')" \
    || fail "couldn't reach nodejs.org."
  [ -n "$node_file" ] || fail "nodejs.org has no Node 22 for linux-$ARCH."
  node_version="${node_file#node-}"; node_version="${node_version%%-*}"
  if [ -x node/bin/node ] && [ "$(node/bin/node --version)" = "$node_version" ]; then
    echo "Node $node_version is up to date."
  else
    echo "Downloading Node $node_version."
    rm -rf node.download && mkdir node.download
    curl -fsSL -o "node.download/$node_file" "$NODE_DIST/$node_file" || fail "couldn't download Node from nodejs.org."
    expected="$(curl -fsSL "$NODE_DIST/SHASUMS256.txt" | awk -v f="$node_file" '$2 == f { print $1 }')"
    [ "$(sha256 "node.download/$node_file")" = "$expected" ] || fail "the Node download didn't match its checksum. Run this again."
    tar -xzf "node.download/$node_file" -C node.download --strip-components=1
    rm "node.download/$node_file"
    rm -rf node && mv node.download node
  fi
  export PATH="$DIR/node/bin:$PATH"

  step "Installing packages (this takes a minute or two)"
  # better-sqlite3, esbuild and fsevents ship ready-built binaries. Without
  # --ignore-scripts, npm ci compiles better-sqlite3 anyway, which needs a compiler.
  (cd app.new && npm ci --ignore-scripts --no-audit --no-fund --no-update-notifier --loglevel=error) || fail "installing packages failed (see above)."
  step "Building the app"
  (cd app.new && npm run build --silent >/dev/null 2>&1) || fail "the build failed. Run this again; if it fails again, please report it."

  # ---- Caddy ----
  # caddy/release names the build installed (Caddy's own version doesn't show the module's).
  step "Checking Caddy $CADDY_VERSION (with Cloudflare DNS $CADDY_DNS_CLOUDFLARE)"
  if [ -x caddy/caddy ] && [ "$(cat caddy/release 2>/dev/null)" = "$CADDY_RELEASE" ]; then
    echo "Caddy $CADDY_VERSION is up to date."
  else
    local caddy_arch caddy_file caddy_url
    case "$ARCH" in x64) caddy_arch=amd64 ;; *) caddy_arch=arm64 ;; esac
    caddy_file="caddy_${CADDY_VERSION}_linux_${caddy_arch}.tar.gz"
    caddy_url="https://github.com/$CADDY_REPO/releases/download/$CADDY_RELEASE"
    echo "Downloading Caddy $CADDY_VERSION."
    rm -rf caddy.download && mkdir caddy.download
    curl -fsSL -o "caddy.download/$caddy_file" "$caddy_url/$caddy_file" || fail "couldn't download Caddy from $caddy_url."
    expected="$(curl -fsSL "$caddy_url/caddy_${CADDY_VERSION}_checksums.txt" | awk -v f="$caddy_file" '$2 == f { print $1 }')"
    { [ -n "$expected" ] && [ "$(sha512 "caddy.download/$caddy_file")" = "$expected" ]; } || fail "the Caddy download didn't match its checksum. Run this again."
    tar -xzf "caddy.download/$caddy_file" -C caddy.download caddy
    mkdir -p caddy
    mv caddy.download/caddy caddy/caddy.new && mv caddy/caddy.new caddy/caddy
    printf '%s\n' "$CADDY_RELEASE" > caddy/release
    rm -rf caddy.download
  fi

  write_settings
  write_crafty_script

  # ---- Swap in the new build ----
  step "Installing the new version"
  stop_unmanaged
  mkdir -p logs
  rm -rf app.old app.failed
  if [ -d app ]; then mv app app.old; fi
  mv app.new app

  # Started by root, which sets up and starts the services next.
  [ "$by_root" = 1 ] && return 0

  step "Restarting"
  if ! "$DIR/crafty" restart; then
    if roll_back "$DIR" && "$DIR/crafty" restart >/dev/null 2>&1; then
      fail "the new version didn't start, so the previous one is running again. See: $DIR/crafty log"
    fi
    fail "the app didn't start. See: $DIR/crafty log"
  fi
  rm -rf app.old
  if ! grep -qs "(services $SERVICES_VERSION)" "/etc/systemd/system/$APP_SERVICE.service"; then
    echo
    echo "This version changes how the services are set up. To finish, run the installer"
    echo "again as root (see the README)."
  fi
  printf '\n%s%sUpdated.%s\n' "$bold" "$green" "$reset"
}

# Copies from before the services (install.sh v1.8 and earlier) ran with `crafty start`.
stop_unmanaged() {
  local f pid
  for f in caddy.pid crafty.pid; do
    if [ -f "$f" ]; then
      pid="$(cat "$f")"
      if kill -0 "$pid" 2>/dev/null; then
        kill "$pid"
        for _ in 1 2 3 4 5 6 7 8 9 10; do kill -0 "$pid" 2>/dev/null || break; sleep 0.5; done
        kill -9 "$pid" 2>/dev/null || true
      fi
      rm -f "$f"
    fi
  done
  # A crontab line that started it at boot is no longer needed: the services do that.
  if crontab -l 2>/dev/null | grep -q "crafty-accounting/crafty start"; then
    crontab -l 2>/dev/null | grep -v "crafty-accounting/crafty start" | crontab - || true
    echo "Removed the crontab line that started it at boot; the services do that now."
  fi
}

write_settings() {
  ENV_FILE="$DIR/.env"
  if [ ! -f "$ENV_FILE" ]; then
    step "Writing settings to $ENV_FILE"
    (umask 077 && cat > "$ENV_FILE" <<EOF
# Written by install.sh. See "Configuration" in the README for every setting.
# Apply changes with:  $DIR/crafty restart

SESSION_SECRET=$(od -An -N32 -tx1 /dev/urandom | tr -d ' \n')

PORT=${CRAFTY_PORT:-3000}
DATA_DIR=$DIR/data
TZ=Europe/London
EOF
    )
  else
    echo
    echo "Keeping the existing settings in $ENV_FILE."
  fi

  # Always HTTPS through Caddy, with the app itself answering only on this computer.
  set_env HOST 127.0.0.1
  set_env COOKIE_SECURE true
  set_env TRUST_PROXY true
  delete_env HTTPS
  if [ -z "$(env_value SITE_ADDRESS)" ]; then
    local ip="${CRAFTY_SITE_IP:-}"
    [ -n "$ip" ] || ip="$(lan_ip)"
    printf '\n# HTTPS: the addresses you browse to, and a private certificate for them (see "HTTPS"\n# in the README). If this computer'"'"'s IP address changes, update SITE_ADDRESS and SITE_IP.\n' >> "$ENV_FILE"
    set_env SITE_ADDRESS "localhost${ip:+, $ip}"
    set_env SITE_IP "${ip:-localhost}"
  fi
  # A domain with a Let's Encrypt certificate was set in .env up to 1.10.72 (TLS_ISSUER, then
  # TLS_MODE, DOMAIN and CLOUDFLARE_API_TOKEN); it's set up in the app now.
  local old_domain=""
  case "$(env_value TLS_MODE)" in letsencrypt | cloudflare) old_domain="$(env_value DOMAIN)" ;; esac
  case "$(env_value TLS_ISSUER)" in "" | internal) ;; *) old_domain="$(env_value SITE_ADDRESS)" ;; esac
  for name in TLS_ISSUER TLS_MODE DOMAIN CLOUDFLARE_API_TOKEN; do delete_env "$name"; done
  if [ -n "$old_domain" ]; then
    echo
    echo "A domain with a Let's Encrypt certificate ($old_domain) is now set up in the app, in"
    echo "Settings → HTTPS Certificate, using Cloudflare's DNS. Its settings in .env have been"
    echo "removed; enter the domain and API token there again."
  fi
  # 8080 and 8443 together were the old installer's fallback for a normal user.
  if [ "$(env_value HTTP_PORT)" = 8080 ] && [ "$(env_value HTTPS_PORT)" = 8443 ] && [ -z "${CRAFTY_HTTPS_PORT:-}" ]; then
    set_env HTTP_PORT 80
    set_env HTTPS_PORT 443
    echo "Moved HTTPS to ports 80 and 443, so the addresses no longer need :8443."
  fi
  if [ -n "${CRAFTY_HTTP_PORT:-}" ]; then set_env HTTP_PORT "$CRAFTY_HTTP_PORT"; fi
  if [ -n "${CRAFTY_HTTPS_PORT:-}" ]; then set_env HTTPS_PORT "$CRAFTY_HTTPS_PORT"; fi
  [ -n "$(env_value HTTP_PORT)" ] || set_env HTTP_PORT 80
  [ -n "$(env_value HTTPS_PORT)" ] || set_env HTTPS_PORT 443
}

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
delete_env() {
  grep -q "^$1=" "$ENV_FILE" || return 0
  grep -v "^$1=" "$ENV_FILE" > "$ENV_FILE.tmp"
  cat "$ENV_FILE.tmp" > "$ENV_FILE" && rm -f "$ENV_FILE.tmp"
}

# The crafty script: what the services run, and status, log, restart and update.
# Written to a new file and moved into place: `crafty update` is still reading the old one.
write_crafty_script() {
  cat > "$DIR/crafty.new" <<'EOF'
#!/bin/sh
# Crafty Accounting:  crafty status | log | restart | restart-caddy | update
# The services crafty-accounting and crafty-caddy run "crafty app" and "crafty caddy".
DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$DIR/.env"
setting() { sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1; }
PORT="$(setting PORT)"; PORT="${PORT:-3000}"
HTTPS_PORT="$(setting HTTPS_PORT)"; HTTPS_PORT="${HTTPS_PORT:-443}"
# Where the app writes an uploaded certificate and a domain's site block for Caddy.
CUSTOM="$(setting CRAFTY_TLS_DIR)"; CUSTOM="${CUSTOM:-$DIR/caddy/custom}"
# The address other devices browse to: the domain set up in Settings → HTTPS Certificate if
# there is one (from the site block the app writes), else the first in SITE_ADDRESS that isn't localhost.
ADDRESS="$(sed -n '/^[^#[:space:]].* {$/{s/ {$//p;q;}' "$CUSTOM/domain.caddy" 2>/dev/null)"
[ -n "$ADDRESS" ] || ADDRESS="$(setting SITE_ADDRESS | tr ',' '\n' | tr -d ' ' | grep -v '^localhost$' | grep . | head -n 1)"
ADDRESS="${ADDRESS:-localhost}"
case "$ADDRESS" in
  *:[0-9]*) URL="https://$ADDRESS" ;;
  *) if [ "$HTTPS_PORT" = 443 ]; then URL="https://$ADDRESS"; else URL="https://$ADDRESS:$HTTPS_PORT"; fi ;;
esac
# Caddy first: a page that started an update reloads once the new app answers, and
# came up blank when that was while Caddy was still restarting.
SERVICES="crafty-caddy crafty-accounting"

main_pid() { systemctl show -p MainPID --value "$1" 2>/dev/null; }

# Waits up to $2 seconds for the check in $1 to pass.
wait_for() {
  i=0
  while [ $i -lt "$2" ]; do
    eval "$1" && return 0
    i=$((i + 1)); sleep 1
  done
  return 1
}

app_up() { curl -fsS "http://127.0.0.1:$PORT/api/health" >/dev/null 2>&1; }
# Any answer at all over HTTPS means Caddy is serving (the certificate isn't checked).
caddy_up() { [ "$(curl -sk -o /dev/null -w '%{http_code}' "https://localhost:$HTTPS_PORT/api/health" 2>/dev/null)" != 000 ]; }

# Restarts the services named in $1 (both unless given), Caddy first.
restart() {
  services="${1:-$SERVICES}"
  if [ "$(id -u)" = 0 ]; then
    systemctl restart $services || return 1
  else
    # This account can't use systemctl, but the services start again by themselves when they stop.
    for s in $services; do
      pid="$(main_pid "$s")"
      if [ -z "$pid" ] || [ "$pid" = 0 ]; then
        # Between two attempts at starting (after a crash, say), systemd is already on it.
        case "$(systemctl is-active "$s" 2>/dev/null)" in activating | reloading) continue ;; esac
        echo "$s isn't running. As root, start it with: systemctl start $s" >&2; return 1
      fi
      kill "$pid"
      started="p=\$(main_pid $s); [ -n \"\$p\" ] && [ \"\$p\" != 0 ] && [ \"\$p\" != $pid ]"
      # Caddy before version 1.9.1's Caddyfile waited for open pages' connections to close,
      # forever; anything still running after 10 seconds is stopped outright.
      if ! wait_for "$started" 10; then
        kill -9 "$pid" 2>/dev/null
        wait_for "$started" 20 || { echo "$s didn't start again." >&2; return 1; }
      fi
    done
  fi
  if [ "$services" != crafty-caddy ] && ! wait_for app_up 60; then
    echo "Crafty Accounting didn't start. The end of its log:" >&2
    journalctl -u crafty-accounting -n 20 --no-pager >&2 2>/dev/null
    return 1
  fi
  if ! wait_for caddy_up 30; then
    echo "Caddy (HTTPS) didn't start. The end of its log:" >&2
    journalctl -u crafty-caddy -n 20 --no-pager >&2 2>/dev/null
    return 1
  fi
  echo "Crafty Accounting is running at $URL"
}

status() {
  ok=0
  for s in $SERVICES; do
    state="$(systemctl is-active "$s" 2>/dev/null)"
    echo "$s: $state"
    [ "$state" = active ] || ok=1
  done
  [ $ok = 0 ] && echo "Running at $URL"
  return $ok
}

# The comma separated list $1 without the names in the site blocks the app writes to $CUSTOM
# from Settings → HTTPS Certificate (a domain on Cloudflare, an uploaded certificate's other
# names): Caddy refuses a name in two site blocks.
without_app_sites() {
  taken="$(sed -n '/^[^#[:space:]].* {$/{s/ {$//;p;}' "$CUSTOM"/*.caddy 2>/dev/null | tr ',' '\n' | sed 's/^ *//;s/ *$//;s/:[0-9]*$//' | tr 'A-Z\n' 'a-z ')"
  printf '%s' "$1" | tr ',' '\n' | awk -v t="$taken" 'BEGIN { n = split(t, names, " "); for (i = 1; i <= n; i++) skip[names[i]] = 1 } NF { a = $1; h = tolower(a); sub(/^[a-z]+:\/\//, "", h); sub(/:[0-9]+$/, "", h); if (!(h in skip)) out = out (out ? ", " : "") a } END { print out }'
}

# Off port 443, each address in the comma separated list $1 gets the port, or Caddy's
# http->https redirect leaves it out.
with_port() {
  if [ "$HTTPS_PORT" = 443 ]; then printf '%s' "$1"; return; fi
  printf '%s' "$1" | tr ',' '\n' | awk -v p="$HTTPS_PORT" 'NF { a = $1; if (a !~ /:[0-9]+$/) a = a ":" p; out = out (out ? ", " : "") a } END { print out }'
}

case "${1:-}" in
  app)
    cd "$DIR/app" || exit 1
    export NODE_ENV=production
    exec "$DIR/node/bin/node" "--env-file=$ENV_FILE" server/dist/index.js ;;
  caddy)
    # Only what's set: Caddy takes a variable that's set but empty as empty, not its default.
    for name in SITE_ADDRESS SITE_IP; do
      value="$(setting $name)"
      [ "$name" = SITE_ADDRESS ] && value="$(with_port "$(without_app_sites "$value")")"
      if [ -n "$value" ]; then export "$name=$value"; fi
    done
    # A domain on Cloudflare set up in Settings → HTTPS Certificate: the Caddyfile imports the
    # site block the app writes here.
    export CRAFTY_TLS_DIR="$CUSTOM"
    # A certificate of your own for SITE_ADDRESS, uploaded in Settings → HTTPS Certificate, unless
    # TLS_CUSTOM=off. The Caddyfile's "tls {$CRAFTY_SITE_TLS}" then reads "tls <cert> <key>", and
    # /crafty-root.crt points at a folder that isn't there, as the private authority isn't in use.
    if [ "$(setting TLS_CUSTOM | tr 'A-Z' 'a-z')" != off ] && [ -s "$CUSTOM/cert.pem" ] && [ -s "$CUSTOM/key.pem" ]; then
      export CRAFTY_SITE_TLS="$CUSTOM/cert.pem $CUSTOM/key.pem" CRAFTY_CA_HIDDEN=-not-in-use
    fi
    export CADDY_HTTP_PORT="$(setting HTTP_PORT)" CRAFTY_OTHER_ADDRESSES="https://:$HTTPS_PORT" CRAFTY_UPSTREAM="127.0.0.1:$PORT"
    export CRAFTY_ENV_PLACE="at $ENV_FILE" CRAFTY_APPLY="$DIR/crafty restart"
    # Its certificates, including the private certificate authority, live here.
    export XDG_DATA_HOME="$DIR/caddy/data" XDG_CONFIG_HOME="$DIR/caddy/config"
    exec "$DIR/caddy/caddy" run --config "$DIR/app/Caddyfile" --adapter caddyfile ;;
  status) status || exit 1 ;;
  log) exec journalctl -u crafty-accounting -u crafty-caddy -n 50 -f ;;
  restart) restart || exit 1 ;;
  # Picks up a new HTTPS certificate (the app runs this after one is uploaded or removed).
  restart-caddy) restart crafty-caddy || exit 1 ;;
  update)
    # A copy of the installer that came with the app, since the update replaces the app.
    # (Outside the account's folder when root runs it, so the account can still update later.)
    if [ "$(id -u)" = 0 ]; then copy="$(mktemp)"; else copy="$DIR/.install.sh"; fi
    cp "$DIR/app/install.sh" "$copy" || exit 1
    exec /bin/bash "$copy" ;;
  start | stop)
    echo "Crafty Accounting runs as a service. As root: systemctl $1 $SERVICES" >&2; exit 2 ;;
  *) echo "Usage: $0 status | log | restart | restart-caddy | update" >&2; exit 2 ;;
esac
EOF
  chmod +x "$DIR/crafty.new"
  mv "$DIR/crafty.new" "$DIR/crafty"
}

if [ "$(id -u)" -eq 0 ]; then
  root_main
else
  user_main
fi
