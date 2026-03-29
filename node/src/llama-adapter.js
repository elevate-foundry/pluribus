/**
 * llama-adapter.js
 * Thin adapter over llama.cpp's built-in OpenAI-compatible HTTP server.
 *
 * llama.cpp --server mode exposes:
 *   POST /v1/chat/completions  (OpenAI-compatible)
 *   GET  /health
 *
 * This adapter handles:
 *  - Connection management and health polling
 *  - Streaming and non-streaming completions
 *  - Timeout and retry logic
 *  - Model metadata reporting
 */

import { EventEmitter } from 'events';

const DEFAULT_TIMEOUT_MS = 120_000;

export class LlamaAdapter extends EventEmitter {
  /**
   * @param {object} opts
   * @param {string} opts.baseUrl   - e.g. "http://localhost:8080"
   * @param {string} [opts.model]   - model name/alias for logging
   * @param {number} [opts.timeout] - request timeout in ms
   */
  constructor(opts = {}) {
    super();
    this.baseUrl = (opts.baseUrl || 'http://localhost:8080').replace(/\/$/, '');
    this.model = opts.model || 'local';
    this.timeout = opts.timeout || DEFAULT_TIMEOUT_MS;
    this.healthy = false;
    this._pollTimer = null;
  }

  // ── Health ──────────────────────────────────────────────────────────────────

  async checkHealth() {
    try {
      const res = await this._fetch('/health', { method: 'GET' }, 5000);
      const data = await res.json();
      this.healthy = res.ok && (data.status === 'ok' || data.status === 'loading model');
    } catch {
      this.healthy = false;
    }
    return this.healthy;
  }

  startHealthPolling(intervalMs = 10_000) {
    this._pollTimer = setInterval(async () => {
      const was = this.healthy;
      await this.checkHealth();
      if (was !== this.healthy) {
        this.emit(this.healthy ? 'online' : 'offline');
      }
    }, intervalMs);
  }

  stopHealthPolling() {
    if (this._pollTimer) clearInterval(this._pollTimer);
  }

  // ── Inference ───────────────────────────────────────────────────────────────

  /**
   * Non-streaming chat completion.
   * @param {Array<{role:string,content:string}>} messages
   * @param {object} [params]  - temperature, max_tokens, top_p, etc.
   * @returns {Promise<{text:string, tokens_used:number, model:string}>}
   */
  async complete(messages, params = {}) {
    const body = {
      model: this.model,
      messages,
      stream: false,
      temperature: params.temperature ?? 0.7,
      max_tokens: params.max_tokens ?? 1024,
      top_p: params.top_p ?? 0.9,
      stop: params.stop ?? [],
    };

    const res = await this._fetch('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`llama.cpp error ${res.status}: ${err}`);
    }

    const data = await res.json();
    const choice = data.choices?.[0];
    if (!choice) throw new Error('No choices in llama.cpp response');

    return {
      text: choice.message?.content ?? choice.text ?? '',
      tokens_used: data.usage?.total_tokens ?? 0,
      model: data.model ?? this.model,
      finish_reason: choice.finish_reason,
    };
  }

  /**
   * Streaming chat completion — yields text chunks as they arrive.
   * @param {Array<{role:string,content:string}>} messages
   * @param {object} [params]
   * @returns {AsyncGenerator<string>}
   */
  async *stream(messages, params = {}) {
    const body = {
      model: this.model,
      messages,
      stream: true,
      temperature: params.temperature ?? 0.7,
      max_tokens: params.max_tokens ?? 1024,
      top_p: params.top_p ?? 0.9,
    };

    const res = await this._fetch('/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const err = await res.text();
      throw new Error(`llama.cpp stream error ${res.status}: ${err}`);
    }

    // Parse SSE stream
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop(); // keep incomplete line

      for (const line of lines) {
        if (!line.startsWith('data: ')) continue;
        const data = line.slice(6).trim();
        if (data === '[DONE]') return;
        try {
          const parsed = JSON.parse(data);
          const delta = parsed.choices?.[0]?.delta?.content;
          if (delta) yield delta;
        } catch { /* skip malformed */ }
      }
    }
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  async _fetch(path, opts = {}, timeoutMs = this.timeout) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
      const { default: fetch } = await import('node-fetch');
      return await fetch(`${this.baseUrl}${path}`, {
        ...opts,
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
  }
}
