#!/bin/bash
# Removes the Linux quick install of Crafty Accounting (install.sh) completely, including
# the books, documents, backups, settings and HTTPS certificates. Run it as root:
#
#   bash -c "$(curl -fsSL https://raw.githubusercontent.com/koder-guy/crafty-accounting/main/uninstall.sh)"
#
# It lists what it will remove and asks you to type "delete" first. There is no undo:
# download a backup (Settings → Backup and Restore) before running it if you might want
# the books again.
#
# It removes:
#   - the crafty-accounting and crafty-caddy services;
#   - the crafty account, with its home folder (the app, Node, Caddy and its certificates,
#     the settings, the books and documents, backups, logs), crontab and mail;
#   - DATA_DIR and the automatic backups in BACKUP_DIR, if .env moved them elsewhere;
#   - copies of the installer it left in /tmp.
# The account is only removed if its home holds nothing but the install; otherwise just
# the install's folder goes.
#
# Optional settings, given as environment variables before the command:
#   CRAFTY_USER     the account the install runs as (default crafty)
#   CRAFTY_CONFIRM  set to yes to skip the question (for scripts)
#
# The Docker install (install-docker.sh) isn't removed by this: see "Uninstalling" in the README.

set -euo pipefail

APP_SERVICE=crafty-accounting
CADDY_SERVICE=crafty-caddy
USER_NAME="${CRAFTY_USER:-crafty}"

bold=$'\033[1m'; green=$'\033[32m'; red=$'\033[31m'; reset=$'\033[0m'
step() { printf '\n%s==> %s%s\n' "$bold" "$1" "$reset"; }
fail() { printf '\n%sError: %s%s\n' "$red" "$1" "$reset" >&2; exit 1; }

# A setting from .env, or nothing.
setting() { [ -f "$ENV_FILE" ] && sed -n "s/^$1=//p" "$ENV_FILE" | tail -n 1 || true; }

# Whether $1 is a folder that's safe to remove whole: absolute, at least two levels deep,
# and not a system folder or someone's home.
safe_to_remove() {
  local d="${1%/}"
  case "$d" in /*) ;; *) return 1 ;; esac
  case "$d" in */../* | */.. | */./* | */.) return 1 ;; esac
  [ "$(printf '%s' "$d" | tr -cd '/' | wc -c)" -ge 2 ] || return 1
  case "$d" in
    /bin* | /boot* | /dev* | /etc* | /lib* | /proc* | /root | /run* | /sbin* | /srv | /sys* | /usr* | /var | /var/lib | /var/log | /home | /mnt | /media | /opt | /tmp) return 1 ;;
  esac
  local home
  while IFS=: read -r _ _ _ _ _ home _; do
    [ "$d" = "${home%/}" ] && return 1
  done < <(getent passwd)
  return 0
}

# Whether $1 lies inside folder $2.
inside() { case "${1%/}/" in "${2%/}"/*) return 0 ;; *) return 1 ;; esac; }

# Whether the account's home holds anything besides the install and the usual dotfiles
# (from /etc/skel, npm's cache and the like).
home_has_other_files() {
  local f
  for f in "$HOME_DIR"/* "$HOME_DIR"/.[!.]* "$HOME_DIR"/..?*; do
    [ -e "$f" ] || [ -L "$f" ] || continue
    case "${f##*/}" in
      crafty-accounting | .bashrc | .bash_logout | .profile | .bash_history | .npm | .cache | .config | .local | .node_repl_history | .lesshst | .viminfo | .wget-hsts | .sudo_as_admin_successful | .install.sh) ;;
      *) return 0 ;;
    esac
  done
  return 1
}

[ "$(uname -s)" = Linux ] || fail "this removes the Linux quick install. For the Docker install, see \"Uninstalling\" in the README."
[ "$(id -u)" = 0 ] || fail "run this as root (with sudo, or bash -c \"\$(curl ...)\" as root)."

