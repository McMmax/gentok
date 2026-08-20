# GenTok one-time setup — installs everything needed to run run-dev.ps1
$ErrorActionPreference = "Continue"
$root = $PSScriptRoot
Write-Host "`n=== GenTok setup ===" -ForegroundColor Green

function Have($cmd) { [bool](Get-Command $cmd -ErrorAction SilentlyContinue) }

# --- Prerequisite checks ---
if (-not (Have python)) { Write-Host "Python not found - install from https://www.python.org/downloads/ (check 'Add to PATH'), then re-run." -ForegroundColor Red; exit 1 }
if (-not (Have node))   { Write-Host "Node.js not found - install from https://nodejs.org , then re-run." -ForegroundColor Red; exit 1 }

# --- FFmpeg: direct download (no winget needed) ---
$ffbin = "$root\tools\ffmpeg\bin"
if (-not (Have ffmpeg) -and -not (Test-Path "$ffbin\ffmpeg.exe")) {
    Write-Host "FFmpeg not found - downloading (~90 MB)..." -ForegroundColor Yellow
    $zip = "$env:TEMP\ffmpeg.zip"
    Invoke-WebRequest "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip" -OutFile $zip
    Expand-Archive $zip -DestinationPath "$env:TEMP\ffmpeg_x" -Force
    $inner = Get-ChildItem "$env:TEMP\ffmpeg_x" -Directory | Select-Object -First 1
    New-Item -ItemType Directory -Force -Path "$root\tools" | Out-Null
    Move-Item $inner.FullName "$root\tools\ffmpeg" -Force
    Remove-Item $zip -Force -ErrorAction SilentlyContinue
    Remove-Item "$env:TEMP\ffmpeg_x" -Recurse -Force -ErrorAction SilentlyContinue
}
if (Test-Path "$ffbin\ffmpeg.exe") {
    $env:Path = "$ffbin;" + $env:Path
    # persist to user PATH so it works in every future terminal
    $userPath = [Environment]::GetEnvironmentVariable("Path", "User")
    if ($userPath -notlike "*$ffbin*") {
        [Environment]::SetEnvironmentVariable("Path", "$userPath;$ffbin", "User")
    }
}

# --- Claude Code CLI (subscription LLM) ---
if (-not (Have claude)) {
    Write-Host "`nInstalling Claude Code CLI..." -ForegroundColor Green
    npm install -g @anthropic-ai/claude-code
    $env:Path = [Environment]::GetEnvironmentVariable("Path", "Machine") + ";" + [Environment]::GetEnvironmentVariable("Path", "User")
}

# --- Backend deps ---
Write-Host "`nInstalling Python packages..." -ForegroundColor Green
python -m pip install --upgrade pip
python -m pip install -r "$root\backend\requirements.txt"

# --- Frontend deps ---
Write-Host "`nInstalling frontend packages..." -ForegroundColor Green
Push-Location "$root\frontend"
if (Test-Path node_modules) { Remove-Item -Recurse -Force node_modules -ErrorAction SilentlyContinue }
npm install --no-audit --no-fund
Pop-Location

# --- .env ---
if (-not (Test-Path "$root\.env")) { Copy-Item "$root\.env.example" "$root\.env" }

# --- Verify ---
Write-Host "`n=== Verification ===" -ForegroundColor Green
foreach ($c in "python","node","ffmpeg","claude") {
    if (Have $c) { Write-Host "  [OK] $c" -ForegroundColor Green } else { Write-Host "  [MISSING] $c - restart PowerShell and re-run setup.ps1" -ForegroundColor Red }
}
python -c "import fastapi, yt_dlp, faster_whisper; print('  [OK] Python packages')" 2>$null
if (Test-Path "$root\frontend\node_modules\.bin\next.cmd") { Write-Host "  [OK] frontend packages" -ForegroundColor Green }

Write-Host "`nLast step (one time): run 'claude' in a terminal and log in with your Claude account." -ForegroundColor Yellow
Write-Host "Then start the app any time with: .\run-dev.ps1`n" -ForegroundColor Green
