#!/bin/bash
# Omarchy Themify installer / uninstaller.
#
# Wires up the two things an unpacked extension can't do by itself:
#   1. the native-messaging host manifest in every Chromium-family profile dir
#   2. the omarchy `theme-set` hook, so theme switches push instantly
#
# It does NOT touch browser flags files by default (that would require a full
# browser restart). Pass --flags to also add --load-extension so the extension
# loads without Developer mode.

set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
EXT_ID="doiheolmnhipkonmobdifpcloeehoknb"
HOST_NAME="com.omarchy.themify"
HOST_PATH="$ROOT/native/themify-host.py"
HOOK_SRC="$ROOT/hooks/themify-theme-set"
HOOK_DST="$HOME/.config/omarchy/hooks/theme-set.d/50-themify"

# Chromium-family profile roots. Brave Origin is a distinct browser with its own
# profile root (not a Brave channel) — omitting it is a real, easy bug.
PROFILE_DIRS=(
  "$HOME/.config/chromium"
  "$HOME/.config/google-chrome"
  "$HOME/.config/google-chrome-beta"
  "$HOME/.config/google-chrome-unstable"
  "$HOME/.config/BraveSoftware/Brave-Browser"
  "$HOME/.config/BraveSoftware/Brave-Browser-Beta"
  "$HOME/.config/BraveSoftware/Brave-Browser-Nightly"
  "$HOME/.config/BraveSoftware/Brave-Origin"
  "$HOME/.config/BraveSoftware/Brave-Origin-Beta"
  "$HOME/.config/BraveSoftware/Brave-Origin-Nightly"
  "$HOME/.config/microsoft-edge"
  "$HOME/.config/microsoft-edge-dev"
)

FLAGS_TARGETS=(
  "$HOME/.config/chromium-flags.conf"
  "$HOME/.config/brave-flags.conf"
  "$HOME/.config/brave-origin-flags.conf"
  "$HOME/.config/microsoft-edge-flags.conf"
)

DO_FLAGS=0
UNINSTALL=0
for arg in "$@"; do
  case "$arg" in
    --flags) DO_FLAGS=1 ;;
    --uninstall) UNINSTALL=1 ;;
    -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
    *) echo "unknown option: $arg" >&2; exit 1 ;;
  esac
done

host_manifest() {
  # Rendered from native/com.omarchy.themify.json.template so the manifest's
  # shape lives in exactly one place. Chromium parses this file strictly: no
  # comments, no unknown keys, both placeholders substituted.
  python3 - "$ROOT/native/com.omarchy.themify.json.template" "$HOST_PATH" "$EXT_ID" <<'PY'
import json, sys
tpl, host_path, ext_id = sys.argv[1], sys.argv[2], sys.argv[3]
with open(tpl, encoding="utf-8") as fh:
    manifest = json.load(fh)
manifest.pop("_comment", None)
manifest["path"] = host_path
manifest["allowed_origins"] = [f"chrome-extension://{ext_id}/"]
print(json.dumps(manifest, indent=2))
PY
}

install_hosts() {
  local wrote=0
  for dir in "${PROFILE_DIRS[@]}"; do
    # omarchy pre-creates every profile dir, so presence proves nothing; only
    # write where a browser has actually been configured (or is Brave Origin,
    # the browser this was built for).
    [[ -d $dir ]] || continue
    mkdir -p "$dir/NativeMessagingHosts"
    host_manifest >"$dir/NativeMessagingHosts/$HOST_NAME.json"
    wrote=$((wrote + 1))
  done
  if (( wrote == 0 )); then
    echo "warning: no Chromium-family profile dirs found" >&2
    return 1
  fi
  echo "installed native host manifest in $wrote profile dir(s)"
}

remove_hosts() {
  for dir in "${PROFILE_DIRS[@]}"; do
    rm -f -- "$dir/NativeMessagingHosts/$HOST_NAME.json" 2>/dev/null || true
  done
  echo "removed native host manifests"
}

install_hook() {
  mkdir -p "$(dirname "$HOOK_DST")"
  install -m 755 "$HOOK_SRC" "$HOOK_DST"
  echo "installed theme-set hook: $HOOK_DST"
}

remove_hook() {
  rm -f -- "$HOOK_DST"
  echo "removed theme-set hook"
}

install_flags() {
  local line="--load-extension=$ROOT"
  for conf in "${FLAGS_TARGETS[@]}"; do
    # Only touch a flags file that already exists (i.e. the browser is used).
    [[ -e $conf ]] || continue
    if grep -qxF "$line" "$conf" 2>/dev/null; then
      continue
    fi
    printf '%s\n' "$line" >>"$conf"
    echo "added --load-extension to $conf"
  done
  echo "note: fully quit your browser (pkill brave-origin) for flags to apply"
}

remove_flags() {
  local line="--load-extension=$ROOT"
  for conf in "${FLAGS_TARGETS[@]}"; do
    [[ -e $conf ]] || continue
    grep -vxF "$line" "$conf" >"$conf.tmp" 2>/dev/null || true
    mv -f "$conf.tmp" "$conf" 2>/dev/null || true
  done
  echo "removed --load-extension from flags files"
}

chmod +x "$HOST_PATH" "$HOOK_SRC" 2>/dev/null || true

# Guard: key material must never sit inside the folder the browser loads
# unpacked. Chromium warns about it, and the private key is a secret — only the
# PUBLIC half belongs in manifest.json's "key" field.
if find "$ROOT" -name '*.pem' -o -name '*.der' -o -name '*.key' | grep -q .; then
  echo "WARNING: key material found inside $ROOT - move it out:" >&2
  find "$ROOT" \( -name '*.pem' -o -name '*.der' -o -name '*.key' \) >&2
  echo "  Suggested: $HOME/.config/omarchy-themify/keys/ (see native/gen-key.sh)" >&2
fi

if (( UNINSTALL )); then
  remove_hosts
  remove_hook
  (( DO_FLAGS )) && remove_flags
  echo "uninstalled."
  exit 0
fi

install_hosts
install_hook
(( DO_FLAGS )) && install_flags

cat <<EOF

Done. To load the extension:
  brave://extensions  ->  Developer mode  ->  Load unpacked  ->  $ROOT
(or re-run with --flags, then fully quit and reopen the browser)

Extension ID (pinned): $EXT_ID
EOF
