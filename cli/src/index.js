#!/usr/bin/env node
/**
 * cli/src/index.js
 * Pluribus CLI — interact with the swarm from the terminal.
 *
 * Commands:
 *   pluribus chat "your question"          — full braid
 *   pluribus chat --fast "your question"   — fast braid
 *   pluribus chat --stream "your question" — streaming output
 *   pluribus repl                          — interactive REPL
 *   pluribus nodes                         — list registered nodes
 *   pluribus stats                         — swarm statistics
 *   pluribus node start                    — start a local node
 *   pluribus coordinator start             — start the coordinator
 */

import { Command } from 'commander';
import chalk from 'chalk';
import { createInterface } from 'readline';
import { Pluribus } from '../../sdk/src/index.js';
import { buildCoordinatorServer } from '../../coordinator/src/server.js';
import { buildNodeServer } from '../../node/src/server.js';

const program = new Command();

program
  .name('pluribus')
  .description('Distributed AI swarm with braided inference')
  .version('0.1.0')
  .option('-c, --coordinator <url>', 'Coordinator URL', process.env.PLURIBUS_COORDINATOR || 'http://localhost:7779');

// ── chat ──────────────────────────────────────────────────────────────────────
program
  .command('chat [query]')
  .description('Send a query to the swarm')
  .option('--fast', 'Fast braid (no critic layer)')
  .option('--single', 'Single model (no braiding)')
  .option('--stream', 'Stream the response')
  .option('--id <id>', 'Conversation ID for persistent history')
  .action(async (query, opts, cmd) => {
    const coordinator = cmd.parent.opts().coordinator;
    const client = new Pluribus({ coordinator });

    if (!query) {
      // Interactive single-query mode
      const rl = createInterface({ input: process.stdin, output: process.stdout });
      query = await new Promise(resolve => rl.question(chalk.cyan('Query: '), answer => { rl.close(); resolve(answer); }));
    }

    if (!query.trim()) { console.error('No query provided'); process.exit(1); }

    const mode = opts.single ? 'single' : opts.fast ? 'fast' : 'full';
    console.log(chalk.dim(`\n  Mode: ${mode} | Coordinator: ${coordinator}\n`));

    if (opts.stream) {
      process.stdout.write(chalk.bold('Answer: '));
      try {
        for await (const { event, data } of client.stream(query, { mode, conversationId: opts.id })) {
          if (event === 'layer_complete') {
            process.stderr.write(chalk.dim(` [${data.model || data.nodeId}] `));
          } else if (event === 'result') {
            process.stdout.write('\n');
            printResult(data);
          } else if (event === 'error') {
            console.error(chalk.red('\nError: ' + data.error));
          }
        }
      } catch (err) {
        console.error(chalk.red('Stream error: ' + err.message));
        process.exit(1);
      }
      return;
    }

    try {
      const spinner = startSpinner();
      const chatFn = opts.single ? client.chatSingle.bind(client)
                   : opts.fast   ? client.chatFast.bind(client)
                   :               client.chat.bind(client);
      const result = await chatFn(query, { conversationId: opts.id });
      clearSpinner(spinner);
      printResult(result);
    } catch (err) {
      console.error(chalk.red('\nError: ' + err.message));
      process.exit(1);
    }
  });

// ── repl ──────────────────────────────────────────────────────────────────────
program
  .command('repl')
  .description('Interactive REPL with conversation history')
  .option('--fast', 'Use fast braid mode')
  .action(async (opts, cmd) => {
    const coordinator = cmd.parent.opts().coordinator;
    const client = new Pluribus({ coordinator });
    const mode = opts.fast ? 'fast' : 'full';

    console.log(chalk.bold.cyan('\n  Pluribus Swarm REPL'));
    console.log(chalk.dim(`  Mode: ${mode} | Coordinator: ${coordinator}`));
    console.log(chalk.dim('  Type "exit" to quit, "clear" to reset history, "stats" for swarm info\n'));

    // Check coordinator health
    try {
      const h = await client.health();
      console.log(chalk.green(`  Swarm online — ${h.healthy_nodes}/${h.nodes} nodes healthy\n`));
    } catch {
      console.log(chalk.yellow('  Warning: coordinator not reachable. Start with: pluribus coordinator start\n'));
    }

    const conversationId = `repl-${Date.now()}`;
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });

    const prompt = () => rl.question(chalk.cyan('\nYou: '), async (input) => {
      const query = input.trim();
      if (!query) return prompt();
      if (query === 'exit' || query === 'quit') { rl.close(); return; }
      if (query === 'clear') {
        console.log(chalk.dim('  Conversation history cleared.'));
        return prompt();
      }
      if (query === 'stats') {
        try {
          const s = await client.stats();
          console.log(chalk.dim(JSON.stringify(s, null, 2)));
        } catch (e) { console.error(chalk.red(e.message)); }
        return prompt();
      }

      const spinner = startSpinner();
      try {
        const chatFn = mode === 'fast' ? client.chatFast.bind(client) : client.chat.bind(client);
        const result = await chatFn(query, { conversationId });
        clearSpinner(spinner);
        console.log(chalk.bold('\nSwarm: ') + result.answer);
        console.log(chalk.dim(`  [${result.model_count} models, ${result.total_elapsed_ms}ms]`));
      } catch (err) {
        clearSpinner(spinner);
        console.error(chalk.red('Error: ' + err.message));
      }
      prompt();
    });

    prompt();
  });

