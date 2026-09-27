#!/bin/bash
# Regenerate the extension's pinned ID keypair — SAFELY, outside the extension
# folder.
#
# Why this matters: the browser warns (and you should not) when key material
# sits inside a folder loaded with "Load unpacked". Only the PUBLIC half may
# ever live in the repo, as the manifest's "key" field. The private half is a
# secret: anything that can sign with it can impersonate the extension.
#
# Writes to $KEYDIR (default ~/.config/omarchy-themify/keys), never into the
# extension folder. Run this only if you want to CHANGE the extension ID — the
# ID derives from the key, so a new key means every native-host manifest must be
# updated with the new allowed_origins.

set -euo pipefail

KEYDIR="${OMARCHY_THEMIFY_KEYDIR:-$HOME/.config/omarchy-themify/keys}"

mkdir -p "$KEYDIR"
chmod 700 "$KEYDIR"

if [[ -e "$KEYDIR/key.pem" ]]; then
  echo "refusing to overwrite existing key at $KEYDIR/key.pem" >&2
  echo "(a new key changes the extension ID and invalidates installed host manifests)" >&2
  exit 1
fi

openssl genpkey -algorithm ed25519 -out "$KEYDIR/key.pem"
openssl pkey -in "$KEYDIR/key.pem" -pubout -outform DER -out "$KEYDIR/spki.der"
chmod 600 "$KEYDIR/key.pem" "$KEYDIR/spki.der"

read -r KEY_B64 EXT_ID < <(python3 - "$KEYDIR/spki.der" <<'PY'
import base64, hashlib, sys

der = open(sys.argv[1], "rb").read()
digest = hashlib.sha256(der).digest()[:16]
alpha = "abcdefghijklmnop"
ext_id = "".join(alpha[b >> 4] + alpha[b & 15] for b in digest)
print(base64.b64encode(der).decode(), ext_id)
PY
)

echo
echo "Private key: $KEYDIR/key.pem   (0600 - never commit, never place in the extension folder)"
echo "Public half: $KEYDIR/spki.der  (safe to publish)"
echo
echo "Put this in manifest.json as \"key\":"
echo "  $KEY_B64"
echo
echo "Extension ID will become: $EXT_ID"
echo "Then re-run ./install.sh so host manifests carry the right allowed_origins."
