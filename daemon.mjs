#!/usr/bin/env node
/**
 * daemon — infinite index → dream loop.
 *
 * Runs index (collect events) then dream (process one closed segment).
 * If neither produced work, sleeps 30 seconds and repeats.
 */

const SLEEP_MS = 30_000;

export async function run({ verbose = false } = {}) {
  const { run: indexRun } = await import("./index.mjs");
  const { run: dreamRun } = await import("./dream.mjs");

  let running = true;
  const shutdown = () => {
    process.stderr.write("[daemon] shutting down...\n");
    running = false;
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  process.stderr.write("[daemon] starting index → dream loop\n");

  while (running) {
    let worked = false;

    try {
      const indexed = await indexRun({ max: 200 });
      if (indexed > 0) { worked = true; }
    } catch (e) {
      process.stderr.write(`[daemon] index error: ${e.message}\n`);
    }

    if (!running) break;

    try {
      const dreamt = await dreamRun({ verbose });
      if (dreamt > 0) { worked = true; }
    } catch (e) {
      process.stderr.write(`[daemon] dream error: ${e.message}\n`);
    }

    if (!running) break;

    if (!worked) {
      process.stderr.write("[daemon] idle — sleeping 30s\n");
      await new Promise((r) => setTimeout(r, SLEEP_MS));
    }
  }

  const { end } = await import("./lib/db.mjs");
  await end();
}

// Direct execution
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/.*\//, ""))) {
  const verbose = process.argv.includes("--verbose");
  run({ verbose }).catch((e) => { console.error(e); process.exit(1); });
}
