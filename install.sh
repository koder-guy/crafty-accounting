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
#   CRAFTY_BRANCH          branch or tag to install (default: the latest release)
#   CRAFTY_TARBALL         URL of the app's source .tar.gz, instead of GitHub's for CRAFTY_BRANCH
#   CRAFTY_REPO            GitHub repository to install from (default koder-guy/crafty-accounting)

set -euo pipefail

REPO="${CRAFTY_REPO:-koder-guy/crafty-accounting}"
NODE_DIST="https://nodejs.org/dist/latest-v22.x"
CADDY_VERSION="2.11.8"
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
  printf '%s\n' "$tags" | sed -n 's/.*"name": *"\(v[0-9][0-9]*\.[0-9][0-9]*\.[0-9][0-9]*\)".*/\1/p' \
    | sort -t. -k1.2,1n -k2,2n -k3,3n | tail -n 1 | grep . || echo main
}

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
    /bin/bash "$script"; then
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

  # Caddy's private certificate authority, for devices to trust.
  local cert="" ca="$dir/caddy/data/caddy/pki/authorities/local/root.crt"
  if [ "$(sed -n 's/^TLS_ISSUER=//p' "$env_file" | tail -n 1)" = internal ] && [ -f "$ca" ]; then
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

summary() {
  local user="$1" dir="$2" cert="$3" new_install="$4" env_file="$2/.env" https_port suffix="" label="On this computer:     " addr
  https_port="$(sed -n 's/^HTTPS_PORT=//p' "$env_file" | tail -n 1)"
  [ "${https_port:-443}" = 443 ] || suffix=":$https_port"
  printf '\n%s%sCrafty Accounting is running.%s\n\n' "$bold" "$green" "$reset"
  echo "Open it in a web browser:"
  for addr in $(sed -n 's/^SITE_ADDRESS=//p' "$env_file" | tail -n 1 | tr ',' ' '); do
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
  if [ -n "$cert" ]; then
    echo
    echo "The certificate is private to this install, so browsers warn about it until each"
    echo "device trusts it once (see \"HTTPS\" in the README). It's $cert"
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
  step "Checking Caddy $CADDY_VERSION"
  if [ -x caddy/caddy ] && caddy/caddy version 2>/dev/null | grep -q "^v$CADDY_VERSION "; then
    echo "Caddy $CADDY_VERSION is up to date."
  else
    local caddy_arch caddy_file caddy_url
    case "$ARCH" in x64) caddy_arch=amd64 ;; *) caddy_arch=arm64 ;; esac
    caddy_file="caddy_${CADDY_VERSION}_linux_${caddy_arch}.tar.gz"
    caddy_url="https://github.com/caddyserver/caddy/releases/download/v$CADDY_VERSION"
    echo "Downloading Caddy $CADDY_VERSION."
    rm -rf caddy.download && mkdir caddy.download
    curl -fsSL -o "caddy.download/$caddy_file" "$caddy_url/$caddy_file" || fail "couldn't download Caddy from $caddy_url."
    expected="$(curl -fsSL "$caddy_url/caddy_${CADDY_VERSION}_checksums.txt" | awk -v f="$caddy_file" '$2 == f { print $1 }')"
    { [ -n "$expected" ] && [ "$(sha512 "caddy.download/$caddy_file")" = "$expected" ]; } || fail "the Caddy download didn't match its checksum. Run this again."
    tar -xzf "caddy.download/$caddy_file" -C caddy.download caddy
    mkdir -p caddy
    mv caddy.download/caddy caddy/caddy.new && mv caddy/caddy.new caddy/caddy
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
    local ip
    ip="$(lan_ip)"
    printf '\n# HTTPS: the addresses you browse to, and a private certificate for them (see "HTTPS"\n# in the README). If this computer'"'"'s IP address changes, update SITE_ADDRESS and SITE_IP.\n' >> "$ENV_FILE"
    set_env SITE_ADDRESS "localhost${ip:+, $ip}"
    set_env SITE_IP "${ip:-localhost}"
    set_env TLS_ISSUER internal
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
# Crafty Accounting:  crafty status | log | restart | update
# The services crafty-accounting and crafty-caddy run "crafty app" and "crafty caddy".
DIR="$(cd "$(dirname "$0")" && pwd)"
ENV_FILE="$DIR/.env"
setting() { sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1; }
PORT="$(setting PORT)"; PORT="${PORT:-3000}"
HTTPS_PORT="$(setting HTTPS_PORT)"; HTTPS_PORT="${HTTPS_PORT:-443}"
if [ "$HTTPS_PORT" = 443 ]; then URL="https://localhost"; else URL="https://localhost:$HTTPS_PORT"; fi
SERVICES="crafty-accounting crafty-caddy"

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

