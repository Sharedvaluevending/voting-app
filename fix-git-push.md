# Fix Git push stuck (worked before, now hangs)

## Why it gets stuck
Git is using **cached credentials** (Credential Manager). When that credential is expired or invalid, Git tries to re-authenticate but the popup doesn’t show, so the push just hangs.

## Step 1: Remove the old credential (so nothing is cached)

**Option A – Windows Credential Manager (recommended)**  
1. Press **Win**, type **Credential Manager**, open it.  
2. Click **Windows Credentials**.  
3. Under “Generic Credentials”, find **git:https://github.com** (or similar).  
4. Click it → **Remove**.

**Option B – From PowerShell**  
Run this to remove the GitHub credential:

```powershell
cmdkey /delete:git:https://github.com
```

(If it says "element not found", the cache is already clear.)

## Step 2: Push using a token in the URL (no popup, no cache)

1. Create a token: https://github.com/settings/tokens → **Generate new token (classic)** → check **repo** → Generate → **copy the token** (`ghp_...`).

2. In PowerShell, from your repo folder:

```powershell
cd c:\Users\mekal\clone\voting-app
& "C:\Program Files\Git\bin\git.exe" remote set-url origin https://Sharedvaluevending:YOUR_TOKEN_HERE@github.com/Sharedvaluevending/voting-app
& "C:\Program Files\Git\bin\git.exe" push origin main
```

Replace `YOUR_TOKEN_HERE` with your real token. After this, future pushes should work without getting stuck.
