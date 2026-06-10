# Pluribus

**Distributed AI swarm with braided inference — frontier-level capability from edge models.**

Pluribus runs multiple small language models across your devices and braids their responses together using the [Mixture-of-Agents](https://arxiv.org/abs/2406.04692) protocol. A swarm of 360M–1.7B models consistently outperforms a single 7B model on reasoning benchmarks. No cloud. No GPU required. Runs on Linux, macOS, and Android (Termux).

---

## How it works

The braiding protocol runs in three layers:

```
User query
    │
    ▼
┌─────────────────────────────────────────────┐
│  Layer 1: Proposers (parallel)              │
│  ┌──────────┐  ┌──────────┐  ┌──────────┐  │
│  │ Node A   │  │ Node B   │  │ Node C   │  │
│  │ 360M     │  │ 0.5B     │  │ 360M     │  │
│  └──────────┘  └──────────┘  └──────────┘  │
│  Each answers independently in parallel     │
└─────────────────────────────────────────────┘
    │ 3 proposals
    ▼
┌─────────────────────────────────────────────┐
│  Layer 2: Critic                            │
│  ┌──────────────────────────────────────┐   │
│  │ Node D — 1.7B                        │   │
│  │ Reads all proposals, scores them,    │   │
│  │ identifies strongest reasoning       │   │
│  └──────────────────────────────────────┘   │
└─────────────────────────────────────────────┘
    │ critique
    ▼
┌─────────────────────────────────────────────┐
│  Layer 3: Synthesizer                       │
│  ┌──────────────────────────────────────┐   │
│  │ Node E — 1.7B                        │   │
│  │ Merges best reasoning into final     │   │
│  │ answer, corrects errors              │   │
│  └──────────────────────────────────────┘   │
└─────────────────────────────────────────────┘
    │
    ▼
Final answer (frontier quality)
```

> **Key insight (MoA paper, Wang et al. 2024):** Models are better at aggregating diverse perspectives than generating correct answers from scratch — even when the perspectives come from weaker models.

---

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/elevate-foundry/pluribus/master/bootstrap.sh | bash
```

Supports: **Termux/Android**, **Ubuntu/Debian**, **Fedora/RHEL**, **Arch**, **openSUSE**, **macOS**.

Installs: `git`, `Node.js 22`, `llama.cpp` (compiled from source), and the Pluribus CLI.

---

## Quick start

### 1. Start the coordinator (hub)

```bash
pluribus-coordinator
# Listening on http://0.0.0.0:7779
```

### 2. Start a node (one per device/model)

First, start `llama.cpp` with your GGUF model:

```bash
~/.pluribus-llama/llama-server -m ~/models/smollm2-360m-q4.gguf --port 8080
```

Then start the Pluribus node:

```bash
LLAMA_URL=http://localhost:8080 \
LLAMA_MODEL=smollm2-360m \
LLAMA_ROLE=proposer \
PLURIBUS_COORDINATOR=http://coordinator-ip:7779 \
pluribus-node
```

### 3. Chat

```bash
# One-shot query
pluribus chat "Explain the halting problem"

# Fast mode (no critic layer, lower latency)
pluribus chat --fast "What is 17 * 23?"

# Streaming
pluribus chat --stream "Write a poem about distributed systems"

# Interactive REPL with conversation history
pluribus repl
```

---

## Recommended models (CPU-only, edge-friendly)

| Model | Size (Q4) | Role | Download |
|---|---|---|---|
| SmolLM2-360M | ~200MB | Proposer | [HuggingFace](https://huggingface.co/HuggingFaceTB/SmolLM2-360M-Instruct-GGUF) |
| Qwen2.5-0.5B | ~300MB | Proposer | [HuggingFace](https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct-GGUF) |
| SmolLM2-1.7B | ~1GB | Critic / Synthesizer | [HuggingFace](https://huggingface.co/HuggingFaceTB/SmolLM2-1.7B-Instruct-GGUF) |
| Qwen2.5-1.5B | ~900MB | Critic / Synthesizer | [HuggingFace](https://huggingface.co/Qwen/Qwen2.5-1.5B-Instruct-GGUF) |

---

## Multi-device swarm

Each device runs one or more nodes. The coordinator can be on any device.

```
Phone (Android/Termux)          Laptop (Ubuntu)            VPS
┌──────────────────────┐    ┌──────────────────────┐    ┌──────────────────────┐
│ pluribus-coordinator │    │ pluribus-node         │    │ pluribus-node         │
│ pluribus-node        │    │ model: qwen-0.5b      │    │ model: smollm2-1.7b  │
│ model: smollm2-360m  │    │ role: proposer        │    │ role: synthesizer    │
│ role: proposer       │    └──────────────────────┘    └──────────────────────┘
└──────────────────────┘
```

All nodes register with the coordinator on startup via `PLURIBUS_COORDINATOR=http://phone-ip:7779`.

---

## SDK

```javascript
import { Pluribus } from '~/.pluribus-runtime/sdk/src/index.js';

const swarm = new Pluribus({ coordinator: 'http://localhost:7779' });

// Full 3-layer braid
const { answer, model_count, total_elapsed_ms } = await swarm.chat(
  'What are the key differences between transformers and RNNs?'
);

// Fast braid (proposer → synthesizer, no critic)
const fast = await swarm.chatFast('What is 2+2?');

// Streaming
for await (const { event, data } of swarm.stream('Tell me a story')) {
  if (event === 'result') console.log(data.answer);
}

// Persistent conversation
const conv = new Pluribus({ conversationId: 'my-session' });
await conv.chat('My name is Ryan');
const { answer } = await conv.chat('What is my name?'); // remembers
```

---

## REST API

```bash
# Full braid
curl -X POST http://localhost:7779/v1/chat \
  -H "Content-Type: application/json" \
  -d '{"query": "What is consciousness?", "mode": "full"}'

# Fast braid
curl -X POST http://localhost:7779/v1/chat \
  -d '{"query": "2+2?", "mode": "fast"}'

# Register a node manually
curl -X POST http://localhost:7779/v1/nodes/register \
  -d '{"url":"http://192.168.1.5:7778","slots":[{"id":"s0","model":"smollm2-360m","role":"proposer"}]}'

# Swarm stats
curl http://localhost:7779/v1/stats
```

---

## Architecture

```
pluribus/
├── coordinator/    Swarm hub — node registry, task routing, braid orchestration
├── node/           Swarm node — wraps llama.cpp, serves inference requests
├── braider/        Braiding engine — MoA protocol (proposer → critic → synthesizer)
├── sdk/            JavaScript client SDK
├── cli/            Terminal CLI (chat, repl, nodes, stats)
└── bootstrap.sh    One-command install for all platforms
```

---

## License

MIT — build freely, run anywhere.

<!-- ELEVATE:BEGIN (auto-generated section; edits here are overwritten) -->
## About

| | |
| --- | --- |
| **Description** | Distributed AI swarm with braided inference — frontier capability from edge models |
| **Language** | JavaScript |
| **Commits** | 7 |
| **Created** | 2026-03-29 |
| **Last push** | 2026-03-30 |

Part of [**elevate-foundry**](https://github.com/elevate-foundry) · [repository](https://github.com/elevate-foundry/pluribus)
<!-- ELEVATE:END -->
