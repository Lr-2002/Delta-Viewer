#!/usr/bin/env bash

set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/build-flatpak.sh --deb /path/to/dohc-viewer.deb \
  --output /path/to/DOHC-Viewer_<version>_UNSIGNED_ubuntu-x64.flatpak \
  --version <version>
EOF
}

deb_path=""
output_path=""
version=""
while (($# > 0)); do
  case "$1" in
    --deb|--output|--version)
      [[ $# -ge 2 ]] || { echo "$1 requires a value" >&2; usage >&2; exit 2; }
      case "$1" in
        --deb) deb_path="$2" ;;
        --output) output_path="$2" ;;
        --version) version="$2" ;;
      esac
      shift 2
      ;;
    --help) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

[[ -n "$deb_path" && -n "$output_path" && -n "$version" ]] || { usage >&2; exit 2; }
[[ "$(uname -s)" == "Linux" && "$(uname -m)" == "x86_64" ]] || {
  echo "Flatpak release packaging requires Linux x86_64" >&2
  exit 2
}
command -v flatpak-builder >/dev/null || { echo "flatpak-builder is required" >&2; exit 2; }
command -v flatpak >/dev/null || { echo "flatpak is required" >&2; exit 2; }
[[ -f "$deb_path" ]] || { echo "Debian package is missing: $deb_path" >&2; exit 2; }
[[ "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+([.-][0-9A-Za-z.-]+)?$ ]] || {
  echo "Invalid version: $version" >&2
  exit 2
}

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd -P)"
repo_root="$(cd "$script_dir/.." && pwd -P)"
manifest_source="$repo_root/packaging/flatpak/com.dohc.viewer.json"
metainfo_source="$repo_root/packaging/flatpak/com.dohc.viewer.metainfo.xml"
[[ -s "$manifest_source" && -s "$metainfo_source" ]] || {
  echo "Flatpak manifest or AppStream metadata is missing" >&2
  exit 2
}

output_directory="$(dirname "$output_path")"
mkdir -p "$output_directory"
output_path="$(cd "$output_directory" && pwd -P)/$(basename "$output_path")"
temporary_root="$(mktemp -d "${RUNNER_TEMP:-/tmp}/dohc-flatpak.XXXXXX")"
cleanup() { rm -rf -- "$temporary_root"; }
trap cleanup EXIT

manifest_dir="$temporary_root/manifest"
build_dir="$temporary_root/build"
repo_dir="$temporary_root/repo"
mkdir -p "$manifest_dir"
cp "$manifest_source" "$manifest_dir/com.dohc.viewer.json"
cp "$metainfo_source" "$manifest_dir/com.dohc.viewer.metainfo.xml"
cp "$deb_path" "$manifest_dir/dohc-viewer.deb"

flatpak-builder \
  --force-clean \
  --disable-cache \
  --repo="$repo_dir" \
  "$build_dir" \
  "$manifest_dir/com.dohc.viewer.json"

rm -f -- "$output_path"
flatpak build-bundle \
  "$repo_dir" \
  "$output_path" \
  com.dohc.viewer \
  stable \
  --runtime-repo=https://flathub.org/repo/flathub.flatpakrepo

[[ -s "$output_path" ]] || { echo "Flatpak bundle was not created" >&2; exit 1; }
echo "Created $output_path"
