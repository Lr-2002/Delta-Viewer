#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/build-ffmpeg-linux.sh \
  --source-archive /path/to/ffmpeg.tar.gz \
  --expected-source-sha256 <64 hex characters> \
  --source-url https://example.invalid/ffmpeg.tar.gz \
  --source-revision <40 character git revision> \
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
    --source-archive|--expected-source-sha256|--source-url|--source-revision|--build-id)
      [[ $# -ge 2 ]] || { echo "$1 requires a value" >&2; usage >&2; exit 2; }
      case "$1" in
        --source-archive) source_archive="$2" ;;
        --expected-source-sha256) expected_source_sha256="$2" ;;
        --source-url) source_url="$2" ;;
        --source-revision) source_revision="$2" ;;
        --build-id) build_id="$2" ;;
      esac
      shift 2
      ;;
    --help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

[[ -n "$source_archive" && -n "$expected_source_sha256" && -n "$source_url" && -n "$source_revision" && -n "$build_id" ]] || {
  usage >&2
  exit 2
}
[[ "$(uname -s)" == "Linux" && "$(uname -m)" == "x86_64" ]] || {
  echo "Linux x86_64 is required" >&2
  exit 2
}
for command_name in file sha256sum tar make; do
  command -v "$command_name" >/dev/null || { echo "$command_name is required" >&2; exit 2; }
