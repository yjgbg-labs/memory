#!/usr/bin/env node
/**
 * dream — segment-based knowledge extraction.
 *
 * Phase 1 (Digest):  Summarize all events in the segment into an abstract.
 * Phase 2 (Extract): Agent uses the abstract to update facts in the DB.
 *
 * Usage:
 *   node dream.mjs          # dream the earliest closed segment
 *   node dream.mjs --all    # loop through all closed segments in order
 */
import { query } from "./lib/db.mjs";
import { embed } from "./lib/embed.mjs";
import {
  search, getFacts,
  addFact, updateFact, deleteFact, confirmFact,
  getEarliestClosedSegment, getSegmentEvents,
  updateSegment, embedSegmentSentences,
} from "./lib/ops.mjs";

const DIGEST_CHUNK_SIZE = 2000;
const EXTRACT_MAX_TURNS = 30;

// ── LLM config ───────────────────────────────────────────────────────

async function getLLMConfig() {
  const base = process.env.DREAM_API_BASE || "https://api.deepseek.com/v1";
  const model = process.env.DREAM_MODEL || "deepseek-reasoner";
  let key = process.env.DREAM_API_KEY;
  if (!key) {
    try {
      const res = await fetch("http://10.0.0.1/cgi-bin/kv-get?key=deepseek_key");
      if (res.ok) key = (await res.text()).trim();
    } catch {}
  }
  if (!key) throw new Error("No LLM API key — set DREAM_API_KEY or vault deepseek_key");
  return { base, model, key };
}

async function callLLM(messages, config, { tools, maxTokens = 4096, verbose = false } = {}) {
  const body = { model: config.model, messages, temperature: 0.3, max_tokens: maxTokens };
  if (tools) body.tools = tools;
  const res = await fetch(`${config.base}/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${config.key}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`LLM API error ${res.status}: ${await res.text()}`);
  const data = await res.json();

  if (verbose) {
    const msg = data.choices?.[0]?.message;
    if (msg?.reasoning_content) {
      process.stderr.write(`\n[think]\n${msg.reasoning_content}\n[/think]\n`);
    }
    if (msg?.content) {
      process.stderr.write(`\n[text]\n${msg.content}\n[/text]\n`);
    }
  }

  return data;
}

// ── Phase 0: Title ───────────────────────────────────────────────────

async function generateTitle(abstract, config, verbose = false) {
  // Use a non-reasoning model for title generation (cheaper, faster)
  const titleConfig = { ...config, model: "deepseek-chat" };
  const messages = [
    {
      role: "system",
      content: "根据以下会话摘要，生成一个简洁的中文标题（不超过20个字）。直接输出标题，不加任何前缀、引号或标点。",
    },
    { role: "user", content: abstract.slice(0, 2000) },
  ];
  const data = await callLLM(messages, titleConfig, { maxTokens: 100, verbose });
  return (data.choices?.[0]?.message?.content || "").trim().slice(0, 40);
}

// ── Phase 1: Digest ──────────────────────────────────────────────────

const DIGEST_SYSTEM_FIRST = `You are summarizing conversation logs into a structured digest.

Extract information valuable for future memory:
- Topics discussed, decisions made, technical details
- Problems encountered, outcomes, user preferences
- Environment info (tools, versions, paths)

**语言要求（强制）**：必须用中文输出摘要，技术术语（命令名、文件路径、代码片段）保持原文。Be thorough — do not drop important details.`;

const DIGEST_SYSTEM_BASE = `You are performing a REDUCE operation on conversation logs to build a cumulative digest.

Rules:
1. You receive NEW events in the user message. Summarize ONLY these new events.
2. Append your summary semantically to the existing digest — do NOT rewrite or compress it.
3. If the new events are mostly noise, return the existing digest unchanged.
4. Be thorough with new content.
5. **语言要求（强制）**：必须用中文输出，技术术语保持原文。`;

function formatEventsForDigest(events) {
  return events.map((e) => {
    const time = new Date(e.ts).toISOString().slice(0, 16);
    return `[${time}] [${e.event_type}] ${e.content.slice(0, 1500)}`;
  }).join("\n");
}

async function digestEvents(events, segmentId, config, verbose = false) {
  let digest = null;
  const totalChunks = Math.ceil(events.length / DIGEST_CHUNK_SIZE);

  for (let i = 0; i < events.length; i += DIGEST_CHUNK_SIZE) {
    const chunk = events.slice(i, i + DIGEST_CHUNK_SIZE);
    const chunkNum = Math.floor(i / DIGEST_CHUNK_SIZE) + 1;
    process.stderr.write(`[dream] digest chunk ${chunkNum}/${totalChunks}: ${chunk.length} events\n`);

    const eventsText = formatEventsForDigest(chunk);
    let messages;
    if (!digest) {
      messages = [
        { role: "system", content: DIGEST_SYSTEM_FIRST },
        { role: "user", content: `Events from segment ${segmentId} (chunk ${chunkNum}/${totalChunks}):\n\n${eventsText}` },
      ];
    } else {
      messages = [
        { role: "system", content: `${DIGEST_SYSTEM_BASE}\n\n## Existing digest (DO NOT rewrite — only append)\n\n${digest}` },
        { role: "user", content: `New events (chunk ${chunkNum}/${totalChunks}):\n\n${eventsText}\n\nAppend new content to the digest. If these are noise, return the existing digest unchanged.` },
      ];
    }

    const data = await callLLM(messages, config, { maxTokens: 16384, verbose });
    digest = data.choices?.[0]?.message?.content || digest;
    process.stderr.write(`[dream] digest ${chunkNum}: ${(digest || "").length} chars\n`);
  }

  return digest;
}

