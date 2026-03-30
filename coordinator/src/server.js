/**
 * coordinator/src/server.js
 * Pluribus Swarm Coordinator
 *
 * The coordinator is the hub of the hub-and-spoke swarm. It:
 *  1. Maintains the node registry (registration, health, roles)
 *  2. Accepts user queries via REST API
 *  3. Runs the braiding protocol across registered nodes
 *  4. Returns the synthesized answer
 *  5. Streams progress via Server-Sent Events
 *
 * API:
 *   POST /v1/chat          - Full braid (proposer → critic → synthesizer)
 *   POST /v1/chat/fast     - Fast braid (proposer → synthesizer, no critic)
 *   POST /v1/nodes/register - Register a node
 *   DELETE /v1/nodes/:id   - Deregister a node
 *   GET  /v1/nodes         - List all nodes
 *   POST /v1/nodes/:id/heartbeat - Heartbeat
 *   GET  /v1/health        - Coordinator health
 *   GET  /v1/stats         - Swarm statistics
 */

import Fastify from 'fastify';
import cors from '@fastify/cors';
import { NodeRegistry } from './registry.js';
import { Braider } from '../../braider/src/braider.js';
import { randomUUID } from 'crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import os from 'os';

const HISTORY_DIR = join(os.homedir(), '.pluribus', 'conversations');

