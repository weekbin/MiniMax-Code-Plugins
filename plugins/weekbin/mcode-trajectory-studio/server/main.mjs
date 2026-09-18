#!/usr/bin/env node
/**
 * MCode Trajectory Studio entry point.
 *
 *   node server/main.mjs              # MCP over stdio (used by mcode)
 *   node server/main.mjs --serve      # Trajectory Studio panel only
 *   node server/main.mjs --doctor     # print data-source diagnostics and exit
 */

import { pathToFileURL } from 'node:url';
import path from 'node:path';

import { openStore, resolveDataDir, sqlitePath } from './store.mjs';
import { createHandler, serveStdio } from './mcp.mjs';
import { createStudio } from './http.mjs';

function parseArgs(argv) {
  const args = { mode: 'stdio', port: null, sessionId: null };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === '--serve' || token === '--http') args.mode = 'serve';
    else if (token === '--doctor') args.mode = 'doctor';
    else if (token === '--stdio') args.mode = 'stdio';
    else if (token === '--port') args.port = Number.parseInt(argv[++index] ?? '', 10);
    else if (token === '--session') args.sessionId = argv[++index] ?? null;
  }
  return args;
}

export function bootstrap({ env = process.env, homeDir } = {}) {
  const dataDir = resolveDataDir(env, homeDir);
  const warnings = [];
  const store = openStore({ dataDir, warnings });
  const pluginDataDir = typeof env.PLUGIN_DATA === 'string' && env.PLUGIN_DATA.trim()
    ? path.resolve(env.PLUGIN_DATA.trim())
    : null;
  const studio = createStudio({ store, homeDir: homeDir ?? env.HOME ?? null, pluginDataDir });
  const handler = createHandler({ store, studio, homeDir: homeDir ?? env.HOME ?? null });
  return { dataDir, store, studio, handler, warnings };
}

async function doctor(context) {
  const { dataDir, store } = context;
  const sessions = store.listSessions({ limit: 5 });
  const [latest] = sessions;
  const stats = latest ? store.getStats(latest.sessionId) : null;
  return {
    node: process.version,
    dataDir,
    sqlitePath: sqlitePath(dataDir),
    sqliteAvailable: Boolean(store.db),
    ftsAvailable: store.hasFts,
    sessionsVisible: sessions.length,
    latestSession: latest ? { sessionId: latest.sessionId, title: latest.title, agent: latest.agent } : null,
    latestStats: stats
      ? {
          turns: stats.turns,
          steps: stats.steps,
          llmMs: stats.llmMs,
          toolMs: stats.toolMs,
          decodeMs: stats.decodeMs,
          ttftMs: stats.ttftMs,
          toolCalls: stats.toolCalls,
          compactions: stats.compactions,
          subagentTasks: stats.subagentTasks,
        }
      : null,
    warnings: store.warnings,
  };
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const context = bootstrap();

  if (args.mode === 'doctor') {
    process.stdout.write(`${JSON.stringify(await doctor(context), null, 2)}\n`);
    context.store.close();
    return;
  }

  if (args.mode === 'serve') {
    const started = await context.studio.start({ sessionId: args.sessionId, port: args.port });
    process.stdout.write(`Trajectory Studio listening on ${started.url} (read-only, 127.0.0.1)\n`);
    return;
  }

  await serveStdio(context.handler);
  // mcode closing the MCP pipe ends the process; the panel must not keep it alive.
  await context.studio.stop();
  context.store.close();
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
