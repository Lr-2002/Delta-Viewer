#!/usr/bin/env bash

set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "scripts/stage-ffmpeg.sh only supports macOS." >&2
  exit 2
fi

usage() {
  cat <<'EOF'
Usage: scripts/stage-ffmpeg.sh \
  --source /path/to/ffmpeg \
  --expected-sha256 <64 hex characters> \
  --license /path/to/license [--license /path/to/another-license] \
  --source-url https://example.invalid/ffmpeg \
  --build-id <reviewed-build-id> \
  [--allow-nonportable]

--allow-nonportable is only for local debug bundles. A manifest produced with
that option is rejected by the normal bundle release check.
EOF
}

source_path=""
expected_sha256=""
source_url=""
build_id=""
allow_nonportable=false
license_files=()

while (($# > 0)); do
  case "$1" in
    --source|--expected-sha256|--license|--source-url|--build-id)
      if (($# < 2)); then
        echo "Missing value for $1" >&2
        usage >&2
        exit 2
      fi
      case "$1" in
        --source) source_path="$2" ;;
        --expected-sha256) expected_sha256="$2" ;;
        --license) license_files+=("$2") ;;
        --source-url) source_url="$2" ;;
        --build-id) build_id="$2" ;;
      esac
      shift 2
      ;;
    --allow-nonportable)
      allow_nonportable=true
      shift
      ;;
    --help)
      usage
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [[ -z "$source_path" || -z "$expected_sha256" || -z "$source_url" || -z "$build_id" ]]; then
  echo "Source, SHA-256, source URL, and build ID are required." >&2
  usage >&2
  exit 2
