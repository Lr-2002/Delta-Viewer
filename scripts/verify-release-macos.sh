#!/usr/bin/env bash

set -euo pipefail

usage() {
  echo "Usage: scripts/verify-release-macos.sh --target <triple> --arch <arm64|x64> --version <semver> --tag <tag> --commit <sha> --team-id <id> --output <directory>"
}

target=""
arch=""
version=""
tag=""
commit=""
team_id=""
output=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --target) target="${2:-}"; shift 2 ;;
    --arch) arch="${2:-}"; shift 2 ;;
    --version) version="${2:-}"; shift 2 ;;
    --tag) tag="${2:-}"; shift 2 ;;
    --commit) commit="${2:-}"; shift 2 ;;
    --team-id) team_id="${2:-}"; shift 2 ;;
    --output) output="${2:-}"; shift 2 ;;
    --help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

for value in "$target" "$arch" "$version" "$tag" "$commit" "$team_id" "$output"; do
  [[ -n "$value" ]] || { usage >&2; exit 2; }
done
[[ "$arch" == "arm64" || "$arch" == "x64" ]] || { echo "Unsupported architecture: $arch" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }

repo_root="$(cd "$(dirname "$0")/.." && pwd)"
bundle_root="$repo_root/src-tauri/target/$target/release/bundle"
app_count="$(find "$bundle_root/macos" -maxdepth 1 -type d -name '*.app' 2>/dev/null | wc -l | tr -d ' ')"
dmg_count="$(find "$bundle_root/dmg" -maxdepth 1 -type f -name '*.dmg' 2>/dev/null | wc -l | tr -d ' ')"
[[ "$app_count" == "1" ]] || { echo "Expected one macOS app, found $app_count" >&2; exit 1; }
[[ "$dmg_count" == "1" ]] || { echo "Expected one DMG, found $dmg_count" >&2; exit 1; }
app="$(find "$bundle_root/macos" -maxdepth 1 -type d -name '*.app' -print)"
dmg="$(find "$bundle_root/dmg" -maxdepth 1 -type f -name '*.dmg' -print)"

main_binary="$app/Contents/MacOS/dohc-viewer"
bundled_ffmpeg="$app/Contents/Resources/bin/ffmpeg"
bundled_license="$app/Contents/Resources/licenses/FFmpeg.txt"
bundled_manifest="$app/Contents/Resources/ffmpeg-manifest.json"
for file in "$main_binary" "$bundled_ffmpeg" "$bundled_license" "$bundled_manifest"; do
  [[ -f "$file" && -s "$file" ]] || { echo "Missing bundle file: $file" >&2; exit 1; }
done

actual_version="$(plutil -extract CFBundleShortVersionString raw -o - "$app/Contents/Info.plist")"
minimum_version="$(plutil -extract LSMinimumSystemVersion raw -o - "$app/Contents/Info.plist")"
bundle_id="$(plutil -extract CFBundleIdentifier raw -o - "$app/Contents/Info.plist")"
[[ "$actual_version" == "$version" ]] || { echo "App version $actual_version != $version" >&2; exit 1; }
[[ "$minimum_version" == "12.0" ]] || { echo "Minimum macOS version is not 12.0" >&2; exit 1; }
[[ "$bundle_id" == "com.dohc.viewer" ]] || { echo "Unexpected bundle ID: $bundle_id" >&2; exit 1; }

expected_lipo_arch="x86_64"
[[ "$arch" == "arm64" ]] && expected_lipo_arch="arm64"
lipo -archs "$main_binary" | tr ' ' '\n' | grep -Fx "$expected_lipo_arch" >/dev/null
lipo -archs "$bundled_ffmpeg" | tr ' ' '\n' | grep -Fx "$expected_lipo_arch" >/dev/null

