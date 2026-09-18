# Folio 02 (Sync Ledger) step 7 — PowerShell wrapper for a Windows Task
# Scheduler job. Point Task Scheduler's Action directly at scheduled-sync.js
# via node.exe if preferred (see that file's own header) — this wrapper
# exists only to also capture stdout/stderr to a timestamped log file,
# which a bare "node.exe scheduled-sync.js" Action does not do on its own.
#
# Task Scheduler setup:
#   Program/script:  powershell.exe
#   Arguments:       -NoProfile -ExecutionPolicy Bypass -File "<full path to this file>"
#   Start in:        <this directory> (busy-extraction-poc\)
#   Trigger:         Daily, at whatever time this dealer's Busy data for
#                    the day is expected to be settled (e.g. after close of
#                    business) — no specific time is prescribed here, since
#                    that's a business decision, not a technical one.
#
# Requires Node.js to be installed and on PATH on the machine this runs on
# (confirm with `node --version` in a plain cmd/PowerShell window first).

$ErrorActionPreference = "Stop"
Set-Location -Path $PSScriptRoot

$logDir = Join-Path $PSScriptRoot "output"
if (-not (Test-Path $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
$logFile = Join-Path $logDir ("scheduled-sync-{0}.log" -f (Get-Date -Format "yyyy-MM-dd"))

"=== Run started $(Get-Date -Format o) ===" | Out-File -Append -FilePath $logFile

try {
    node scheduled-sync.js *>> $logFile
    $exitCode = $LASTEXITCODE
} catch {
    $_.Exception.Message | Out-File -Append -FilePath $logFile
    $exitCode = 1
}

"=== Run finished $(Get-Date -Format o), exit code $exitCode ===" | Out-File -Append -FilePath $logFile
exit $exitCode
