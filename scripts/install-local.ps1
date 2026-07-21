[CmdletBinding()]
param(
    [string]$CodeRoot = $HOME
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "common.ps1")

# ── Resolve paths ─────────────────────────────────────────────────────────────
$Root        = Get-NotionCodeRoot
$BridgeDir   = Join-Path $Root "bridge"
$PrivateMcp  = Join-Path $Root "notion-private-api-mcp"
$RuntimeDir  = Join-Path $Root "runtime"
$RuntimeEnv  = Join-Path $RuntimeDir ".env"
$RuntimeState = Join-Path $Root ".runtime"
$NpmCache    = Join-Path $RuntimeState "npm-cache"
$OpenCodeDir = Join-Path $RuntimeState "opencode"
$AccountHome = Join-Path $HOME ".notionagents"
$CodexHome   = Join-Path $HOME ".codex"
$NodeCli     = Join-Path $BridgeDir "bin\notion-agent.mjs"
$ModelsTemplate = Join-Path $Root "state-template\.notionagents\models.json"
$ModelsPath  = Join-Path $AccountHome "models.json"

# ── Prerequisites ─────────────────────────────────────────────────────────────
Assert-Command "node.exe" "Install Node.js 20 or newer."
Assert-Command "npm.cmd"  "Install Node.js 20 or newer."
Assert-Node20

# ── Create directories ────────────────────────────────────────────────────────
foreach ($dir in @(
    $RuntimeState,
    $OpenCodeDir,
    $NpmCache,
    $AccountHome,
    (Join-Path $AccountHome "accounts"),
    $CodexHome
)) {
    New-Item -ItemType Directory -Force -Path $dir | Out-Null
}

# ── Node bridge dependencies ──────────────────────────────────────────────────
if (Test-NpmInstalled $BridgeDir) {
    Write-Host "[✓] Unified Node bridge dependencies already installed — skipping npm ci."
} else {
    Write-Host "[>] Installing unified Node bridge dependencies..."
    & npm.cmd --prefix $BridgeDir ci --omit=dev --cache $NpmCache
    if ($LASTEXITCODE -ne 0) { throw "Unified Node bridge dependency installation failed." }
}

# ── Notion private MCP dependencies ──────────────────────────────────────────
if (Test-NpmInstalled $PrivateMcp) {
    Write-Host "[✓] Notion MCP Node dependencies already installed — skipping npm ci."
} else {
    Write-Host "[>] Installing Notion private MCP dependencies..."
    & npm.cmd --prefix $PrivateMcp ci --omit=dev --cache $NpmCache
    if ($LASTEXITCODE -ne 0) { throw "Private Notion MCP dependency installation failed." }
}

# ── OpenCode dependencies ─────────────────────────────────────────────────────
if (Test-NpmInstalled $OpenCodeDir -Packages "@ai-sdk/openai-compatible","@opencode-ai/plugin") {
    Write-Host "[✓] OpenCode Node dependencies already installed — skipping npm install."
} else {
    Write-Host "[>] Installing OpenCode dependencies..."
    & npm.cmd --prefix $OpenCodeDir install --cache $NpmCache "@ai-sdk/openai-compatible" "@opencode-ai/plugin"
    if ($LASTEXITCODE -ne 0) { throw "OpenCode dependency installation failed." }
}

# ── Runtime .env (create once) ────────────────────────────────────────────────
if (-not (Test-Path $RuntimeEnv)) {
    Write-Host "[>] Creating local MCP runtime configuration..."
    New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null
    $secret = New-RandomHex 32
    $resolvedCodeRoot = [IO.Path]::GetFullPath($CodeRoot)
    $envContent = @(
        "MCP_PATH_SECRET=$secret"
        "CODE_ROOT=$resolvedCodeRoot"
        "MCP_PORT=8787"
    ) -join [Environment]::NewLine
    Write-Utf8NoBom $RuntimeEnv ($envContent + [Environment]::NewLine)
    # Restrict permissions: owner read/write only
    $acl = Get-Acl -LiteralPath $RuntimeEnv
    $acl.SetAccessRuleProtection($true, $false)
    $rule = [Security.AccessControl.FileSystemAccessRule]::new(
        [Environment]::UserName, "FullControl", "Allow"
    )
    $acl.SetAccessRule($rule)
    Set-Acl -LiteralPath $RuntimeEnv $acl -ErrorAction SilentlyContinue
}

