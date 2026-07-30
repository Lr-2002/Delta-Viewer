#!/usr/bin/env bash
set -euo pipefail

if [[ "$(uname -s)" != "Darwin" ]]; then
  echo "This installer is only for the macOS update mirror host." >&2
  exit 1
fi

repo_root="$(cd "$(dirname "$0")/.." && pwd -P)"
node_binary="$(command -v node)"
[[ "$node_binary" == /* && -x "$node_binary" ]] || {
  echo "An absolute executable Node.js path is required." >&2
  exit 1
}

label="com.dohc.viewer.update-mirror"
service_root="${DOHC_UPDATE_CACHE_ROOT:-$HOME/Library/Application Support/DOHC Viewer Update Service}"
launch_agents="$HOME/Library/LaunchAgents"
plist="$launch_agents/$label.plist"
mkdir -p "$service_root" "$launch_agents"
chmod 700 "$service_root"

xml_escape() {
  sed -e 's/&/\&amp;/g' -e 's/</\&lt;/g' -e 's/>/\&gt;/g' -e 's/"/\&quot;/g'
}

node_xml="$(printf '%s' "$node_binary" | xml_escape)"
script_xml="$(printf '%s' "$repo_root/scripts/update-mirror-server.mjs" | xml_escape)"
config_xml="$(printf '%s' "$repo_root/update-service.config.json" | xml_escape)"
root_xml="$(printf '%s' "$service_root" | xml_escape)"
repo_xml="$(printf '%s' "$repo_root" | xml_escape)"
stdout_xml="$(printf '%s' "$service_root/service.stdout.log" | xml_escape)"
stderr_xml="$(printf '%s' "$service_root/service.stderr.log" | xml_escape)"

proxy_xml=""
proxy_enabled="$(scutil --proxy 2>/dev/null | awk '$1 == "HTTPEnable" {print $3; exit}')"
proxy_host="$(scutil --proxy 2>/dev/null | awk '$1 == "HTTPProxy" {print $3; exit}')"
proxy_port="$(scutil --proxy 2>/dev/null | awk '$1 == "HTTPPort" {print $3; exit}')"
if [[ "$proxy_enabled" == "1" && -n "$proxy_host" && "$proxy_port" =~ ^[0-9]+$ ]]; then
  proxy_url="http://$proxy_host:$proxy_port"
  escaped_proxy="$(printf '%s' "$proxy_url" | xml_escape)"
  proxy_xml="<key>EnvironmentVariables</key><dict><key>http_proxy</key><string>$escaped_proxy</string><key>https_proxy</key><string>$escaped_proxy</string><key>no_proxy</key><string>127.0.0.1,localhost,10.0.0.0/8,*.local</string></dict>"
fi

temporary="$(mktemp "$launch_agents/.$label.XXXXXX")"
trap 'rm -f "$temporary"' EXIT
umask 077
{
  printf '%s\n' '<?xml version="1.0" encoding="UTF-8"?>'
  printf '%s\n' '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">'
  printf '%s\n' '<plist version="1.0"><dict>'
  printf '%s\n' "<key>Label</key><string>$label</string>"
  printf '%s\n' '<key>ProgramArguments</key><array>'
  printf '%s\n' "<string>$node_xml</string><string>--use-env-proxy</string><string>$script_xml</string>"
  printf '%s\n' "<string>--config</string><string>$config_xml</string>"
  printf '%s\n' "<string>--cache-root</string><string>$root_xml</string>"
  printf '%s\n' '</array>'
  printf '%s\n' "<key>WorkingDirectory</key><string>$repo_xml</string>"
  printf '%s\n' '<key>RunAtLoad</key><true/><key>KeepAlive</key><true/><key>ThrottleInterval</key><integer>10</integer>'
  printf '%s\n' "<key>StandardOutPath</key><string>$stdout_xml</string>"
  printf '%s\n' "<key>StandardErrorPath</key><string>$stderr_xml</string>"
  [[ -z "$proxy_xml" ]] || printf '%s\n' "$proxy_xml"
  printf '%s\n' '</dict></plist>'
} > "$temporary"
plutil -lint "$temporary" >/dev/null

launchctl bootout "gui/$(id -u)/$label" >/dev/null 2>&1 || true
mv "$temporary" "$plist"
chmod 600 "$plist"
trap - EXIT
service_target="gui/$(id -u)/$label"
if ! launchctl bootstrap "gui/$(id -u)" "$plist"; then
  # Some macOS sessions report EIO after the service was registered. Trust the
  # actual service state and health endpoint instead of treating that as fatal.
  if ! launchctl print "$service_target" >/dev/null 2>&1; then
    launchctl load -w "$plist" >/dev/null 2>&1 || true
  fi
fi
launchctl kickstart -k "$service_target" >/dev/null 2>&1 || true

for _ in {1..30}; do
  if curl --fail --silent --max-time 1 http://127.0.0.1:17879/healthz >/dev/null; then
    echo "DOHC Viewer update mirror is running at http://39.155.172.162:17879/"
    exit 0
  fi
  sleep 1
done

echo "The launch agent started but its health endpoint is unavailable." >&2
echo "Inspect: $service_root/service.stderr.log" >&2
exit 1
