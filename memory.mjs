#!/usr/bin/env node
/**
 * memory — CLI entry point for the memory system (v3).
 *
 * Business logic lives in lib/ops.mjs.
 * All read commands support --json for full JSON output (no truncation).
 * Default output is a human-readable table with content truncated for terminal viewing.
 */
import {
  init, clear, health, stats, end,
  search, getFacts, addFact, updateFact, deleteFact, confirmFact,
  getSegment, listSegments, getSegmentEvents, updateSegment,
} from "./lib/ops.mjs";

const PORT = Number(process.argv.find((_, i) => process.argv[i - 1] === "--port")) || 3456;

// ── Argument parser ───────────────────────────────────────────────────

function parseArgs(args) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--watch" || a === "-w") flags.watch = true;
    else if (a === "--no-embed")        flags.noEmbed = true;
    else if (a === "--all")             flags.all = true;
    else if (a === "--json")            flags.json = true;
    else if (a === "--verbose")         flags.verbose = true;
    else if (a.startsWith("--"))        flags[a.slice(2)] = args[++i];
    else positional.push(a);
  }
  return { positional, flags };
}

// ── Output helpers ────────────────────────────────────────────────────

function out(obj) { console.log(JSON.stringify(obj, null, 2)); }

/** Truncate string to maxLen chars, collapsing internal newlines. */
function trunc(s, maxLen = 80) {
  if (!s) return "";
  s = String(s).replace(/\n+/g, " ").trim();
  return s.length <= maxLen ? s : s.slice(0, maxLen - 1) + "…";
}

function compactTime(ts) {
  if (!ts) return "";
  const d = new Date(ts);
  const pad = n => String(n).padStart(2, "0");
  // Display in local time (server is Asia/Shanghai)
  const loc = new Date(d.toLocaleString("en-US", { timeZone: "Asia/Shanghai" }));
  return `${pad(loc.getMonth() + 1)}-${pad(loc.getDate())} ${pad(loc.getHours())}:${pad(loc.getMinutes())}`;
}

// ── Table renderers ───────────────────────────────────────────────────

function printFactsTable(rows) {
  if (!rows.length) { console.log("(no facts)"); return; }
  const header = `${"ID".padEnd(8)}  ${"×".padStart(3)}  ${"updated".padEnd(11)}  summary`;
  console.log(header);
  console.log("─".repeat(Math.min(process.stdout.columns || 100, 120)));
  for (const r of rows) {
    const id = r.id.slice(0, 8);
    const cc = String(r.confirm_count || 0).padStart(3);
    const ts = compactTime(r.updated_at).padEnd(11);
    const summary = trunc(r.summary, 72);
    console.log(`${id}  ${cc}  ${ts}  ${summary}`);
  }
}

function printSearchTable(rows) {
  if (!rows.length) { console.log("(no results)"); return; }
  const header = `${"score".padEnd(6)}  ${"table".padEnd(9)}  ${"id".padEnd(8)}  preview`;
  console.log(header);
  console.log("─".repeat(Math.min(process.stdout.columns || 100, 120)));
  for (const r of rows) {
    const score = (r.score ?? r.similarity ?? 0).toFixed(3).padEnd(6);
    const tbl = (r.ref_table || "").padEnd(9);
    const id = (r.ref_id || "").slice(0, 8).padEnd(8);
    const preview = trunc(r.content_preview, 70);
    console.log(`${score}  ${tbl}  ${id}  ${preview}`);
  }
}

function printSegmentsTable(rows) {
  if (!rows.length) { console.log("(no segments)"); return; }
  const ICON = { open: "🟢", closed: "🟡", dreamed: "🔵" };
  const header = `st  ${"id".padEnd(12)}  ${"evts".padEnd(5)}  ${"dur".padEnd(7)}  ${"started".padEnd(11)}  title`;
  console.log(header);
  console.log("─".repeat(Math.min(process.stdout.columns || 100, 120)));
  for (const s of rows) {
    const icon = ICON[s.status] || "⚪";
    const id = String(s.id).padEnd(12);
    const evts = String(s.event_count).padStart(4).padEnd(5);
    const dur = s.duration ? `${Math.round(s.duration / 60)}min` : "—";
    const started = compactTime(s.started_at).padEnd(11);
    const title = trunc(s.title || "(no title)", 40);
    console.log(`${icon} ${id}  ${evts}  ${dur.padEnd(7)}  ${started}  ${title}`);
  }
}

