#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This installer is only for the macOS user-center host." >&2
  exit 1
fi

repo_root="$(cd "$(dirname "$0")/.." && pwd -P)"
node_binary="$(command -v node)"
[[ "$node_binary" == /* && -x "$node_binary" ]] || {
  echo "An absolute executable Node.js path is required." >&2
  exit 1
}

label="com.dohc.viewer.user-center"
service_root="${DOHC_USER_CENTER_DATA_ROOT:-$HOME/Library/Application Support/DOHC User Center}"
launch_agents="$HOME/Library/LaunchAgents"
plist="$launch_agents/$label.plist"
client_config="$HOME/Desktop/DOHC-User-Center-Client.json"
mkdir -p "$service_root" "$launch_agents"
chmod 700 "$service_root"

"$node_binary" "$repo_root/scripts/user-center-server.mjs" \
  --init \
  --config "$repo_root/user-center.config.json" \
  --data-root "$service_root" \
  --client-config "$client_config"

certificate="$service_root/tls/server.crt"
security add-trusted-cert -d -r trustRoot -k "$HOME/Library/Keychains/login.keychain-db" "$certificate" >/dev/null 2>&1 || true

xml_escape() {
  sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g'
}

node_xml="$(printf '%s' "$node_binary" | xml_escape)"
script_xml="$(printf '%s' "$repo_root/scripts/user-center-server.mjs" | xml_escape)"
config_xml="$(printf '%s' "$repo_root/user-center.config.json" | xml_escape)"
root_xml="$(printf '%s' "$service_root" | xml_escape)"
repo_xml="$(printf '%s' "$repo_root" | xml_escape)"
stdout_xml="$(printf '%s' "$service_root/service.stdout.log" | xml_escape)"
stderr_xml="$(printf '%s' "$service_root/service.stderr.log" | xml_escape)"

temporary="$(mktemp "$launch_agents/.$label.XXXXXX")"
trap 'rm -f "$temporary"' EXIT
umask 077
{
  printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>'
  printf '%s\n' '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
  printf '%s\n' '<plist version="1.0"><dict>'
  printf '%s\n' "<key>Label</key><string>$label</string>"
  printf '%s\n' '<key>ProgramArguments</key><array>'
  printf '%s\n' "<string>$node_xml</string><string>$script_xml</string>"
  printf '%s\n' "<string>--config</string><string>$config_xml</string>"
  printf '%s\n' "<string>--data-root</string><string>$root_xml</string>"
  printf '%s\n' '</array>'
  printf '%s\n' "<key>WorkingDirectory</key><string>$repo_xml</string>"
  printf '%s\n' '<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer>'
  printf '%s\n' "<key>StandardOutPath</key><string>$stdout_xml</string>"
  printf '%s\n' "<key>StandardErrorPath</key><string>$stderr_xml</string>"
  printf '%s\n' '</dict></plist>'
} > "$temporary"
plutil -lint "$temporary" >/dev/null

launchctl bootout "gui/$(id -u)/$label" >/dev/null 2>&1 || true
mv "$temporary" "$plist"
chmod 600 "$plist"
trap - EXIT
service_target="gui/$(id -u)/$label"
launchctl bootstrap "gui/$(id -u)" "$plist" >/dev/null 2>&1 || launchctl load -w "$plist" >/dev/null 2>&1 || true
launchctl kickstart -k "$service_target" >/dev/null 2>&1 || true

for _ in {1..30}; do
  if curl --fail --silent --insecure --max-time 1 https://127.0.0.1:17880/healthz >/dev/null; then
    open "https://localhost:17880/" || true
    echo "DOHC User Center is running. Import this file on desktop clients: $client_config"
    exit 0
  fi
  sleep 1
done

echo "The launch agent started but its health endpoint is unavailable." >&2
echo "Inspect: $service_root/service.stderr.log" >&2
exit 1
