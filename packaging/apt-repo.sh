#!/usr/bin/env bash
set -euo pipefail

usage() {
  echo "usage: GPG_KEY_ID=<id> $0 REPO_DIR DEB..." >&2
  exit 2
}

[ $# -ge 2 ] || usage
: "${GPG_KEY_ID:?set GPG_KEY_ID to the signing key id}"

REPO=$1
shift
SUITE=stable
COMPONENT=main
ARCHES="amd64 arm64"
KEEP=${KEEP:-5}
POOL="$REPO/pool/$COMPONENT/d/dynamic-island"
BASE_URL=${BASE_URL:-https://adamshannag.github.io/dynamic-island}

mkdir -p "$POOL"
cp -f "$@" "$POOL/"

for arch in $ARCHES; do
  ls -1t "$POOL"/*_"$arch".deb 2>/dev/null | tail -n +"$((KEEP + 1))" | xargs -r rm -f
done

cd "$REPO"
for arch in $ARCHES; do
  dir="dists/$SUITE/$COMPONENT/binary-$arch"
  mkdir -p "$dir"
  apt-ftparchive --arch "$arch" packages pool > "$dir/Packages"
  gzip -9kf "$dir/Packages"
done

apt-ftparchive \
  -o APT::FTPArchive::Release::Origin="Dynamic Island" \
  -o APT::FTPArchive::Release::Label="Dynamic Island" \
  -o APT::FTPArchive::Release::Suite="$SUITE" \
  -o APT::FTPArchive::Release::Codename="$SUITE" \
  -o APT::FTPArchive::Release::Architectures="$ARCHES" \
  -o APT::FTPArchive::Release::Components="$COMPONENT" \
  -o APT::FTPArchive::Release::Description="Dynamic Island for GNOME" \
  release "dists/$SUITE" > "dists/$SUITE/Release"

gpg_sign() { gpg --batch --yes --pinentry-mode loopback ${GPG_PASSPHRASE:+--passphrase "$GPG_PASSPHRASE"} --local-user "$GPG_KEY_ID" "$@"; }
gpg_sign --clearsign -o "dists/$SUITE/InRelease" "dists/$SUITE/Release"
gpg_sign --armor --detach-sign -o "dists/$SUITE/Release.gpg" "dists/$SUITE/Release"

gpg --batch --yes --armor --export "$GPG_KEY_ID" > dynamic-island.asc
gpg --batch --yes --export "$GPG_KEY_ID" > dynamic-island.gpg

cat > setup.sh <<EOF
#!/bin/sh
set -e
[ "\$(id -u)" -eq 0 ] || { echo "Run with sudo: curl -fsSL $BASE_URL/setup.sh | sudo sh" >&2; exit 1; }
install -d -m 0755 /usr/share/keyrings
curl -fsSL $BASE_URL/dynamic-island.gpg -o /usr/share/keyrings/dynamic-island.gpg
echo "deb [signed-by=/usr/share/keyrings/dynamic-island.gpg] $BASE_URL $SUITE $COMPONENT" > /etc/apt/sources.list.d/dynamic-island.list
apt-get update -o Dir::Etc::sourcelist=sources.list.d/dynamic-island.list -o Dir::Etc::sourceparts=- -o APT::Get::List-Cleanup=0
echo
echo "Repository added. Now run:"
echo "  sudo apt install dynamic-island"
echo "  island setup"
EOF

cat > index.html <<EOF
<!doctype html>
<meta charset="utf-8">
<title>Dynamic Island APT repository</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:46rem;margin:3rem auto;padding:0 1rem}pre{background:#111;color:#eee;padding:1rem;border-radius:8px;overflow:auto}</style>
<h1>Dynamic Island</h1>
<p>APT repository for <a href="https://github.com/AdamShannag/dynamic-island">Dynamic Island</a> (Ubuntu, GNOME Shell 46+, amd64 and arm64).</p>
<pre>curl -fsSL $BASE_URL/setup.sh | sudo sh
sudo apt install dynamic-island
island setup</pre>
<p>Or add it by hand:</p>
<pre>curl -fsSL $BASE_URL/dynamic-island.gpg | sudo tee /usr/share/keyrings/dynamic-island.gpg &gt;/dev/null
echo "deb [signed-by=/usr/share/keyrings/dynamic-island.gpg] $BASE_URL $SUITE $COMPONENT" | sudo tee /etc/apt/sources.list.d/dynamic-island.list
sudo apt update &amp;&amp; sudo apt install dynamic-island</pre>
EOF
touch .nojekyll
echo "APT repository updated in $REPO"
