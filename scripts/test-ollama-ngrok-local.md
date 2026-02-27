# Test Ollama through ngrok (run on your PC)

Run these in PowerShell or Command Prompt **on the same machine where Ollama and ngrok run**.

Replace `YOUR_NGROK_URL` with your ngrok URL, e.g. `https://kent-attackable-emanuel.ngrok-free.dev`

## 1. Test GET (should return 200)
```powershell
curl -H "ngrok-skip-browser-warning: 1" "YOUR_NGROK_URL/api/tags"
```

## 2. Test POST /v1/chat/completions
```powershell
curl -X POST "YOUR_NGROK_URL/v1/chat/completions" -H "Content-Type: application/json" -H "ngrok-skip-browser-warning: 1" -H "User-Agent: VotingApp-Ollama/1.0" -d "{\"model\":\"qwen3-coder:480b-cloud\",\"messages\":[{\"role\":\"user\",\"content\":\"Say hi\"}]}"
```

## 3. Test POST /api/generate
```powershell
curl -X POST "YOUR_NGROK_URL/api/generate" -H "Content-Type: application/json" -H "ngrok-skip-browser-warning: 1" -d "{\"model\":\"qwen3-coder:480b-cloud\",\"prompt\":\"Say hi\"}"
```

**If 1 works but 2 and 3 return 404:** Your Ollama may need updating. Run `ollama update`.

**If all work locally:** The issue may be that requests from Render (cloud) are treated differently by ngrok. Consider:
- ngrok paid plan (no interstitial)
- Cloudflare Tunnel (free alternative)
- Run the app locally instead of Render when using Ollama
