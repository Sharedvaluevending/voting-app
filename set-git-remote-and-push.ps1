# Run this once with your GitHub Personal Access Token (PAT) so push works without a popup.
# 1. Create a PAT at https://github.com/settings/tokens (scope: repo)
# 2. Run: .\set-git-remote-and-push.ps1 -Token "ghp_yourTokenHere"
#    Or run and paste when asked.

param(
  [string]$Token = ""
)

$git = "C:\Program Files\Git\bin\git.exe"
$repo = "https://github.com/Sharedvaluevending/voting-app"
$user = "Sharedvaluevending"

if (-not $Token) {
  $Token = Read-Host "Paste your GitHub PAT (ghp_...)" -AsSecureString
  $BSTR = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($Token)
  $Token = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($BSTR)
  [System.Runtime.InteropServices.Marshal]::ZeroFreeBSTR($BSTR)
}

if (-not $Token) {
  Write-Host "No token. Create one at https://github.com/settings/tokens then run again."
  exit 1
}

Set-Location $PSScriptRoot
& $git remote set-url origin "https://${user}:$Token@github.com/Sharedvaluevending/voting-app"
Write-Host "Remote updated. Pushing..."
& $git push origin main
Write-Host "Done. Your PAT is now in .git/config (local only, not pushed to GitHub). Future pushes will work."