// ── Phase 2: Extract ─────────────────────────────────────────────────

const EXTRACT_SYSTEM = `You are a memory consolidation agent. You receive a digest of a conversation segment. Search existing memory, then extract / update / delete / confirm structured facts.

## Fact definition

A fact is a single piece of reusable knowledge. Each fact has:
- **summary**: a dense, keyword-rich sentence used for vector search. It determines whether the fact surfaces in future conversations. Pack it with search terms (concepts, tools, names, categories) without being verbose.
- **content**: markdown detail backing the summary. Can include context, examples, caveats, code snippets.
- **refs**: which segments this knowledge comes from. Every fact MUST have a ref to this segment.

**Good fact**:
  summary: "用户偏好使用 TypeScript strict 模式进行后端开发"
  content: "用户在讨论后端技术栈时表示偏好 TS strict 模式。项目包括 Fastify + Prisma。严格模式开启所有检查。\n\n相关项目: ~/repos/backend-api"

**Bad fact** (vague, useless for search):
  summary: "讨论了一些技术问题"
  content: "用户和助手讨论了关于编程的一些事情。"

## When to use each tool

1. **search_memory**: Always search 2-3 times with different query angles before concluding something is new. Try synonyms, broader/narrower terms, and translations.
2. **update_fact**: A related fact exists but is stale, incomplete, or contradicted. Prefer this over add_fact. Append new refs, don't replace them.
3. **add_fact**: Only after thorough search confirms nothing similar exists. Fact must have future retrieval value.
4. **confirm_fact**: The digest reaffirms an existing fact without change. Just bump confirm_count — don't rewrite it.
5. **delete_fact**: The digest explicitly contradicts a fact, or the fact is proven wrong. Don't hesitate — stale facts poison the memory.

## What to extract

Capture knowledge likely to help future conversations:
- User preferences and conventions (tech stack, coding style, naming, tools)
- Decisions and their rationale
- Environment details (paths, versions, configurations)
- Problems solved and their solutions
- Project architecture and dependencies

Skip: chitchat, temporary debugging, one-off queries with no lasting value, restatements of well-known knowledge.

## Language

All content and summary must be in Chinese. Technical terms (commands, paths, identifiers) stay in original form.`;

