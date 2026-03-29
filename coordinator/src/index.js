/**
 * coordinator/src/index.js
 * Pluribus Swarm Coordinator entry point.
 *
 * Usage:
 *   COORDINATOR_PORT=7779 node src/index.js
 */

import { buildCoordinatorServer } from './server.js';

const PORT = parseInt(process.env.COORDINATOR_PORT || '7779', 10);
const HOST = process.env.COORDINATOR_HOST || '0.0.0.0';

const app = await buildCoordinatorServer();

try {
  await app.listen({ port: PORT, host: HOST });
  console.log(`\n  Pluribus Coordinator running on http://${HOST}:${PORT}`);
  console.log(`  POST /v1/chat          — full braid (proposer → critic → synthesizer)`);
  console.log(`  POST /v1/chat/fast     — fast braid (proposer → synthesizer)`);
  console.log(`  POST /v1/nodes/register — register a swarm node`);
  console.log(`  GET  /v1/stats         — swarm status\n`);
} catch (err) {
  console.error('Failed to start coordinator:', err);
  process.exit(1);
}
