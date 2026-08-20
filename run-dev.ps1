# Starts backend (:8000) and frontend (:3000) in separate windows
$root = $PSScriptRoot
# Use bundled FFmpeg if present
if (Test-Path "$root\tools\ffmpeg\bin\ffmpeg.exe") { $env:Path = "$root\tools\ffmpeg\bin;" + $env:Path }
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$root\backend'; python -m uvicorn app.main:app --reload --port 8000"
Start-Process powershell -ArgumentList "-NoExit", "-Command", "cd '$root\frontend'; npm run dev"
Write-Host "GenTok starting: API http://localhost:8000  UI http://localhost:3000"
