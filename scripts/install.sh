#!/usr/bin/env bash
set -euo pipefail

REPO_URL="${C2C_REPO_URL:-https://github.com/czstudio/codex-with-chatgpt-pro.git}"
C2C_CHECKOUT="${C2C_INSTALL_DIR:-$HOME/.local/share/codex-with-chatgpt}"
SKILL_DIR="${CODEX_SKILLS_DIR:-$HOME/.codex/skills}/codex-with-chatgpt"

need() { command -v "$1" >/dev/null 2>&1; }

if ! need git || ! need node; then
  if need brew; then
    brew install git node
  else
    echo "Install Git and Node.js 20+ first (macOS: https://brew.sh; Linux: your package manager)." >&2
    exit 1
  fi
fi

NODE_MAJOR="$(node -p 'Number(process.versions.node.split(".")[0])')"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "Node.js 20+ is required; found $(node --version)." >&2
  exit 1
fi

if ! need cloudflared; then
  if need brew; then
    brew install cloudflared
  else
    echo "Install cloudflared from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/" >&2
    exit 1
  fi
fi

mkdir -p "$(dirname "$C2C_CHECKOUT")"
if [ -d "$C2C_CHECKOUT/.git" ]; then
  git -C "$C2C_CHECKOUT" pull --ff-only
else
  git clone "$REPO_URL" "$C2C_CHECKOUT"
fi

if need corepack; then
  corepack enable
  PNPM=(corepack pnpm)
elif need pnpm; then
  PNPM=(pnpm)
else
  PNPM=(npx --yes pnpm@11.24.0)
fi
"${PNPM[@]}" --dir "$C2C_CHECKOUT" install --frozen-lockfile
"${PNPM[@]}" --dir "$C2C_CHECKOUT" build

mkdir -p "$SKILL_DIR"
sed "s|__C2C_CHECKOUT__|$C2C_CHECKOUT|g" "$C2C_CHECKOUT/skill/SKILL.md" > "$SKILL_DIR/SKILL.md"
node "$C2C_CHECKOUT/bin/c2c.js" sandbox-allow --json >/dev/null

echo "Installed Codex with ChatGPT."
echo "Next: tell Codex: 使用 Codex with ChatGPT 完成首次配置。"