# ── Model aliases ─────────────────────────────────────────────────────────────
Write-Host "[>] Updating model aliases..."
& node.exe (Join-Path $Root "scripts\install-model-aliases.mjs") $ModelsTemplate $ModelsPath
if ($LASTEXITCODE -ne 0) { throw "Model alias installation failed." }

# ── Account migration ─────────────────────────────────────────────────────────
& node.exe $NodeCli migrate $AccountHome
if ($LASTEXITCODE -ne 0) { throw "Notion account migration failed." }

# ── Detect whether Notion credentials are present ────────────────────────────
$hasAccount = Test-Path (Join-Path $AccountHome "notion_account.json")
if (-not $hasAccount) {
    $hasAccount = @(Get-ChildItem -LiteralPath (Join-Path $AccountHome "accounts") -Filter "*.json" -File -ErrorAction SilentlyContinue).Count -gt 0
}
$notionMcpEnabled = if ($hasAccount) { "true" } else { "false" }

# ── Render configs ────────────────────────────────────────────────────────────
Write-Host "[>] Rendering OpenCode configuration..."
& node.exe (Join-Path $Root "scripts\render-config.mjs") `
    (Join-Path $Root "config\opencode.jsonc") `
    (Join-Path $OpenCodeDir "opencode.jsonc") `
    $Root $HOME
if ($LASTEXITCODE -ne 0) { throw "OpenCode configuration rendering failed." }

Write-Host "[>] Rendering Codex configuration..."
& node.exe (Join-Path $Root "scripts\install-codex-config.mjs") `
    (Join-Path $Root "config\codex-cli-config.toml") `
    (Join-Path $CodexHome "config.toml") `
    $Root $HOME $notionMcpEnabled
if ($LASTEXITCODE -ne 0) { throw "Codex configuration generation failed." }

Write-Host "[>] Applying token profile..."
& node.exe (Join-Path $Root "scripts\apply-token-profile.mjs") `
    $RuntimeState `
    (Join-Path $CodexHome "config.toml") `
    (Join-Path $Root "config\codex-models.json") `
    (Join-Path $OpenCodeDir "opencode.jsonc")
if ($LASTEXITCODE -ne 0) { throw "Token profile application failed." }

# ── Auto-start shortcut in Windows Startup folder ────────────────────────────
$startupDir = [Environment]::GetFolderPath("Startup")
$startupCmd = Join-Path $startupDir "notioncode-mcp.cmd"
$escapedPs1 = (Join-Path $Root "run-full.ps1").Replace('"', '""')
@(
    "@echo off"
    "powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File `"$escapedPs1`" -Action Start"
) | Set-Content -LiteralPath $startupCmd -Encoding ASCII

# ── Write paths env for other tools ──────────────────────────────────────────
$pathsEnv = Join-Path $Root ".runtime\windows-paths.env"
$pathsContent = @(
    "NOTIONCODE_ROOT=$Root"
    "NOTION_AGENT_HOME=$AccountHome"
    "OPENCODE_CONFIG_DIR=$OpenCodeDir"
) -join [Environment]::NewLine
Write-Utf8NoBom $pathsEnv ($pathsContent + [Environment]::NewLine)

# ── Summary ───────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "[✓] Installation complete."
Write-Host "    Notion account directory : $AccountHome"
Write-Host "    Model aliases            : $ModelsPath"
Write-Host "    Codex configuration      : $(Join-Path $CodexHome 'config.toml')"
Write-Host "    OpenCode profile         : $OpenCodeDir"
Write-Host "    Health endpoint          : http://127.0.0.1:8765/healthz"

if (-not $hasAccount) {
    Write-Host ""
    Write-Warning "Notion credentials are not configured yet."
    Write-Warning "The notion-private MCP server remains disabled until credentials are configured."
    Write-Host "Run this command, paste token_v2, then press Ctrl+Z and Enter:"
    Write-Host "  & node.exe '$NodeCli' init --token-v2 - --all-workspaces --account-home '$AccountHome'"
    Write-Host "Run notion-agent doctor for each account, then re-run this installer to enable MCP."
}