function printSegmentDetail(s) {
  const ICON = { open: "🟢", closed: "🟡", dreamed: "🔵" };
  const icon = ICON[s.status] || "⚪";
  const dur = s.duration ? `${Math.round(s.duration / 60)}min` : "—";
  console.log(`${icon} Segment ${s.id}  [${s.status}]`);
  console.log(`  session   : ${s.session_id}`);
  console.log(`  started   : ${new Date(s.started_at).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}`);
  console.log(`  last event: ${new Date(s.last_event_at).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })}`);
  console.log(`  events    : ${s.event_count}  duration: ${dur}`);
  if (s.title) console.log(`  title     : ${s.title}`);
  if (s.abstract) {
    const lines = s.abstract.split("\n");
    const preview = lines.slice(0, 15).join("\n");
    console.log(`  abstract  :\n${preview.split("\n").map(l => "    " + l).join("\n")}`);
    if (lines.length > 15) console.log(`    … (${lines.length - 15} more lines)`);
  }
}

function printEventsTable(rows) {
  if (!rows.length) { console.log("(no events)"); return; }
  const header = `${"ts".padEnd(11)}  ${"type".padEnd(17)}  content`;
  console.log(header);
  console.log("─".repeat(Math.min(process.stdout.columns || 100, 120)));
  for (const e of rows) {
    const ts = compactTime(e.ts).padEnd(11);
    const type = (e.event_type || "").padEnd(17);
    const content = trunc(e.content, 70);
    console.log(`${ts}  ${type}  ${content}`);
  }
}

// ── Usage ─────────────────────────────────────────────────────────────

function usage() {
  console.error(`Usage:
  memory search <query> [--limit N] [--table ts|facts|segments] [--json]

  memory facts [id...]                List all facts, or fetch by ID prefix  [--json]
  memory facts add <json>             Add a new fact (always returns JSON)
  memory facts update <id> <json>     Update a fact (always returns JSON)
  memory facts delete <id>            Delete a fact (always returns JSON)

  memory segment list [--status open|closed|dreamed] [--limit N] [--json]
  memory segment <id>                 Show segment details              [--json]
  memory segment <id> events [--offset N] [--limit N]                  [--json]
  memory segment update <id> [--title T] [--abstract A]

  memory index [--watch] [--max N] [--no-embed]
  memory dream [--all] [--verbose]
  memory daemon [--verbose]

  memory init | health | stats | clear | web [--port N]`);
  process.exit(1);
}

// ── Main ──────────────────────────────────────────────────────────────

const [cmd, ...rest] = process.argv.slice(2);
const { positional, flags } = parseArgs(rest);
const limit = Number(flags.limit ?? 20);
const asJson = !!flags.json;

