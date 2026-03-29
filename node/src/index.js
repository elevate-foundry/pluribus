/**
 * node/src/index.js
 * Pluribus Swarm Node entry point.
 *
 * Auto-launches llama.cpp if LLAMA_AUTO_START=true (default) and
 * LLAMA_SERVER_BIN + LLAMA_MODEL_PATH are set or discoverable.
 *
 * Usage (simplest — bootstrap sets all env vars in the launcher):
 *   pluribus-node
 *
 * Manual:
 *   LLAMA_URL=http://localhost:8080 LLAMA_MODEL=smollm2-360m \
 *   LLAMA_ROLE=proposer PLURIBUS_COORDINATOR=http://localhost:7779 \
 *   node src/index.js
 */

import { buildNodeServer } from './server.js';
import { spawn } from 'child_process';
import { existsSync } from 'fs';
import { join } from 'path';
import os from 'os';

const PORT = parseInt(process.env.NODE_PORT || '7778', 10);
const HOST = process.env.NODE_HOST || '0.0.0.0';

// ── Auto-start llama.cpp ──────────────────────────────────────────────────────

const AUTO_START = process.env.LLAMA_AUTO_START !== 'false';
const LLAMA_PORT = parseInt(process.env.LLAMA_PORT || '8080', 10);
const LLAMA_URL  = process.env.LLAMA_URL || `http://localhost:${LLAMA_PORT}`;

// Discover llama-server binary
function findLlamaServer() {
  const candidates = [
    process.env.LLAMA_SERVER_BIN,
    join(os.homedir(), '.pluribus-llama', 'llama-server'),
    '/usr/local/bin/llama-server',
    '/usr/bin/llama-server',
  ].filter(Boolean);
  return candidates.find(p => existsSync(p)) || null;
}

// Discover model file
function findModel() {
  const explicit = process.env.LLAMA_MODEL_PATH;
  if (explicit && existsSync(explicit)) return explicit;

  const modelsDir = join(os.homedir(), 'models');
  const candidates = [
    join(modelsDir, 'smollm2-360m-q4.gguf'),
    join(modelsDir, 'smollm2-360m-q4_k_m.gguf'),
    join(modelsDir, 'smollm2-1.7b-q4.gguf'),
    join(modelsDir, 'qwen2.5-0.5b-q4.gguf'),
  ];
  return candidates.find(p => existsSync(p)) || null;
}

// Check if llama.cpp is already running on the target port
async function isLlamaRunning(url) {
  try {
    const { default: fetch } = await import('node-fetch');
    const res = await fetch(`${url}/health`, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

// Wait for llama.cpp to become ready (up to maxWait ms)
async function waitForLlama(url, maxWait = 120_000) {
  const start = Date.now();
  process.stdout.write('  Waiting for llama.cpp to load model');
  while (Date.now() - start < maxWait) {
    if (await isLlamaRunning(url)) {
      process.stdout.write(' ready!\n');
      return true;
    }
    process.stdout.write('.');
    await new Promise(r => setTimeout(r, 2000));
  }
  process.stdout.write(' timed out\n');
  return false;
}

async function startLlamaServer(bin, modelPath) {
  const threads = Math.max(1, os.cpus().length - 1);
  const args = [
    '-m', modelPath,
    '--port', String(LLAMA_PORT),
    '--host', '127.0.0.1',
    '-t', String(threads),
    '-c', '2048',
    '--log-disable',
  ];

  console.log(`  Launching llama.cpp:`);
  console.log(`    ${bin} ${args.join(' ')}`);

  const proc = spawn(bin, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  proc.stdout.on('data', d => process.stdout.write(d));
  proc.stderr.on('data', d => {
    const line = d.toString();
    // Only show important lines
    if (line.includes('model loaded') || line.includes('error') || line.includes('listening')) {
      process.stdout.write('  [llama] ' + line);
    }
  });

  proc.on('exit', (code) => {
    if (code !== 0 && code !== null) {
      console.error(`\n  llama.cpp exited with code ${code}`);
    }
  });

  // Ensure llama.cpp is killed when this process exits
  process.on('exit', () => { try { proc.kill(); } catch {} });
  process.on('SIGINT', () => { try { proc.kill(); } catch {} process.exit(0); });
  process.on('SIGTERM', () => { try { proc.kill(); } catch {} process.exit(0); });

  return proc;
}

// ── Main ──────────────────────────────────────────────────────────────────────

console.log('\n  Pluribus Node starting...');

if (AUTO_START) {
  const alreadyRunning = await isLlamaRunning(LLAMA_URL);

  if (alreadyRunning) {
    console.log(`  ✓ llama.cpp already running at ${LLAMA_URL}`);
  } else {
    const bin = findLlamaServer();
    const model = findModel();

    if (!bin) {
      console.error('  ! llama-server binary not found.');
      console.error('    Set LLAMA_SERVER_BIN=/path/to/llama-server or re-run bootstrap.');
      console.error('    Continuing anyway — set LLAMA_AUTO_START=false if using a remote llama.cpp.');
    } else if (!model) {
      console.error('  ! No GGUF model found in ~/models/');
      console.error('    Download a model first:');
      console.error('    wget -O ~/models/smollm2-360m-q4.gguf \\');
      console.error("      'https://huggingface.co/HuggingFaceTB/SmolLM2-360M-Instruct-GGUF/resolve/main/smollm2-360m-instruct-q4_k_m.gguf'");
      process.exit(1);
    } else {
      console.log(`  Model: ${model}`);
      await startLlamaServer(bin, model);
      const ready = await waitForLlama(LLAMA_URL);
      if (!ready) {
        console.error('  ! llama.cpp did not become ready in time. Check the output above.');
        process.exit(1);
      }
    }
  }
}

const app = await buildNodeServer();

try {
  await app.listen({ port: PORT, host: HOST });
  console.log(`\n  Pluribus Node running on http://${HOST}:${PORT}`);
  console.log(`  Model: ${process.env.LLAMA_MODEL || 'local'} | Role: ${process.env.LLAMA_ROLE || 'proposer'}`);
  console.log(`  Coordinator: ${process.env.PLURIBUS_COORDINATOR || '(none — standalone mode)'}\n`);
} catch (err) {
  console.error('Failed to start node server:', err);
  process.exit(1);
}
