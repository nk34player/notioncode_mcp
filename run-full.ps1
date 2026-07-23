[CmdletBinding()]
param(
    [ValidateSet("Menu", "Start", "Stop", "Status", "CheckAccounts", "AddAccount",
                 "RefreshClientVersion", "Settings", "Install", "Verify", "OpenCode")]
    [string]$Action = "Menu",
    [string]$CodeRoot = $HOME,
    [switch]$NoAutoStart
)

$ErrorActionPreference = "Stop"
. (Join-Path $PSScriptRoot "scripts\common.ps1")

# ── Paths ──────────────────────────────────────────────────────────────────────
$Root            = Get-NotionCodeRoot
$BridgeDir       = Join-Path $Root "bridge"
$NodeServer      = Join-Path $BridgeDir "server.js"
$NodeCli         = Join-Path $BridgeDir "bin\notion-agent.mjs"
$PrivateMcp      = Join-Path $Root "notion-private-api-mcp"
$RuntimeDir      = Join-Path $Root "runtime"
$RuntimeEnv      = Join-Path $RuntimeDir ".env"
$RuntimeState    = Join-Path $Root ".runtime"
$NpmCache        = Join-Path $RuntimeState "npm-cache"
$LogFile         = Join-Path $RuntimeState "notioncode-node.log"
$PidDir          = Join-Path $RuntimeState "pids"
$PidFile         = Join-Path $PidDir "notioncode-node.pid"
$OpenCodeDir     = Join-Path $RuntimeState "opencode"
$AccountHome     = Join-Path $HOME ".notionagents"
$CodexHome       = Join-Path $HOME ".codex"
$TokenProfileScript = Join-Path $Root "scripts\apply-token-profile.mjs"
$TokenProfileState  = Join-Path $RuntimeState "token-profile"
$CodexConfig     = Join-Path $CodexHome "config.toml"
$CatalogTemplate = Join-Path $Root "config\codex-models.json"
$OpenCodeConfig  = Join-Path $OpenCodeDir "opencode.jsonc"
$ModelsTemplate  = Join-Path $Root "state-template\.notionagents\models.json"
$ModelsPath      = Join-Path $AccountHome "models.json"

# ── Helpers ────────────────────────────────────────────────────────────────────

function Get-AccountFiles {
    $files = @()
    $main = Join-Path $AccountHome "notion_account.json"
    if (Test-Path $main) { $files += Get-Item -LiteralPath $main }
    $extra = Join-Path $AccountHome "accounts"
    if (Test-Path $extra) {
        $files += @(Get-ChildItem -LiteralPath $extra -Filter "*.json" -File | Sort-Object Name)
    }
    return @($files)
}

function Get-BridgePort {
    $v = $env:NOTION_FABLE_PORT
    if (-not $v) { $v = (Get-DotEnv $RuntimeEnv)["NOTION_FABLE_PORT"] }
    if (-not $v) { $v = "8765" }
    return [int]$v
}

function Get-McpPort {
    $env = Get-DotEnv $RuntimeEnv
    $v = $env:MCP_PORT
    if (-not $v) { $v = $env["MCP_PORT"] }
    if (-not $v) { $v = $env["PORT"] }
    if (-not $v) { $v = "8787" }
    return [int]$v
}

# ── EnsureSetup (mirrors ensure_setup / ensure_node from run-full.sh) ──────────
# Light: only bridge npm install + runtime.env + codex config.
# Called from the interactive menu (Start, AddAccount, Settings).