try {
  switch (cmd) {
    // ── Admin ──────────────────────────────────────────────────────────
    case "init":   console.log(await init()); break;
    case "clear": {
      // Also reset the index state so next `memory index` re-reads everything
      const { resetState } = await import("./index.mjs");
      resetState();
      console.log(await clear());
      break;
    }
    case "health": out(await health()); break;
    case "stats":  out(await stats()); break;

    case "web": {
      const mod = await import("./web.mjs");
      mod.server.listen(PORT, "0.0.0.0", () =>
        console.log(`Memory Browser: http://localhost:${PORT}`)
      );
      break; // keep process alive
    }

    // ── Search ─────────────────────────────────────────────────────────
    case "search": {
      if (!positional[0]) usage();
      let vector = null;
      try {
        const resp = await fetch("http://127.0.0.1:3457/embed", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: positional[0] }),
          signal: AbortSignal.timeout(2000),
        });
        if (resp.ok) {
          const { vectors } = await resp.json();
          vector = vectors[0];
        }
      } catch {} // daemon not running, fall back to local embedding
      const rows = await search(positional[0], { limit, table: flags.table, vector });
      if (asJson) out(rows);
      else printSearchTable(rows);
      process.exit(0);
    }

    // ── Facts ──────────────────────────────────────────────────────────
    case "facts": {
      const sub = positional[0];
      const RESERVED = new Set(["add", "update", "delete", "confirm"]);

      // No subcommand or positional args are IDs (not reserved words)
      if (!sub || !RESERVED.has(sub)) {
        const ids = positional.length ? positional : null;
        const rows = await getFacts(ids);
        if (asJson) out(rows);
        else printFactsTable(rows);
        break;
      }

      if (sub === "add") {
        const json = positional[1];
        if (!json) { console.error("facts add: missing <json>"); process.exit(1); }
        out(await addFact(JSON.parse(json)));
        break;
      }

      if (sub === "update") {
        const id = positional[1], json = positional[2];
        if (!id || !json) { console.error("facts update: missing <id> or <json>"); process.exit(1); }
        out(await updateFact(id, JSON.parse(json)));
        break;
      }

      if (sub === "delete") {
        const id = positional[1];
        if (!id) { console.error("facts delete: missing <id>"); process.exit(1); }
        out(await deleteFact(id));
        break;
      }

      if (sub === "confirm") {
        const id = positional[1];
        if (!id) { console.error("facts confirm: missing <id>"); process.exit(1); }
        out(await confirmFact(id));
        break;
      }

      // Fallback: treat positional args as IDs (backward compat)
      const rows = await getFacts([sub, ...positional.slice(1)]);
      if (asJson) out(rows);
      else printFactsTable(rows);
      break;
    }

    // ── Segment ────────────────────────────────────────────────────────
    case "segment": {
      const sub = positional[0];
      if (!sub) usage();

      if (sub === "list") {
        const rows = await listSegments({
          status: flags.status,
          limit,
          offset: Number(flags.offset || 0),
        });
        if (asJson) out(rows);
        else printSegmentsTable(rows);
        break;
      }

      if (sub === "update") {
        const id = positional[1];
        if (!id) usage();
        const patch = {};
        if (flags.title    !== undefined) patch.title    = flags.title;
        if (flags.abstract !== undefined) patch.abstract = flags.abstract;
        if (flags.status   !== undefined) patch.status   = flags.status;
        out(await updateSegment(id, patch));
        break;
      }

      // memory segment <id>  or  memory segment <id> events
      const id = sub;
      if (positional[1] === "events") {
        const rows = await getSegmentEvents(id, {
          offset: Number(flags.offset || 0),
          limit: Number(flags.limit || 20),
        });
        if (asJson) out(rows);
        else printEventsTable(rows);
      } else {
        const seg = await getSegment(id);
        if (!seg) { console.error(`Segment ${id} not found`); process.exit(1); }
        if (asJson) out(seg);
        else printSegmentDetail(seg);
      }
      break;
    }

    // ── Index ──────────────────────────────────────────────────────────
    case "index": {
      const mod = await import("./index.mjs");
      await mod.run({
        watch: !!flags.watch,
        max: Number(flags.max || 200),
        noEmbed: !!flags.noEmbed,
      });
      break;
    }

    // ── Dream ──────────────────────────────────────────────────────────
    case "dream": {
      const mod = await import("./dream.mjs");
      await mod.run({ all: !!flags.all, verbose: !!flags.verbose });
      break;
    }

    // ── Daemon ────────────────────────────────────────────────────────
    case "daemon": {
      const mod = await import("./daemon.mjs");
      await mod.run({ verbose: !!flags.verbose });
      break;
    }

    default: usage();
  }
} catch (e) {
  console.error(e.message || e);
  process.exit(1);
} finally {
  await end();
}
