#!/usr/bin/env node
/**
 * memory web — simple web UI to browse memory data (facts, segments, search).
 */
import { createServer } from "http";
import { query } from "./lib/db.mjs";

const HTML = `<!DOCTYPE html>
<html lang="zh">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Memory Browser</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, "Segoe UI", Roboto, monospace; background: #0d1117; color: #c9d1d9; padding: 16px; }
  h1 { color: #58a6ff; margin-bottom: 12px; font-size: 20px; }
  .tabs { display: flex; gap: 4px; margin-bottom: 12px; flex-wrap: wrap; }
  .tab { padding: 6px 14px; border: 1px solid #30363d; background: #161b22; color: #8b949e; border-radius: 6px; cursor: pointer; font-size: 13px; }
  .tab.active { background: #1f6feb; color: #fff; border-color: #1f6feb; }
  .stats { display: flex; gap: 12px; margin-bottom: 12px; flex-wrap: wrap; }
  .stat { background: #161b22; border: 1px solid #30363d; border-radius: 6px; padding: 8px 14px; }
  .stat .n { font-size: 22px; font-weight: bold; color: #58a6ff; }
  .stat .l { font-size: 11px; color: #8b949e; }
  .search-bar { display: flex; gap: 8px; margin-bottom: 12px; }
  .search-bar input { flex: 1; padding: 6px 10px; background: #0d1117; border: 1px solid #30363d; border-radius: 6px; color: #c9d1d9; font-size: 13px; }
  .search-bar button { padding: 6px 14px; background: #238636; border: none; border-radius: 6px; color: #fff; cursor: pointer; font-size: 13px; }
  table { width: 100%; border-collapse: collapse; font-size: 12px; }
  th { text-align: left; padding: 6px 8px; background: #161b22; color: #8b949e; border-bottom: 1px solid #30363d; position: sticky; top: 0; }
  td { padding: 6px 8px; border-bottom: 1px solid #21262d; vertical-align: top; max-width: 600px; word-break: break-word; }
  tr:hover td { background: #161b22; }
  .json { white-space: pre-wrap; font-size: 11px; color: #7ee787; max-height: 200px; overflow-y: auto; }
  .ref { color: #d2a8ff; font-size: 11px; }
  .time { color: #8b949e; font-size: 11px; white-space: nowrap; }
  .confirm { background: #1f6feb33; color: #58a6ff; padding: 1px 6px; border-radius: 10px; font-size: 11px; }
  .badge { padding: 1px 8px; border-radius: 10px; font-size: 11px; font-weight: bold; }
  .badge-open    { background: #1a4a1a; color: #3fb950; }
  .badge-closed  { background: #4a3a00; color: #d29922; }
  .badge-dreamed { background: #1a2a4a; color: #58a6ff; }
  .abstract { color: #8b949e; font-size: 11px; white-space: pre-wrap; max-height: 80px; overflow-y: auto; }
  .pagination { margin-top: 12px; display: flex; gap: 8px; align-items: center; }
  .pagination button { padding: 4px 12px; background: #21262d; border: 1px solid #30363d; border-radius: 6px; color: #c9d1d9; cursor: pointer; }
  .pagination button:disabled { opacity: 0.3; cursor: default; }
  #content { min-height: 300px; }
  .empty { color: #8b949e; padding: 40px; text-align: center; }
</style>
</head>
<body>
<h1>🧠 Memory Browser</h1>
<div class="stats" id="stats"></div>
<div class="tabs">
  <div class="tab active" data-tab="facts">Facts</div>
  <div class="tab" data-tab="segments">Segments</div>
  <div class="tab" data-tab="search">Search</div>
</div>
<div id="search-area" style="display:none">
  <div class="search-bar">
    <input id="search-input" placeholder="语义搜索..." />
    <button onclick="doSearch()">Search</button>
  </div>
</div>
<div id="content"></div>
<div class="pagination" id="pagination" style="display:none">
  <button id="prev-btn" onclick="prevPage()">← Prev</button>
  <span id="page-info"></span>
  <button id="next-btn" onclick="nextPage()">Next →</button>
</div>

<script>
let currentTab = 'facts';
let page = 0;
const PAGE_SIZE = 50;

document.querySelectorAll('.tab').forEach(t => {
  t.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(x => x.classList.remove('active'));
    t.classList.add('active');
    currentTab = t.dataset.tab;
    page = 0;
    document.getElementById('search-area').style.display = currentTab === 'search' ? '' : 'none';
    if (currentTab === 'search') {
      document.getElementById('content').innerHTML = '<div class="empty">输入关键词搜索</div>';
      document.getElementById('pagination').style.display = 'none';
    } else {
      loadTab();
    }
  });
});

async function api(path) {
  const r = await fetch('/api/' + path);
  return r.json();
}

async function loadStats() {
  const s = await api('stats');
  const keys = ['ts','facts','segments','vec','open','closed','dreamed'];
  document.getElementById('stats').innerHTML =
    keys.filter(k => s[k] !== undefined).map(k =>
      '<div class="stat"><div class="n">' + s[k] + '</div><div class="l">' + k + '</div></div>'
    ).join('');
}

function fmtTime(t) {
  if (!t) return '';
  return new Date(t).toLocaleString('zh-CN', {month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
}

function esc(s) {
  if (s == null) return '';
  return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;');
}

function md(s) {
  if (s == null) return '';
  let h = esc(s);
  h = h.replace(/^### (.+)$/gm, '<strong style="font-size:13px">$1</strong>');
  h = h.replace(/^## (.+)$/gm, '<strong style="font-size:14px">$1</strong>');
  h = h.replace(/^# (.+)$/gm, '<strong style="font-size:15px">$1</strong>');
  h = h.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');
  var bt = String.fromCharCode(96);
  h = h.replace(new RegExp(bt + '([^' + bt + ']+)' + bt, 'g'), '<code style="background:#1c2129;padding:1px 4px;border-radius:3px">$1</code>');
  h = h.replace(/^- (.+)$/gm, '&bull; $1');
  h = h.replace(/\\n/g, '<br>');
  return h;
}

function renderFacts(rows) {
  if (!rows.length) return '<div class="empty">No facts</div>';
  return '<table><tr><th>Summary</th><th>Content</th><th>Refs</th><th>Confirm</th><th>Updated</th></tr>' +
    rows.map(r => '<tr>' +
      '<td>' + esc(r.summary) + '</td>' +
      '<td><div class="json">' + md(r.content) + '</div></td>' +
      '<td class="ref">' + (r.refs||[]).map(ref => esc(ref.type + ':' + (ref.id||'').toString().slice(0,10))).join('<br>') + '</td>' +
      '<td>' + (r.confirm_count ? '<span class="confirm">×' + r.confirm_count + '</span>' : '') + '</td>' +
      '<td class="time">' + fmtTime(r.updated_at) + '</td>' +
    '</tr>').join('') + '</table>';
}

function fmtDuration(sec) {
  if (!sec) return '—';
  if (sec < 60) return sec + 's';
  if (sec < 3600) return Math.round(sec/60) + 'min';
  return (sec/3600).toFixed(1) + 'h';
}

function renderSegments(rows) {
  if (!rows.length) return '<div class="empty">No segments</div>';
  return '<table><tr><th>ID</th><th>Status</th><th>Title</th><th>Events</th><th>Duration</th><th>Started</th><th>Abstract</th></tr>' +
    rows.map(r => '<tr>' +
      '<td class="time">' + esc(r.id) + '</td>' +
      '<td><span class="badge badge-' + r.status + '">' + r.status + '</span></td>' +
      '<td>' + esc(r.title || '') + '</td>' +
      '<td>' + r.event_count + '</td>' +
      '<td class="time">' + fmtDuration(r.duration) + '</td>' +
      '<td class="time">' + fmtTime(r.started_at) + '</td>' +
      '<td><div class="abstract">' + esc((r.abstract||'').slice(0, 300)) + '</div></td>' +
    '</tr>').join('') + '</table>';
}

function renderSearch(rows) {
  if (!rows.length) return '<div class="empty">No results</div>';
  return '<table><tr><th>Score</th><th>Table</th><th>Preview</th><th>Record</th></tr>' +
    rows.map(r => '<tr>' +
      '<td>' + (r.score||r.similarity||0).toFixed(3) + '</td>' +
      '<td>' + esc(r.ref_table) + '</td>' +
      '<td>' + esc(r.content_preview) + '</td>' +
      '<td><div class="json">' + esc(JSON.stringify(r.record, null, 1)?.slice(0,500)) + '</div></td>' +
    '</tr>').join('') + '</table>';
}

async function loadTab() {
  const el = document.getElementById('content');
  el.innerHTML = '<div class="empty">Loading...</div>';

  if (currentTab === 'facts') {
    const rows = await api('facts?offset=' + (page * PAGE_SIZE) + '&limit=' + PAGE_SIZE);
    el.innerHTML = renderFacts(rows);
    updatePagination(rows.length);
  } else if (currentTab === 'segments') {
    const rows = await api('segments?offset=' + (page * PAGE_SIZE) + '&limit=' + PAGE_SIZE);
    el.innerHTML = renderSegments(rows);
    updatePagination(rows.length);
  }
}

async function doSearch() {
  const q = document.getElementById('search-input').value.trim();
  if (!q) return;
  const el = document.getElementById('content');
  el.innerHTML = '<div class="empty">Searching...</div>';
  document.getElementById('pagination').style.display = 'none';
  const rows = await api('search?q=' + encodeURIComponent(q));
  el.innerHTML = renderSearch(rows);
}

document.getElementById('search-input')?.addEventListener('keydown', e => { if (e.key === 'Enter') doSearch(); });

function updatePagination(count) {
  const pag = document.getElementById('pagination');
  pag.style.display = '';
  document.getElementById('prev-btn').disabled = page === 0;
  document.getElementById('next-btn').disabled = count < PAGE_SIZE;
  document.getElementById('page-info').textContent = 'Page ' + (page + 1);
}

function prevPage() { if (page > 0) { page--; loadTab(); } }
function nextPage() { page++; loadTab(); }

loadStats();
loadTab();
</script>
</body>
</html>`;

