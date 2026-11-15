#!/usr/bin/env bash
set -uo pipefail

APP=dynamic-island
UUID=dynamic-island@adamshannag.github.io

gnome-extensions disable "$UUID" 2>/dev/null
if command -v island >/dev/null && grep -q "claude hook" "$HOME/.claude/settings.json" 2>/dev/null; then
  island claude uninstall
fi
systemctl --user disable --now "$APP.service" 2>/dev/null
rm -f "$HOME/.config/systemd/user/$APP.service" "$HOME/.local/bin/dynamic-islandd" "$HOME/.local/bin/island"
systemctl --user daemon-reload
rm -rf "$HOME/.local/share/gnome-shell/extensions/$UUID"
if [ "${1:-}" = "--purge" ]; then
  rm -rf "$HOME/.local/share/$APP" "$HOME/.cache/$APP" "$HOME/.config/$APP"
  echo "Removed Dynamic Island and its data."
else
  echo "Removed Dynamic Island. Data kept in ~/.local/share/$APP (use --purge to delete it)."
fi