// ── nodes ─────────────────────────────────────────────────────────────────────
program
  .command('nodes')
  .description('List registered swarm nodes')
  .action(async (opts, cmd) => {
    const coordinator = cmd.parent.opts().coordinator;
    const client = new Pluribus({ coordinator });
    try {
      const stats = await client.stats();
      console.log(chalk.bold('\nSwarm Nodes:'));
      console.log(`  Total: ${stats.total_nodes} | Healthy: ${stats.healthy_nodes}`);
      console.log(`  Proposers: ${stats.proposers} | Critics: ${stats.critics} | Synthesizers: ${stats.synthesizers}\n`);
      for (const n of stats.nodes) {
        const status = n.healthy ? chalk.green('●') : chalk.red('●');
        console.log(`  ${status} ${n.nodeId} — ${n.url}`);
        for (const s of n.slots) {
          console.log(`      ${chalk.dim(s.role.padEnd(12))} ${s.model}`);
        }
      }
    } catch (err) {
      console.error(chalk.red('Error: ' + err.message));
      process.exit(1);
    }
  });

// ── stats ─────────────────────────────────────────────────────────────────────
program
  .command('stats')
  .description('Show swarm statistics')
  .action(async (opts, cmd) => {
    const coordinator = cmd.parent.opts().coordinator;
    const client = new Pluribus({ coordinator });
    try {
      const s = await client.stats();
      console.log(JSON.stringify(s, null, 2));
    } catch (err) {
      console.error(chalk.red('Error: ' + err.message));
    }
  });

// ── coordinator start ─────────────────────────────────────────────────────────
const coordinatorCmd = program.command('coordinator').description('Coordinator management');
coordinatorCmd
  .command('start')
  .description('Start the coordinator server')
  .option('-p, --port <port>', 'Port', '7779')
  .action(async (opts) => {
    const port = parseInt(opts.port, 10);
    console.log(chalk.bold.cyan(`\n  Starting Pluribus Coordinator on port ${port}...\n`));
    const app = await buildCoordinatorServer({ port });
    await app.listen({ port, host: '0.0.0.0' });
  });

// ── node start ────────────────────────────────────────────────────────────────
const nodeCmd = program.command('node').description('Node management');
nodeCmd
  .command('start')
  .description('Start a swarm node')
  .option('-p, --port <port>', 'Node port', '7778')
  .option('--llama-url <url>', 'llama.cpp server URL', 'http://localhost:8080')
  .option('--model <name>', 'Model name/alias', 'local')
  .option('--role <role>', 'Slot role: proposer|critic|synthesizer', 'proposer')
  .option('--coordinator <url>', 'Coordinator to register with')
  .action(async (opts, cmd) => {
    const port = parseInt(opts.port, 10);
    const coordinator = opts.coordinator || cmd.parent.parent.opts().coordinator;
    console.log(chalk.bold.cyan(`\n  Starting Pluribus Node on port ${port}...`));
    console.log(chalk.dim(`  Model: ${opts.model} | Role: ${opts.role} | llama.cpp: ${opts.llamaUrl}\n`));
    const app = await buildNodeServer({
      port,
      coordinatorUrl: coordinator,
      slots: [{
        id: opts.model,
        model: opts.model,
        url: opts.llamaUrl,
        role: opts.role,
      }],
    });
    await app.listen({ port, host: '0.0.0.0' });
  });

// ── Helpers ───────────────────────────────────────────────────────────────────

function printResult(result) {
  console.log(chalk.bold('\nAnswer:\n'));
  console.log(result.answer);
  if (result.total_elapsed_ms) {
    console.log(chalk.dim(`\n  [${result.model_count} models | ${result.total_elapsed_ms}ms | conversation: ${result.conversation_id}]`));
  }
}

function startSpinner() {
  const frames = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
  let i = 0;
  process.stdout.write(chalk.dim('  Braiding'));
  return setInterval(() => {
    process.stdout.write(`\r  ${chalk.cyan(frames[i++ % frames.length])} Braiding...`);
  }, 80);
}

function clearSpinner(spinner) {
  clearInterval(spinner);
  process.stdout.write('\r                    \r');
}

program.parse(process.argv);