function Invoke-EnsureSetup {
    Assert-Command "node.exe" "Install Node.js 20 or newer."
    Assert-Command "npm.cmd"  "Install Node.js 20 or newer."
    Assert-Node20

    foreach ($dir in @(
        $RuntimeState, $OpenCodeDir, $NpmCache,
        $AccountHome, (Join-Path $AccountHome "accounts"),
        $CodexHome, $PidDir
    )) { New-Item -ItemType Directory -Force -Path $dir | Out-Null }

    # Bridge deps only — mirrors ensure_node in run-full.sh which runs
    # "npm install --prefix bridge" (not ci, not private MCP, not opencode)
    if (Test-NpmInstalled $BridgeDir) {
        Write-Host "[✓] Node dependencies already installed; skipping download."
    } else {
        Write-Host ""
        Write-Host "[>] Installing Node dependencies (first run or lockfile changed)..."
        & npm.cmd install --prefix $BridgeDir --cache $NpmCache
        if ($LASTEXITCODE -ne 0) { throw "Node bridge dependency installation failed." }
    }

    # runtime/.env — created once, never overwritten
    if (-not (Test-Path $RuntimeEnv)) {
        Write-Host "[>] Creating local MCP runtime configuration..."
        New-Item -ItemType Directory -Force -Path $RuntimeDir | Out-Null
        $secret = New-RandomHex 32
        $resolvedRoot = [IO.Path]::GetFullPath($CodeRoot)
        $envContent = @(
            "MCP_PATH_SECRET=$secret"
            "CODE_ROOT=$resolvedRoot"
            "MCP_PORT=8787"
        ) -join [Environment]::NewLine
        Write-Utf8NoBom $RuntimeEnv ($envContent + [Environment]::NewLine)
    }

    # Model aliases — ensure models.json exists for the server
    & node.exe (Join-Path $Root "scripts\install-model-aliases.mjs") $ModelsTemplate $ModelsPath
    if ($LASTEXITCODE -ne 0) { throw "Model alias installation failed." }

    # Account migration — upgrade any legacy account file layout
    & node.exe $NodeCli migrate $AccountHome
    if ($LASTEXITCODE -ne 0) { throw "Notion account migration failed." }

    # Re-detect credentials after migration (may have changed state)
    $hasAccount = Test-Path (Join-Path $AccountHome "notion_account.json")
    if (-not $hasAccount) {
        $hasAccount = @(Get-ChildItem -LiteralPath (Join-Path $AccountHome "accounts") -Filter "*.json" -File -ErrorAction SilentlyContinue).Count -gt 0
    }
    $notionMcpEnabled = if ($hasAccount) { "true" } else { "false" }

    # Render configs + token profile
    & node.exe (Join-Path $Root "scripts\render-config.mjs") `
        (Join-Path $Root "config\opencode.jsonc") $OpenCodeConfig $Root $HOME
    if ($LASTEXITCODE -ne 0) { throw "OpenCode configuration rendering failed." }

    & node.exe (Join-Path $Root "scripts\install-codex-config.mjs") `
        (Join-Path $Root "config\codex-cli-config.toml") $CodexConfig $Root $HOME $notionMcpEnabled
    if ($LASTEXITCODE -ne 0) { throw "Codex configuration generation failed." }

    & node.exe $TokenProfileScript $RuntimeState $CodexConfig $CatalogTemplate $OpenCodeConfig
    if ($LASTEXITCODE -ne 0) { throw "Token profile application failed." }
}

# ── Install (mirrors install-local.sh — full setup) ────────────────────────────
# Heavy: all packages (npm ci), model aliases, migration, startup shortcut.
# Called via -Action Install.

