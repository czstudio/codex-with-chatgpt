#!/bin/sh
set -eu

home_dir=${HOME:?HOME is required for a per-user launch agent}
plist=$home_dir/Library/LaunchAgents/com.codex.c2c.extension-bridge.plist
uid=$(id -u)
launchctl bootout "gui/$uid" "$plist" >/dev/null 2>&1 || true
if [ -f "$plist" ]; then
  rm -f "$plist"
fi
echo "uninstalled com.codex.c2c.extension-bridge"
