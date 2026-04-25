#!/usr/bin/env node
/**
 * index — watches session event files and syncs them into ts + segments tables.
 *
 * Segmentation rules:
 *   - A new segment starts when the gap between consecutive events ≥ 1 hour.
 *   - Segments with < 5 events OR duration < 300 seconds are deleted after closing.
 *   - User messages < 20 chars and assistant messages < 30 chars are stored in ts
 *     but skipped for vec (embedding) indexing.
 *
 * Usage:
 *   node index.mjs                  # one-shot: process up to 200 new events
 *   node index.mjs --max 50
 *   node index.mjs --watch          # daemon: poll every 30s
 *   node index.mjs --no-embed       # insert events without embedding (fast)
 */
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, rmSync } from "fs";
import { join } from "path";
import { homedir, hostname } from "os";
import { query } from "./lib/db.mjs";

const HOME = homedir();
const HOST = hostname();
export const STATE_PATH = join(HOME, ".copilot", ".memory-index-state.json");
const COPILOT_DIR = join(HOME, ".copilot", "session-state");
const CLAUDE_DIR = join(HOME, ".claude", "projects");

const DEFAULT_MAX = 200;
const GAP_SECONDS = 3600;           // 1 hour → new segment
const MIN_EVENTS = 5;               // minimum events to keep a segment
const MIN_DURATION = 300;           // minimum 5 minutes to keep a segment
const USER_MIN_CHARS = 20;          // user messages shorter than this skip vec
const ASSISTANT_MIN_CHARS = 30;     // assistant messages shorter than this skip vec

// ── State management ─────────────────────────────────────────────────

function loadState() {
  try { return JSON.parse(readFileSync(STATE_PATH, "utf8")); } catch { return { offsets: {} }; }
}