function Invoke-Install {
    # Run the light ensure-setup first
    Invoke-EnsureSetup

    # Private MCP deps
    if (Test-NpmInstalled $PrivateMcp) {
        Write-Host "[✓] Notion MCP Node dependencies already installed — skipping npm ci."
    } else {
        Write-Host "[>] Installing Notion private MCP dependencies..."
        & npm.cmd --prefix $PrivateMcp ci --omit=dev --cache $NpmCache
        if ($LASTEXITCODE -ne 0) { throw "Private Notion MCP dependency installation failed." }
    }

    # OpenCode deps
    if (Test-NpmInstalled $OpenCodeDir -Packages "@ai-sdk/openai-compatible","@opencode-ai/plugin") {
        Write-Host "[✓] OpenCode Node dependencies already installed — skipping npm install."
    } else {
        Write-Host "[>] Installing OpenCode dependencies..."
        & npm.cmd --prefix $OpenCodeDir install --cache $NpmCache "@ai-sdk/openai-compatible" "@opencode-ai/plugin"
        if ($LASTEXITCODE -ne 0) { throw "OpenCode dependency installation failed." }
    }

    # Windows Startup shortcut
    $startupDir = [Environment]::GetFolderPath("Startup")
    $startupCmd = Join-Path $startupDir "notioncode-mcp.cmd"
    if (-not $NoAutoStart) {
        $escapedPs1 = (Join-Path $Root "run-full.ps1").Replace('"', '""')
        @(
            "@echo off"
            "powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File `"$escapedPs1`" -Action Start"
        ) | Set-Content -LiteralPath $startupCmd -Encoding ASCII
    }

    # Write paths env
    $pathsEnv = Join-Path $RuntimeState "windows-paths.env"
    $pathsContent = @(
        "NOTIONCODE_ROOT=$Root"
        "NOTION_AGENT_HOME=$AccountHome"
        "OPENCODE_CONFIG_DIR=$OpenCodeDir"
    ) -join [Environment]::NewLine
    Write-Utf8NoBom $pathsEnv ($pathsContent + [Environment]::NewLine)

    Write-Host ""
    Write-Host "[✓] Installation complete."
    Write-Host "    Notion account directory : $AccountHome"
    Write-Host "    Model aliases            : $ModelsPath"
    Write-Host "    Codex configuration      : $CodexConfig"
    Write-Host "    OpenCode profile         : $OpenCodeDir"
    Write-Host "    Health endpoint          : http://127.0.0.1:8765/healthz"

    $hasAccount = Test-Path (Join-Path $AccountHome "notion_account.json")
    if (-not $hasAccount) {
        $hasAccount = @(Get-ChildItem -LiteralPath (Join-Path $AccountHome "accounts") -Filter "*.json" -File -ErrorAction SilentlyContinue).Count -gt 0
    }
    if (-not $hasAccount) {
        Write-Host ""
        Write-Warning "Notion credentials are not configured yet."
        Write-Warning "The notion-private MCP server remains disabled until credentials are configured."
        Write-Host 'Run: notion-agent init --token-v2 - --all-workspaces --account-home "$AccountHome"'
        Write-Host "Run notion-agent doctor for each account, then re-run the installer to enable MCP."
    }

}

# ── Start server ───────────────────────────────────────────────────────────────

function Invoke-StartServer {
    param([switch]$NoLogTail)

    Assert-Command "node.exe" "Install Node.js 20 or newer."
    Assert-Command "npm.cmd"  "Install Node.js 20 or newer."
    Assert-Node20

    if (-not (Test-Path $RuntimeEnv))  { throw "runtime\.env is missing. Run: .\run-full.ps1 -Action Install" }
    if (-not (Test-Path $NodeServer))  { throw "bridge\server.js is missing." }

    if (-not (Test-NpmInstalled $BridgeDir)) { throw "Bridge dependencies missing. Run: .\run-full.ps1 -Action Install" }

    New-Item -ItemType Directory -Force -Path $RuntimeState, $PidDir | Out-Null

    $envValues = Get-DotEnv $RuntimeEnv
    foreach ($kv in $envValues.GetEnumerator()) {
        [Environment]::SetEnvironmentVariable($kv.Key, $kv.Value, "Process")
    }

    $bridgePort = Get-BridgePort
    $mcpPort    = Get-McpPort
    if ($bridgePort -eq $mcpPort) { throw "Bridge and MCP ports must be different." }

    # Auto-stop existing server/listeners if running (matches run-full.sh)
    Invoke-StopServer

    foreach ($port in @($bridgePort, $mcpPort)) {
        $pidOnPort = Get-ListeningProcessId $port
        if ($pidOnPort) {
            Write-Host "[>] Terminating existing process listening on port $port (PID $pidOnPort)..."
            Stop-Process -Id $pidOnPort -Force -ErrorAction SilentlyContinue
            Start-Sleep -Milliseconds 500
        }
    }

    $env:NOTION_AGENT_HOME  = $AccountHome
    $env:NOTION_RUNTIME_ENV = $RuntimeEnv
    $env:NOTION_FABLE_PORT  = [string]$bridgePort
    $env:MCP_PORT           = [string]$mcpPort
    $env:NOTION_QUIET_POLL  = "1"
    if ([string]::IsNullOrWhiteSpace($env:NOTION_LOG_FORMAT)) { $env:NOTION_LOG_FORMAT = "pretty" }
    if ([string]::IsNullOrWhiteSpace($env:NOTION_COLOR))      { $env:NOTION_COLOR = "1" }

    if (Test-Path $LogFile) { Remove-Item -LiteralPath $LogFile -Force -ErrorAction SilentlyContinue }

    Write-Host ""
    Write-Host "[>] Starting the unified Node server..."
    $cmd = "cmd.exe /c `"set NOTION_AGENT_HOME=$AccountHome&& set NOTION_RUNTIME_ENV=$RuntimeEnv&& set NOTION_FABLE_PORT=$bridgePort&& set MCP_PORT=$mcpPort&& set NOTION_LOG_FORMAT=pretty&& set NOTION_COLOR=1&& node `"$NodeServer`" > `"$LogFile`" 2>&1`""
    $startup = ([wmiclass]"Win32_ProcessStartup").CreateInstance()
    $startup.ShowWindow = 0 # SW_HIDE (hidden in background)
    $procClass = [wmiclass]"Win32_Process"
    $res = $procClass.Create($cmd, $Root, $startup)
    if ($res.ReturnValue -ne 0 -or -not $res.ProcessId) {
        throw "Failed to create unified Node server process (ReturnValue: $($res.ReturnValue))"
    }

    Write-Host "[~] Waiting for both listeners..."
    $ready    = $false
    $deadline = [DateTime]::UtcNow.AddSeconds(30)
    do {
        try {
            Invoke-RestMethod -Uri "http://127.0.0.1:$bridgePort/v1/models" -TimeoutSec 2 | Out-Null
            if (Test-TcpPort $mcpPort) { $ready = $true; break }
        } catch { }
        Start-Sleep -Milliseconds 500
    } while ([DateTime]::UtcNow -lt $deadline)

    if (-not $ready) {
        Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
        throw "Unified Node server failed to become ready. See: $LogFile"
    }

    $bridgeOwner = Get-ListeningProcessId $bridgePort
    $mcpOwner    = Get-ListeningProcessId $mcpPort
    if (-not $bridgeOwner -or -not $mcpOwner -or $bridgeOwner -ne $mcpOwner) {
        if ($bridgeOwner) { Stop-Process -Id $bridgeOwner -Force -ErrorAction SilentlyContinue }
        Remove-Item -LiteralPath $PidFile -Force -ErrorAction SilentlyContinue
        throw "Port ownership check failed; both ports must belong to the same Node process. See: $LogFile"
    }

    $serverPid = $bridgeOwner
    Set-Content -LiteralPath $PidFile -Value $serverPid -Encoding ASCII

    Write-Host ""
    Write-Host "  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    Write-Host "  [✓] Unified Node server is UP (PID $serverPid)" -ForegroundColor Green
    Write-Host "      Bridge:  http://127.0.0.1:$bridgePort"
    Write-Host "      Runtime: http://127.0.0.1:$mcpPort"
    Write-Host "      Log:     $LogFile"

    if (-not $env:NO_OPEN_DASHBOARD) {
        Start-Process "http://127.0.0.1:$bridgePort/dashboard"
    }

    if ($NoLogTail) {
        return
    }

    Write-Host ""
    Write-Host "  To use with Codex CLI:"
    Write-Host "    `$env:ANTHROPIC_BASE_URL = 'http://127.0.0.1:$bridgePort'"
    Write-Host "    `$env:ANTHROPIC_API_KEY  = 'sk-notioncode'"
    Write-Host "    codex"
    Write-Host ""
    Write-Host "  Streaming live logs (Press Ctrl+C to stop the server):"
    Write-Host "  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    Write-Host ""
    try {
        Get-Content -LiteralPath $LogFile -Wait -Tail 25
    } finally {
        Write-Host ""
        Write-Host "[>] Stopping the unified Node server..."
        Invoke-StopServer
    }
}

# ── Stop server ────────────────────────────────────────────────────────────────

function Invoke-StopServer {
    if (Test-Path $PidFile) {
        $processId = 0
        $rawPid = (Get-Content -LiteralPath $PidFile -Raw).Trim()
        if (-not [int]::TryParse($rawPid, [ref]$processId) -or $processId -le 0) {
            Write-Warning "Removing invalid unified server PID file."
            Remove-Item -LiteralPath $PidFile -Force
        } else {
            $process = Get-Process -Id $processId -ErrorAction SilentlyContinue
            if (-not $process) {
                Write-Host "Removing stale unified server PID file."
                Remove-Item -LiteralPath $PidFile -Force
            } else {
                $info = Get-CimInstance Win32_Process -Filter "ProcessId = $processId" -ErrorAction SilentlyContinue
                $cmdLine = if ($info) { [string]$info.CommandLine } else { "" }
                $isOurs = $process.ProcessName -like "node*" -and $cmdLine -match 'bridge[\\/]server\.js'
                if (-not $isOurs) {
                    Write-Warning "PID $processId is not the unified notioncode Node server; not stopping."
                    Remove-Item -LiteralPath $PidFile -Force
                } else {
                    Stop-Process -Id $processId
                    if (-not $process.WaitForExit(10000)) { Stop-Process -Id $processId -Force }
                    Remove-Item -LiteralPath $PidFile -Force
                    Write-Host "[✓] Stopped unified Node server (PID $processId)." -ForegroundColor Green
                }
            }
        }
    } else {
        Write-Host "Unified Node server PID file is not present."
    }
    # Clean up legacy PID files
    foreach ($legacyName in @("bridge.pid", "runtime.pid")) {
        $legacyPath = Join-Path $PidDir $legacyName
        if (Test-Path $legacyPath) {
            Remove-Item -LiteralPath $legacyPath -Force
            Write-Host "Removed stale legacy PID file: $legacyName"
        }
    }
}

# ── Status ─────────────────────────────────────────────────────────────────────

function Show-Status {
    $bridgePort = Get-BridgePort
    $mcpPort    = Get-McpPort
    $result = [ordered]@{
        project_root        = $Root
        "runtime_port_$mcpPort"    = Test-TcpPort $mcpPort
        "bridge_port_$bridgePort"  = Test-TcpPort $bridgePort
        account_file        = Test-Path (Join-Path $AccountHome "notion_account.json")
        models_file         = Test-Path $ModelsPath
    }
    if ($result["bridge_port_$bridgePort"]) {
        try   { $result.health = Invoke-RestMethod -Uri "http://127.0.0.1:$bridgePort/healthz" -TimeoutSec 5 }
        catch { $result.health_error = $_.Exception.Message }
    }
    [pscustomobject]$result | ConvertTo-Json -Depth 10
}

# ── Verify ─────────────────────────────────────────────────────────────────────

function Invoke-Verify {
    param([switch]$SkipLiveChecks)

    $required = @(
        "bridge\server.js"
        "bridge\package.json"
        "bridge\package-lock.json"
        "bridge\bin\notion-agent.mjs"
        "bridge\src\http-server.js"
        "bridge\src\mcp-server.js"
        "bridge\src\runtime-tools.js"
        "runtime\.env"
        "notion-private-api-mcp\run-from-account.js"
        "config\codex-models.json"
        ".runtime\opencode\opencode.jsonc"
    )
    $missing = @($required | Where-Object { -not (Test-Path (Join-Path $Root $_)) })
    if ($missing.Count -gt 0) { throw "Missing installed files: $($missing -join ', ')" }

    Assert-Command "node.exe" "Install Node.js 20 or newer."
    Assert-Command "npm.cmd"  "Install Node.js 20 or newer."
    Assert-Node20
    if (-not (Test-NpmInstalled $BridgeDir)) { throw "Bridge dependencies are missing or invalid." }

    if (-not (Test-Path $ModelsPath)) { throw "Model alias file missing: $ModelsPath" }
    if (-not (Test-Path $CodexConfig)) { throw "Codex configuration missing: $CodexConfig" }

    $cfgText = Get-Content -LiteralPath $CodexConfig -Raw -Encoding UTF8
    if ($cfgText -notmatch 'model_provider\s*=\s*"notion-ai"' -or $cfgText -notmatch '\[model_providers\.notion-ai\]') {
        throw "Codex is not configured for the Notion provider: $CodexConfig"
    }
    if ($cfgText -notmatch '(?s)\[mcp_servers\.notion-private\].*?enabled\s*=\s*true') {
        throw "The notion-private MCP server is disabled. Run AddAccount then re-run Install."
    }

    $bridgePort = Get-BridgePort
    $mcpPort    = Get-McpPort
    if ($bridgePort -eq $mcpPort) { throw "Bridge and MCP ports must be different." }

    $unifiedPid = $null
    if (-not $SkipLiveChecks) {
        if (-not (Test-TcpPort $mcpPort))    { throw "MCP runtime is not listening on 127.0.0.1:$mcpPort" }
        if (-not (Test-TcpPort $bridgePort)) { throw "Bridge is not listening on 127.0.0.1:$bridgePort" }

        $bOwner = Get-ListeningProcessId $bridgePort
        $mOwner = Get-ListeningProcessId $mcpPort
        if (-not $bOwner -or -not $mOwner -or $bOwner -ne $mOwner) {
            throw "Bridge and MCP listeners are not owned by one process."
        }
        $unifiedPid = $bOwner
        $proc = Get-Process -Id $unifiedPid -ErrorAction SilentlyContinue
        $info = Get-CimInstance Win32_Process -Filter "ProcessId = $unifiedPid" -ErrorAction SilentlyContinue
        $cmdLine = if ($info) { [string]$info.CommandLine } else { "" }
        if (-not $proc -or $proc.ProcessName -notlike "node*" -or $cmdLine -notmatch 'bridge[\\/]server\.js') {
            throw "The shared listener process is not the unified notioncode Node server."
        }

        $health = Invoke-RestMethod -Uri "http://127.0.0.1:$bridgePort/healthz" -TimeoutSec 10
        if (-not $health.ok) { throw "Bridge health check reports no valid Notion accounts." }
    }

    [pscustomobject]@{
        ok               = $true
        project_root     = $Root
        bridge_port      = $bridgePort
        mcp_port         = $mcpPort
        unified_pid      = $unifiedPid
        live_checks      = (-not $SkipLiveChecks)
    } | ConvertTo-Json -Depth 10
}

# ── Token profile ──────────────────────────────────────────────────────────────

function Invoke-TokenProfile {
    param([ValidateSet("safe", "extreme")][string]$Profile)
    $args = @($TokenProfileScript, $RuntimeState, $CodexConfig, $CatalogTemplate, $OpenCodeConfig)
    if ($Profile) { $args += $Profile }
    & node.exe @args
    if ($LASTEXITCODE -ne 0) { throw "Token profile update failed." }
}

function Invoke-Settings {
    Invoke-EnsureSetup
    $current = "extreme"
    if (Test-Path $TokenProfileState) { $current = (Get-Content -LiteralPath $TokenProfileState -Raw).Trim() }

    Write-Host ""
    Write-Host "  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    Write-Host "   Token Settings (current: $current)"
    Write-Host "  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    Write-Host "    1) Safe    — 100K context, auto-compact at 60K"
    Write-Host "    2) Extreme — 256K context, auto-compact at 140K"
    Write-Host "    3) Back"
    Write-Host ""

    switch (Read-Host "  Select a token profile [1-3]") {
        "1" { Invoke-TokenProfile -Profile "safe" }
        "2" { Invoke-TokenProfile -Profile "extreme" }
        "3" { return }
        default { throw "Invalid token profile." }
    }
    Write-Host "[✓] Reload VS Code/Codex and open a new chat to use the new limits." -ForegroundColor Green
}

# ── Check accounts ─────────────────────────────────────────────────────────────

function Invoke-CheckAccounts {
    Assert-Command "node.exe" "Install Node.js 20 or newer."
    Assert-Node20
    $files = @(Get-AccountFiles)

    Write-Host ""
    Write-Host "  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    Write-Host "   Account Status"
    Write-Host "  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

    if ($files.Count -eq 0) {
        Write-Host ""
        Write-Host "  No accounts configured."
        Write-Host "  Use option 3 to add an account."
        Write-Host "  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        return
    }

    $failed = 0
    foreach ($file in $files) {
        Write-Host ""
        Write-Host "  [>] $($file.FullName)"
        & node.exe $NodeCli doctor --account $file.FullName
        if ($LASTEXITCODE -eq 0) {
            Write-Host "      [✓] Account verified" -ForegroundColor Green
        } else {
            Write-Host "      [!] Doctor check failed" -ForegroundColor Red
            $failed += 1
        }
    }

    Write-Host ""
    Write-Host "  Total accounts found: $($files.Count)"
    if ($failed -gt 0) { Write-Host "  Failed checks: $failed" -ForegroundColor Red }
    Write-Host "  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

    if ($failed -gt 0) { throw "$failed account check(s) failed." }
}

# ── Add account ────────────────────────────────────────────────────────────────

function Invoke-AddAccount {
    Invoke-EnsureSetup
    New-Item -ItemType Directory -Force -Path $AccountHome, (Join-Path $AccountHome "accounts") | Out-Null

    Write-Host ""
    Write-Host "  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    Write-Host "   How to get your token_v2:"
    Write-Host "    1. Open Notion in your browser"
    Write-Host "    2. Press F12 (DevTools) → Application → Cookies"
    Write-Host "    3. Open the notion.so cookie list"
    Write-Host "    4. Find 'token_v2' and copy its value"
    Write-Host "  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    Write-Host ""

    $secureToken = Read-Host "  Paste your token_v2 here (input is hidden)" -AsSecureString
    $ptr = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureToken)
    try {
        $token = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($ptr)
        if ([string]::IsNullOrWhiteSpace($token)) { throw "No token was entered. Aborting." }
        Write-Host ""
        Write-Host "  [>] Discovering and provisioning every workspace for this credential..."
        $oldEap = $ErrorActionPreference
        $ErrorActionPreference = "SilentlyContinue"
        $output = @(
            $token | & node.exe $NodeCli init --token-v2 - --all-workspaces --account-home $AccountHome 2>&1
        )
        $exitCode = $LASTEXITCODE
        $ErrorActionPreference = $oldEap
    } finally {
        if ($ptr -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($ptr) }
        $token = $null; $secureToken = $null
    }

    $output | ForEach-Object { Write-Host $_ }
    if ($exitCode -ne 0) {
        Write-Host "[!] Account initialization failed:" -ForegroundColor Red
        throw "Account initialization failed."
    }

    $createdFiles = @(
        $output | ForEach-Object {
            if ([string]$_ -match '^\[init\] wrote (.+)$') { $Matches[1] }
        }
    )

    if ($createdFiles.Count -eq 0) {
        Write-Host "[✓] Every discovered workspace was already configured." -ForegroundColor Green
        return
    }

    Write-Host ""
    Write-Host "  [>] Verifying $($createdFiles.Count) newly created workspace account(s)..."
    $failed = 0
    foreach ($file in $createdFiles) {
        Write-Host ""
        Write-Host "    [>] $(Split-Path $file -Leaf)"
        & node.exe $NodeCli doctor --account $file --json
        if ($LASTEXITCODE -eq 0) {
            Write-Host "    [✓] Verified: $file" -ForegroundColor Green
        } else {
            Write-Host "    [!] Verification failed: $file" -ForegroundColor Red
            $failed += 1
        }
    }

    if ($failed -gt 0) { throw "[!] $failed workspace account(s) failed verification." }

    Write-Host ""
    Write-Host "[✓] All newly created workspace accounts were verified." -ForegroundColor Green
}

