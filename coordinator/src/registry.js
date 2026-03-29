/**
 * coordinator/src/registry.js
 * Node Registry — tracks all registered swarm nodes, their slots, and health.
 *
 * Nodes register via POST /v1/nodes/register
 * The registry assigns roles (proposer / critic / synthesizer) based on:
 *   1. The node's declared slot roles
 *   2. A round-robin assignment when multiple nodes share the same role
 */

import { randomUUID } from 'crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import { join } from 'path';
import os from 'os';

const PERSIST_PATH = join(os.homedir(), '.pluribus', 'registry.json');

export class NodeRegistry {
  constructor(opts = {}) {
    this.nodes = new Map();       // nodeId -> NodeEntry
    this.persistPath = opts.persistPath || PERSIST_PATH;
    this._load();
  }

  // ── Registration ─────────────────────────────────────────────────────────

  register(info) {
    const entry = {
      nodeId: info.nodeId || `node-${randomUUID().slice(0, 8)}`,
      url: info.url,
      slots: info.slots || [],
      registeredAt: Date.now(),
      lastSeen: Date.now(),
      healthy: true,
      failCount: 0,
    };
    this.nodes.set(entry.nodeId, entry);
    this._save();
    return entry;
  }

  deregister(nodeId) {
    this.nodes.delete(nodeId);
    this._save();
  }

  heartbeat(nodeId) {
    const node = this.nodes.get(nodeId);
    if (node) {
      node.lastSeen = Date.now();
      node.healthy = true;
      node.failCount = 0;
    }
  }

  markFailed(nodeId) {
    const node = this.nodes.get(nodeId);
    if (node) {
      node.failCount = (node.failCount || 0) + 1;
      if (node.failCount >= 3) node.healthy = false;
    }
  }

  // ── Node selection ────────────────────────────────────────────────────────

  /**
   * Get all healthy nodes that have at least one slot with the given role.
   * @param {'proposer'|'critic'|'synthesizer'|'any'} role
   */
  getByRole(role) {
    const healthy = [...this.nodes.values()].filter(n => n.healthy);
    if (role === 'any') return healthy;
    return healthy.filter(n =>
      n.slots.some(s => s.role === role || role === 'any')
    );
  }

  /**
   * Build a braid assignment from available nodes.
   * Returns { proposerNodes, criticNode, synthNode } or throws if insufficient.
   *
   * Strategy:
   *  - Proposers: all nodes with role='proposer' (or all nodes if none declared)
   *  - Critic:    best node with role='critic', fallback to a proposer
   *  - Synth:     best node with role='synthesizer', fallback to critic node
   */
  assignBraid(minProposers = 1) {
    const all = [...this.nodes.values()].filter(n => n.healthy);
    if (!all.length) throw new Error('No healthy nodes registered');

    const proposers = this.getByRole('proposer');
    const critics   = this.getByRole('critic');
    const synths    = this.getByRole('synthesizer');

    // Fall back: if no role-specific nodes, use all nodes
    const proposerPool = proposers.length ? proposers : all;
    const criticPool   = critics.length   ? critics   : all;
    const synthPool    = synths.length    ? synths    : all;

    if (proposerPool.length < minProposers) {
      throw new Error(`Need at least ${minProposers} proposer node(s), have ${proposerPool.length}`);
    }

    // Build proposer node descriptors (include slot info)
    const proposerNodes = proposerPool.map(n => {
      const slot = n.slots.find(s => s.role === 'proposer') || n.slots[0] || {};
      return { nodeId: n.nodeId, url: n.url, slotId: slot.id, model: slot.model };
    });

    const criticEntry = criticPool[0];
    const criticSlot  = criticEntry.slots.find(s => s.role === 'critic') || criticEntry.slots[0] || {};
    const criticNode  = { nodeId: criticEntry.nodeId, url: criticEntry.url, slotId: criticSlot.id, model: criticSlot.model };

    const synthEntry  = synthPool[0];
    const synthSlot   = synthEntry.slots.find(s => s.role === 'synthesizer') || synthEntry.slots[0] || {};
    const synthNode   = { nodeId: synthEntry.nodeId, url: synthEntry.url, slotId: synthSlot.id, model: synthSlot.model };

    return { proposerNodes, criticNode, synthNode };
  }

  list() {
    return [...this.nodes.values()];
  }

  // ── Persistence ───────────────────────────────────────────────────────────

  _save() {
    try {      const dir = this.persistPath.replace(/\/[^\/]+$/, '');
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(this.persistPath, JSON.stringify([...this.nodes.entries()], null, 2));
    } catch { /* non-fatal */ }
  }

  _load() {
    try {
      if (existsSync(this.persistPath)) {
        const raw = JSON.parse(readFileSync(this.persistPath, 'utf8'));
        for (const [id, entry] of raw) {
          // Mark stale nodes (not seen in 5 min) as unhealthy
          if (Date.now() - entry.lastSeen > 5 * 60 * 1000) entry.healthy = false;
          this.nodes.set(id, entry);
        }
      }
    } catch { /* start fresh */ }
  }
}