# ---- What's there ----
HOME_DIR=""
if id -u "$USER_NAME" >/dev/null 2>&1; then
  [ "$(id -u "$USER_NAME")" != 0 ] || fail "$USER_NAME is the root account. Give the account the app runs as in CRAFTY_USER."
  HOME_DIR="$(getent passwd "$USER_NAME" | cut -d: -f6)"
  case "$HOME_DIR" in /?*/?*) ;; *) fail "$USER_NAME's home folder ($HOME_DIR) doesn't look like one the installer made, so nothing was removed." ;; esac
fi
DIR="${HOME_DIR:+$HOME_DIR/crafty-accounting}"
ENV_FILE="$DIR/.env"
if [ -n "$DIR" ] && { [ -f "$DIR/docker-compose.yml" ] || grep -qs '^# Written by install-docker.sh' "$ENV_FILE"; }; then
  fail "$DIR has the Docker install, which this doesn't remove. See \"Uninstalling\" in the README."
fi

units=()
for s in "$APP_SERVICE" "$CADDY_SERVICE"; do
  [ -f "/etc/systemd/system/$s.service" ] && units+=("$s")
done

# Folders .env may have moved outside the install's folder.
data_dir="" backup_dir=""
if [ -n "$DIR" ]; then
  data_dir="$(setting DATA_DIR)"
  backup_dir="$(setting BACKUP_DIR)"
  [ -n "$backup_dir" ] || { [ -n "$data_dir" ] && backup_dir="$data_dir/backups"; }
  if [ -n "$data_dir" ] && inside "$data_dir" "$DIR"; then data_dir=""; fi
  if [ -n "$backup_dir" ] && { inside "$backup_dir" "$DIR" || { [ -n "$data_dir" ] && inside "$backup_dir" "$data_dir"; }; }; then backup_dir=""; fi
  [ -d "$data_dir" ] || data_dir=""
  [ -d "$backup_dir" ] || backup_dir=""
fi

remove_account=0
if [ -n "$HOME_DIR" ] && [ -d "$DIR" ]; then
  home_has_other_files || remove_account=1
fi

# Copies of the installer in /tmp (`crafty update` as root leaves one).
installer_copies=()
for f in /tmp/tmp.*; do
  [ -f "$f" ] && [ "$(stat -c %u "$f")" = 0 ] || continue
  sed -n 2p "$f" 2>/dev/null | grep -q '^# Installs Crafty Accounting on a Linux server' && installer_copies+=("$f")
done