# ── Refresh client version ─────────────────────────────────────────────────────

function Invoke-RefreshClientVersion {
    Assert-Command "node.exe" "Install Node.js 20 or newer."
    Assert-Node20
    $files = @(Get-AccountFiles)

    Write-Host ""
    Write-Host "  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
    Write-Host "   Refreshing Client Token Version for all Accounts"
    Write-Host "  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

    if ($files.Count -eq 0) {
        Write-Host "  No accounts found to refresh."
        return
    }

    $failed = 0
    foreach ($file in $files) {
        Write-Host ""
        Write-Host "  [>] Refreshing: $($file.Name)"
        & node.exe $NodeCli doctor --refresh-client-version --account $file.FullName
        if ($LASTEXITCODE -ne 0) { $failed += 1 }
    }
    Write-Host ""
    if ($failed -gt 0) {
        Write-Host "  [!] Token refresh failed for $failed account(s)." -ForegroundColor Red
        Write-Host "  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
        throw "Client-version refresh failed for $failed account(s)."
    }
    Write-Host "  [✓] Client token refresh sequence complete!" -ForegroundColor Green
    Write-Host "  ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
}

# ── Start (menu action — installs if needed, then starts) ──────────────────────

function Invoke-Start {
    if (@(Get-AccountFiles).Count -eq 0) {
        Write-Host ""
        Write-Host "  [!] No Notion accounts configured." -ForegroundColor Yellow
        Write-Host "      You must add an account before starting."
        Write-Host ""
        $answer = Read-Host "  Would you like to add one now? [Y/n]"
        if ($answer -match '^[Nn]') { Write-Host "Exiting."; return }
        Invoke-AddAccount
    }
    Invoke-EnsureSetup
    Invoke-StartServer
}

