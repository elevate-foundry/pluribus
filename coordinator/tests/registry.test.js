/**
 * coordinator/tests/registry.test.js
 * Unit tests for the NodeRegistry.
 */

import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { NodeRegistry } from '../src/registry.js';

describe('NodeRegistry — registration', () => {
  test('registers a node and returns entry with nodeId', () => {
    const reg = new NodeRegistry({ persistPath: '/tmp/test-registry.json' });
    const entry = reg.register({
      url: 'http://localhost:7778',
      slots: [{ id: 'slot-0', model: 'smollm-360m', role: 'proposer' }],
    });
    assert.ok(entry.nodeId);
    assert.equal(entry.url, 'http://localhost:7778');
    assert.equal(entry.healthy, true);
  });

  test('deregisters a node', () => {
    const reg = new NodeRegistry({ persistPath: '/tmp/test-registry.json' });
    const entry = reg.register({ url: 'http://localhost:7778', slots: [] });
    reg.deregister(entry.nodeId);
    assert.equal(reg.list().find(n => n.nodeId === entry.nodeId), undefined);
  });

  test('heartbeat keeps node healthy', () => {
    const reg = new NodeRegistry({ persistPath: '/tmp/test-registry.json' });
    const entry = reg.register({ url: 'http://localhost:7778', slots: [] });
    reg.heartbeat(entry.nodeId);
    const node = reg.list().find(n => n.nodeId === entry.nodeId);
    assert.equal(node.healthy, true);
    assert.equal(node.failCount, 0);
  });

  test('markFailed 3 times marks node unhealthy', () => {
    const reg = new NodeRegistry({ persistPath: '/tmp/test-registry.json' });
    const entry = reg.register({ url: 'http://localhost:7778', slots: [] });
    reg.markFailed(entry.nodeId);
    reg.markFailed(entry.nodeId);
    reg.markFailed(entry.nodeId);
    const node = reg.list().find(n => n.nodeId === entry.nodeId);
    assert.equal(node.healthy, false);
  });
});

describe('NodeRegistry — role assignment', () => {
  test('getByRole returns nodes with matching slot role', () => {
    const reg = new NodeRegistry({ persistPath: '/tmp/test-registry2.json' });
    reg.register({ url: 'http://p1', slots: [{ id: 's1', model: 'a', role: 'proposer' }] });
    reg.register({ url: 'http://s1', slots: [{ id: 's2', model: 'b', role: 'synthesizer' }] });

    assert.equal(reg.getByRole('proposer').length, 1);
    assert.equal(reg.getByRole('synthesizer').length, 1);
    assert.equal(reg.getByRole('critic').length, 0);
    assert.equal(reg.getByRole('any').length, 2);
  });

  test('assignBraid returns valid assignment with 2 nodes', () => {
    const reg = new NodeRegistry({ persistPath: '/tmp/test-registry3.json' });
    reg.register({ url: 'http://p1', slots: [{ id: 's1', model: 'smollm-360m', role: 'proposer' }] });
    reg.register({ url: 'http://s1', slots: [{ id: 's2', model: 'smollm-1.7b', role: 'synthesizer' }] });

    const { proposerNodes, criticNode, synthNode } = reg.assignBraid(1);
    assert.ok(proposerNodes.length >= 1);
    assert.ok(criticNode.nodeId);
    assert.ok(synthNode.nodeId);
  });

  test('assignBraid throws when no healthy nodes', () => {
    const reg = new NodeRegistry({ persistPath: '/tmp/test-registry4.json' });
    assert.throws(() => reg.assignBraid(1), /No healthy nodes/);
  });
});