ffmpeg_expected="$(jq -er '.sha256 | ascii_downcase | select(test("^[0-9a-f]{64}$"))' "$bundled_manifest")"
ffmpeg_source_sha="$(jq -er '.sourceSha256 | ascii_downcase | select(test("^[0-9a-f]{64}$"))' "$bundled_manifest")"
ffmpeg_portable="$(jq -er '.portable' "$bundled_manifest")"
ffmpeg_code_signed="$(jq -er '.codeSigned' "$bundled_manifest")"
[[ "$ffmpeg_portable" == "true" ]] || { echo "Bundled FFmpeg is not marked portable" >&2; exit 1; }
[[ "$ffmpeg_code_signed" == "true" ]] || { echo "Bundled FFmpeg is not marked code-signed" >&2; exit 1; }
ffmpeg_actual="$(shasum -a 256 "$bundled_ffmpeg" | awk '{print $1}')"
[[ "$ffmpeg_actual" == "$ffmpeg_expected" ]] || { echo "Bundled FFmpeg hash mismatch" >&2; exit 1; }
license_sha="$(shasum -a 256 "$bundled_license" | awk '{print $1}')"
manifest_sha="$(shasum -a 256 "$bundled_manifest" | awk '{print $1}')"

codesign --verify --deep --strict --verbose=2 "$app"
sign_details="$(codesign -dv --verbose=4 "$app" 2>&1)"
signer="$(printf '%s\n' "$sign_details" | sed -n 's/^Authority=//p' | head -1)"
signed_team="$(printf '%s\n' "$sign_details" | sed -n 's/^TeamIdentifier=//p' | head -1)"
signature_timestamp="$(printf '%s\n' "$sign_details" | sed -n 's/^Timestamp=//p' | head -1)"
[[ "$signer" == Developer\ ID\ Application:* ]] || { echo "App is not signed with Developer ID Application" >&2; exit 1; }
[[ "$signed_team" == "$team_id" ]] || { echo "Signed TeamIdentifier $signed_team != $team_id" >&2; exit 1; }
[[ -n "$signature_timestamp" ]] || { echo "App signature has no secure timestamp" >&2; exit 1; }
codesign --verify --strict --verbose=2 "$bundled_ffmpeg"
ffmpeg_sign_details="$(codesign -dv --verbose=4 "$bundled_ffmpeg" 2>&1)"
ffmpeg_signer="$(printf '%s\n' "$ffmpeg_sign_details" | sed -n 's/^Authority=//p' | head -1)"
ffmpeg_team="$(printf '%s\n' "$ffmpeg_sign_details" | sed -n 's/^TeamIdentifier=//p' | head -1)"
ffmpeg_timestamp="$(printf '%s\n' "$ffmpeg_sign_details" | sed -n 's/^Timestamp=//p' | head -1)"
[[ "$ffmpeg_signer" == Developer\ ID\ Application:* && "$ffmpeg_team" == "$team_id" && -n "$ffmpeg_timestamp" ]] || {
  echo "Bundled FFmpeg is not signed by the release Developer ID" >&2
  exit 1
}
spctl --assess --type execute --verbose=4 "$app"
xcrun stapler validate "$app"

image_info="$(hdiutil imageinfo "$dmg")"
printf '%s\n' "$image_info" | grep -q 'UDZO' || { echo "DMG is not a compressed read-only UDZO image" >&2; exit 1; }
codesign --verify --strict --verbose=2 "$dmg"
dmg_sign_details="$(codesign -dv --verbose=4 "$dmg" 2>&1)"
dmg_signer="$(printf '%s\n' "$dmg_sign_details" | sed -n 's/^Authority=//p' | head -1)"
dmg_team="$(printf '%s\n' "$dmg_sign_details" | sed -n 's/^TeamIdentifier=//p' | head -1)"
dmg_timestamp="$(printf '%s\n' "$dmg_sign_details" | sed -n 's/^Timestamp=//p' | head -1)"
[[ "$dmg_signer" == Developer\ ID\ Application:* && "$dmg_team" == "$team_id" && -n "$dmg_timestamp" ]] || {
  echo "DMG does not have the expected timestamped Developer ID signature" >&2
  exit 1
}
spctl --assess --type open --context context:primary-signature --verbose=4 "$dmg"

mount_point="$(mktemp -d "${RUNNER_TEMP:-/tmp}/dohc-viewer-dmg.XXXXXX")"
install_parent="$(mktemp -d "${RUNNER_TEMP:-/tmp}/dohc-viewer-install.XXXXXX")"
attached=false
app_pid=""
cleanup() {
  if [[ -n "$app_pid" ]] && kill -0 "$app_pid" 2>/dev/null; then kill -KILL "$app_pid" 2>/dev/null || true; fi
  if [[ "$attached" == true ]]; then hdiutil detach "$mount_point" >/dev/null 2>&1 || true; fi
  rmdir "$mount_point" 2>/dev/null || true
}
trap cleanup EXIT

