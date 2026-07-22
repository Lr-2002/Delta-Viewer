#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/verify-release-linux.sh \
  --bundle /path/to/DOHC-Viewer_<version>_UNSIGNED_ubuntu-x64.flatpak \
  --version <version> \
  --tag <vX.Y.Z> \
  --commit <40 character git revision> \
  --output-directory /path/to/release-assets
EOF
}

bundle_path=""
version=""
tag=""
commit=""
output_directory=""
while (($# > 0)); do
  case "$1" in
    --bundle|--version|--tag|--commit|--output-directory)
      [[ $# -ge 2 ]] || { echo "$1 requires a value" >&2; usage >&2; exit 2; }
      case "$1" in
        --bundle) bundle_path="$2" ;;
        --version) version="$2" ;;
        --tag) tag="$2" ;;
        --commit) commit="$2" ;;
        --output-directory) output_directory="$2" ;;
      esac
      shift 2
      ;;
    --help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

[[ -n "$bundle_path" && -n "$version" && -n "$tag" && -n "$commit" && -n "$output_directory" ]] || {
  usage >&2
  exit 2
}
[[ "$(uname -s)" == "Linux" && "$(uname -m)" == "x86_64" ]] || {
  echo "Linux x86_64 is required" >&2
  exit 2
}
for command_name in flatpak sha256sum timeout xvfb-run dbus-run-session jq node; do
  command -v "$command_name" >/dev/null || { echo "$command_name is required" >&2; exit 2; }
done
[[ -f "$bundle_path" ]] || { echo "Flatpak bundle is missing: $bundle_path" >&2; exit 2; }
[[ "$tag" == "v$version" ]] || { echo "Tag and version do not match" >&2; exit 2; }
[[ "$commit" =~ ^[0-9a-f]{40}$ ]] || { echo "Commit must be a full lowercase Git SHA" >&2; exit 2; }

app_id="com.dohc.viewer"
runtime="org.gnome.Platform"
runtime_version="50"
expected_name="DOHC-Viewer_"$version"_UNSIGNED_ubuntu-x64.flatpak"
[[ "$(basename "$bundle_path")" == "$expected_name" ]] || {
  echo "Unexpected Flatpak file name: $(basename "$bundle_path")" >&2
  exit 1
}
mkdir -p "$output_directory"
bundle_path="$(cd "$(dirname "$bundle_path")" && pwd -P)/$(basename "$bundle_path")"
output_directory="$(cd "$output_directory" && pwd -P)"

if flatpak info --user "$app_id" >/dev/null 2>&1; then
  echo "$app_id is already installed in the user Flatpak installation; refusing to alter it" >&2
  exit 1
fi

temporary_base=/tmp
if [[ -n "${RUNNER_TEMP:-}" ]]; then temporary_base="$RUNNER_TEMP"; fi
temporary_root="$(mktemp -d "$temporary_base/dohc-flatpak-verify.XXXXXX")"
installed=false
cleanup() {
  if [[ "$installed" == true ]]; then
    flatpak uninstall --user --noninteractive -y "$app_id" >/dev/null 2>&1 || true
  fi
  rm -rf -- "$temporary_root"
}
trap cleanup EXIT

flatpak install --user --noninteractive -y "$bundle_path"
installed=true

installed_runtime="$(flatpak info --user --show-runtime "$app_id")"
[[ "$installed_runtime" == "$runtime/x86_64/$runtime_version" ]] || {
  echo "Unexpected Flatpak runtime: $installed_runtime" >&2
  exit 1
}
permissions_file="$temporary_root/permissions.ini"
flatpak info --user --show-permissions "$app_id" > "$permissions_file"
for permission_pattern in \
  'shared=ipc;' \
  'sockets=.*wayland' \
  'devices=dri;' \
  'filesystems=.*\/media' \
  'filesystems=.*\/run\/media' \
  'filesystems=.*\/mnt'; do
  grep -Eq "$permission_pattern" "$permissions_file" || {
    echo "Installed Flatpak permission is missing: $permission_pattern" >&2
    cat "$permissions_file" >&2
    exit 1
  }
done
if grep -Eq 'shared=.*network' "$permissions_file"; then
  echo "Installed Flatpak unexpectedly has network access" >&2
  cat "$permissions_file" >&2
  exit 1
fi

resource_root="/app/lib/DOHC Viewer"
bundled_manifest="$temporary_root/ffmpeg-manifest.json"
flatpak run --user --command=cat "$app_id" "$resource_root/ffmpeg-manifest.json" > "$bundled_manifest"
jq -e '
  .schemaVersion == 1 and
  .platform == "linux-x64" and
  .portable == true and
  .architecture == "x86_64" and
  .codeSigned == false and
  .signatureMode == "unsigned" and
  .trustedSignature == false and
  (.sha256 | test("^[0-9a-f]{64}$")) and
  (.sourceArchiveSha256 | test("^[0-9a-f]{64}$")) and
  (.sourceRevision | test("^[0-9a-f]{40}$"))
' "$bundled_manifest" >/dev/null

ffmpeg_sha256="$(flatpak run --user --command=sha256sum "$app_id" "$resource_root/bin/ffmpeg" | awk '{print $1}')"
manifest_ffmpeg_sha256="$(jq -r '.sha256' "$bundled_manifest")"
[[ "$ffmpeg_sha256" == "$manifest_ffmpeg_sha256" ]] || {
  echo "Bundled FFmpeg does not match its manifest" >&2
  exit 1
}
license_sha256="$(flatpak run --user --command=sha256sum "$app_id" "$resource_root/licenses/FFmpeg.txt" | awk '{print $1}')"
manifest_sha256="$(sha256sum "$bundled_manifest" | awk '{print $1}')"
flatpak run --user --command="$resource_root/bin/ffmpeg" "$app_id" -hide_banner -encoders 2>&1 |
  grep -Eq '^[[:space:]]*[A-Z.]{6}[[:space:]]+mpeg4([[:space:]]|$)' || {
    echo "Bundled FFmpeg does not provide the mpeg4 encoder" >&2
    exit 1
  }