const TOOLS = [
  {
    type: "function",
    function: {
      name: "search_memory",
      description: "Semantic vector search across all memory.",
      parameters: {
        type: "object",
        properties: {
          query: { type: "string" },
          limit: { type: "number" },
          table: { type: "string", enum: ["all", "ts", "facts", "segments"] },
        },
        required: ["query"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_facts",
      description: "Get facts by ID list. Omit IDs for all.",
      parameters: { type: "object", properties: { ids: { type: "array", items: { type: "string" } } } },
    },
  },
  {
    type: "function",
    function: {
      name: "add_fact",
      description: "Create a new fact. Search first — prefer update_fact.",
      parameters: {
        type: "object",
        properties: {
          content: { type: "string", description: "Detailed markdown content" },
          summary: { type: "string", description: "One-line summary for embedding" },
          refs: { type: "array", items: { type: "object" } },
        },
        required: ["content", "summary"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "update_fact",
      description: "Update an existing fact. Preferred over add_fact.",
      parameters: {
        type: "object",
        properties: {
          id: { type: "string" },
          content: { type: "string" },
          summary: { type: "string" },
          refs: { type: "array", description: "ALL refs (replaces old)" },
        },
        required: ["id"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "delete_fact",
      description: "Delete a fact.",
      parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    },
  },
  {
    type: "function",
    function: {
      name: "confirm_fact",
      description: "Confirm a fact is still valid. Bumps confirm_count.",
      parameters: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    },
  },
];

async function executeTool(name, args) {
  switch (name) {
    case "search_memory": return search(args.query, { limit: args.limit || 5, table: args.table || "all" });
    case "get_facts": return getFacts(args.ids);
    case "add_fact": return addFact(args);
    case "update_fact": { const { id, ...rest } = args; return updateFact(id, rest); }
    case "delete_fact": return deleteFact(args.id);
    case "confirm_fact": return confirmFact(args.id);
    default: return { error: `Unknown tool: ${name}` };
  }
}

async function extractFromDigest(digest, segment, events, config, verbose = false) {
  const timeRange = events.length
    ? `${new Date(events[0].ts).toISOString()} to ${new Date(events[events.length - 1].ts).toISOString()}`
    : "unknown";

  const messages = [
    { role: "system", content: EXTRACT_SYSTEM },
    {
      role: "user",
      content: `Digest of segment ${segment.id} (${events.length} events, ${timeRange}):\n\n${digest}\n\nSearch existing facts, then extract/update knowledge. Use segment ref: {"type":"segment","id":${segment.id}}`,
    },
  ];

  let turns = 0;
  while (turns < EXTRACT_MAX_TURNS) {
    turns++;
    const data = await callLLM(messages, config, { tools: TOOLS, verbose });
    const choice = data.choices?.[0];
    if (!choice) break;

    const msg = choice.message;
    messages.push(msg);

    if (choice.finish_reason === "tool_calls" || msg.tool_calls?.length) {
      for (const tc of msg.tool_calls) {
        const fnName = tc.function.name;
        let args;
        try { args = JSON.parse(tc.function.arguments); } catch { args = {}; }
        process.stderr.write(`[dream]   tool: ${fnName}(${JSON.stringify(args).slice(0, 100)})\n`);
        let result;
        try { result = await executeTool(fnName, args); } catch (e) { result = { error: e.message }; }
        messages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(result).slice(0, 8000) });
      }
    } else {
      if (msg.content) process.stderr.write(`[dream] extract done: ${msg.content.slice(0, 200)}\n`);
      break;
    }
  }

  if (turns >= EXTRACT_MAX_TURNS) process.stderr.write(`[dream] hit max turns (${EXTRACT_MAX_TURNS})\n`);
}

// ── Dream a single segment ───────────────────────────────────────────

async function dreamSegment(segment, config, verbose = false) {
  process.stderr.write(`[dream] === segment ${segment.id} (${segment.event_count} events) ===\n`);

  const events = await getSegmentEvents(segment.id, { limit: 10000 });
  if (!events.length) {
    process.stderr.write(`[dream] no events — marking dreamed\n`);
    await updateSegment(segment.id, { status: "dreamed" });
    return 0;
  }

  // Phase 1: Digest
  process.stderr.write("[dream] ── Phase 1: Digest ──\n");
  const abstract = await digestEvents(events, segment.id, config, verbose);

  // Generate title from abstract
  const title = await generateTitle(abstract, config, verbose);
  process.stderr.write(`[dream] title: ${title}\n`);

  // Phase 2: Extract facts
  process.stderr.write("[dream] ── Phase 2: Extract ──\n");
  await extractFromDigest(abstract, segment, events, config, verbose);

  // Persist abstract + embed segment sentences
  await updateSegment(segment.id, { title, abstract, status: "dreamed" });
  await embedSegmentSentences(segment.id, title, abstract);

  process.stderr.write(`[dream] done: segment ${segment.id} → dreamed\n`);
  return events.length;
}

// ── Entry point ──────────────────────────────────────────────────────

export async function run({ all = false, verbose = false } = {}) {
  const config = await getLLMConfig();

  if (all) {
    let total = 0;
    let count = 0;
    while (true) {
      const segment = await getEarliestClosedSegment();
      if (!segment) break;
      total += await dreamSegment(segment, config, verbose);
      count++;
    }
    process.stderr.write(`[dream] all done: ${total} events across ${count} segments\n`);
    return total;
  }

  const segment = await getEarliestClosedSegment();
  if (!segment) {
    process.stderr.write("[dream] no closed segments to process\n");
    return 0;
  }
  return dreamSegment(segment, config, verbose);
}

// Direct execution
if (process.argv[1] && import.meta.url.endsWith(process.argv[1].replace(/.*\//, ""))) {
  const args = process.argv.slice(2);
  const all = args.includes("--all");
  const verbose = args.includes("--verbose");
  run({ all, verbose })
    .then(() => process.exit(0))
    .catch((e) => { console.error(e); process.exit(1); });
}
