# Voice Copilot Setup (Whisper + Piper + Mumble)

## 1) App dependencies

`openai` is required for Whisper transcription.

```bash
npm install
```

## 2) Environment variables

Add these to your `.env` on Vultr:

```bash
OPENAI_API_KEY=sk-...
WHISPER_MODEL=whisper-1

PIPER_BIN=piper
PIPER_MODEL=/opt/piper/en_US-amy-medium.onnx
PIPER_SPEAKER=

VOICE_TRANSPORT=http
MUMBLE_ENABLED=false
MUMBLE_HOST=127.0.0.1
MUMBLE_PORT=64738
```

## 3) Install Piper on Vultr

```bash
sudo mkdir -p /opt/piper
cd /opt/piper

# Example x86_64 Linux binary (update URL to latest release if needed)
sudo wget -O piper.tar.gz https://github.com/rhasspy/piper/releases/download/v1.2.0/piper_linux_x86_64.tar.gz
sudo tar -xzf piper.tar.gz
sudo ln -sf /opt/piper/piper /usr/local/bin/piper

# Example high quality English model
sudo wget -O /opt/piper/en_US-amy-medium.onnx https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/amy/medium/en_US-amy-medium.onnx
sudo wget -O /opt/piper/en_US-amy-medium.onnx.json https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/amy/medium/en_US-amy-medium.onnx.json
```

Quick test:

```bash
echo "Voice test from AlphaConfluence" | piper --model /opt/piper/en_US-amy-medium.onnx --output_file /tmp/piper-test.wav
```

## 4) Install Mumble server (Murmur) on Vultr

```bash
sudo apt-get update
sudo apt-get install -y mumble-server
sudo dpkg-reconfigure mumble-server
sudo systemctl enable mumble-server
sudo systemctl restart mumble-server
sudo systemctl status mumble-server
```

Open firewall for UDP/TCP `64738` if you plan to use Mumble transport.

## 5) Current app behavior

- `/api/voice/transcribe` -> Whisper (OpenAI)
- `/api/voice/synthesize` -> Piper (WAV response)
- `/api/voice/transport` -> reports `http` or `mumble` mode
- `/ws/voice` -> low-latency realtime voice gateway (browser WebSocket)

When `VOICE_TRANSPORT=http`, the app uses HTTP upload/download voice flow.
When `VOICE_TRANSPORT=mumble`, both LLM Chat and Chart Copilot switch to realtime WebSocket audio chunk streaming and process STT -> LLM -> TTS in one round trip, with fallback to HTTP/text mode if needed.
