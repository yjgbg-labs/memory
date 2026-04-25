#!/usr/bin/env node
/**
 * daemon — infinite index → dream loop, with embedded embed server.
 *
 * Runs a small HTTP server on 127.0.0.1:3457 so that CLI commands like
 * `memory search` can reuse the pre-loaded model instead of loading it
 * from scratch each invocation.
 */

import { createServer } from "http";

const SLEEP_MS = 30_000;
const EMBED_PORT = 3457;
const EMBED_HOST = "127.0.0.1";

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => { data += c; });
    req.on("end", () => resolve(data));
  });
}

function startEmbedServer(embedFn) {
  return new Promise((resolve) => {
    const server = createServer(async (req, res) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

      if (req.method === "GET" && req.url === "/health") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ ok: true }));
        return;
      }

      if (req.method === "POST" && req.url === "/embed") {
        try {
          const body = await readBody(req);
          const { text, texts } = JSON.parse(body);
          const input = texts || (text ? [text] : []);
          if (!input.length) {
            res.writeHead(400, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "missing text/texts" }));
            return;
          }
          const vecs = await embedFn(input);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ vectors: vecs }));
        } catch (e) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: e.message }));
        }
        return;
      }

      res.writeHead(404); res.end("not found");
    });

    server.listen(EMBED_PORT, EMBED_HOST, () => {
      process.stderr.write(`[daemon] embed server on ${EMBED_HOST}:${EMBED_PORT}\n`);
      resolve(server);
    });
  });
}

export async function run({ verbose = false } = {}) {
  // Warm up the embedding model before accepting requests
  const { embed, warmup } = await import("./lib/embed.mjs");
  await warmup();

  const server = await startEmbedServer(embed);

  const { run: indexRun } = await import("./index.mjs");
  const { run: dreamRun } = await import("./dream.mjs");

  let running = true;
  const shutdown = () => {
    process.stderr.write("[daemon] shutting down...\n");
    running = false;
    server.close();
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  process.stderr.write("[daemon] starting index → dream loop\n");

  while (running) {
    let worked = false;

    try {
      const indexed = await indexRun({ max: 200 });
      if (indexed > 0) worked = true;
    } catch (e) {
      process.stderr.write(`[daemon] index error: ${e.message}\n`);
    }

    if (!running) break;

    try {
      const dreamt = await dreamRun({ verbose });
      if (dreamt > 0) worked = true;
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
