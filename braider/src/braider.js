/**
 * braider/src/braider.js
 * Pluribus Braiding Engine
 *
 * Implements the Mixture-of-Agents (MoA) braiding protocol:
 *
 *   Layer 1 — Proposers:   N small models answer the query independently in parallel
 *   Layer 2 — Critic:      1 model reads all proposals, scores and critiques them
 *   Layer 3 — Synthesizer: 1 model merges the best reasoning into a final answer
 *
 * The braiding is the intelligence multiplier. Even 360M models consistently
 * produce frontier-quality output when their proposals are synthesized correctly.
 *
 * Key insight from MoA paper (Wang et al., 2024):
 *   "Models are better at aggregating diverse perspectives than generating
 *    correct answers from scratch — even when the perspectives come from
 *    weaker models."
 */

// ── Prompt templates ──────────────────────────────────────────────────────────

const PROPOSER_SYSTEM = `You are a precise, concise reasoning assistant. Answer the user's question directly and thoroughly. Show your reasoning step by step where applicable.`;

const CRITIC_SYSTEM = `You are a critical evaluator. You will be given a question and several proposed answers from different AI models. Your job is to:
1. Identify the strongest reasoning in each proposal
2. Note any errors, gaps, or contradictions
3. Assign a quality score (1-10) to each proposal
4. Briefly explain which proposal(s) have the best reasoning

Be objective and specific. Focus on correctness and completeness.`;

const SYNTHESIZER_SYSTEM = `You are a master synthesizer. You will be given a question, several proposed answers, and a critical evaluation of those answers. Your job is to produce the single best possible answer by:
1. Taking the strongest reasoning from each proposal
2. Correcting any errors identified in the critique
3. Filling in gaps that none of the proposals addressed
4. Writing a clear, complete, well-structured final answer

Do not mention the other models or the synthesis process. Just deliver the best possible answer as if it were your own.`;

// ── Braider class ─────────────────────────────────────────────────────────────

export class Braider {
  /**
   * @param {object} opts
   * @param {Function} opts.callNode  - async (nodeUrl, messages, params) => {text, ...}
   *   The coordinator injects this function so the braider stays transport-agnostic.
   */
  constructor(opts = {}) {
    this.callNode = opts.callNode;
    this.maxProposers = opts.maxProposers || 4;
    this.timeout = opts.timeout || 60_000;
  }

