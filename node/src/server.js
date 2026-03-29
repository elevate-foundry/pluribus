/**
 * node/src/server.js
 * Pluribus Swarm Node
 *
 * Each node:
 *  1. Wraps one or more llama.cpp server instances
 *  2. Registers itself with the coordinator
 *  3. Serves inference requests from the coordinator
 *  4. Reports health and model metadata
 *
 * A node can run multiple "slots" (one per model/llama.cpp instance).
 */

import Fastify from 'fastify';
import cors from '@fastify/cors';
import { LlamaAdapter } from './llama-adapter.js';
import { randomUUID } from 'crypto';
import os from 'os';

export async function buildNodeServer(config = {}) {
  const nodeId = config.nodeId || `node-${randomUUID().slice(0, 8)}`;
  const coordinatorUrl = config.coordinatorUrl || process.env.PLURIBUS_COORDINATOR || null;
  const nodePort = config.port || parseInt(process.env.NODE_PORT || '7778', 10);
  const nodeHost = config.host || process.env.NODE_HOST || '0.0.0.0';
  const publicUrl = config.publicUrl || process.env.NODE_PUBLIC_URL || `http://localhost:${nodePort}`;

  // ── Model slots ─────────────────────────────────────────────────────────────
  // Each slot = one llama.cpp server instance with a specific model
  // Config example:
  //   PLURIBUS_SLOTS=[{"model":"smollm2-360m","url":"http://localhost:8080","role":"proposer"}]
  let slots = config.slots || [];
  if (!slots.length && process.env.PLURIBUS_SLOTS) {
    try { slots = JSON.parse(process.env.PLURIBUS_SLOTS); } catch {}
  }
  if (!slots.length) {
    // Default: single slot pointing at localhost:8080
    slots = [{
      id: 'slot-0',
      model: process.env.LLAMA_MODEL || 'local',
      url: process.env.LLAMA_URL || 'http://localhost:8080',
      role: process.env.LLAMA_ROLE || 'proposer', // proposer | synthesizer | critic
    }];
  }

  // Build adapters
  const adapters = new Map();
  for (const slot of slots) {
    const adapter = new LlamaAdapter({
      baseUrl: slot.url,
      model: slot.model,
    });
    adapters.set(slot.id || slot.model, { adapter, slot });
  }

  // ── Fastify app ─────────────────────────────────────────────────────────────
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL || 'info',
      transport: process.env.NODE_ENV !== 'production'
        ? { target: 'pino-pretty', options: { colorize: true } }
        : undefined,
    },
  });

  await app.register(cors, { origin: true });

  // ── Health ──────────────────────────────────────────────────────────────────
  app.get('/health', async () => {
    const slotHealth = await Promise.all(
      [...adapters.entries()].map(async ([id, { adapter, slot }]) => ({
        id,
        model: slot.model,
        role: slot.role,
        url: slot.url,
        healthy: await adapter.checkHealth(),
      }))
    );
    return {
      nodeId,
      publicUrl,
      status: 'ok',
      slots: slotHealth,
      system: {
        platform: os.platform(),
        arch: os.arch(),
        cpus: os.cpus().length,
        freemem_mb: Math.round(os.freemem() / 1024 / 1024),
      },
    };
  });

  // ── Node info ───────────────────────────────────────────────────────────────
  app.get('/info', async () => ({
    nodeId,
    publicUrl,
    slots: slots.map(s => ({ id: s.id || s.model, model: s.model, role: s.role })),
  }));

  // ── Inference endpoint ──────────────────────────────────────────────────────
  /**
   * POST /infer
   * Body: { slot_id?, messages, params?, stream? }
   * Returns: { text, tokens_used, model, slot_id, node_id, elapsed_ms }
   */
  app.post('/infer', {
    schema: {
      body: {
        type: 'object',
        required: ['messages'],
        properties: {
          slot_id:  { type: 'string' },
          messages: { type: 'array' },
          params:   { type: 'object' },
          stream:   { type: 'boolean', default: false },
        },
      },
    },
  }, async (request, reply) => {
    const { slot_id, messages, params = {}, stream = false } = request.body;

    // Pick slot: requested slot_id, or first healthy slot
    let entry;
    if (slot_id && adapters.has(slot_id)) {
      entry = adapters.get(slot_id);
    } else {
      // Pick first slot (could add load-balancing here)
      entry = [...adapters.values()][0];
    }

    if (!entry) {
      return reply.code(503).send({ error: 'No model slots available' });
    }

    const { adapter, slot } = entry;
    const start = Date.now();

    try {
      if (stream) {
        // SSE streaming response
        reply.raw.setHeader('Content-Type', 'text/event-stream');
        reply.raw.setHeader('Cache-Control', 'no-cache');
        reply.raw.setHeader('Connection', 'keep-alive');
        reply.raw.flushHeaders();

        for await (const chunk of adapter.stream(messages, params)) {
          reply.raw.write(`data: ${JSON.stringify({ chunk })}\n\n`);
        }
        reply.raw.write('data: [DONE]\n\n');
        reply.raw.end();
        return reply;
      }

      const result = await adapter.complete(messages, params);
      return {
        ...result,
        slot_id: slot.id || slot.model,
        node_id: nodeId,
        elapsed_ms: Date.now() - start,
      };
    } catch (err) {
      request.log.error(err);
      return reply.code(502).send({ error: `Inference failed: ${err.message}` });
    }
  });

  // ── Registration with coordinator ───────────────────────────────────────────
  app.addHook('onReady', async () => {
    // Check all slots health
    for (const [id, { adapter }] of adapters) {
      const healthy = await adapter.checkHealth();
      app.log.info(`Slot ${id}: ${healthy ? 'healthy' : 'OFFLINE (llama.cpp not running?)'}`);
    }

    // Register with coordinator if configured
    if (coordinatorUrl) {
      await registerWithCoordinator(coordinatorUrl, nodeId, publicUrl, slots, app.log);
    }
  });

  app.addHook('onClose', async () => {
    for (const [, { adapter }] of adapters) adapter.stopHealthPolling();
  });

  return app;
}

// ── Coordinator registration ─────────────────────────────────────────────────

async function registerWithCoordinator(coordinatorUrl, nodeId, publicUrl, slots, log) {
  try {
    const { default: fetch } = await import('node-fetch');
    const res = await fetch(`${coordinatorUrl}/v1/nodes/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        nodeId,
        url: publicUrl,
        slots: slots.map(s => ({
          id: s.id || s.model,
          model: s.model,
          role: s.role || 'proposer',
        })),
      }),
    });
    if (res.ok) {
      log.info(`Registered with coordinator at ${coordinatorUrl}`);
    } else {
      log.warn(`Coordinator registration failed: ${res.status}`);
    }
  } catch (err) {
    log.warn(`Could not reach coordinator: ${err.message}`);
  }
}
