#!/usr/bin/env bash

set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "scripts/make-dmg.sh only supports macOS." >&2
  exit 2
fi

app_path=""
output_path=""
volume_name="DOHC Viewer"

while (($# > 0)); do
  case "$1" in
    --app|--output|--volume-name)
      if (($# < 2)); then
        echo "Missing value for $1" >&2
        exit 2
      fi
      case "$1" in
        --app) app_path="$2" ;;
        --output) output_path="$2" ;;
        --volume-name) volume_name="$2" ;;
      esac
      shift 2
      ;;
    --help)
      echo "Usage: scripts/make-dmg.sh --app <.app> --output <.dmg> [--volume-name <name>]"
      exit 0
      ;;
    *)
      echo "Unknown argument: $1" >&2
      exit 2
      ;;
  esac
done

if [[ -z "$app_path" || -z "$output_path" ]]; then
  echo "Both --app and --output are required." >&2
  exit 2
fi
if [[ ! -d "$app_path" || "${app_path##*.}" != "app" ]]; then
  echo "--app must point to an existing .app directory: $app_path" >&2
  exit 1
fi
requested_output_dir="$(dirname "$output_path")"
mkdir -p "$requested_output_dir"
output_dir="$(cd "$requested_output_dir" && pwd -P)"
output_name="$(basename "$output_path")"
output_path="$output_dir/$output_name"
if [[ -e "$output_path" ]]; then
  echo "Refusing to overwrite an existing DMG: $output_path" >&2
  exit 1
fi

temporary="$output_dir/.${output_name}.partial-$$.dmg"
staging="$(mktemp -d "$output_dir/.dmg-stage.XXXXXX")"
cleanup() {
  rm -f -- "$temporary"
  rm -rf -- "$staging"
}
trap cleanup EXIT

ditto "$app_path" "$staging/$(basename "$app_path")"
ln -s /Applications "$staging/Applications"
hdiutil create \
  -srcfolder "$staging" \
  -volname "$volume_name" \
  -fs HFS+ \
  -format UDZO \
  "$temporary"
hdiutil imageinfo "$temporary" >/dev/null
ln "$temporary" "$output_path"
rm "$temporary"

echo "Created headless DMG at $output_path"