# ── Dashboard ──────────────────────────────────────────────────────────────────

function Invoke-Dashboard {
    Invoke-EnsureSetup

    $DashboardDir = Join-Path $Root "dashboard"
    $DistIndex = Join-Path $DashboardDir "dist\index.html"
    $ChecksumFile = Join-Path $DashboardDir "dist\.src-checksum"

    # Compute SHA256 checksum of all src/ files + package.json
    $srcDir = Join-Path $DashboardDir "src"
    $pkgJson = Join-Path $DashboardDir "package.json"
    $srcFiles = @()
    if (Test-Path $srcDir) {
        $srcFiles += @(Get-ChildItem -LiteralPath $srcDir -Recurse -File | Sort-Object FullName)
    }
    if (Test-Path $pkgJson) {
        $srcFiles += Get-Item -LiteralPath $pkgJson
    }

    $combinedHash = ""
    if ($srcFiles.Count -gt 0) {
        $hasher = [System.Security.Cryptography.SHA256]::Create()
        $allBytes = [System.Text.StringBuilder]::new()
        foreach ($f in $srcFiles) {
            $hash = [BitConverter]::ToString($hasher.ComputeHash([System.IO.File]::ReadAllBytes($f.FullName))) -replace '-',''
            [void]$allBytes.AppendLine("$hash  $($f.FullName)")
        }
        $combinedHash = [BitConverter]::ToString(
            $hasher.ComputeHash([System.Text.Encoding]::UTF8.GetBytes($allBytes.ToString()))
        ) -replace '-',''
        $hasher.Dispose()
    }

    $savedHash = if (Test-Path $ChecksumFile) { (Get-Content -LiteralPath $ChecksumFile -Raw).Trim() } else { "" }

    if (-not (Test-Path $DistIndex) -or ($combinedHash -and $combinedHash -ne $savedHash)) {
        Write-Host "[>] Dashboard source changed — rebuilding static assets..." -ForegroundColor Cyan
        & npm.cmd --prefix $DashboardDir install --silent 2>$null
        & npm.cmd --prefix $DashboardDir run build
        if ($LASTEXITCODE -ne 0) {
            Write-Host "[!] Dashboard build failed; continuing with existing dist if present." -ForegroundColor Yellow
        } else {
            if ($combinedHash) {
                Set-Content -LiteralPath $ChecksumFile -Value $combinedHash -NoNewline -Encoding ASCII
            }
        }
    } else {
        Write-Host "[✓] Dashboard is up to date; skipping rebuild." -ForegroundColor Green
    }

    Invoke-StartServer

    # Hide current launcher console window if running interactively
    $asyncCode = '[DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow); [DllImport("kernel32.dll")] public static extern IntPtr GetConsoleWindow();'
    $type = Add-Type -MemberDefinition $asyncCode -Name "Win32Utils" -Namespace "Win32" -PassThru -ErrorAction SilentlyContinue
    if ($type) {
        $hwnd = [Win32.Win32Utils]::GetConsoleWindow()
        if ($hwnd -ne [IntPtr]::Zero) {
            [Win32.Win32Utils]::ShowWindow($hwnd, 0) | Out-Null # SW_HIDE
        }
    }
}

