# claude-savings

**The #1 token waste in Claude Code isn't verbose output — it's Claude re-reading files it already has in context.**

We measured 107 real sessions and found that duplicate file reads waste **more tokens than all verbose bash/grep/web output combined**. No other tool catches this — and we don't just warn about it, we **block it before it happens**.

claude-savings is a two-hook system for Claude Code: a PreToolUse hook that blocks duplicate reads, and a PostToolUse hook for output compression and loop detection. Two files, zero dependencies, ~580k tokens saved per week — measured, not estimated.

![demo](https://vhs.charm.sh/vhs-XbmoXiyGHgFy0WwjYYjis.gif)

## Real impact

Measured from 107 real Claude Code sessions (7 days):

```
  SAVINGS BREAKDOWN
  ─────────────────────────────────────────────────────
  Strategy                  Instances    Tokens saved/week
  ─────────────────────────────────────────────────────
  Duplicate read blocking       309          ~316,000
  Output compression            287          ~264,000
  Loop detection                  —          (insurance)
  ─────────────────────────────────────────────────────
  TOTAL                                      ~580,000
  Per month                               ~2,317,000
```

Run the benchmark on your own sessions:

```bash
node benchmark.mjs
```

## Three savings strategies

### 1. Duplicate Read blocking — the big one (~316k tokens/week)

Claude re-reads files it already has in context. A lot. We measured **309 duplicate reads per week** in normal usage. Each one adds the full file content to the conversation again — completely wasted tokens.

Other tools warn about this. We **block it**.

```
  Claude tries to Read src/auth.ts (already read 40 turns ago)
  ┌──────────────────────────────────────────────────────┐
  │  BLOCKED by claude-savings                           │
  │                                                      │
  │  src/auth.ts was already read in this session with   │
  │  the same parameters. The file content is already    │
  │  in your conversation context — scroll up to find    │
  │  it.                                                 │
  └──────────────────────────────────────────────────────┘
  → Zero tokens wasted. Claude uses the content already in context.
```

How it works:
- **PreToolUse hook** intercepts Read calls before they execute
- Tracks which files were read per session (with offset/limit params)
- Exact same read = **blocked** with `decision: "block"`
- Different offset/limit = allowed (intentional partial re-reads)
- State stored in `~/.claude-savings/read-cache.json`

> **Why not compress Read output instead?** We tested it. 94% of edits to large files target the middle — exactly the part compression would strip. Compressing Read would cause Claude to hallucinate or fail on nearly every edit. We measured this against 316 real Read→Edit sequences. Blocking duplicates is the right approach — it saves the same tokens without breaking anything.

### 2. Output compression (77% average reduction, ~264k tokens/week)

PostToolUse hook that compresses verbose output from Bash, Grep, Glob, WebFetch, and WebSearch:

| Tool | Strategy | What's kept | What's stripped |
|---|---|---|---|
| **Bash** | Strip noise, collapse stack traces | Errors, warnings, app-level frames | Progress bars, repeated lines, node_modules frames |
| **Grep** | Truncate matches | First 15 + last 5, total count | Excess matches beyond 30 |
| **Glob** | Truncate file lists | First 20 files, total count | Excess files beyond 30 |
| **WebFetch** | Strip HTML, truncate | Text content, head + tail | `<script>`, `<style>`, HTML tags |
| **WebSearch** | Truncate results | First 30 results | Excess results |

Smart stack trace handling — collapses `node_modules` and `internal/` frames:

```
  Before (30 lines):                 After (5 lines):
  TypeError: Cannot read 'id'       TypeError: Cannot read 'id'
    at getUserProfile (users.ts:47)    at getUserProfile (users.ts:47)
    at processAuth (auth.ts:12)        at processAuth (auth.ts:12)
    at Layer.handle (node_modules/     (+ 28 framework frames hidden)
      express/lib/router/layer.js)   Process exited with code 1
    ... 25 more node_modules lines
  Process exited with code 1
```

### 3. Loop detection (prevents 10-50k tokens per incident)

Detects when Claude repeats the same tool call 3+ times with identical input and output:

```
  [savings: LOOP DETECTED] "npm test" has produced the same result 3 times.
  This is wasting tokens. Stop and try a different approach.
```

Rare in normal usage (0 times in our 107-session benchmark), but when it fires it prevents the worst token waste — Claude retrying a command that will never succeed.

## Cost savings

### Per developer

| Model | Tokens saved/month | Cost saved/month |
|---|---|---|
| Claude Sonnet 4.6 | ~2.3M | **$6.95** |
| Claude Opus 4.6 | ~2.3M | **$34.76** |

### At scale

| Team size | Model | Cost saved/month | Cost saved/year |
|---|---|---|---|
| 10 devs | Sonnet | $70 | **$834** |
| 10 devs | Opus | $348 | **$4,171** |
| 50 devs | Opus | $1,738 | **$20,856** |
| 200 devs | Opus | $6,952 | **$83,424** |

> Based on measured data: ~580k tokens saved per dev per week (316k from blocked duplicate reads + 264k from compression).

### How this makes Claude Code faster

Less context = faster responses. Every token saved from a duplicate read or compressed output is one fewer token re-processed on every subsequent turn:

```
  Turn 5:  Claude reads auth.ts (4,000 chars / 1,000 tokens)
  Turn 30: Claude tries to re-read auth.ts
           → BLOCKED. Zero tokens added.
           Without blocking: 1,000 tokens × 50 remaining turns = 50,000 tokens wasted
```

Effects:
- **Faster time-to-first-token** — less input per turn
- **Delayed compaction** — sessions last longer before Claude "forgets" earlier work
- **Better prompt cache hits** — stable context = more cache reuse (10x cheaper)
- **Lower rate limit pressure** — fewer tokens per request

## Why this over alternatives

| | claude-savings | [contextzip](https://github.com/jee599/contextzip) | [clauditor](https://github.com/IyadhKhalfallah/clauditor) |
|---|---|---|---|
| **Blocks duplicate reads** | **Yes (PreToolUse)** | No | No |
| **Output compression** | Bash, Grep, Glob, WebFetch, WebSearch | CLI output only | Bash output only |
| **Loop detection** | Yes (3+ identical calls) | No | Yes (Stop hook) |
| **Stack trace dedup** | Collapses framework frames | Collapses framework frames | No |
| **Install** | Copy 2 files | `npx` or `cargo install` | `npm install -g` |
| **Dependencies** | None | Rust binary + `jq` | 5 npm packages |
| **Size** | 2 files, ~350 lines | Full CLI + 6 filters | 31 files, TUI, daemon |

**Our edge:** We block the #1 token waste that nobody else addresses. Duplicate reads waste more tokens than all verbose output combined — and we're the only tool that prevents them.

## Install

```bash
# One-line install
curl -fsSL https://raw.githubusercontent.com/Cyvid7-Darus10/claude-savings/main/install.sh | bash
```

Or manually:

```bash
# Download both hooks
mkdir -p ~/.claude/hooks
curl -o ~/.claude/hooks/pre-read.mjs \
  https://raw.githubusercontent.com/Cyvid7-Darus10/claude-savings/main/pre-read.mjs
curl -o ~/.claude/hooks/compress.mjs \
  https://raw.githubusercontent.com/Cyvid7-Darus10/claude-savings/main/compress.mjs
```

Add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Read",
        "hooks": [
          {
            "type": "command",
            "command": "node \"$HOME/.claude/hooks/pre-read.mjs\""
          }
        ]
      }
    ],
    "PostToolUse": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node \"$HOME/.claude/hooks/compress.mjs\""
          }
        ]
      }
    ]
  }
}
```

No dependencies, no build step. Requires Node.js 20+.

## Tests

```bash
node compress.test.mjs
```

```
── Output Compression ──
  ✓ Bash: compresses npm install, preserves errors, collapses stack traces
  ✓ Grep / Glob / WebFetch / WebSearch compression
  ✓ Read: never compressed  |  Edit/Write/Agent: never compressed

── Loop Detection ──
  ✓ warns on 3rd identical call, resets on change

── Duplicate Read Blocking (PreToolUse) ──
  ✓ allows first read
  ✓ blocks second read with same params
  ✓ allows re-read with different offset/limit
  ✓ passes through non-Read tools

20 passed, 0 failed
```

## Configuration

Edit constants at the top of each file:

**compress.mjs** (PostToolUse):

| Constant | Default | Description |
|---|---|---|
| `MAX_CHARS` | 2000 | Maximum compressed output size |
| `MIN_CHARS` | 500 | Output shorter than this passes through |
| `LOOP_THRESHOLD` | 3 | Identical calls before loop warning |

**pre-read.mjs** (PreToolUse):

Blocks any Read with identical `file_path` + `offset` + `limit` within the same session. State stored in `~/.claude-savings/read-cache.json`.

## License

MIT
