# Memory — 语义记忆系统 v3

基于 PostgreSQL (pgvector) 的三层记忆系统，支持语义搜索。

## 架构

```
对话事件 (JSONL)
    ↓ memory index
ts 表（时序事件流）──→ vec 表（BGE-M3 向量，1024维，HNSW索引）
segments 表（会话片段）↑ 按句分词索引
facts 表（提炼的知识）──→ vec 表
```

### 数据流

```
~/.claude/projects/**/*.jsonl           ──┐
~/.copilot/session-state/*/events.jsonl ──┤ memory index → ts + segments + vec
                                          ↓
                              memory dream → facts (via DeepSeek)
```

## Segment 生命周期

```
open  →  closed  →  dreamed
```

- **open**：仍在接收事件
- **closed**：最后事件 > 1小时前，≥5条事件 & 持续 ≥5分钟
- **dreamed**：已提炼为 abstract + facts

## 安装

```bash
curl -fsSL https://raw.githubusercontent.com/yjgbg-labs/memory/main/install.sh | bash
```

安装完成后：

```bash
memory init                              # 初始化数据库
memory daemon                            # 启动后台循环（index → dream → sleep）
```

## CLI 用法

### 管理

```bash
memory init                              # 初始化数据库（幂等）
memory health                            # 检查 PG 连接
memory stats                             # 各表记录数
memory clear                             # 删除所有表
memory web [--port N]                    # 启动 Web 界面 (http://localhost:3456)
```

### 语义搜索

```bash
memory search <query> [--limit N] [--table ts|facts|segments] --json
```

### Facts 操作

```bash
memory facts --json                      # 列出所有
memory facts <id前缀> --json              # 按 ID 前缀查询
memory facts add '{"content":"...","summary":"...","refs":[...]}'
memory facts update <id> '{"summary":"..."}'
memory facts delete <id>
memory facts confirm <id>                # 确认 fact 仍有效
```

### Segment 操作

```bash
memory segment list --json
memory segment list --status closed --limit 10 --json
memory segment <id> --json
memory segment <id> events --limit 50 --json
memory segment update <id> --title "标题" --abstract "摘要"
```

### 自动化

```bash
memory index [--watch] [--max N] [--no-embed]
memory dream [--all] [--verbose]
memory daemon                    # 后台循环 index → dream，空闲 30s sleep
```

## 数据库表

| 表 | 说明 |
|---|---|
| `ts` | 原始事件流，含 segment_id 外键 |
| `segments` | 会话片段（id=unix秒） |
| `facts` | 提炼的原子知识，含 refs 指向 segment |
| `vec` | BGE-M3 向量索引（HNSW, cosine） |

## 配置

启动时自动加载 `~/.memoryrc`（已存在的环境变量不会被覆盖）：

```
# ~/.memoryrc
MEMORY_DATABASE_URL=postgres://user:pass@host:5432/memory
DREAM_API_KEY=sk-xxx
DREAM_MODEL=deepseek-reasoner    # 可选
```

| 变量 | 说明 | 示例 |
|---|---|---|
| `MEMORY_DATABASE_URL` | PostgreSQL 连接 | `postgres://memory:pass@10.0.2.0:5432/memory` |
| `DREAM_API_KEY` | DeepSeek API key | `sk-xxx` |
| `DREAM_MODEL` | Dream 模型（可选） | `deepseek-reasoner` |
