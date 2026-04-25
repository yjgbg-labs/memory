/**
 * ops.mjs — core memory operations (search, facts, segments).
 *
 * Shared by memory.mjs (CLI) and dream.mjs (agent). No circular dependencies.
 */
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { query, end as dbEnd } from "./db.mjs";
import { embed } from "./embed.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

/** Split text into sentences on Chinese/English punctuation and newlines. */
function splitSentences(text) {
  if (!text) return [];
  return text
    .split(/(?<=[。！？!?\n])|(?<=\. )/)
    .map((s) => s.trim())
    .filter((s) => s.length > 5);
}

// ── Schema init ──────────────────────────────────────────────────────

export async function init() {
  const sql = readFileSync(join(__dirname, "schema.sql"), "utf8");
  const statements = sql.split(";").map((s) => s.trim()).filter(Boolean);
  for (const stmt of statements) {
    await query(stmt);
  }
  return "schema initialized";
}

export async function clear() {
  for (const tbl of ["vec", "facts", "ts", "segments"]) {
    await query(`DROP TABLE IF EXISTS ${tbl} CASCADE`);
  }
  return "all tables dropped — run 'memory init' to recreate";
}

// ── Health ───────────────────────────────────────────────────────────

export async function health() {
  const { rows } = await query("SELECT now() AS t, current_database() AS db");
  return rows[0];
}

// ── Search (vector similarity) ───────────────────────────────────────

export async function search(text, { limit = 10, table = "all" } = {}) {
  const [vec] = await embed(text);
  const tableFilter = table === "all" ? "" : `AND v.ref_table = '${table}'`;

  const oversample = limit * 3;
  const { rows } = await query(
    `WITH candidates AS (
       SELECT v.ref_table, v.ref_id, v.content_preview, v.refs,
              1 - (v.embedding <=> $1::vector) AS similarity
       FROM vec v
       WHERE 1=1 ${tableFilter}
       ORDER BY v.embedding <=> $1::vector
       LIMIT $2
     )
     SELECT c.*,
       CASE
         WHEN c.ref_table = 'facts' THEN
           c.similarity * (1.0 + log(2.0, GREATEST(f.confirm_count, 0) + 1))
         ELSE c.similarity
       END AS score
     FROM candidates c
     LEFT JOIN facts f ON c.ref_table = 'facts' AND c.ref_id = f.id::text
     ORDER BY score DESC
     LIMIT $3`,
    [JSON.stringify(vec), oversample, limit]
  );

  for (const row of rows) {
    const { ref_table, ref_id } = row;
    if (ref_table === "facts") {
      const r = await query("SELECT * FROM facts WHERE id = $1::uuid", [ref_id]);
      row.record = r.rows[0] || null;
    } else if (ref_table === "segments") {
      const r = await query("SELECT * FROM segments WHERE id = $1", [BigInt(ref_id)]);
      row.record = r.rows[0] || null;
    } else if (ref_table === "ts") {
      const r = await query("SELECT * FROM ts WHERE id = $1::uuid", [ref_id]);
      row.record = r.rows[0] || null;
    }
  }
  return rows;
}

// ── Facts CRUD ───────────────────────────────────────────────────────

export async function getFacts(ids) {
  if (ids && ids.length) {
    // Support both full UUIDs and short prefixes (e.g. "e6b111d7" → LIKE 'e6b111d7%')
    const conditions = ids.map((_, i) => `id::text LIKE $${i + 1}`).join(" OR ");
    const params = ids.map(id => id + "%");
    const { rows } = await query(
      `SELECT * FROM facts WHERE ${conditions} ORDER BY updated_at DESC`, params
    );
    return rows;
  }
  const { rows } = await query("SELECT * FROM facts ORDER BY updated_at DESC");
  return rows;
}

export async function addFact({ content, summary, refs = [] }) {
  const { rows } = await query(
    "INSERT INTO facts (content, summary, refs) VALUES ($1, $2, $3) RETURNING *",
    [content, summary, JSON.stringify(refs)]
  );
  const fact = rows[0];
  await embedFact(fact.id, summary);
  return fact;
}

export async function updateFact(id, { content, summary, refs, confirm_count } = {}) {
  const sets = [];
  const params = [id];
  if (content !== undefined) { params.push(content); sets.push(`content = $${params.length}`); }
  if (summary !== undefined) { params.push(summary); sets.push(`summary = $${params.length}`); }
  if (refs !== undefined) { params.push(JSON.stringify(refs)); sets.push(`refs = $${params.length}`); }
  if (confirm_count !== undefined) { params.push(confirm_count); sets.push(`confirm_count = $${params.length}`); }
  sets.push("updated_at = now()");
  const { rows } = await query(
    `UPDATE facts SET ${sets.join(", ")} WHERE id = $1 RETURNING *`, params
  );
  if (!rows.length) return null;
  const s = summary ?? rows[0].summary;
  await embedFact(id, s);
  return rows[0];
}