if [ ${#units[@]} = 0 ] && [ ! -d "$DIR" ] && [ -z "$data_dir" ]; then
  echo "Crafty Accounting isn't installed here (no services, and no ${DIR:-~$USER_NAME/crafty-accounting})."
  [ "$USER_NAME" = crafty ] || exit 0
  echo "If it was installed with CRAFTY_USER, give the same CRAFTY_USER to this."
  exit 0
fi

# ---- Ask first ----
printf '\n%sThis permanently removes Crafty Accounting and everything it has saved:%s\n\n' "$bold" "$reset"
[ ${#units[@]} -gt 0 ] && echo "  Services:  ${units[*]}"
if [ "$remove_account" = 1 ]; then
  echo "  Account:   $USER_NAME, with its home folder $HOME_DIR"
elif [ -d "$DIR" ]; then
  echo "  Folder:    $DIR"
  echo "             (the $USER_NAME account stays: its home has other files in it)"
fi
if [ -d "$DIR" ]; then
  echo "             the books and documents, backups, settings, logs and HTTPS certificates"
fi
if [ -n "$data_dir" ]; then
  if safe_to_remove "$data_dir"; then
    echo "  Data:      $data_dir"
  else
    echo "  Data:      $data_dir is left alone, as it isn't safe to remove whole."
    echo "             Remove what Crafty Accounting saved there yourself."
    data_dir=""
  fi
fi
[ -n "$backup_dir" ] && echo "  Backups:   crafty-accounting-auto-*.zip in $backup_dir"
[ ${#installer_copies[@]} -gt 0 ] && echo "  Leftovers: ${installer_copies[*]}"
echo
echo "There is no undo. To keep the books, first download a backup in the app"
echo "(Settings → Backup and Restore) or copy the backups somewhere else."
echo

if [ "${CRAFTY_CONFIRM:-}" != yes ]; then
  (: </dev/tty) 2>/dev/null || fail "no terminal to ask on. Run it from a terminal, or set CRAFTY_CONFIRM=yes."
  printf 'Type %sdelete%s to remove it all: ' "$bold" "$reset"
  answer=""
  read -r answer </dev/tty || true
  [ "$answer" = delete ] || { echo "Nothing removed."; exit 1; }
fi

# ---- Remove ----
if [ ${#units[@]} -gt 0 ]; then
  step "Stopping and removing the services"
  systemctl disable --now "${units[@]}" >/dev/null 2>&1 || true
  for s in "${units[@]}"; do rm -f "/etc/systemd/system/$s.service"; done
  rm -rf "/etc/systemd/system/$APP_SERVICE.service.d" "/etc/systemd/system/$CADDY_SERVICE.service.d"
  systemctl daemon-reload
  systemctl reset-failed "${units[@]}" >/dev/null 2>&1 || true
fi

if [ -n "$HOME_DIR" ]; then
  # Anything still running as the account: an update in progress, or a copy started by hand
  # before the services (install.sh v1.8 and earlier).
  if [ "$remove_account" = 1 ]; then
    pkill -KILL -u "$USER_NAME" 2>/dev/null || true
  elif [ -d "$DIR" ]; then
    pkill -KILL -u "$USER_NAME" -f "$DIR/" 2>/dev/null || true
  fi
  sleep 1
  # Before v1.9 a crontab line started it at boot.
  if [ "$remove_account" = 1 ]; then
    crontab -r -u "$USER_NAME" 2>/dev/null || true
  elif crontab -l -u "$USER_NAME" 2>/dev/null | grep -q "crafty-accounting/crafty"; then
    crontab -l -u "$USER_NAME" 2>/dev/null | grep -v "crafty-accounting/crafty" | crontab -u "$USER_NAME" - || true
  fi
fi

if [ -n "$data_dir" ]; then
  step "Removing $data_dir"
  rm -rf -- "$data_dir"
fi
if [ -n "$backup_dir" ]; then
  step "Removing the backups in $backup_dir"
  find "$backup_dir" -maxdepth 1 -type f -name 'crafty-accounting-auto-*.zip' -delete
  rmdir "$backup_dir" 2>/dev/null && echo "Removed the folder, as it's now empty." || true
fi

if [ "$remove_account" = 1 ]; then
  step "Removing the $USER_NAME account and its home folder"
  userdel --remove "$USER_NAME" 2>/dev/null || userdel "$USER_NAME"
  rm -rf -- "$HOME_DIR"
  # userdel normally removes the account's own group too, but not on every system.
  if getent group "$USER_NAME" >/dev/null 2>&1 && [ -z "$(getent group "$USER_NAME" | cut -d: -f4)" ]; then
    groupdel "$USER_NAME" 2>/dev/null || true
  fi
elif [ -d "$DIR" ]; then
  step "Removing $DIR"
  rm -rf -- "$DIR" "$HOME_DIR/.install.sh"
fi

for f in ${installer_copies[@]+"${installer_copies[@]}"}; do rm -f -- "$f"; done

printf '\n%s%sCrafty Accounting has been removed.%s\n\n' "$bold" "$green" "$reset"
cat <<'EOF'
Still to do yourself, if you want them gone too:
  - On each device that trusted its certificate, remove "Caddy Local Authority": on a Mac,
    in Keychain Access → System; on an iPhone, Settings → General → VPN & Device Management.
  - Its old log lines stay in the system journal until it's rotated away. To clear the whole
    journal now (every service's logs, not just these): journalctl --rotate && journalctl --vacuum-time=1s
  - curl and tar, if the installer added them, are left installed.
EOF