fi
if ((${#license_files[@]} == 0)); then
  echo "At least one --license file is required." >&2
  exit 2
fi
if [[ "$source_url" != https://* ]]; then
  echo "FFmpeg source URL must use HTTPS." >&2
  exit 2
fi
if [[ ! -f "$source_path" || ! -x "$source_path" ]]; then
  echo "FFmpeg source must be an executable file: $source_path" >&2
  exit 2
fi

expected_sha256="$(printf '%s' "$expected_sha256" | tr '[:upper:]' '[:lower:]')"
if [[ ! "$expected_sha256" =~ ^[0-9a-f]{64}$ ]]; then
  echo "Expected SHA-256 must contain exactly 64 hexadecimal characters." >&2
  exit 2
fi

for license_file in "${license_files[@]}"; do
  if [[ ! -s "$license_file" ]]; then
    echo "License file is missing or empty: $license_file" >&2
    exit 2
  fi
done

actual_sha256="$(shasum -a 256 "$source_path" | awk '{print $1}')"
if [[ "$actual_sha256" != "$expected_sha256" ]]; then
  echo "FFmpeg SHA-256 mismatch: expected $expected_sha256, got $actual_sha256" >&2
  exit 1
fi

version_output="$("$source_path" -version 2>&1)"
version_line="$(printf '%s\n' "$version_output" | sed -n '1p')"
configuration_line="$(printf '%s\n' "$version_output" | sed -n 's/^configuration: //p' | sed -n '1p')"
if [[ -z "$version_line" || -z "$configuration_line" ]]; then
  echo "FFmpeg did not report a version and configuration." >&2
  exit 1
fi
if printf '%s\n' "$configuration_line" | grep -Eq -- '(^|[[:space:]])--enable-nonfree([[:space:]]|$)'; then
  echo "FFmpeg was built with --enable-nonfree and cannot be staged." >&2
  exit 1
fi

encoder_output="$("$source_path" -hide_banner -encoders 2>&1)"
if ! printf '%s\n' "$encoder_output" | grep -Eq '^[[:space:]]*[A-Z.]{6}[[:space:]]+mpeg4([[:space:]]|$)'; then
  echo "FFmpeg does not provide the required mpeg4 encoder." >&2
  exit 1
fi

machine="$(uname -m)"
file_output="$(file "$source_path")"
case "$machine" in
  arm64)
    if [[ "$file_output" != *"arm64"* ]]; then
      echo "FFmpeg does not contain the host arm64 architecture: $file_output" >&2
      exit 1
    fi
    node_arch="arm64"
    ;;
  x86_64)
    if [[ "$file_output" != *"x86_64"* ]]; then
      echo "FFmpeg does not contain the host x86_64 architecture: $file_output" >&2
      exit 1
    fi
    node_arch="x64"
    ;;
  *)
    echo "Unsupported macOS architecture: $machine" >&2
    exit 1
    ;;
esac

external_dependencies=()
while IFS= read -r dependency; do
  [[ -z "$dependency" ]] && continue
  case "$dependency" in
    /System/Library/*|/usr/lib/*) ;;
    *) external_dependencies+=("$dependency") ;;
  esac
done < <(otool -L "$source_path" | sed -n '2,$s/^[[:space:]]*\([^[:space:]]*\).*/\1/p')

portable=true
if ((${#external_dependencies[@]} > 0)); then
  portable=false
  echo "FFmpeg has non-system dynamic dependencies:" >&2
  printf '  %s\n' "${external_dependencies[@]}" >&2
  if [[ "$allow_nonportable" != true ]]; then
    echo "Use a portable build, or pass --allow-nonportable for a local debug bundle only." >&2
    exit 1
  fi
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
resources_dir="$(cd "$script_dir/../src-tauri" && pwd -P)/resources"
mkdir -p "$resources_dir"
temporary="$(mktemp -d "$resources_dir/.ffmpeg-stage.XXXXXX")"
cleanup() {
  rm -rf -- "$temporary"
}
trap cleanup EXIT

mkdir -p "$temporary/bin" "$temporary/licenses"
cp "$source_path" "$temporary/bin/ffmpeg"
chmod 755 "$temporary/bin/ffmpeg"

license_bundle="$temporary/licenses/FFmpeg.txt"
: > "$license_bundle"
for license_file in "${license_files[@]}"; do
  {
    printf '===== %s =====\n\n' "$(basename "$license_file")"
    cat "$license_file"
    printf '\n\n'
  } >> "$license_bundle"
done

staged_sha256="$(shasum -a 256 "$temporary/bin/ffmpeg" | awk '{print $1}')"
if [[ "$staged_sha256" != "$expected_sha256" ]]; then
  echo "Staged FFmpeg failed SHA-256 readback." >&2
  exit 1
fi

license_names=""
for license_file in "${license_files[@]}"; do
  if [[ -n "$license_names" ]]; then
    license_names+=$'\n'
  fi
  license_names+="$(basename "$license_file")"
done

FFMPEG_PLATFORM="darwin-$node_arch" \
FFMPEG_SOURCE_URL="$source_url" \
FFMPEG_BUILD_ID="$build_id" \
FFMPEG_SHA256="$actual_sha256" \
FFMPEG_VERSION="$version_line" \
FFMPEG_CONFIGURATION="$configuration_line" \
FFMPEG_PORTABLE="$portable" \
FFMPEG_ARCHITECTURE="$machine" \
FFMPEG_LICENSE_NAMES="$license_names" \
node - "$temporary/ffmpeg-manifest.json" <<'NODE'
const fs = require("node:fs");
const output = process.argv[2];
const manifest = {
  schemaVersion: 1,
  platform: process.env.FFMPEG_PLATFORM,
  binaryPath: "bin/ffmpeg",
  licensePath: "licenses/FFmpeg.txt",
  sourceUrl: process.env.FFMPEG_SOURCE_URL,
  buildId: process.env.FFMPEG_BUILD_ID,
  sha256: process.env.FFMPEG_SHA256,
  version: process.env.FFMPEG_VERSION,
  configuration: process.env.FFMPEG_CONFIGURATION,
  encoder: "mpeg4",
  portable: process.env.FFMPEG_PORTABLE === "true",
  architecture: process.env.FFMPEG_ARCHITECTURE,
  licenseFiles: process.env.FFMPEG_LICENSE_NAMES.split("\n"),
  stagedAtUtc: new Date().toISOString(),
};
fs.writeFileSync(output, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
NODE

mkdir -p "$resources_dir/bin" "$resources_dir/licenses"
mv -f "$temporary/bin/ffmpeg" "$resources_dir/bin/ffmpeg"
mv -f "$temporary/licenses/FFmpeg.txt" "$resources_dir/licenses/FFmpeg.txt"
mv -f "$temporary/ffmpeg-manifest.json" "$resources_dir/ffmpeg-manifest.json"

echo "$version_line"
echo "Staged FFmpeg at $resources_dir/bin/ffmpeg"
echo "SHA-256: $actual_sha256"
echo "Portable: $portable"