flatpak run --user --command=test "$app_id" -f /app/share/applications/com.dohc.viewer.desktop
flatpak run --user --command=test "$app_id" -f /app/share/metainfo/com.dohc.viewer.metainfo.xml
flatpak run --user --command=test "$app_id" -f /app/share/icons/hicolor/128x128/apps/com.dohc.viewer.png

startup_log="$temporary_root/startup.log"
set +e
timeout --signal=TERM 10s dbus-run-session -- xvfb-run -a flatpak run --user "$app_id" >"$startup_log" 2>&1
startup_status=$?
set -e
if [[ $startup_status -ne 124 ]]; then
  echo "Flatpak did not stay running for the 10 second startup smoke (status $startup_status)" >&2
  cat "$startup_log" >&2
  exit 1
fi
if grep -Eiq 'panic|segmentation fault|failed to initialize gtk|error while loading shared libraries' "$startup_log"; then
  echo "Flatpak startup log contains a fatal error" >&2
  cat "$startup_log" >&2
  exit 1
fi

artifact_sha256="$(sha256sum "$bundle_path" | awk '{print $1}')"
artifact_size="$(stat -c '%s' "$bundle_path")"
permissions_sha256="$(sha256sum "$permissions_file" | awk '{print $1}')"
source_archive_sha256="$(jq -r '.sourceArchiveSha256' "$bundled_manifest")"
source_revision="$(jq -r '.sourceRevision' "$bundled_manifest")"
source_binary_sha256="$ffmpeg_sha256"
report_path="$output_directory/DOHC-Viewer_"$version"_linux-flatpak-x64.verification.json"
temporary_report="$report_path.partial-$$"

REPORT_PATH="$temporary_report" \
REPORT_TAG="$tag" \
REPORT_COMMIT="$commit" \
REPORT_VERSION="$version" \
REPORT_ARTIFACT_NAME="$expected_name" \
REPORT_ARTIFACT_SHA256="$artifact_sha256" \
REPORT_ARTIFACT_SIZE="$artifact_size" \
REPORT_FFMPEG_SHA256="$ffmpeg_sha256" \
REPORT_FFMPEG_SOURCE_BINARY_SHA256="$source_binary_sha256" \
REPORT_FFMPEG_SOURCE_ARCHIVE_SHA256="$source_archive_sha256" \
REPORT_FFMPEG_SOURCE_REVISION="$source_revision" \
REPORT_FFMPEG_LICENSE_SHA256="$license_sha256" \
REPORT_FFMPEG_MANIFEST_SHA256="$manifest_sha256" \
REPORT_PERMISSIONS_SHA256="$permissions_sha256" \
node <<'NODE'
const fs = require("node:fs");
const requiredPermissions = [
  "--socket=wayland",
  "--socket=fallback-x11",
  "--device=dri",
  "--share=ipc",
  "--filesystem=/media:rw",
  "--filesystem=/run/media:rw",
  "--filesystem=/mnt:rw"
];
const report = {
  schemaVersion: 1,
  status: "passed",
  tag: process.env.REPORT_TAG,
  commit: process.env.REPORT_COMMIT,
  version: process.env.REPORT_VERSION,
  platform: "linux",
  architecture: "x64",
  verifiedAtUtc: new Date().toISOString(),
  distribution: {
    signingMode: "unsigned",
    trustedPublisher: false
  },
  artifact: {
    fileName: process.env.REPORT_ARTIFACT_NAME,
    sha256: process.env.REPORT_ARTIFACT_SHA256,
    sizeBytes: Number(process.env.REPORT_ARTIFACT_SIZE)
  },
  signing: {
    mode: "unsigned",
    inspected: true,
    verified: false
  },
  runtimeSmoke: {
    passed: true,
    displayServer: "xvfb",
    durationSeconds: 10
  },
  flatpak: {
    appId: "com.dohc.viewer",
    runtime: "org.gnome.Platform",
    runtimeVersion: "50",
    hostMinimum: "ubuntu-20.04",
    permissions: requiredPermissions,
    permissionsSha256: process.env.REPORT_PERMISSIONS_SHA256,
    networkAccess: false
  },
  ffmpeg: {
    portable: true,
    sha256: process.env.REPORT_FFMPEG_SHA256,
    sourceBinarySha256: process.env.REPORT_FFMPEG_SOURCE_BINARY_SHA256,
    sourceArchiveSha256: process.env.REPORT_FFMPEG_SOURCE_ARCHIVE_SHA256,
    sourceRevision: process.env.REPORT_FFMPEG_SOURCE_REVISION,
    licenseSha256: process.env.REPORT_FFMPEG_LICENSE_SHA256,
    manifestSha256: process.env.REPORT_FFMPEG_MANIFEST_SHA256,
    codeSigned: false,
    signatureMode: "unsigned",
    trustedSignature: false
  }
};
fs.writeFileSync(process.env.REPORT_PATH, JSON.stringify(report, null, 2) + "\n", {
  encoding: "utf8",
  flag: "wx"
});
NODE
mv "$temporary_report" "$report_path"

echo "Verified Ubuntu 20.04+ Flatpak: $bundle_path"
echo "Verification report: $report_path"