// ── API routes ───────────────────────────────────────────────────────

async function handleAPI(path, params) {
  const limit = Math.min(Number(params.get("limit") || 50), 200);
  const offset = Number(params.get("offset") || 0);

  if (path === "stats") {
    const res = {};
    for (const tbl of ["ts", "facts", "segments", "vec"]) {
      const { rows } = await query(`SELECT count(*)::int AS count FROM ${tbl}`);
      res[tbl] = rows[0].count;
    }
    for (const status of ["open", "closed", "dreamed"]) {
      const { rows } = await query("SELECT count(*)::int AS count FROM segments WHERE status = $1", [status]);
      res[status] = rows[0].count;
    }
    return res;
  }

  if (path === "facts") {
    const { rows } = await query(
      "SELECT * FROM facts ORDER BY updated_at DESC LIMIT $1 OFFSET $2", [limit, offset]
    );
    return rows;
  }

  if (path === "segments") {
    const { rows } = await query(
      "SELECT * FROM segments ORDER BY started_at DESC LIMIT $1 OFFSET $2", [limit, offset]
    );
    return rows;
  }

  if (path === "search") {
    const q = params.get("q");
    if (!q) return [];
    const { embed } = await import("./lib/embed.mjs");
    const [vec] = await embed(q);
    const { rows } = await query(
      `WITH candidates AS (
         SELECT v.ref_table, v.ref_id, v.content_preview, v.refs,
                1 - (v.embedding <=> $1::vector) AS similarity
         FROM vec v
         ORDER BY v.embedding <=> $1::vector
         LIMIT 20
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
       LIMIT 20`,
      [JSON.stringify(vec)]
    );
    for (const row of rows) {
      if (row.ref_table === "facts") {
        const r = await query("SELECT * FROM facts WHERE id = $1", [row.ref_id]);
        row.record = r.rows[0] || null;
      } else if (row.ref_table === "segments") {
        const r = await query("SELECT * FROM segments WHERE id = $1", [BigInt(row.ref_id)]);
        row.record = r.rows[0] || null;
      } else if (row.ref_table === "ts") {
        const r = await query("SELECT * FROM ts WHERE id = $1", [row.ref_id]);
        row.record = r.rows[0] || null;
      }
    }
    return rows;
  }

  return { error: "not found" };
}

// ── Server ───────────────────────────────────────────────────────────

export const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  if (url.pathname.startsWith("/api/")) {
    const apiPath = url.pathname.slice(5);
    try {
      const data = await handleAPI(apiPath, url.searchParams);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
  res.end(HTML);
});
