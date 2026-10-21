#!/usr/bin/env bash
# Holt die deutschen Senderlogos aus github.com/tv-logo/tv-logos nach webos-app/logos
# und schreibt die Liste neu nach webos-app/js/logos.js (ohne Sky, ohne -alt/-hz-Varianten).
set -euo pipefail
cd "$(dirname "$0")/.."
tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
git clone -q --depth 1 --filter=blob:none --sparse https://github.com/tv-logo/tv-logos "$tmp/tv-logos"
git -C "$tmp/tv-logos" sparse-checkout set countries/germany
rm -rf webos-app/logos
mkdir -p webos-app/logos
for f in "$tmp"/tv-logos/countries/germany/*-de.png; do
  b=$(basename "$f")
  case $b in sky-*|*-alt-de.png|*-alt2-de.png|*-hz-de.png) continue ;; esac
  cp "$f" "webos-app/logos/${b%-de.png}.png"
done
{
  echo "// Vorhandene Senderlogos in logos/ (aus github.com/tv-logo/tv-logos, Ordner countries/germany)"
  echo "// Neu erzeugen: scripts/update-logos.sh"
  printf "window.KABELTV_LOGOS = ["
  ls webos-app/logos | sed 's/\.png$//' | awk '{printf "%s\x27%s\x27", (NR>1?",":""), $0}'
  echo "];"
} > webos-app/js/logos.js
echo "$(ls webos-app/logos | wc -l) Logos"
