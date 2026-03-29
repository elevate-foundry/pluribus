/**
 * sdk/src/client.js
 * Pluribus SDK — JavaScript/Node.js client for the swarm coordinator.
 *
 * Usage:
 *   import { Pluribus } from '@pluribus/sdk';
 *   const p = new Pluribus({ coordinator: 'http://localhost:7779' });
 *   const { answer } = await p.chat('What is the nature of consciousness?');
 */

export class Pluribus {
  /**
   * @param {object} opts
   * @param {string} opts.coordinator  - Coordinator URL, default http://localhost:7779
   * @param {string} [opts.conversationId] - Persist conversation across calls
   * @param {object} [opts.params]     - Default inference params
   */
  constructor(opts = {}) {
    this.coordinator = (opts.coordinator || 'http://localhost:7779').replace(/\/$/, '');
    this.conversationId = opts.conversationId || null;
    this.defaultParams = opts.params || {};
  }

  // ── Chat ──────────────────────────────────────────────────────────────────

  /**
   * Full 3-layer braid: proposer → critic → synthesizer.
   * @param {string} query
   * @param {object} [opts]
   * @returns {Promise<ChatResult>}
   */
  async chat(query, opts = {}) {
    return this._post('/v1/chat', {
      query,
      conversation_id: opts.conversationId || this.conversationId,
      history: opts.history,
      params: { ...this.defaultParams, ...opts.params },
      mode: 'full',
    });
  }

  /**
   * Fast braid: proposer → synthesizer (no critic layer, lower latency).
   */
  async chatFast(query, opts = {}) {
    return this._post('/v1/chat', {
      query,
      conversation_id: opts.conversationId || this.conversationId,
      history: opts.history,
      params: { ...this.defaultParams, ...opts.params },
      mode: 'fast',
    });
  }

  /**
   * Single model (no braiding) — fastest, lowest quality.
   */
  async chatSingle(query, opts = {}) {
    return this._post('/v1/chat', {
      query,
      conversation_id: opts.conversationId || this.conversationId,
      params: { ...this.defaultParams, ...opts.params },
      mode: 'single',
    });
  }

  /**
   * Streaming chat — returns an async generator of SSE events.
   * @param {string} query
   * @param {object} [opts]
   * @yields {{ event: string, data: object }}
   */
  async *stream(query, opts = {}) {
    const { default: fetch } = await import('node-fetch');
    const res = await fetch(`${this.coordinator}/v1/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        query,
        conversation_id: opts.conversationId || this.conversationId,
        params: { ...this.defaultParams, ...opts.params },
        mode: opts.mode || 'full',
        stream: true,
      }),
    });

    if (!res.ok) throw new Error(`Coordinator error ${res.status}`);

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop();

      let event = null;
      for (const line of lines) {
        if (line.startsWith('event: ')) {
          event = line.slice(7).trim();
        } else if (line.startsWith('data: ')) {
          const data = line.slice(6).trim();
          if (data === '{}' && event === 'done') return;
          try {
            yield { event, data: JSON.parse(data) };
          } catch {}
        }
      }
    }
  }

  // ── Node management ───────────────────────────────────────────────────────

  async registerNode(nodeInfo) {
    return this._post('/v1/nodes/register', nodeInfo);
  }

  async listNodes() {
    return this._get('/v1/nodes');
  }

  async stats() {
    return this._get('/v1/stats');
  }

  async health() {
    return this._get('/v1/health');
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  async _post(path, body) {
    const { default: fetch } = await import('node-fetch');
    const res = await fetch(`${this.coordinator}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Coordinator ${path} error ${res.status}: ${err}`);
    }
    return res.json();
  }

  async _get(path) {
    const { default: fetch } = await import('node-fetch');
    const res = await fetch(`${this.coordinator}${path}`);
    if (!res.ok) throw new Error(`Coordinator ${path} error ${res.status}`);
    return res.json();
  }
}

/**
 * @typedef {object} ChatResult
 * @property {string} conversation_id
 * @property {string} answer
 * @property {number} model_count
 * @property {number} total_elapsed_ms
 * @property {Array}  trace
 */