function saveState(state) {
  writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

/** Delete the state file so the next `memory index` re-reads everything from scratch. */
export function resetState() {
  try { rmSync(STATE_PATH); } catch {}
}

// ── Discover event files ─────────────────────────────────────────────

function discoverFiles() {
  const files = [];

  // Copilot: ~/.copilot/session-state/<session>/events.jsonl
  if (existsSync(COPILOT_DIR)) {
    for (const dir of readdirSync(COPILOT_DIR)) {
      const evFile = join(COPILOT_DIR, dir, "events.jsonl");
      if (existsSync(evFile)) files.push({ path: evFile, agent: "copilot", sessionId: dir });
    }
  }

  // Claude: ~/.claude/projects/<proj>/<session>.jsonl
  //         ~/.claude/projects/<proj>/<session>/subagents/<agent>.jsonl
  if (existsSync(CLAUDE_DIR)) {
    for (const proj of readdirSync(CLAUDE_DIR)) {
      const projDir = join(CLAUDE_DIR, proj);
      try { if (!statSync(projDir).isDirectory()) continue; } catch { continue; }

      for (const entry of readdirSync(projDir)) {
        const entryPath = join(projDir, entry);

        // Top-level session file: <session-uuid>.jsonl
        if (entry.endsWith(".jsonl")) {
          files.push({ path: entryPath, agent: "claude", sessionId: entry.replace(".jsonl", "") });
          continue;
        }

        // Session directory: <session-uuid>/ — look for subagents inside
        let entryStat;
        try { entryStat = statSync(entryPath); } catch { continue; }
        if (!entryStat.isDirectory()) continue;

        const subagentsDir = join(entryPath, "subagents");
        if (!existsSync(subagentsDir)) continue;

        for (const agentFile of readdirSync(subagentsDir)) {
          if (!agentFile.endsWith(".jsonl")) continue;
          // sessionId = parent session uuid (entry), not agent file name
          files.push({
            path: join(subagentsDir, agentFile),
            agent: "claude",
            sessionId: entry,
          });
        }
      }
    }
  }

  return files;
}

// ── Parse events ─────────────────────────────────────────────────────

function parseCopilotEvent(line, sessionId) {
  const e = JSON.parse(line);
  const t = e.type;
  if (!["user.message", "assistant.message", "skill.invoked", "session.start", "session.model_change"].includes(t)) return null;

  let content = "";
  const metadata = {};

  if (t === "user.message") {
    content = e.data?.content || e.data?.transformedContent || "";
  } else if (t === "assistant.message") {
    const raw = e.data?.content;
    content = Array.isArray(raw)
      ? raw.filter(c => c.type === "text").map(c => c.text).join("\n")
      : raw || "";
    if (e.data?.toolRequests?.length) metadata.hasTools = true;
  } else if (t === "skill.invoked") {
    content = `[skill:${e.data?.name}] ${e.data?.description || ""}`;
    metadata.skillName = e.data?.name;
  } else if (t === "session.start") {
    const ctx = e.data?.context || {};
    content = `[session.start] cwd=${ctx.cwd || ""}`;
    metadata.cwd = ctx.cwd;
  } else if (t === "session.model_change") {
    content = `[model_change] ${e.data?.newModel || ""}`;
  }

  if (!content || content.length < 3) return null;
  return { ts: e.timestamp || new Date().toISOString(), event_type: t, session_id: sessionId, content: content.slice(0, 10000), metadata };
}

function parseClaudeEvent(line, sessionId) {
  const e = JSON.parse(line);
  const t = e.type;
  if (!["user", "assistant"].includes(t)) return null;

  const metadata = {};
  if (e.cwd) metadata.cwd = e.cwd;
  if (e.gitBranch) metadata.gitBranch = e.gitBranch;

  let content = "";
  if (e.message?.content) {
    if (Array.isArray(e.message.content)) {
      const parts = [];
      for (const c of e.message.content) {
        if (c.type === "thinking") parts.push(`[thinking] ${c.thinking}`);
        else if (c.type === "text") parts.push(c.text);
        else if (c.type === "tool_use") { parts.push(`[tool:${c.name}] ${JSON.stringify(c.input || {}).slice(0, 500)}`); metadata.hasTools = true; }
        else if (c.type === "tool_result") {
          const r = Array.isArray(c.content) ? c.content.filter(x => x.type === "text").map(x => x.text).join("\n") : String(c.content || "");
          parts.push(`[tool_result] ${r.slice(0, 1000)}`);
        }
      }
      content = parts.join("\n");
    } else {
      content = String(e.message.content);
    }
  }

  if (!content || content.length < 3) return null;
  return {
    ts: e.timestamp ? new Date(e.timestamp).toISOString() : new Date().toISOString(),
    event_type: t === "user" ? "user.message" : "assistant.message",
    session_id: e.sessionId || sessionId,
    content: content.slice(0, 10000),
    metadata,
  };
}

// ── File reading ─────────────────────────────────────────────────────

function readNewLines(filePath, offset) {
  const buf = readFileSync(filePath);
  if (offset >= buf.length) return { lines: [], newOffset: offset };
  const chunk = buf.subarray(offset).toString("utf8");
  const lines = chunk.split("\n").filter(Boolean);
  return { lines, newOffset: buf.length };
}

// ── Segment management ───────────────────────────────────────────────

/** Resolve a unique segment id (unix seconds), bumping by 1 if collision. */
async function resolveSegmentId(tsSeconds) {
  let id = tsSeconds;
  for (let i = 0; i < 10; i++) {
    const { rows } = await query("SELECT 1 FROM segments WHERE id = $1", [BigInt(id)]);
    if (!rows.length) return id;
    id++;
  }
  return id;
}

/** Create a new open segment in the DB. */
async function createSegment(id, sessionId, startedAt) {
  await query(
    `INSERT INTO segments (id, session_id, status, started_at, last_event_at, created_at, updated_at)
     VALUES ($1, $2, 'open', $3, $3, now(), now())
     ON CONFLICT (id) DO NOTHING`,
    [BigInt(id), sessionId, startedAt]
  );
  return id;
}

/** Update segment stats after processing its events. */
async function refreshSegmentStats(segmentId) {
  await query(
    `UPDATE segments
     SET last_event_at = sub.last_ts,
         event_count   = sub.cnt,
         duration      = EXTRACT(EPOCH FROM (sub.last_ts - segments.started_at))::int,
         updated_at    = now()
     FROM (
       SELECT MAX(ts) AS last_ts, COUNT(*)::int AS cnt
       FROM ts WHERE segment_id = $1
     ) sub
     WHERE segments.id = $1 AND sub.last_ts IS NOT NULL`,
    [BigInt(segmentId)]
  );
}

// ── Embedding ────────────────────────────────────────────────────────

const EMBED_BATCH_SIZE = 64;

function shouldEmbed(event) {
  if (event.event_type === "user.message" && event.content.length < USER_MIN_CHARS) return false;
  if (event.event_type === "assistant.message" && event.content.length < ASSISTANT_MIN_CHARS) return false;
  return true;
}

async function embedBatch(items, embedFn) {
  if (!items.length) return;
  const texts = items.map(({ content }) => content.slice(0, 500));
  const vecs = await embedFn(texts);
  for (let i = 0; i < items.length; i++) {
    const refs = items[i].segmentId
      ? JSON.stringify([{ type: "segment", id: items[i].segmentId }])
      : "[]";
    await query(
      `INSERT INTO vec (ref_table, ref_id, content_preview, embedding, refs)
       VALUES ('ts', $1, $2, $3::vector, $4)`,
      [items[i].id, items[i].content.slice(0, 200), JSON.stringify(vecs[i]), refs]
    );
  }
}

// ── Main cycle ───────────────────────────────────────────────────────

export async function run({ watch = false, max = DEFAULT_MAX, noEmbed = false } = {}) {
  let embedFn = null;
  if (!noEmbed) {
    const { embed } = await import("./lib/embed.mjs");
    embedFn = embed;
  }

  let totalNew = 0;

  const cycle = async (budget) => {
    const state = loadState();
    const files = discoverFiles();
    let cycleNew = 0;
    let remaining = budget;
    const affectedSegments = new Set();

    for (const { path, agent, sessionId } of files) {
      if (remaining <= 0) break;

      const offset = state.offsets[path] || 0;
      const { lines, newOffset } = readNewLines(path, offset);
      if (!lines.length) { state.offsets[path] = newOffset; continue; }

      // Load current open segment for this session (if any)
      const { rows: openRows } = await query(
        "SELECT * FROM segments WHERE session_id = $1 AND status = 'open' ORDER BY started_at DESC LIMIT 1",
        [sessionId]
      );
      let currentSegment = openRows[0] || null;
      let lastEventTs = currentSegment
        ? new Date(currentSegment.last_event_at).getTime()
        : null;

      let fileNew = 0;
      let linesConsumed = 0;
      const pendingEmbeds = [];

      for (const line of lines) {
        if (remaining <= 0) break;
        linesConsumed++;
        try {
          const parser = agent === "copilot" ? parseCopilotEvent : parseClaudeEvent;
          const r = parser(line, sessionId);
          if (!r) continue;

          const eventTs = new Date(r.ts).getTime();

          // Check for segment gap
          if (lastEventTs !== null && (eventTs - lastEventTs) >= GAP_SECONDS * 1000) {
            currentSegment = null; // force new segment
          }

          // Create new segment if needed
          if (!currentSegment) {
            const tsSeconds = Math.floor(eventTs / 1000);
            const newId = await resolveSegmentId(tsSeconds);
            await createSegment(newId, sessionId, new Date(r.ts).toISOString());
            currentSegment = { id: newId };
          }

          lastEventTs = eventTs;
          affectedSegments.add(currentSegment.id);

          // Insert event
          const { rows: inserted } = await query(
            `INSERT INTO ts (ts, event_type, session_id, segment_id, content, metadata)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (session_id, ts, md5(content)) DO NOTHING
             RETURNING id`,
            [r.ts, r.event_type, r.session_id, BigInt(currentSegment.id), r.content, r.metadata]
          );

          const eventId = inserted[0]?.id;
          if (!eventId) continue; // dedup

          if (embedFn && shouldEmbed(r)) {
            pendingEmbeds.push({ id: eventId, content: r.content, ts: r.ts, segmentId: currentSegment.id });
            if (pendingEmbeds.length >= EMBED_BATCH_SIZE) {
              await embedBatch(pendingEmbeds.splice(0), embedFn);
            }
          }

          fileNew++;
          remaining--;
        } catch {
          // skip malformed lines
        }
      }

      if (pendingEmbeds.length) await embedBatch(pendingEmbeds, embedFn);

      if (fileNew > 0) {
        process.stderr.write(`[index] ${agent}/${sessionId.slice(0, 8)}: ${fileNew} events\n`);
      }

      // Advance offset
      state.offsets[path] = linesConsumed >= lines.length
        ? newOffset
        : offset + lines.slice(0, linesConsumed).reduce((s, l) => s + Buffer.byteLength(l) + 1, 0);

      cycleNew += fileNew;
    }

    // Refresh stats for all affected segments
    for (const segId of affectedSegments) {
      await refreshSegmentStats(segId);
    }

    // Close segments idle for ≥ 1 hour
    await query(
      `UPDATE segments SET status = 'closed', updated_at = now()
       WHERE status = 'open' AND last_event_at <= now() - interval '1 hour'`
    );

    // Delete newly-closed segments that don't meet minimum thresholds
    // Clean up vec + ts first to avoid orphan records (FK ON DELETE SET NULL)
    await query(
      `DELETE FROM vec WHERE ref_table = 'ts' AND ref_id IN (
         SELECT id::text FROM ts WHERE segment_id IN (
           SELECT id FROM segments WHERE status = 'closed' AND (event_count < $1 OR duration < $2)
         )
       )`,
      [MIN_EVENTS, MIN_DURATION]
    );
    await query(
      `DELETE FROM ts WHERE segment_id IN (
         SELECT id FROM segments WHERE status = 'closed' AND (event_count < $1 OR duration < $2)
       )`,
      [MIN_EVENTS, MIN_DURATION]
    );
    await query(
      `DELETE FROM segments
       WHERE status = 'closed' AND (event_count < $1 OR duration < $2)`,
      [MIN_EVENTS, MIN_DURATION]
    );

    saveState(state);
    totalNew += cycleNew;
    return cycleNew;
  };

  const n = await cycle(max);
  process.stderr.write(`[index] indexed ${n} new events (total: ${totalNew})\n`);

  if (watch) {
    process.stderr.write("[index] watching for new events (30s interval)...\n");
    const interval = setInterval(async () => {
      try {
        const n = await cycle(max);
        if (n > 0) process.stderr.write(`[index] indexed ${n} new events\n`);
      } catch (e) {
        process.stderr.write(`[index] error: ${e.message}\n`);
      }
    }, 30_000);

    process.on("SIGINT", () => { clearInterval(interval); process.stderr.write(`\n[index] stopped. total: ${totalNew}\n`); process.exit(0); });
    process.on("SIGTERM", () => { clearInterval(interval); process.exit(0); });
    await new Promise(() => {});
  }

  return totalNew;
}

// Direct execution
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/.*\//, ""))) {
  const args = process.argv.slice(2);
  const watch = args.includes("--watch") || args.includes("-w");
  const noEmbed = args.includes("--no-embed");
  const maxIdx = args.indexOf("--max");
  const max = maxIdx >= 0 ? Number(args[maxIdx + 1]) : DEFAULT_MAX;
  run({ watch, max, noEmbed }).then((n) => { if (!watch) process.exit(0); }).catch((e) => { console.error(e); process.exit(1); });
}
