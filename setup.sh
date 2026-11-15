#!/bin/sh
set -e
[ "$(id -u)" -eq 0 ] || { echo "Run with sudo: curl -fsSL https://adamshannag.github.io/dynamic-island/setup.sh | sudo sh" >&2; exit 1; }
install -d -m 0755 /usr/share/keyrings
curl -fsSL https://adamshannag.github.io/dynamic-island/dynamic-island.gpg -o /usr/share/keyrings/dynamic-island.gpg
echo "deb [signed-by=/usr/share/keyrings/dynamic-island.gpg] https://adamshannag.github.io/dynamic-island stable main" > /etc/apt/sources.list.d/dynamic-island.list
apt-get update -o Dir::Etc::sourcelist=sources.list.d/dynamic-island.list -o Dir::Etc::sourceparts=- -o APT::Get::List-Cleanup=0
echo
echo "Repository added. Now run:"
echo "  sudo apt install dynamic-island"
echo "  island setup"
