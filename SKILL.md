---
name: memory
description: Memory is all you need. A semantic memory system supporting temporal records, structured facts, and conversation segments.
---

# Memory — 语义记忆系统 v3

基于 PostgreSQL (pgvector) 的三层记忆系统，支持语义搜索。会话按 1 小时间隔自动切分为 Segment，以 Segment 为 dream 处理单元。

## ⚠️ 调用规则（强制）

1. **必须通过 `memory` CLI 调用**，禁止直接执行 `node *.mjs` 或导入 JS 模块。`memory` wrapper 脚本自动设置 CUDA 路径等环境变量。
2. **所有读取操作必须加 `--json` 标志**，获取完整的 JSON 结构化数据。默认输出是为人类阅读设计的表格（内容会被截断），不适合程序处理。
3. **mutation 操作**（`facts add/update/delete`）始终输出完整 JSON，无需 `--json`。

## 架构

```
对话事件 (JSONL)
    ↓ memory index
ts 表（时序事件流）──→ vec 表（BGE-M3 向量，1024维，HNSW索引）
segments 表（会话片段）↑ 按句分词索引
facts 表（提炼的知识）──→ vec 表
```

**数据流：**
```
~/.claude/projects/**/*.jsonl           ──┐
~/.copilot/session-state/*/events.jsonl ──┤ memory index → ts + segments + vec
                                          ↓
                              memory dream → facts (via DeepSeek)
```

## Segment 生命周期

```
open  →  closed  →  dreamed
 ↑           ↑
新事件进来    最后事件 >1小时前
```

- **open**：仍在接收事件
- **closed**：已结束，待 dream 处理（最后事件 >1小时前，且 ≥5条事件、持续 ≥5分钟）
- **dreamed**：已提炼为 abstract + facts

不足 5 条事件或持续不足 5 分钟的 segment 自动删除（视为无效片段）。

## CLI 用法

### 语义搜索

```bash
# ✅ 正确：加 --json 获取完整结构化结果
memory search <query> [--limit N] [--table ts|facts|segments] --json

# ❌ 错误：不加 --json，输出被截断的表格
memory search <query>
```

### Facts 操作

```bash
# 查询（必须加 --json）
memory facts --json                           # 列出所有 facts
memory facts <id前缀> [id前缀...] --json      # 按 ID 或 ID 前缀获取（支持缩写，如 e6b111d7）

# 写入（始终输出完整 JSON）
memory facts add '{"content":"...","summary":"...","refs":[...]}'
memory facts update <id> '{"summary":"新摘要"}'
memory facts delete <id>
memory facts confirm <id>                     # 确认一个 fact 仍然有效
```

### Segment 操作

```bash
# 列表（必须加 --json）
memory segment list --json
memory segment list --status closed --limit 10 --json

# 详情（必须加 --json）
memory segment <id> --json

# 事件流（必须加 --json）
memory segment <id> events --limit 50 --json
memory segment <id> events --offset 100 --limit 50 --json

# 更新（始终输出完整 JSON）
memory segment update <id> --title "标题" --abstract "摘要"
```

### 自动化

```bash
memory index [--watch] [--max N] [--no-embed]   # 采集事件 → ts + segments + vec
memory dream [--all]                             # dream 最早 closed segment（--all: 全部）
```

### 管理

```bash
memory init      # 初始化数据库（幂等，可重复执行）
memory health    # 检查 PG 连接
memory stats     # 各表记录数
memory clear     # 删除所有表（危险！）
memory web       # 启动 Web 浏览界面（http://localhost:3456）
```

## 嵌入过滤规则

| 类型 | 最小长度 | 行为 |
|---|---|---|
| user.message | 20 字符 | 短于此不建 vec 索引 |
| assistant.message | 30 字符 | 短于此不建 vec 索引 |
| segment abstract | 按句切分 | 每句单独嵌入一条 vec |
| fact summary | 全文 | 每个 fact 一条 vec |

## 数据库表

| 表 | 说明 |
|---|---|
| `ts` | 原始事件流，含 segment_id 外键 |
| `segments` | 会话片段（id=unix秒，open/closed/dreamed） |
| `facts` | 提炼的原子知识，含 refs 指向 segment |
| `vec` | BGE-M3 向量索引（ref_table: ts/facts/segments，ref_id: TEXT） |

## Node.js API（仅供系统内部使用）

> 外部 skill 禁止直接导入，必须通过 CLI。

```javascript
import {
  search, getFacts, addFact, updateFact, deleteFact, confirmFact,
  getSegment, listSegments, getSegmentEvents, updateSegment,
  getEarliestClosedSegment, embedSegmentSentences,
  health, init, stats,
} from "/home/emma/.claude/skills/memory/lib/ops.mjs";

// 语义搜索
const results = await search("用户的技术栈偏好", { limit: 5 });

// Facts CRUD
await addFact({ content: "...", summary: "用户偏好 TypeScript" });
await updateFact(id, { summary: "更新摘要" });
await confirmFact(id);
await deleteFact(id);

// Segment 查询
const seg = await getSegment(1745000000);
const segs = await listSegments({ status: "closed", limit: 10 });
const events = await getSegmentEvents(1745000000, { offset: 0, limit: 50 });
await updateSegment(1745000000, { title: "重构讨论", abstract: "..." });
```

## 配置

- **PG 连接**：自动从 vault 获取密码（key: `memory_pg_password`）
- **嵌入模型**：BGE-M3 fp32 via Transformers.js，优先 CUDA，失败回退 CPU
- **Dream LLM**：DeepSeek Reasoner（vault: `deepseek_key`）
- **状态文件**：`~/.copilot/.memory-index-state.json`（记录文件偏移量）
