#!/usr/bin/env bash

set -euo pipefail

usage() {
  echo "Usage: scripts/verify-release-macos.sh --target <triple> --arch <arm64|x64> --version <semver> --tag <tag> --commit <sha> --output <directory>"
}

target=""
arch=""
version=""
tag=""
commit=""
output=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --target) target="${2:-}"; shift 2 ;;
    --arch) arch="${2:-}"; shift 2 ;;
    --version) version="${2:-}"; shift 2 ;;
    --tag) tag="${2:-}"; shift 2 ;;
    --commit) commit="${2:-}"; shift 2 ;;
    --output) output="${2:-}"; shift 2 ;;
    --help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

for value in "$target" "$arch" "$version" "$tag" "$commit" "$output"; do
  [[ -n "$value" ]] || { usage >&2; exit 2; }
done
[[ "$arch" == "arm64" || "$arch" == "x64" ]] || { echo "Unsupported architecture: $arch" >&2; exit 1; }
command -v jq >/dev/null || { echo "jq is required" >&2; exit 1; }
command -v codesign >/dev/null || { echo "codesign is required" >&2; exit 1; }
command -v syspolicy_check >/dev/null || { echo "syspolicy_check is required" >&2; exit 1; }

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
ffmpeg_source_binary_sha="$(jq -er '.sourceBinarySha256 | ascii_downcase | select(test("^[0-9a-f]{64}$"))' "$bundled_manifest")"
ffmpeg_source_archive_sha="$(jq -er '.sourceArchiveSha256 | ascii_downcase | select(test("^[0-9a-f]{64}$"))' "$bundled_manifest")"
ffmpeg_source_revision="$(jq -er '.sourceRevision | select(test("^[0-9a-f]{40}$"))' "$bundled_manifest")"
ffmpeg_portable="$(jq -er '.portable' "$bundled_manifest")"
ffmpeg_code_signed="$(jq -r '.codeSigned' "$bundled_manifest")"
ffmpeg_signature_mode="$(jq -r '.signatureMode' "$bundled_manifest")"
ffmpeg_trusted_signature="$(jq -r '.trustedSignature' "$bundled_manifest")"
[[ "$ffmpeg_portable" == "true" ]] || { echo "Bundled FFmpeg is not marked portable" >&2; exit 1; }
[[ "$ffmpeg_code_signed" == "true" && "$ffmpeg_signature_mode" == "adhoc" && "$ffmpeg_trusted_signature" == "false" ]] || {
  echo "Bundled FFmpeg does not have the required untrusted ad-hoc signature state"
  exit 1
}
ffmpeg_actual="$(shasum -a 256 "$bundled_ffmpeg" | awk '{print $1}')"
[[ "$ffmpeg_actual" == "$ffmpeg_expected" ]] || { echo "Bundled FFmpeg hash mismatch" >&2; exit 1; }
license_sha="$(shasum -a 256 "$bundled_license" | awk '{print $1}')"
manifest_sha="$(shasum -a 256 "$bundled_manifest" | awk '{print $1}')"

codesign --verify --deep --strict --verbose=4 "$app"
codesign --verify --strict --verbose=4 "$main_binary"
codesign --verify --strict --verbose=4 "$bundled_ffmpeg"
app_sign_details="$(codesign -dv --verbose=4 "$app" 2>&1)"
binary_sign_details="$(codesign -dv --verbose=4 "$main_binary" 2>&1)"
ffmpeg_sign_details="$(codesign -dv --verbose=4 "$bundled_ffmpeg" 2>&1)"
for details in "$app_sign_details" "$binary_sign_details" "$ffmpeg_sign_details"; do
  printf '%s\n' "$details" | grep -Fx 'Signature=adhoc' >/dev/null || {
    echo "macOS app code is not ad-hoc signed" >&2
    exit 1
  }
  if printf '%s\n' "$details" | grep -Eq '^Authority=|^TeamIdentifier=[A-Z0-9]'; then
    echo "Unsigned release unexpectedly contains a trusted Apple identity" >&2
    exit 1
  fi
done
printf '%s\n' "$app_sign_details" | grep -F 'Identifier=com.dohc.viewer' >/dev/null || {
  echo "App signature has the wrong identifier" >&2
  exit 1
}
printf '%s\n' "$app_sign_details" | grep -F 'Sealed Resources version=2' >/dev/null || {
  echo "App signature does not seal bundle resources" >&2
  exit 1
}
if codesign -dv --verbose=4 "$dmg" >/dev/null 2>&1; then
  echo "Unsigned release DMG unexpectedly contains a code signature" >&2
  exit 1
fi
if xcrun stapler validate "$app" >/dev/null 2>&1; then
  echo "Unsigned app unexpectedly contains a notarization ticket" >&2
  exit 1
fi

image_info="$(hdiutil imageinfo "$dmg")"
printf '%s\n' "$image_info" | grep -q 'UDZO' || { echo "DMG is not a compressed read-only UDZO image" >&2; exit 1; }

