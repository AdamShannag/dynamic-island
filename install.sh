#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"

APP=dynamic-island
UUID=dynamic-island@adamshannag.github.io
DAEMON=dynamic-islandd
BIN="$HOME/.local/bin"
EXT="$HOME/.local/share/gnome-shell/extensions/$UUID"
UNIT_DIR="$HOME/.config/systemd/user"

LEGACY_UUID=go-island@local
LEGACY_UNIT=islandd.service

say()  { printf '\033[1m%s\033[0m\n' "$*"; }
warn() { printf '\033[33m%s\033[0m\n' "$*"; }
die()  { printf '\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

[ "$(id -u)" -ne 0 ] || die "Run this as your normal user, not root."
command -v gnome-shell >/dev/null || die "GNOME Shell not found. Dynamic Island needs Ubuntu's GNOME desktop."
command -v systemctl   >/dev/null || die "systemd not found."
if dpkg -s "$APP" >/dev/null 2>&1; then
  die "The $APP package is installed from apt. Use 'sudo apt upgrade' instead, or 'sudo apt remove $APP' first."
fi

ver=$(gnome-shell --version | grep -oE '[0-9]+' | head -1)
case "$ver" in
  46|47|48|49) ;;
  *) warn "GNOME Shell $ver: only 46–49 are supported; it may not load." ;;
esac

case "$(uname -m)" in
  x86_64)        arch=amd64 ;;
  aarch64|arm64) arch=arm64 ;;
  *)             arch="" ;;
esac

if [ -n "$arch" ] && [ -x "bin/linux-$arch/$DAEMON" ]; then
  src="bin/linux-$arch"
  say "Using prebuilt binaries ($arch)"
elif command -v go >/dev/null; then
  say "Building with $(go version | awk '{print $3}')…"
  CGO_ENABLED=0 go build -trimpath -ldflags "-s -w" -o build/ ./cmd/...
  src=build
else
  die "No prebuilt binaries for $(uname -m) and Go isn't installed.
Install Go (sudo apt install golang-go) or use a release tarball."
fi

if [ -e "$UNIT_DIR/$LEGACY_UNIT" ] || [ -d "$HOME/.local/share/gnome-shell/extensions/$LEGACY_UUID" ]; then
  say "Removing the old Go Island install (your data is migrated automatically)"
  gnome-extensions disable "$LEGACY_UUID" 2>/dev/null || true
  systemctl --user disable --now "$LEGACY_UNIT" 2>/dev/null || true
  rm -f "$UNIT_DIR/$LEGACY_UNIT" "$BIN/islandd"
  rm -rf "$HOME/.local/share/gnome-shell/extensions/$LEGACY_UUID"
fi

say "Installing the daemon and CLI to $BIN"
install -Dm755 "$src/$DAEMON" "$BIN/$DAEMON"
install -Dm755 "$src/island"  "$BIN/island"
install -Dm644 "systemd/$APP.service" "$UNIT_DIR/$APP.service"
systemctl --user daemon-reload
systemctl --user enable --now "$APP.service" >/dev/null
systemctl --user restart "$APP.service"

say "Installing the GNOME Shell extension"
rm -rf "$EXT"
mkdir -p "$EXT"
cp -r "extension/$UUID/." "$EXT/"

if [ "$(gsettings get org.gnome.shell disable-user-extensions)" = "true" ]; then
  gsettings set org.gnome.shell disable-user-extensions false
  warn "User extensions were disabled system-wide; turned them on."
fi

needs_restart=0
if ! gnome-extensions enable "$UUID" 2>/dev/null; then
  needs_restart=1
  current=$(gsettings get org.gnome.shell enabled-extensions)
  if [[ "$current" != *"'$UUID'"* ]]; then
    if [[ "$current" == "@as []" || "$current" == "[]" ]]; then
      gsettings set org.gnome.shell enabled-extensions "['$UUID']"
    else
      gsettings set org.gnome.shell enabled-extensions "${current%]}, '$UUID']"
    fi
  fi
fi

case ":$PATH:" in
  *":$BIN:"*) ;;
  *) warn "$BIN is not on your PATH yet; Ubuntu adds it at your next login." ;;
esac

echo
say "Done."
if [ "$needs_restart" = 1 ]; then
  if [ "${XDG_SESSION_TYPE:-}" = "x11" ]; then
    echo "Restart GNOME Shell to load the extension: press Alt+F2, type r, press Enter."
  else
    echo "Log out and back in to load the extension (Wayland can't restart the shell in place)."
  fi
fi
echo "Optional: report Claude Code sessions to the island:  island claude install"
