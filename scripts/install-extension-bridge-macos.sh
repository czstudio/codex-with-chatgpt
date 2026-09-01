#!/bin/sh
set -eu

if [ "$#" -ne 1 ]; then
  echo "usage: install-extension-bridge-macos.sh WORKSPACE_ROOT" >&2
  exit 2
fi

workspace_input=$1
if [ ! -d "$workspace_input" ]; then
  echo "workspace root does not exist: $workspace_input" >&2
  exit 2
fi

# Resolve this script before changing cwd.  `$0` is commonly relative (for
# example, ./scripts/install-extension-bridge-macos.sh); resolving it after
# cd would make the package path relative to the target workspace.
script_path=$0
case "$script_path" in
  /*) ;;
  *) script_path=$PWD/$script_path ;;
esac
script_dir=$(CDPATH= cd -- "$(dirname -- "$script_path")" && pwd -P)
package_root=$(dirname "$script_dir")

cd "$workspace_input"
workspace_root=$(pwd -P)
case "$workspace_root" in
  *'&'*|*'<'*|*'>'*|*'"'*|*"'"*)
    echo "workspace path contains XML-special characters; choose a safe path" >&2
    exit 2
    ;;
esac

cli_path=$package_root/dist/cli/index.js
if [ ! -f "$cli_path" ]; then
  echo "built CLI not found: $cli_path (run pnpm build first)" >&2
  exit 2
fi
node_bin=$(command -v node || true)
if [ -z "$node_bin" ]; then
  echo "node is not installed" >&2
  exit 2
fi

home_dir=${HOME:?HOME is required for a per-user launch agent}
launch_agents_dir=$home_dir/Library/LaunchAgents
plist=$launch_agents_dir/com.codex.c2c.extension-bridge.plist
state_dir=${C2C_STATE_DIR:-$home_dir/Library/Application Support/codex-with-chatgpt}
log_dir=$state_dir/logs
mkdir -p "$launch_agents_dir" "$log_dir"

xml_escape() {
  printf '%s' "$1" | sed \
    -e 's/&/\&amp;/g' \
    -e 's/</\&lt;/g' \
    -e 's/>/\&gt;/g' \
    -e 's/"/\&quot;/g' \
    -e "s/'/\&apos;/g"
}

node_xml=$(xml_escape "$node_bin")
cli_xml=$(xml_escape "$cli_path")
workspace_xml=$(xml_escape "$workspace_root")
state_xml=$(xml_escape "$state_dir")
stdout_xml=$(xml_escape "$log_dir/c2c-extension-bridge.out.log")
stderr_xml=$(xml_escape "$log_dir/c2c-extension-bridge.err.log")
uid=$(id -u)

cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>com.codex.c2c.extension-bridge</string>
  <key>ProgramArguments</key>
  <array>
    <string>$node_xml</string>
    <string>$cli_xml</string>
    <string>extension</string>
    <string>start</string>
    <string>--workspace</string>
    <string>$workspace_xml</string>
  </array>
  <key>WorkingDirectory</key><string>$workspace_xml</string>
  <key>EnvironmentVariables</key>
  <dict><key>C2C_STATE_DIR</key><string>$state_xml</string></dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Background</string>
  <key>StandardOutPath</key><string>$stdout_xml</string>
  <key>StandardErrorPath</key><string>$stderr_xml</string>
</dict>
</plist>
EOF

launchctl bootout "gui/$uid" "$plist" >/dev/null 2>&1 || true
launchctl bootstrap "gui/$uid" "$plist"
echo "installed com.codex.c2c.extension-bridge for $workspace_root"
