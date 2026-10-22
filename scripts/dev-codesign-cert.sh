#!/usr/bin/env bash
# Creates a SELF-SIGNED code-signing certificate for testing the signing pipeline only.
# Windows will still show SmartScreen / "Unknown publisher" for builds signed with it.
# Usage: docker compose run --rm dev bash scripts/dev-codesign-cert.sh
# Then:  CSC_LINK=.secrets/corvus-dev-codesign.pfx CSC_KEY_PASSWORD=<printed> docker compose --profile release run --rm builder
set -euo pipefail
cd "$(dirname "$0")/.."
mkdir -p .secrets
out=.secrets/corvus-dev-codesign
pass="$(openssl rand -hex 16)"
openssl req -x509 -newkey rsa:3072 -sha256 -days 365 -nodes \
  -keyout "$out.key" -out "$out.crt" \
  -subj "/CN=Corvus Development (self-signed)/O=Parendum" \
  -addext "keyUsage=critical,digitalSignature" \
  -addext "extendedKeyUsage=codeSigning" 2>/dev/null
openssl pkcs12 -export -out "$out.pfx" -inkey "$out.key" -in "$out.crt" -passout "pass:$pass"
rm -f "$out.key"
printf '%s\n' "$pass" > "$out.password"
chmod 600 "$out.pfx" "$out.password"
echo "Created $out.pfx (password in $out.password)"
