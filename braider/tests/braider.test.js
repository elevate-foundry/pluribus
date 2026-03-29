/**
 * braider/tests/braider.test.js
 * Unit tests for the Pluribus Braiding Engine.
 * Uses Node.js built-in test runner (no external deps).
 */

import { test, describe, mock } from 'node:test';
import assert from 'node:assert/strict';
import { Braider } from '../src/braider.js';

// ── Mock callNode ─────────────────────────────────────────────────────────────

function makeCallNode(responses = {}) {
  return async (node, messages) => {
    const key = node.nodeId;
    const text = responses[key] || `Mock response from ${key}`;
    return { text, tokens_used: 10, model: node.model || key };
  };
}

const PROPOSER_NODES = [
  { nodeId: 'p1', url: 'http://p1', model: 'smollm-360m' },
  { nodeId: 'p2', url: 'http://p2', model: 'qwen-0.5b' },
];
const CRITIC_NODE = { nodeId: 'critic', url: 'http://critic', model: 'smollm-1.7b' };
const SYNTH_NODE  = { nodeId: 'synth',  url: 'http://synth',  model: 'smollm-1.7b' };

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Braider — full 3-layer braid', () => {
  test('returns a synthesized answer from multiple proposers', async () => {
    const callNode = makeCallNode({
      p1:     'The answer is 42 because of the fundamental constants.',
      p2:     'I believe the answer is 42, derived from first principles.',
      critic: 'Both proposals agree on 42. Proposal 1 has better reasoning.',
      synth:  'The answer is definitively 42.',
    });

    const braider = new Braider({ callNode });
    const result = await braider.braid({
      query: 'What is the answer to life?',
      proposerNodes: PROPOSER_NODES,
      criticNode: CRITIC_NODE,
      synthNode: SYNTH_NODE,
    });

    assert.equal(typeof result.answer, 'string');
    assert.ok(result.answer.length > 0, 'Answer should be non-empty');
    assert.equal(result.proposals.length, 2, 'Should have 2 proposals');
    assert.ok(result.critique, 'Should have a critique');
    assert.ok(result.total_elapsed_ms >= 0);
    assert.equal(result.model_count, 4); // 2 proposers + critic + synth
  });

  test('succeeds even if one proposer fails', async () => {
    let callCount = 0;
    const callNode = async (node, messages) => {
      if (node.nodeId === 'p1' && callCount++ === 0) {
        throw new Error('p1 timed out');
      }
      return { text: `Response from ${node.nodeId}`, tokens_used: 5 };
    };

    const braider = new Braider({ callNode });
    const result = await braider.braid({
      query: 'Test query',
      proposerNodes: PROPOSER_NODES,
      criticNode: CRITIC_NODE,
      synthNode: SYNTH_NODE,
    });

    assert.ok(result.answer.length > 0);
    assert.equal(result.proposals.length, 1, 'Should have 1 successful proposal');
  });

  test('throws if ALL proposers fail', async () => {
    const callNode = async (node) => {
      if (node.nodeId === 'p1' || node.nodeId === 'p2') throw new Error('node down');
      return { text: 'ok', tokens_used: 5 };
    };

    const braider = new Braider({ callNode });
    await assert.rejects(
      () => braider.braid({
        query: 'Test',
        proposerNodes: PROPOSER_NODES,
        criticNode: CRITIC_NODE,
        synthNode: SYNTH_NODE,
      }),
      /All proposer nodes failed/
    );
  });

  test('critic failure is non-fatal — synthesizes without critique', async () => {
    const callNode = async (node) => {
      if (node.nodeId === 'critic') throw new Error('critic down');
      return { text: `Response from ${node.nodeId}`, tokens_used: 5 };
    };

    const braider = new Braider({ callNode });
    const result = await braider.braid({
      query: 'Test',
      proposerNodes: PROPOSER_NODES,
      criticNode: CRITIC_NODE,
      synthNode: SYNTH_NODE,
    });

    assert.ok(result.answer.length > 0);
    assert.equal(result.critique, null, 'Critique should be null when critic fails');
  });
});

describe('Braider — fast braid (no critic)', () => {
  test('returns answer without critic layer', async () => {
    const callNode = makeCallNode({
      p1:    'Fast answer from p1',
      p2:    'Fast answer from p2',
      synth: 'Synthesized fast answer',
    });

    const braider = new Braider({ callNode });
    const result = await braider.braidFast({
      query: 'Quick question',
      proposerNodes: PROPOSER_NODES,
      criticNode: CRITIC_NODE,
      synthNode: SYNTH_NODE,
    });

    assert.ok(result.answer.length > 0);
  });
});

describe('Braider — single model fallback', () => {
  test('returns answer from single node', async () => {
    const callNode = makeCallNode({ p1: 'Single model answer' });
    const braider = new Braider({ callNode });
    const result = await braider.single({
      query: 'Simple question',
      proposerNodes: [PROPOSER_NODES[0]],
    });

    assert.ok(result.answer.length > 0);
    assert.equal(result.model_count, 1);
    assert.equal(result.critique, null);
  });

  test('throws if no nodes provided', async () => {
    const braider = new Braider({ callNode: async () => ({ text: 'x' }) });
    await assert.rejects(
      () => braider.single({ query: 'test', proposerNodes: [] }),
      /No nodes available/
    );
  });
});

describe('Braider — trace', () => {
  test('trace contains all layers', async () => {
    const callNode = makeCallNode();
    const braider = new Braider({ callNode });
    const result = await braider.braid({
      query: 'Trace test',
      proposerNodes: PROPOSER_NODES,
      criticNode: CRITIC_NODE,
      synthNode: SYNTH_NODE,
    });

    const layers = result.trace.map(t => t.layer);
    assert.ok(layers.includes('proposers'));
    assert.ok(layers.includes('critic'));
    assert.ok(layers.includes('synthesizer'));
  });
});