done
[[ "$source_url" == https://* ]] || { echo "Source URL must use HTTPS" >&2; exit 2; }
[[ "$expected_source_sha256" =~ ^[0-9A-Fa-f]{64}$ ]] || { echo "Invalid source SHA-256" >&2; exit 2; }
[[ "$source_revision" =~ ^[0-9a-f]{40}$ ]] || { echo "Source revision must be a full lowercase Git SHA" >&2; exit 2; }
[[ -f "$source_archive" ]] || { echo "Source archive is missing: $source_archive" >&2; exit 2; }

expected_source_sha256="$(printf '%s' "$expected_source_sha256" | tr '[:upper:]' '[:lower:]')"
actual_source_sha256="$(sha256sum "$source_archive" | awk '{print $1}')"
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
temporary_root="$(mktemp -d "${RUNNER_TEMP:-/tmp}/dohc-ffmpeg-linux.XXXXXX")"
temporary_stage=""
cleanup() {
  [[ -z "$temporary_stage" ]] || rm -rf -- "$temporary_stage"
  rm -rf -- "$temporary_root"
}
trap cleanup EXIT
source_root="$temporary_root/source"
sample_root="$temporary_root/sample"
mkdir -p "$source_root" "$sample_root"
tar -xzf "$source_archive" -C "$source_root" --strip-components=1

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
    --enable-demuxer=rawvideo \
    --enable-muxer=mp4 \
    --enable-decoder=rawvideo \
    --enable-encoder=mpeg4 \
    --enable-parser=mjpeg,mpeg4video \
    --enable-filter=format,scale
  make -j"$(nproc)" ffmpeg
)

binary="$source_root/ffmpeg"
[[ -x "$binary" ]] || { echo "FFmpeg build did not produce an executable" >&2; exit 1; }
file_output="$(file "$binary")"
[[ "$file_output" == *"x86-64"* || "$file_output" == *"x86_64"* ]] || {
  echo "FFmpeg is not an x86_64 executable: $file_output" >&2
  exit 1
}
if ldd_output="$(ldd "$binary" 2>&1)"; then
  if printf '%s\n' "$ldd_output" | grep -E 'not found|/usr/local/|/opt/homebrew/' >/dev/null; then
    echo "FFmpeg has an unexpected or missing dynamic dependency:" >&2
    printf '%s\n' "$ldd_output" >&2
    exit 1
  fi
else
  echo "ldd failed for FFmpeg: $ldd_output" >&2
  exit 1
fi

frame_bytes=$((128 * 128 * 3 / 2))
dd if=/dev/zero of="$sample_root/sample.yuv" bs="$frame_bytes" count=3 status=none
"$binary" \
  -hide_banner -loglevel error -nostats -progress pipe:1 \
  -f rawvideo -pix_fmt yuv420p -video_size 128x128 -framerate 30 -i "$sample_root/sample.yuv" \
  -frames:v 3 -an -c:v mpeg4 -q:v 2 -g 2 -pix_fmt yuv420p \
  -movflags +faststart "$sample_root/output.mp4" >/dev/null
[[ -s "$sample_root/output.mp4" ]] || { echo "FFmpeg encode smoke produced no MP4" >&2; exit 1; }

version_line="$("$binary" -version 2>&1 | sed -n '1p')"
configuration_line="$("$binary" -version 2>&1 | sed -n 's/^configuration: //p' | sed -n '1p')"
[[ -n "$version_line" && -n "$configuration_line" ]] || { echo "FFmpeg version metadata is incomplete" >&2; exit 1; }
printf '%s\n' "$configuration_line" | grep -Eq -- '(^|[[:space:]])--enable-nonfree([[:space:]]|$)' && {
  echo "FFmpeg was built with --enable-nonfree" >&2
  exit 1
}
"$binary" -hide_banner -encoders 2>&1 | grep -Eq '^[[:space:]]*[A-Z.]{6}[[:space:]]+mpeg4([[:space:]]|$)' || {
  echo "FFmpeg does not provide the required mpeg4 encoder" >&2
  exit 1
}

resources_dir="$repo_root/src-tauri/resources"
temporary_stage="$(mktemp -d "$resources_dir/.ffmpeg-stage.XXXXXX")"
mkdir -p "$temporary_stage/bin" "$temporary_stage/licenses"
cp "$binary" "$temporary_stage/bin/ffmpeg"
chmod 755 "$temporary_stage/bin/ffmpeg"
{
  printf '===== LICENSE.md =====\n\n'
  cat "$source_root/LICENSE.md"
  printf '\n\n===== COPYING.LGPLv2.1 =====\n\n'
  cat "$source_root/COPYING.LGPLv2.1"
  printf '\n'
} > "$temporary_stage/licenses/FFmpeg.txt"

binary_sha256="$(sha256sum "$temporary_stage/bin/ffmpeg" | awk '{print $1}')"
license_sha256="$(sha256sum "$temporary_stage/licenses/FFmpeg.txt" | awk '{print $1}')"
node - "$temporary_stage/ffmpeg-manifest.json" "$binary_sha256" "$license_sha256" "$actual_source_sha256" "$source_revision" "$source_url" "$build_id" "$version_line" "$configuration_line" <<'NODE'
const fs = require("node:fs");
const [output, sha256, licenseSha256, sourceArchiveSha256, sourceRevision, sourceUrl, buildId, version, configuration] = process.argv.slice(2);
const manifest = {
  schemaVersion: 1,
  platform: "linux-x64",
  binaryPath: "bin/ffmpeg",
  licensePath: "licenses/FFmpeg.txt",
  sourceUrl,
  buildId,
  sha256,
  licenseSha256,
  version,
  configuration,
  encoder: "mpeg4",
  portable: true,
  architecture: "x86_64",
  licenseFiles: ["LICENSE.md", "COPYING.LGPLv2.1"],
  sourceArchiveSha256,
  sourceRevision,
  codeSigned: false,
  signatureMode: "unsigned",
  trustedSignature: false,
  stagedAtUtc: new Date().toISOString()
};
fs.writeFileSync(output, JSON.stringify(manifest, null, 2) + "\n", { encoding: "utf8", flag: "wx" });
NODE

mkdir -p "$resources_dir/bin" "$resources_dir/licenses"
mv -f "$temporary_stage/bin/ffmpeg" "$resources_dir/bin/ffmpeg"
mv -f "$temporary_stage/licenses/FFmpeg.txt" "$resources_dir/licenses/FFmpeg.txt"
mv -f "$temporary_stage/ffmpeg-manifest.json" "$resources_dir/ffmpeg-manifest.json"
echo "Built and staged Linux x86_64 FFmpeg from $source_revision"