restart() {
  if [ "$(id -u)" = 0 ]; then
    systemctl restart $SERVICES || return 1
  else
    # This account can't use systemctl, but the services start again by themselves when they stop.
    for s in $SERVICES; do
      pid="$(main_pid "$s")"
      if [ -z "$pid" ] || [ "$pid" = 0 ]; then
        echo "$s isn't running. As root, start it with: systemctl start $s" >&2; return 1
      fi
      kill "$pid"
      wait_for "p=\$(main_pid $s); [ -n \"\$p\" ] && [ \"\$p\" != 0 ] && [ \"\$p\" != $pid ]" 30 || {
        echo "$s didn't start again." >&2; return 1
      }
    done
  fi
  if ! wait_for app_up 60; then
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

case "${1:-}" in
  app)
    cd "$DIR/app" || exit 1
    export NODE_ENV=production
    exec "$DIR/node/bin/node" "--env-file=$ENV_FILE" server/dist/index.js ;;
  caddy)
    # Off port 443, each address carries the port, or Caddy's http->https redirect leaves it out.
    site="$(setting SITE_ADDRESS)"
    if [ "$HTTPS_PORT" != 443 ]; then
      site="$(printf '%s' "$site" | tr ',' '\n' | awk -v p="$HTTPS_PORT" 'NF { a = $1; if (a !~ /:[0-9]+$/) a = a ":" p; out = out (out ? ", " : "") a } END { print out }')"
    fi
    export SITE_ADDRESS="$site" SITE_IP="$(setting SITE_IP)" TLS_ISSUER="$(setting TLS_ISSUER)"
    export CADDY_HTTP_PORT="$(setting HTTP_PORT)" CRAFTY_OTHER_ADDRESSES="https://:$HTTPS_PORT" CRAFTY_UPSTREAM="127.0.0.1:$PORT"
    export CRAFTY_ENV_PLACE="at $ENV_FILE" CRAFTY_APPLY="$DIR/crafty restart"
    # Its certificates, including the private certificate authority, live here.
    export XDG_DATA_HOME="$DIR/caddy/data" XDG_CONFIG_HOME="$DIR/caddy/config"
    exec "$DIR/caddy/caddy" run --config "$DIR/app/Caddyfile" --adapter caddyfile ;;
  status) status || exit 1 ;;
  log) exec journalctl -u crafty-accounting -u crafty-caddy -n 50 -f ;;
  restart) restart || exit 1 ;;
  update)
    # A copy of the installer that came with the app, since the update replaces the app.
    # (Outside the account's folder when root runs it, so the account can still update later.)
    if [ "$(id -u)" = 0 ]; then copy="$(mktemp)"; else copy="$DIR/.install.sh"; fi
    cp "$DIR/app/install.sh" "$copy" || exit 1
    exec /bin/bash "$copy" ;;
  start | stop)
    echo "Crafty Accounting runs as a service. As root: systemctl $1 $SERVICES" >&2; exit 2 ;;
  *) echo "Usage: $0 status | log | restart | update" >&2; exit 2 ;;
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