export async function deleteFact(id) {
  await query("DELETE FROM vec WHERE ref_table = 'facts' AND ref_id = $1::text", [id]);
  const { rowCount } = await query("DELETE FROM facts WHERE id = $1", [id]);
  return { deleted: !!rowCount };
}

export async function confirmFact(id) {
  const { rows } = await query(
    "UPDATE facts SET confirm_count = confirm_count + 1, updated_at = now() WHERE id = $1 RETURNING *",
    [id]
  );
  if (!rows.length) return null;
  await embedFact(id, rows[0].summary);
  return rows[0];
}

async function embedFact(id, summary) {
  const [vec] = await embed(summary.slice(0, 500));
  await query("DELETE FROM vec WHERE ref_table = 'facts' AND ref_id = $1::text", [id]);
  await query(
    `INSERT INTO vec (ref_table, ref_id, content_preview, embedding, refs)
     VALUES ('facts', $1::text, $2, $3::vector, '[]')`,
    [id, summary.slice(0, 200), JSON.stringify(vec)]
  );
}

// ── Segments CRUD ────────────────────────────────────────────────────

export async function getSegment(id) {
  const { rows } = await query("SELECT * FROM segments WHERE id = $1", [BigInt(id)]);
  return rows[0] || null;
}

export async function listSegments({ status, limit = 50, offset = 0 } = {}) {
  let sql = "SELECT * FROM segments WHERE 1=1";
  const params = [];
  if (status) { params.push(status); sql += ` AND status = $${params.length}`; }
  params.push(limit); sql += ` ORDER BY started_at DESC LIMIT $${params.length}`;
  params.push(offset); sql += ` OFFSET $${params.length}`;
  const { rows } = await query(sql, params);
  return rows;
}

export async function getSegmentEvents(segmentId, { offset = 0, limit = 100 } = {}) {
  const { rows } = await query(
    "SELECT * FROM ts WHERE segment_id = $1 ORDER BY ts ASC LIMIT $2 OFFSET $3",
    [BigInt(segmentId), limit, offset]
  );
  return rows;
}

export async function updateSegment(id, { title, abstract, status } = {}) {
  const sets = [];
  const params = [BigInt(id)];
  if (title !== undefined) { params.push(title); sets.push(`title = $${params.length}`); }
  if (abstract !== undefined) { params.push(abstract); sets.push(`abstract = $${params.length}`); }
  if (status !== undefined) { params.push(status); sets.push(`status = $${params.length}`); }
  if (!sets.length) return getSegment(id);
  sets.push("updated_at = now()");
  const { rows } = await query(
    `UPDATE segments SET ${sets.join(", ")} WHERE id = $1 RETURNING *`, params
  );
  return rows[0] || null;
}

export async function getEarliestClosedSegment() {
  const { rows } = await query(
    "SELECT * FROM segments WHERE status = 'closed' ORDER BY started_at ASC LIMIT 1"
  );
  return rows[0] || null;
}

/**
 * Embed segment title+abstract as individual sentences into vec.
 * Deletes old segment vec records first.
 */
export async function embedSegmentSentences(segmentId, title, abstract) {
  const idStr = String(segmentId);
  await query("DELETE FROM vec WHERE ref_table = 'segments' AND ref_id = $1", [idStr]);

  const sentences = [
    ...(title ? splitSentences(title) : []),
    ...(abstract ? splitSentences(abstract) : []),
  ];
  if (!sentences.length) return;

  const refs = JSON.stringify([{ type: "segment", id: segmentId }]);
  const BATCH = 32;
  for (let i = 0; i < sentences.length; i += BATCH) {
    const batch = sentences.slice(i, i + BATCH);
    const vecs = await embed(batch);
    for (let j = 0; j < batch.length; j++) {
      await query(
        `INSERT INTO vec (ref_table, ref_id, content_preview, embedding, refs)
         VALUES ('segments', $1, $2, $3::vector, $4)`,
        [idStr, batch[j].slice(0, 200), JSON.stringify(vecs[j]), refs]
      );
    }
  }
}

// ── Stats ────────────────────────────────────────────────────────────

export { dbEnd as end };

export async function stats() {
  const res = {};
  for (const tbl of ["ts", "facts", "segments", "vec"]) {
    const { rows } = await query(`SELECT count(*)::int AS count FROM ${tbl}`);
    res[tbl] = rows[0].count;
  }
  for (const status of ["open", "closed", "dreamed"]) {
    const { rows } = await query(
      "SELECT count(*)::int AS count FROM segments WHERE status = $1", [status]
    );
    res[status] = rows[0].count;
  }
  return res;
}
