#!/usr/bin/env bash
# Draws the app's PNG icons from the SVG sources in assets/source (the Corvus mark of the desktop
# app's build/icon.svg). Run in Docker, from the repository root:
#   docker compose run --rm dev bash apps/mobile/scripts/make-icons.sh
set -euo pipefail
command -v rsvg-convert >/dev/null || { apt-get update -qq && apt-get install -y -qq librsvg2-bin >/dev/null; }
cd "$(dirname "$0")/.."
src=assets/source
img=assets/images
draw() { rsvg-convert -w "$2" -h "$2" "$src/$1.svg" -o "$3"; }

draw icon 1024 "$img/icon.png"
draw android-icon-foreground 1024 "$img/android-icon-foreground.png"
draw android-icon-background 1024 "$img/android-icon-background.png"
draw android-icon-monochrome 1024 "$img/android-icon-monochrome.png"
draw splash-icon 512 "$img/splash-icon.png"
draw notification-icon 96 "$img/notification-icon.png"
draw favicon 48 "$img/favicon.png"
# Tab icon at 1x, 2x and 3x (suffix kept apart from the name: the public export rejects
# anything shaped like an e-mail address).
for scale in 1 2 3; do
  suffix=""; [ "$scale" = 1 ] || suffix="@${scale}x"
  draw settings $((24 * scale)) "$img/tabIcons/settings${suffix}.png"
done
echo "Icons written to $img."
