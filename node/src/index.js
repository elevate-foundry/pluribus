/**
 * node/src/index.js
 * Pluribus Swarm Node entry point.
 *
 * Usage:
 *   LLAMA_URL=http://localhost:8080 LLAMA_MODEL=smollm2-360m LLAMA_ROLE=proposer \
 *   PLURIBUS_COORDINATOR=http://coordinator:7779 node src/index.js
 */

import { buildNodeServer } from './server.js';

const PORT = parseInt(process.env.NODE_PORT || '7778', 10);
const HOST = process.env.NODE_HOST || '0.0.0.0';

const app = await buildNodeServer();

try {
  await app.listen({ port: PORT, host: HOST });
} catch (err) {
  console.error('Failed to start node server:', err);
  process.exit(1);
}
