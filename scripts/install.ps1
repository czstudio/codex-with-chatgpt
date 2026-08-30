$ErrorActionPreference = "Stop"

$RepoUrl = if ($env:C2C_REPO_URL) { $env:C2C_REPO_URL } else { "https://github.com/czstudio/codex-with-chatgpt-pro.git" }
$Checkout = if ($env:C2C_INSTALL_DIR) { $env:C2C_INSTALL_DIR } else { Join-Path $env:LOCALAPPDATA "codex-with-chatgpt\source" }
$SkillsRoot = if ($env:CODEX_SKILLS_DIR) { $env:CODEX_SKILLS_DIR } else { Join-Path $env:USERPROFILE ".codex\skills" }
$SkillDir = Join-Path $SkillsRoot "codex-with-chatgpt"

function Refresh-Path {
  $machine = [Environment]::GetEnvironmentVariable("Path", "Machine")
  $user = [Environment]::GetEnvironmentVariable("Path", "User")
  $env:Path = "$machine;$user"
}

if (-not (Get-Command winget -ErrorAction SilentlyContinue)) {
  throw "winget is required for automatic Windows prerequisite installation."
}
if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
  winget install --id Git.Git -e --accept-package-agreements --accept-source-agreements
  Refresh-Path
}
if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  winget install --id OpenJS.NodeJS.LTS -e --accept-package-agreements --accept-source-agreements
  Refresh-Path
}
if (-not (Get-Command cloudflared -ErrorAction SilentlyContinue)) {
  winget install --id Cloudflare.cloudflared -e --accept-package-agreements --accept-source-agreements
  Refresh-Path
}

$NodeMajor = [int]((node -p 'process.versions.node.split(".")[0]').Trim())
if ($NodeMajor -lt 20) { throw "Node.js 20+ is required." }

$Parent = Split-Path -Parent $Checkout
New-Item -ItemType Directory -Force -Path $Parent | Out-Null
if (Test-Path (Join-Path $Checkout ".git")) {
  git -C $Checkout pull --ff-only
} else {
  git clone $RepoUrl $Checkout
}

corepack enable
corepack pnpm --dir $Checkout install --frozen-lockfile
corepack pnpm --dir $Checkout build

New-Item -ItemType Directory -Force -Path $SkillDir | Out-Null
$Skill = Get-Content -Raw (Join-Path $Checkout "skill\SKILL.md")
$Skill.Replace("__C2C_CHECKOUT__", $Checkout) | Set-Content -Encoding utf8 (Join-Path $SkillDir "SKILL.md")
node (Join-Path $Checkout "bin\c2c.js") sandbox-allow --json | Out-Null

Write-Host "Installed Codex with ChatGPT."
Write-Host "Next: tell Codex: 使用 Codex with ChatGPT 完成首次配置。"