export async function buildCoordinatorServer(config = {}) {
  const port = config.port || parseInt(process.env.COORDINATOR_PORT || '7779', 10);

  // ── Registry & Braider ────────────────────────────────────────────────────
  const registry = new NodeRegistry();

  // callNode: transport function injected into Braider
  async function callNode(node, messages, params) {
    const { default: fetch } = await import('node-fetch');
    const url = `${node.url}/infer`;
    const body = {
      messages,
      params,
      slot_id: node.slotId,
    };

    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(90_000),
    });

    if (!res.ok) {
      registry.markFailed(node.nodeId);
      const err = await res.text();
      throw new Error(`Node ${node.nodeId} error ${res.status}: ${err}`);
    }

    const data = await res.json();
    registry.heartbeat(node.nodeId);
    return data;
  }

  const braider = new Braider({ callNode });

  // ── Fastify ───────────────────────────────────────────────────────────────
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL || 'info',
    },
  });

  await app.register(cors, { origin: true });

  // ── Health ────────────────────────────────────────────────────────────────
  app.get('/v1/health', async () => ({
    status: 'ok',
    nodes: registry.list().length,
    healthy_nodes: registry.getByRole('any').length,
    version: '0.1.0',
  }));

  // ── Stats ─────────────────────────────────────────────────────────────────
  app.get('/v1/stats', async () => {
    const nodes = registry.list();
    return {
      total_nodes: nodes.length,
      healthy_nodes: nodes.filter(n => n.healthy).length,
      proposers: registry.getByRole('proposer').length,
      critics: registry.getByRole('critic').length,
      synthesizers: registry.getByRole('synthesizer').length,
      nodes: nodes.map(n => ({
        nodeId: n.nodeId,
        url: n.url,
        healthy: n.healthy,
        slots: n.slots,
        lastSeen: new Date(n.lastSeen).toISOString(),
      })),
    };
  });

  // ── Node registration ─────────────────────────────────────────────────────
  app.post('/v1/nodes/register', {
    schema: {
      body: {
        type: 'object',
        required: ['url'],
        properties: {
          nodeId: { type: 'string' },
          url:    { type: 'string' },
          slots:  { type: 'array' },
        },
      },
    },
  }, async (req) => {
    const entry = registry.register(req.body);
    req.log.info(`Node registered: ${entry.nodeId} @ ${entry.url}`);
    return { nodeId: entry.nodeId, status: 'registered' };
  });

  app.delete('/v1/nodes/:id', async (req) => {
    registry.deregister(req.params.id);
    return { status: 'deregistered' };
  });

  app.post('/v1/nodes/:id/heartbeat', async (req) => {
    registry.heartbeat(req.params.id);
    return { status: 'ok' };
  });

  app.get('/v1/nodes', async () => registry.list());

  // ── Chat (full 3-layer braid) ─────────────────────────────────────────────
  app.post('/v1/chat', {
    schema: {
      body: {
        type: 'object',
        required: ['query'],
        properties: {
          query:           { type: 'string' },
          conversation_id: { type: 'string' },
          history:         { type: 'array' },
          params:          { type: 'object' },
          stream:          { type: 'boolean', default: false },
          mode:            { type: 'string', enum: ['full', 'fast', 'single'], default: 'full' },
        },
      },
    },
  }, async (req, reply) => {
    const {
      query,
      conversation_id = randomUUID(),
      history = [],
      params = {},
      stream = false,
      mode = 'full',
    } = req.body;

    // Load persisted history if conversation_id given
    const fullHistory = loadHistory(conversation_id, history);

    // Assign nodes — use all available proposers for maximum braiding quality
    let assignment;
    try {
      assignment = registry.assignBraid(1);
    } catch (err) {
      return reply.code(503).send({ error: err.message });
    }

    const task = {
      query,
      history: fullHistory,
      ...assignment,
      params,
    };

    if (stream) {
      // SSE streaming — emit events as each layer completes
      reply.raw.setHeader('Content-Type', 'text/event-stream');
      reply.raw.setHeader('Cache-Control', 'no-cache');
      reply.raw.setHeader('Connection', 'keep-alive');
      reply.raw.flushHeaders();

      const sendEvent = (event, data) => {
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      };

      try {
        sendEvent('start', { conversation_id, mode, nodes: assignment.proposerNodes.length });

        // Run braid — we monkey-patch callNode to emit events
        const originalCallNode = braider.callNode;
        braider.callNode = async (node, messages, params) => {
          const result = await originalCallNode(node, messages, params);
          sendEvent('layer_complete', {
            nodeId: node.nodeId,
            model: node.model,
            preview: result.text?.slice(0, 100),
          });
          return result;
        };

        const result = await runBraid(braider, mode, task);
        braider.callNode = originalCallNode;

        // Persist conversation
        saveHistory(conversation_id, fullHistory, query, result.answer);

        sendEvent('result', {
          conversation_id,
          answer: result.answer,
          model_count: result.model_count,
          total_elapsed_ms: result.total_elapsed_ms,
        });
        reply.raw.write('event: done\ndata: {}\n\n');
        reply.raw.end();
      } catch (err) {
        reply.raw.write(`event: error\ndata: ${JSON.stringify({ error: err.message })}\n\n`);
        reply.raw.end();
      }
      return reply;
    }

    // Non-streaming
    try {
      const result = await runBraid(braider, mode, task);
      saveHistory(conversation_id, fullHistory, query, result.answer);
      return {
        conversation_id,
        answer: result.answer,
        model_count: result.model_count,
        total_elapsed_ms: result.total_elapsed_ms,
        trace: result.trace,
      };
    } catch (err) {
      req.log.error(err);
      return reply.code(500).send({ error: err.message });
    }
  });

  // Fast braid shortcut
  app.post('/v1/chat/fast', async (req, reply) => {
    req.body.mode = 'fast';
    return app.inject({ method: 'POST', url: '/v1/chat', payload: req.body });
  });

  return app;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

async function runBraid(braider, mode, task) {
  if (mode === 'single') return braider.single(task);
  if (mode === 'fast')   return braider.braidFast(task);
  return braider.braid(task);
}

function historyPath(conversationId) {
  return join(HISTORY_DIR, `${conversationId}.json`);
}

function loadHistory(conversationId, provided) {
  if (provided?.length) return provided;
  try {
    const p = historyPath(conversationId);
    if (existsSync(p)) return JSON.parse(readFileSync(p, 'utf8'));
  } catch {}
  return [];
}

function saveHistory(conversationId, history, query, answer) {
  try {
    if (!existsSync(HISTORY_DIR)) mkdirSync(HISTORY_DIR, { recursive: true });
    const updated = [
      ...history,
      { role: 'user', content: query },
      { role: 'assistant', content: answer },
    ];
    // Keep last 20 turns to avoid unbounded growth
    const trimmed = updated.slice(-40);
    writeFileSync(historyPath(conversationId), JSON.stringify(trimmed, null, 2));
  } catch { /* non-fatal */ }
}