hdiutil attach -readonly -nobrowse -mountpoint "$mount_point" "$dmg" >/dev/null
attached=true
[[ -L "$mount_point/Applications" ]] || { echo "DMG has no Applications link" >&2; exit 1; }
[[ "$(readlink "$mount_point/Applications")" == "/Applications" ]] || { echo "DMG Applications link is invalid" >&2; exit 1; }
mounted_app_count="$(find "$mount_point" -maxdepth 1 -type d -name '*.app' | wc -l | tr -d ' ')"
[[ "$mounted_app_count" == "1" ]] || { echo "DMG does not contain exactly one app" >&2; exit 1; }
mounted_app="$(find "$mount_point" -maxdepth 1 -type d -name '*.app' -print)"
codesign --verify --deep --strict --verbose=2 "$mounted_app"
mounted_ffmpeg_sha="$(shasum -a 256 "$mounted_app/Contents/Resources/bin/ffmpeg" | awk '{print $1}')"
[[ "$mounted_ffmpeg_sha" == "$ffmpeg_expected" ]] || { echo "DMG FFmpeg hash mismatch" >&2; exit 1; }

installed_app="$install_parent/DOHC Viewer.app"
ditto "$mounted_app" "$installed_app"
codesign --verify --deep --strict --verbose=2 "$installed_app"
spctl --assess --type execute --verbose=4 "$installed_app"
runtime_log="$install_parent/runtime.log"
"$installed_app/Contents/MacOS/dohc-viewer" >"$runtime_log" 2>&1 &
app_pid=$!
sleep 8
if ! kill -0 "$app_pid" 2>/dev/null; then
  wait "$app_pid" || true
  cat "$runtime_log" >&2
  echo "Installed macOS app exited during startup smoke" >&2
  exit 1
fi
kill -TERM "$app_pid" 2>/dev/null || true
sleep 1
if kill -0 "$app_pid" 2>/dev/null; then kill -KILL "$app_pid" 2>/dev/null || true; fi
wait "$app_pid" 2>/dev/null || true
app_pid=""

hdiutil detach "$mount_point" >/dev/null
attached=false
rmdir "$mount_point"

mkdir -p "$output"
artifact_name="DOHC-Viewer_${version}_macos-${arch}.dmg"
artifact_path="$output/$artifact_name"
[[ ! -e "$artifact_path" ]] || { echo "Output already exists: $artifact_path" >&2; exit 1; }
cp "$dmg" "$artifact_path"
artifact_sha="$(shasum -a 256 "$artifact_path" | awk '{print $1}')"
artifact_size="$(stat -f '%z' "$artifact_path")"
report_path="$output/DOHC-Viewer_${version}_macos-${arch}.verification.json"

jq -n \
  --arg tag "$tag" \
  --arg commit "$commit" \
  --arg version "$version" \
  --arg architecture "$arch" \
  --arg artifact_name "$artifact_name" \
  --arg artifact_sha "$artifact_sha" \
  --argjson artifact_size "$artifact_size" \
  --arg ffmpeg_sha "$ffmpeg_actual" \
  --arg ffmpeg_source_sha "$ffmpeg_source_sha" \
  --arg license_sha "$license_sha" \
  --arg manifest_sha "$manifest_sha" \
  --arg signer "$signer" \
  --arg team "$signed_team" \
  --arg signature_timestamp "$signature_timestamp" \
  --arg dmg_signer "$dmg_signer" \
  '{
    schemaVersion: 1,
    status: "passed",
    tag: $tag,
    commit: $commit,
    version: $version,
    platform: "macos",
    architecture: $architecture,
    artifact: { fileName: $artifact_name, sha256: $artifact_sha, sizeBytes: $artifact_size },
    ffmpeg: { sha256: $ffmpeg_sha, sourceSha256: $ffmpeg_source_sha, licenseSha256: $license_sha, manifestSha256: $manifest_sha, portable: true, codeSigned: true },
    signing: { verified: true, signer: $signer, dmgSigner: $dmg_signer, teamIdentifier: $team, secureTimestamp: $signature_timestamp },
    notarization: { verified: true, stapled: true },
    runtimeSmoke: { passed: true, installedCopyLaunchedSeconds: 8 },
    minimumSystemVersion: "12.0"
  }' >"$report_path"

echo "Verified macOS release artifact: $artifact_path"