mount_point="$(mktemp -d "${RUNNER_TEMP:-/tmp}/dohc-viewer-dmg.XXXXXX")"
install_parent="$(mktemp -d "${RUNNER_TEMP:-/tmp}/dohc-viewer-install.XXXXXX")"
attached=false
app_pid=""
cleanup() {
  if [[ -n "$app_pid" ]] && kill -0 "$app_pid" 2>/dev/null; then kill -KILL "$app_pid" 2>/dev/null || true; fi
  if [[ "$attached" == true ]]; then hdiutil detach "$mount_point" >/dev/null 2>&1 || true; fi
  rm -rf -- "$mount_point" "$install_parent"
}
trap cleanup EXIT

hdiutil attach -readonly -nobrowse -mountpoint "$mount_point" "$dmg" >/dev/null
attached=true
[[ -L "$mount_point/Applications" ]] || { echo "DMG has no Applications link" >&2; exit 1; }
[[ "$(readlink "$mount_point/Applications")" == "/Applications" ]] || { echo "DMG Applications link is invalid" >&2; exit 1; }
mounted_app_count="$(find "$mount_point" -maxdepth 1 -type d -name '*.app' | wc -l | tr -d ' ')"
[[ "$mounted_app_count" == "1" ]] || { echo "DMG does not contain exactly one app" >&2; exit 1; }
mounted_app="$(find "$mount_point" -maxdepth 1 -type d -name '*.app' -print)"
codesign --verify --deep --strict --verbose=4 "$mounted_app"
mounted_ffmpeg_sha="$(shasum -a 256 "$mounted_app/Contents/Resources/bin/ffmpeg" | awk '{print $1}')"
[[ "$mounted_ffmpeg_sha" == "$ffmpeg_expected" ]] || { echo "DMG FFmpeg hash mismatch" >&2; exit 1; }

installed_app="$install_parent/DOHC Viewer.app"
ditto "$mounted_app" "$installed_app"
codesign --verify --deep --strict --verbose=4 "$installed_app"
quarantine_timestamp="$(printf '%x' "$(date +%s)")"
xattr -w com.apple.quarantine \
  "0081;$quarantine_timestamp;DOHC-Release-CI;https://github.com/Lr-2002/Delta-Viewer" \
  "$installed_app"
codesign --verify --deep --strict --verbose=4 "$installed_app"
set +e
gatekeeper_output="$(syspolicy_check distribution "$installed_app" 2>&1)"
gatekeeper_status=$?
set -e
[[ "$gatekeeper_status" -ne 0 ]] || {
  echo "Unsigned ad-hoc app unexpectedly passed trusted distribution policy" >&2
  exit 1
}
printf '%s\n' "$gatekeeper_output" | grep -F 'Adhoc Signed App' >/dev/null || {
  printf '%s\n' "$gatekeeper_output" >&2
  echo "Gatekeeper did not identify the expected ad-hoc signature" >&2
  exit 1
}
printf '%s\n' "$gatekeeper_output" | grep -F 'Notary Ticket Missing' >/dev/null || {
  printf '%s\n' "$gatekeeper_output" >&2
  echo "Gatekeeper did not identify the expected missing notarization ticket" >&2
  exit 1
}
if printf '%s\n' "$gatekeeper_output" | grep -Eiq 'code has no resources|invalid signature|damaged'; then
  printf '%s\n' "$gatekeeper_output" >&2
  echo "Gatekeeper reported a structurally damaged app" >&2
  exit 1
fi
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
artifact_name="DOHC-Viewer_${version}_UNSIGNED_macos-${arch}.dmg"
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
  --arg ffmpeg_source_binary_sha "$ffmpeg_source_binary_sha" \
  --arg ffmpeg_source_archive_sha "$ffmpeg_source_archive_sha" \
  --arg ffmpeg_source_revision "$ffmpeg_source_revision" \
  --arg license_sha "$license_sha" \
  --arg manifest_sha "$manifest_sha" \
  '{
    schemaVersion: 1,
    status: "passed",
    tag: $tag,
    commit: $commit,
    version: $version,
    platform: "macos",
    architecture: $architecture,
    distribution: { signingMode: "unsigned", trustedPublisher: false },
    artifact: { fileName: $artifact_name, sha256: $artifact_sha, sizeBytes: $artifact_size },
    ffmpeg: {
      sha256: $ffmpeg_sha,
      sourceBinarySha256: $ffmpeg_source_binary_sha,
      sourceArchiveSha256: $ffmpeg_source_archive_sha,
      sourceRevision: $ffmpeg_source_revision,
      licenseSha256: $license_sha,
      manifestSha256: $manifest_sha,
      portable: true,
      codeSigned: true,
      signatureMode: "adhoc",
      trustedSignature: false
    },
    signing: {
      mode: "adhoc",
      inspected: true,
      structureVerified: true,
      verified: false,
      developerId: false
    },
    notarization: { verified: false, stapled: false },
    gatekeeper: {
      quarantineApplied: true,
      assessment: "rejected-untrusted-adhoc-not-notarized",
      structuralError: false,
      userOverrideRequired: true
    },
    runtimeSmoke: { passed: true, installedCopyLaunchedSeconds: 8, quarantineApplied: true },
    minimumSystemVersion: "12.0"
  }' >"$report_path"

echo "Verified untrusted ad-hoc-sealed macOS release artifact: $artifact_path"