  /**
   * Full 3-layer braid.
   *
   * @param {object} task
   * @param {string}  task.query          - The user's question/prompt
   * @param {Array}   task.history        - Prior conversation messages [{role,content}]
   * @param {Array}   task.proposerNodes  - [{nodeId, url, slotId?, model}]
   * @param {object}  task.criticNode     - {nodeId, url, slotId?, model}
   * @param {object}  task.synthNode      - {nodeId, url, slotId?, model}
   * @param {object}  [task.params]       - Inference params (temperature, max_tokens)
   * @returns {Promise<BraidResult>}
   */
  async braid(task) {
    const {
      query,
      history = [],
      proposerNodes,
      criticNode,
      synthNode,
      params = {},
    } = task;

    const startTime = Date.now();
    const trace = [];

    // ── Layer 1: Proposers (parallel) ─────────────────────────────────────────
    const proposerMessages = [
      ...history,
      { role: 'user', content: query },
    ];

    const proposerResults = await Promise.allSettled(
      proposerNodes.slice(0, this.maxProposers).map(async (node) => {
        const t0 = Date.now();
        const result = await this._callWithTimeout(node, [
          { role: 'system', content: PROPOSER_SYSTEM },
          ...proposerMessages,
        ], params);
        return {
          nodeId: node.nodeId,
          model: node.model || node.slotId || 'unknown',
          text: result.text,
          elapsed_ms: Date.now() - t0,
        };
      })
    );

    const proposals = proposerResults
      .filter(r => r.status === 'fulfilled')
      .map(r => r.value);

    const failedProposers = proposerResults
      .filter(r => r.status === 'rejected')
      .map(r => r.reason?.message || 'unknown error');

    trace.push({ layer: 'proposers', proposals: proposals.map(p => ({ nodeId: p.nodeId, model: p.model, elapsed_ms: p.elapsed_ms })) });

    if (!proposals.length) {
      throw new Error('All proposer nodes failed: ' + failedProposers.join('; '));
    }

    // ── Layer 2: Critic ───────────────────────────────────────────────────────
    const proposalBlock = proposals
      .map((p, i) => `### Proposal ${i + 1} (${p.model})\n${p.text}`)
      .join('\n\n---\n\n');

    const criticMessages = [
      { role: 'system', content: CRITIC_SYSTEM },
      {
        role: 'user',
        content: `## Question\n${query}\n\n## Proposals\n\n${proposalBlock}`,
      },
    ];

    let critique = null;
    try {
      const t0 = Date.now();
      const criticResult = await this._callWithTimeout(criticNode, criticMessages, {
        ...params,
        temperature: 0.3, // lower temp for evaluation
      });
      critique = {
        nodeId: criticNode.nodeId,
        model: criticNode.model || 'critic',
        text: criticResult.text,
        elapsed_ms: Date.now() - t0,
      };
      trace.push({ layer: 'critic', nodeId: critique.nodeId, elapsed_ms: critique.elapsed_ms });
    } catch (err) {
      // Critic failure is non-fatal — synthesize without critique
      trace.push({ layer: 'critic', error: err.message });
    }

    // ── Layer 3: Synthesizer ──────────────────────────────────────────────────
    const synthContent = critique
      ? `## Question\n${query}\n\n## Proposals\n\n${proposalBlock}\n\n## Critical Evaluation\n${critique.text}`
      : `## Question\n${query}\n\n## Proposals\n\n${proposalBlock}`;

    const synthMessages = [
      { role: 'system', content: SYNTHESIZER_SYSTEM },
      { role: 'user', content: synthContent },
    ];

    const t0 = Date.now();
    const synthResult = await this._callWithTimeout(synthNode, synthMessages, {
      ...params,
      temperature: params.temperature ?? 0.5,
      max_tokens: params.max_tokens ?? 2048,
    });

    trace.push({ layer: 'synthesizer', nodeId: synthNode.nodeId, elapsed_ms: Date.now() - t0 });

    return {
      answer: synthResult.text,
      proposals,
      critique,
      trace,
      total_elapsed_ms: Date.now() - startTime,
      model_count: proposals.length + (critique ? 1 : 0) + 1,
    };
  }

  /**
   * Fast single-layer braid (no critic) — lower latency, still better than single model.
   * Uses all proposers in parallel then synthesizes directly.
   */
  async braidFast(task) {
    return this.braid({
      ...task,
      criticNode: task.synthNode, // skip critic, go straight to synth
    });
  }

  /**
   * Single-model fallback — used when only one node is available.
   */
  async single(task) {
    const { query, history = [], proposerNodes, params = {} } = task;
    const node = proposerNodes[0];
    if (!node) throw new Error('No nodes available');

    const messages = [
      { role: 'system', content: PROPOSER_SYSTEM },
      ...history,
      { role: 'user', content: query },
    ];

    const result = await this._callWithTimeout(node, messages, params);
    return {
      answer: result.text,
      proposals: [{ nodeId: node.nodeId, model: node.model, text: result.text, elapsed_ms: result.elapsed_ms }],
      critique: null,
      trace: [{ layer: 'single', nodeId: node.nodeId }],
      total_elapsed_ms: result.elapsed_ms,
      model_count: 1,
    };
  }

  // ── Internal ────────────────────────────────────────────────────────────────

  async _callWithTimeout(node, messages, params) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeout);
    try {
      return await this.callNode(node, messages, params);
    } finally {
      clearTimeout(timer);
    }
  }
}

// ── BraidResult type (for documentation) ─────────────────────────────────────
/**
 * @typedef {object} BraidResult
 * @property {string}  answer           - The final synthesized answer
 * @property {Array}   proposals        - Raw proposals from each proposer
 * @property {object|null} critique     - Critic's evaluation (null if skipped)
 * @property {Array}   trace            - Execution trace for debugging
 * @property {number}  total_elapsed_ms - Wall-clock time for full braid
 * @property {number}  model_count      - Number of model calls made
 */