# ── Main Menu ──────────────────────────────────────────────────────────────────

function Show-Menu {
    Clear-Host
    $accountCount = @(Get-AccountFiles).Count

    Write-Host ""
    Write-Host "  ╔══════════════════════════════════════════╗"
    Write-Host "  ║      NotionCode MCP — Launcher           ║"
    Write-Host "  ╚══════════════════════════════════════════╝"
    Write-Host ""

    if ($accountCount -gt 0) {
        Write-Host "  Status: ✅ $accountCount account(s) configured" -ForegroundColor Green
    } else {
        Write-Host "  Status: ❌ No accounts configured" -ForegroundColor Red
    }

    Write-Host ""
    Write-Host "  1)  🚀  Start unified Node server"
    Write-Host "  2)  🔍  Check accounts"
    Write-Host "  3)  ➕  Add a new account"
    Write-Host "  4)  🔄  Refresh account live tokens"
    Write-Host "  5)  📊  Open Dashboard"
    Write-Host "  6)  ⚙️   Settings"
    Write-Host "  7)  ❌  Exit"
    Write-Host ""

    switch (Read-Host "  Select an option [1-7]") {
        "1" { Invoke-Start }
        "2" { Invoke-CheckAccounts }
        "3" { Invoke-AddAccount }
        "4" { Invoke-RefreshClientVersion }
        "5" { Invoke-Dashboard }
        "6" { Invoke-Settings }
        "7" { return }
        default { throw "Invalid option." }
    }
}

# ── Dispatch ───────────────────────────────────────────────────────────────────

switch ($Action) {
    "Menu"                 { Invoke-Dashboard }
    "Start"                { Invoke-Start }
    "Stop"                 { Invoke-StopServer }
    "Status"               { Show-Status }
    "CheckAccounts"        { Invoke-CheckAccounts }
    "AddAccount"           { Invoke-AddAccount }
    "RefreshClientVersion" { Invoke-RefreshClientVersion }
    "Settings"             { Invoke-Settings }
    "Dashboard"            { Invoke-Dashboard }
    "Install"              { Invoke-Install }
    "Verify"               { Invoke-Verify }
    "OpenCode"             { Invoke-OpenCode }
}
