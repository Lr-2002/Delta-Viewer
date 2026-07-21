#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/build-ffmpeg-macos.sh \
  --source-archive /path/to/ffmpeg.tar.gz \
  --expected-source-sha256 <64 hex characters> \
  --source-url https://example.invalid/ffmpeg.tar.gz \
  --source-revision <git revision> \
  --build-id <reviewed-build-id>
EOF
}

source_archive=""
expected_source_sha256=""
source_url=""
source_revision=""
build_id=""
while (($# > 0)); do
  case "$1" in
    --source-archive) source_archive="${2:-}"; shift 2 ;;
    --expected-source-sha256) expected_source_sha256="${2:-}"; shift 2 ;;
    --source-url) source_url="${2:-}"; shift 2 ;;
    --source-revision) source_revision="${2:-}"; shift 2 ;;
    --build-id) build_id="${2:-}"; shift 2 ;;
    --help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

for value in "$source_archive" "$expected_source_sha256" "$source_url" "$source_revision" "$build_id"; do
  [[ -n "$value" ]] || { usage >&2; exit 2; }
done
[[ "$(uname -s)" == "Darwin" ]] || { echo "macOS is required" >&2; exit 2; }
command -v codesign >/dev/null || { echo "codesign is required" >&2; exit 2; }
[[ -f "$source_archive" ]] || { echo "Source archive is missing: $source_archive" >&2; exit 2; }
[[ "$source_url" == https://* ]] || { echo "Source URL must use HTTPS" >&2; exit 2; }
[[ "$expected_source_sha256" =~ ^[0-9A-Fa-f]{64}$ ]] || {
  echo "Expected source SHA-256 must contain 64 hexadecimal characters" >&2
  exit 2
}
[[ "$source_revision" =~ ^[0-9a-f]{40}$ ]] || {
  echo "Source revision must be a full lowercase Git SHA" >&2
  exit 2
}

expected_source_sha256="$(printf '%s' "$expected_source_sha256" | tr '[:upper:]' '[:lower:]')"
actual_source_sha256="$(shasum -a 256 "$source_archive" | awk '{print $1}')"
[[ "$actual_source_sha256" == "$expected_source_sha256" ]] || {
  echo "FFmpeg source archive SHA-256 mismatch" >&2
  exit 1
}
if tar -tzf "$source_archive" | grep -E '(^/|(^|/)\.\.(/|$))' >/dev/null; then
  echo "FFmpeg source archive contains an unsafe path" >&2
  exit 1
fi

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
repo_root="$(cd "$script_dir/.." && pwd -P)"
temporary_root="$(mktemp -d "${RUNNER_TEMP:-/tmp}/dohc-ffmpeg-build.XXXXXX")"
cleanup() {
  rm -rf -- "$temporary_root"
}
trap cleanup EXIT

source_root="$temporary_root/source"
sample_root="$temporary_root/sample"
mkdir -p "$source_root" "$sample_root"
tar -xzf "$source_archive" -C "$source_root" --strip-components=1

export MACOSX_DEPLOYMENT_TARGET=12.0
export TZ=UTC
(
  cd "$source_root"
  ./configure \
    --prefix="/opt/dohc-viewer/ffmpeg" \
    --disable-autodetect \
    --disable-doc \
    --disable-debug \
    --disable-network \
    --disable-everything \
    --disable-x86asm \
    --enable-ffmpeg \
    --enable-protocol=file,pipe \
    --enable-demuxer=image2 \
    --enable-muxer=mp4 \
    --enable-decoder=mjpeg \
    --enable-encoder=mpeg4 \
    --enable-parser=mjpeg,mpeg4video \
    --enable-filter=format,scale
  make -j"$(sysctl -n hw.ncpu)" ffmpeg
)

binary="$source_root/ffmpeg"
[[ -x "$binary" ]] || { echo "FFmpeg build did not produce an executable" >&2; exit 1; }
codesign --force --sign - --timestamp=none "$binary"
codesign --verify --strict --verbose=2 "$binary"
sips -s format jpeg "$repo_root/src-tauri/icons/128x128.png" --out "$sample_root/0.jpg" >/dev/null
cp "$sample_root/0.jpg" "$sample_root/1.jpg"
cp "$sample_root/0.jpg" "$sample_root/2.jpg"
"$binary" \
  -hide_banner -loglevel error -nostats -progress pipe:1 \
  -framerate 30 -start_number 0 -i "$sample_root/%d.jpg" \
  -frames:v 3 -an -c:v mpeg4 -q:v 2 -g 2 -pix_fmt yuv420p \
  -movflags +faststart "$sample_root/output.mp4" >/dev/null
[[ -s "$sample_root/output.mp4" ]] || { echo "FFmpeg encode smoke produced no MP4" >&2; exit 1; }

binary_sha256="$(shasum -a 256 "$binary" | awk '{print $1}')"
bash "$script_dir/stage-ffmpeg.sh" \
  --source "$binary" \
  --expected-sha256 "$binary_sha256" \
  --license "$source_root/LICENSE.md" \
  --license "$source_root/COPYING.LGPLv2.1" \
  --source-url "$source_url" \
  --build-id "$build_id"

manifest="$repo_root/src-tauri/resources/ffmpeg-manifest.json"
temporary_manifest="$(mktemp "$manifest.partial.XXXXXX")"
jq \
  --arg source_archive_sha256 "$actual_source_sha256" \
  --arg source_revision "$source_revision" \
  '.sourceArchiveSha256 = $source_archive_sha256
    | .sourceRevision = $source_revision
    | .codeSigned = true
    | .signatureMode = "adhoc"
    | .trustedSignature = false' \
  "$manifest" > "$temporary_manifest"
mv "$temporary_manifest" "$manifest"

echo "Built and staged FFmpeg from $source_revision"
