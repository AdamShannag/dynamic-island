#!/usr/bin/env bash
# Removes Go Island. Your data (~/.local/share/go-island: clipboard history,
# notes, saved sites) is kept unless you pass --purge.
set -uo pipefail
UUID=go-island@local

gnome-extensions disable "$UUID" 2>/dev/null
if command -v island >/dev/null && grep -q "island claude hook" "$HOME/.claude/settings.json" 2>/dev/null; then
  island claude uninstall
fi
systemctl --user disable --now islandd.service 2>/dev/null
rm -f "$HOME/.config/systemd/user/islandd.service" "$HOME/.local/bin/islandd" "$HOME/.local/bin/island"
systemctl --user daemon-reload
rm -rf "$HOME/.local/share/gnome-shell/extensions/$UUID"
if [ "${1:-}" = "--purge" ]; then
  rm -rf "$HOME/.local/share/go-island" "$HOME/.cache/go-island" "$HOME/.config/go-island"
  echo "Removed Go Island and its data."
else
  echo "Removed Go Island. Data kept in ~/.local/share/go-island (use --purge to delete it)."
fi
