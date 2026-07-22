#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/verify-release-deb.sh \
  --deb /path/to/DOHC-Viewer_<version>_UNSIGNED_ubuntu-22.04+-x64.deb \
  --version <version> \
  --tag <vX.Y.Z> \
  --commit <40 character git revision> \
  --output-directory /path/to/release-assets
EOF
}

deb_path=""
version=""
tag=""
commit=""
output_directory=""
while (($# > 0)); do
  case "$1" in
    --deb|--version|--tag|--commit|--output-directory)
      [[ $# -ge 2 ]] || { echo "$1 requires a value" >&2; usage >&2; exit 2; }
      case "$1" in
        --deb) deb_path="$2" ;;
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

[[ -n "$deb_path" && -n "$version" && -n "$tag" && -n "$commit" && -n "$output_directory" ]] || {
  usage >&2
  exit 2
}
[[ "$(uname -s)" == "Linux" && "$(uname -m)" == "x86_64" ]] || {
  echo "Linux x86_64 is required" >&2
  exit 2
}
for command_name in ar dbus-run-session dpkg-deb dpkg-query file jq ldd node sha256sum timeout xvfb-run; do
  command -v "$command_name" >/dev/null || { echo "$command_name is required" >&2; exit 2; }
done
[[ -f "$deb_path" ]] || { echo "Debian package is missing: $deb_path" >&2; exit 2; }
[[ "$tag" == "v$version" ]] || { echo "Tag and version do not match" >&2; exit 2; }
[[ "$commit" =~ ^[0-9a-f]{40}$ ]] || { echo "Commit must be a full lowercase Git SHA" >&2; exit 2; }

host_id="$(. /etc/os-release; printf '%s' "$ID")"
host_version="$(. /etc/os-release; printf '%s' "$VERSION_ID")"
[[ "$host_id" == "ubuntu" && "$host_version" == "22.04" ]] || {
  echo "The release deb must be built and verified on Ubuntu 22.04, got $host_id $host_version" >&2
  exit 1
}

expected_name="DOHC-Viewer_${version}_UNSIGNED_ubuntu-22.04+-x64.deb"
[[ "$(basename "$deb_path")" == "$expected_name" ]] || {
  echo "Unexpected Debian package file name: $(basename "$deb_path")" >&2
  exit 1
}
mkdir -p "$output_directory"
deb_path="$(cd "$(dirname "$deb_path")" && pwd -P)/$(basename "$deb_path")"
output_directory="$(cd "$output_directory" && pwd -P)"

package_name="$(dpkg-deb -f "$deb_path" Package)"
package_version="$(dpkg-deb -f "$deb_path" Version)"
package_architecture="$(dpkg-deb -f "$deb_path" Architecture)"
package_dependencies="$(dpkg-deb -f "$deb_path" Depends)"
[[ "$package_name" == "dohc-viewer" ]] || { echo "Unexpected package name: $package_name" >&2; exit 1; }
[[ "$package_version" == "$version" ]] || { echo "Unexpected package version: $package_version" >&2; exit 1; }
[[ "$package_architecture" == "amd64" ]] || { echo "Unexpected package architecture: $package_architecture" >&2; exit 1; }
for dependency in libwebkit2gtk-4.1-0 libgtk-3-0 libayatana-appindicator3-1 librsvg2-2; do
  grep -Eq "(^|, )[[:space:]]*$dependency([[:space:]]|,|$)" <<<"$package_dependencies" || {
    echo "Debian package dependency is missing: $dependency" >&2
    exit 1
  }
done
if ar t "$deb_path" | grep -Eq '^_gpg'; then
  echo "Debian package unexpectedly contains a signature member" >&2
  exit 1
fi
if dpkg-query -W -f='${Status}' "$package_name" 2>/dev/null | grep -q 'install ok installed'; then
  echo "$package_name is already installed; refusing to alter it" >&2
  exit 1
fi

temporary_base=/tmp
if [[ -n "${RUNNER_TEMP:-}" ]]; then temporary_base="$RUNNER_TEMP"; fi
temporary_root="$(mktemp -d "$temporary_base/dohc-deb-verify.XXXXXX")"
installed=false
cleanup() {
  if [[ "$installed" == true ]]; then
    sudo dpkg --remove "$package_name" >/dev/null 2>&1 || true
  fi
  rm -rf -- "$temporary_root"
}
trap cleanup EXIT

sudo apt-get install --yes "$deb_path"
installed=true

installed_version="$(dpkg-query -W -f='${Version}' "$package_name")"
installed_architecture="$(dpkg-query -W -f='${Architecture}' "$package_name")"
[[ "$installed_version" == "$version" ]] || { echo "Installed version is $installed_version" >&2; exit 1; }
[[ "$installed_architecture" == "amd64" ]] || { echo "Installed architecture is $installed_architecture" >&2; exit 1; }

installed_files="$temporary_root/installed-files.txt"
dpkg-query -L "$package_name" > "$installed_files"
binary_path="$(awk '$0 == "/usr/bin/dohc-viewer" { print; exit }' "$installed_files")"
manifest_path="$(awk '/\/ffmpeg-manifest\.json$/ { print; exit }' "$installed_files")"
desktop_path="$(awk '/\/usr\/share\/applications\/.*\.desktop$/ { print; exit }' "$installed_files")"
metainfo_path="$(awk '$0 == "/usr/share/metainfo/com.dohc.viewer.metainfo.xml" { print; exit }' "$installed_files")"
icon_path="$(awk '/\/usr\/share\/icons\/hicolor\/128x128\/apps\/.*\.png$/ { print; exit }' "$installed_files")"
for installed_path in "$binary_path" "$manifest_path" "$desktop_path" "$metainfo_path" "$icon_path"; do
  [[ -n "$installed_path" && -f "$installed_path" ]] || {
    echo "Installed Debian package is missing a required application file" >&2
    cat "$installed_files" >&2
    exit 1
  }
done

file "$binary_path" | grep -Eq 'ELF 64-bit.*x86-64' || {
  echo "Installed application is not an x86-64 ELF binary" >&2
  exit 1
}
ldd_output="$temporary_root/ldd.txt"
ldd "$binary_path" > "$ldd_output"
if grep -q 'not found' "$ldd_output"; then
  echo "Installed application has unresolved shared libraries" >&2
  cat "$ldd_output" >&2
  exit 1
fi

resource_root="$(dirname "$manifest_path")"
ffmpeg_path="$resource_root/bin/ffmpeg"
license_path="$resource_root/licenses/FFmpeg.txt"
[[ -x "$ffmpeg_path" && -s "$license_path" ]] || {
  echo "Installed Debian package is missing FFmpeg or its license" >&2
  exit 1
}
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
' "$manifest_path" >/dev/null

ffmpeg_sha256="$(sha256sum "$ffmpeg_path" | awk '{print $1}')"
manifest_ffmpeg_sha256="$(jq -r '.sha256' "$manifest_path")"
[[ "$ffmpeg_sha256" == "$manifest_ffmpeg_sha256" ]] || {
  echo "Bundled FFmpeg does not match its manifest" >&2
  exit 1
}
license_sha256="$(sha256sum "$license_path" | awk '{print $1}')"
manifest_sha256="$(sha256sum "$manifest_path" | awk '{print $1}')"
"$ffmpeg_path" -hide_banner -encoders 2>&1 |
  grep -Eq '^[[:space:]]*[A-Z.]{6}[[:space:]]+mpeg4([[:space:]]|$)' || {
    echo "Bundled FFmpeg does not provide the mpeg4 encoder" >&2
    exit 1
  }

startup_log="$temporary_root/startup.log"
set +e
timeout --signal=TERM 10s dbus-run-session -- xvfb-run -a "$binary_path" >"$startup_log" 2>&1
startup_status=$?
set -e
if [[ $startup_status -ne 124 ]]; then
  echo "Installed Debian application did not stay running for the 10 second startup smoke (status $startup_status)" >&2
  cat "$startup_log" >&2
  exit 1
fi
if grep -Eiq 'panic|segmentation fault|failed to initialize gtk|error while loading shared libraries' "$startup_log"; then
  echo "Debian application startup log contains a fatal error" >&2
  cat "$startup_log" >&2
  exit 1
fi

artifact_sha256="$(sha256sum "$deb_path" | awk '{print $1}')"
artifact_size="$(stat -c '%s' "$deb_path")"
source_archive_sha256="$(jq -r '.sourceArchiveSha256' "$manifest_path")"
source_revision="$(jq -r '.sourceRevision' "$manifest_path")"
report_path="$output_directory/DOHC-Viewer_${version}_linux-deb-x64.verification.json"
temporary_report="$report_path.partial-$$"

REPORT_PATH="$temporary_report" \
REPORT_TAG="$tag" \
REPORT_COMMIT="$commit" \
REPORT_VERSION="$version" \
REPORT_ARTIFACT_NAME="$expected_name" \
REPORT_ARTIFACT_SHA256="$artifact_sha256" \
REPORT_ARTIFACT_SIZE="$artifact_size" \
REPORT_PACKAGE_NAME="$package_name" \
REPORT_PACKAGE_VERSION="$package_version" \
REPORT_PACKAGE_ARCHITECTURE="$package_architecture" \
REPORT_PACKAGE_DEPENDENCIES="$package_dependencies" \
REPORT_HOST_VERSION="$host_version" \
REPORT_FFMPEG_SHA256="$ffmpeg_sha256" \
REPORT_FFMPEG_SOURCE_ARCHIVE_SHA256="$source_archive_sha256" \
REPORT_FFMPEG_SOURCE_REVISION="$source_revision" \
REPORT_FFMPEG_LICENSE_SHA256="$license_sha256" \
REPORT_FFMPEG_MANIFEST_SHA256="$manifest_sha256" \
node <<'NODE'
const fs = require("node:fs");
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
  deb: {
    packageName: process.env.REPORT_PACKAGE_NAME,
    packageVersion: process.env.REPORT_PACKAGE_VERSION,
    packageArchitecture: process.env.REPORT_PACKAGE_ARCHITECTURE,
    hostMinimum: "ubuntu-22.04",
    verifiedHost: `ubuntu-${process.env.REPORT_HOST_VERSION}`,
    dependencies: process.env.REPORT_PACKAGE_DEPENDENCIES
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
    installationMethod: "apt-local-deb",
    sandboxed: false
  },
  ffmpeg: {
    portable: true,
    sha256: process.env.REPORT_FFMPEG_SHA256,
    sourceBinarySha256: process.env.REPORT_FFMPEG_SHA256,
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

echo "Verified Ubuntu 22.04+ Debian package: $deb_path"
echo "Verification report: $report_path"
