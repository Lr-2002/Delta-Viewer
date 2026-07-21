#!/usr/bin/env bash

set -euo pipefail

usage() {
  echo "Usage: scripts/seal-macos-app-adhoc.sh --app <path-to-app>"
}

app=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --app) app="${2:-}"; shift 2 ;;
    --help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

[[ "$(uname -s)" == "Darwin" ]] || { echo "macOS is required" >&2; exit 2; }
[[ -n "$app" ]] || { usage >&2; exit 2; }
[[ -d "$app" && "${app##*.}" == "app" ]] || {
  echo "--app must point to an existing .app bundle: $app" >&2
  exit 2
}
command -v codesign >/dev/null || { echo "codesign is required" >&2; exit 2; }
command -v jq >/dev/null || { echo "jq is required" >&2; exit 2; }

app="$(cd "$(dirname "$app")" && pwd -P)/$(basename "$app")"
main_binary="$app/Contents/MacOS/dohc-viewer"
ffmpeg="$app/Contents/Resources/bin/ffmpeg"
manifest="$app/Contents/Resources/ffmpeg-manifest.json"
for file in "$main_binary" "$ffmpeg" "$manifest"; do
  [[ -f "$file" && -s "$file" ]] || { echo "Missing app resource: $file" >&2; exit 1; }
done
[[ -x "$main_binary" && -x "$ffmpeg" ]] || { echo "App executables are not executable" >&2; exit 1; }

bundle_id="$(plutil -extract CFBundleIdentifier raw -o - "$app/Contents/Info.plist")"
[[ "$bundle_id" == "com.dohc.viewer" ]] || { echo "Unexpected bundle ID: $bundle_id" >&2; exit 1; }

preseal_ffmpeg_sha="$(shasum -a 256 "$ffmpeg" | awk '{print $1}')"
manifest_ffmpeg_sha="$(jq -er '.sha256 | ascii_downcase | select(test("^[0-9a-f]{64}$"))' "$manifest")"
[[ "$preseal_ffmpeg_sha" == "$manifest_ffmpeg_sha" ]] || {
  echo "FFmpeg hash does not match the pre-seal manifest" >&2
  exit 1
}

codesign --force --sign - --timestamp=none "$ffmpeg"
sealed_ffmpeg_sha="$(shasum -a 256 "$ffmpeg" | awk '{print $1}')"
temporary_manifest="$(mktemp "$manifest.partial.XXXXXX")"
cleanup() {
  rm -f -- "$temporary_manifest"
}
trap cleanup EXIT
jq \
  --arg source_binary_sha256 "$preseal_ffmpeg_sha" \
  --arg sealed_sha256 "$sealed_ffmpeg_sha" \
  '.sourceBinarySha256 = $source_binary_sha256
    | .sha256 = $sealed_sha256
    | .codeSigned = true
    | .signatureMode = "adhoc"
    | .trustedSignature = false' \
  "$manifest" > "$temporary_manifest"
mv "$temporary_manifest" "$manifest"
trap - EXIT

codesign --force --sign - --options runtime --timestamp=none "$main_binary"
codesign --force --sign - --options runtime --timestamp=none "$app"
codesign --verify --deep --strict --verbose=4 "$app"

for target in "$app" "$main_binary" "$ffmpeg"; do
  details="$(codesign -dv --verbose=4 "$target" 2>&1)"
  printf '%s\n' "$details" | grep -Fx 'Signature=adhoc' >/dev/null || {
    echo "Expected an ad-hoc signature: $target" >&2
    exit 1
  }
  if printf '%s\n' "$details" | grep -Eq '^Authority=|^TeamIdentifier=[A-Z0-9]'; then
    echo "Ad-hoc app unexpectedly contains a trusted signing identity: $target" >&2
    exit 1
  fi
done

final_ffmpeg_sha="$(shasum -a 256 "$ffmpeg" | awk '{print $1}')"
final_manifest_sha="$(jq -er '.sha256 | ascii_downcase | select(test("^[0-9a-f]{64}$"))' "$manifest")"
[[ "$final_ffmpeg_sha" == "$final_manifest_sha" ]] || {
  echo "Sealed FFmpeg hash does not match its manifest" >&2
  exit 1
}

echo "Created structurally valid ad-hoc app seal: $app"
