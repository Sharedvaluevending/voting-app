const fs = require('fs').promises;
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');
const OpenAI = require('openai');
const { toFile } = require('openai/uploads');

const whisperClient = process.env.OPENAI_API_KEY
  ? new OpenAI({ apiKey: process.env.OPENAI_API_KEY })
  : null;

function extFromMimeType(mimeType) {
  const safe = String(mimeType || '').toLowerCase();
  if (safe.includes('webm')) return 'webm';
  if (safe.includes('ogg')) return 'ogg';
  if (safe.includes('mp4') || safe.includes('m4a')) return 'm4a';
  if (safe.includes('mpeg') || safe.includes('mp3')) return 'mp3';
  if (safe.includes('wav')) return 'wav';
  return 'webm';
}

function parseBase64Audio(input) {
  const raw = String(input || '').trim();
  if (!raw) return null;

  const m = raw.match(/^data:([^;]+);base64,(.+)$/);
  if (m) {
    return {
      mimeType: m[1] || 'audio/webm',
      buffer: Buffer.from(m[2], 'base64')
    };
  }

  return {
    mimeType: 'audio/webm',
    buffer: Buffer.from(raw, 'base64')
  };
}

async function transcribeWithWhisper(audioBuffer, mimeType) {
  if (!whisperClient) {
    throw new Error('OPENAI_API_KEY is not configured on server');
  }
  const startedAt = Date.now();
  const ext = extFromMimeType(mimeType);
  const file = await toFile(audioBuffer, `voice-input.${ext}`, { type: mimeType || 'audio/webm' });
  const result = await whisperClient.audio.transcriptions.create({
    model: process.env.WHISPER_MODEL || 'whisper-1',
    file,
    language: 'en'
  });
  return {
    text: String(result?.text || '').trim(),
    latencyMs: Date.now() - startedAt
  };
}

async function synthesizeWithPiper(text) {
  const piperBin = process.env.PIPER_BIN || 'piper';
  const modelPath = process.env.PIPER_MODEL;
  const speaker = process.env.PIPER_SPEAKER;

  if (!modelPath) {
    throw new Error('PIPER_MODEL is not configured on server');
  }

  const startedAt = Date.now();
  const outFile = path.join(os.tmpdir(), `piper-${Date.now()}-${crypto.randomBytes(5).toString('hex')}.wav`);
  const args = ['--model', modelPath, '--output_file', outFile];
  if (speaker != null && String(speaker).trim() !== '') {
    args.push('--speaker', String(speaker).trim());
  }

  await new Promise((resolve, reject) => {
    const proc = spawn(piperBin, args, { stdio: ['pipe', 'ignore', 'pipe'] });
    let stderr = '';

    proc.stderr.on('data', (chunk) => {
      stderr += String(chunk || '');
    });

    proc.on('error', (err) => {
      reject(new Error(`Unable to start Piper (${piperBin}): ${err.message}`));
    });

    proc.on('close', (code) => {
      if (code === 0) return resolve();
      reject(new Error(`Piper exited with code ${code}. ${stderr.trim()}`.trim()));
    });

    proc.stdin.write(String(text || ''));
    proc.stdin.end();
  });

  try {
    const audioBuffer = await fs.readFile(outFile);
    return {
      audioBuffer,
      mimeType: 'audio/wav',
      latencyMs: Date.now() - startedAt
    };
  } finally {
    await fs.unlink(outFile).catch(() => {});
  }
}

module.exports = {
  parseBase64Audio,
  transcribeWithWhisper,
  synthesizeWithPiper
};
