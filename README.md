# claude-savings

**The #1 token waste in Claude Code isn't verbose output — it's Claude re-reading files it already has in context.**

We measured 107 real sessions and found that duplicate file reads waste **more tokens than all verbose bash/grep/web output combined**. No other tool catches this.

claude-savings is a single-file Claude Code hook with three savings strategies: output compression, duplicate read prevention, and loop detection. One file, zero dependencies, 580k tokens saved per week — measured, not estimated.

![demo](https://vhs.charm.sh/vhs-XbmoXiyGHgFy0WwjYYjis.gif)

## Real impact

Measured from 107 real Claude Code sessions (7 days):

```
  SAVINGS BREAKDOWN
  ─────────────────────────────────────────────────────
  Strategy              Instances    Tokens saved/week
  ─────────────────────────────────────────────────────
  Output compression        287          ~264,000
  Duplicate read warnings   309          ~316,000
  Loop detection              —          (insurance)
  ─────────────────────────────────────────────────────
  TOTAL                                  ~580,000
  Per month                           ~2,317,000
```

Duplicate reads are the #1 waste — Claude re-reading files already in context adds the full file content to the conversation a second time. This happens ~309 times per week in normal usage.

Run the benchmark on your own sessions:

```bash
node benchmark.mjs
```

## Three savings strategies

### 1. Output compression (77% average reduction)

Compresses verbose output from Bash, Grep, Glob, WebFetch, and WebSearch with per-tool strategies:

| Tool | Strategy | What's kept | What's stripped |
|---|---|---|---|
| **Bash** | Strip noise, collapse stack traces | Errors, warnings, app-level frames | Progress bars, repeated lines, node_modules frames |
| **Grep** | Truncate matches | First 15 + last 5 matches, total count | Excess matches beyond 30 |
| **Glob** | Truncate file lists | First 20 files, total count | Excess files beyond 30 |
| **WebFetch** | Strip HTML, truncate | Text content, first 20 + last 10 lines | `<script>`, `<style>`, HTML tags |
| **WebSearch** | Truncate results | First 30 results | Excess results |

Smart stack trace handling — collapses `node_modules` and `internal/` frames while keeping your application frames:

```
  Before (30 lines):                 After (5 lines):
  TypeError: Cannot read 'id'       TypeError: Cannot read 'id'
    at getUserProfile (users.ts:47)    at getUserProfile (users.ts:47)
    at processAuth (auth.ts:12)        at processAuth (auth.ts:12)
    at Layer.handle (node_modules/     (+ 28 framework frames hidden)
      express/lib/router/layer.js)   Process exited with code 1
    ... 25 more node_modules lines
    ... 3 internal/modules lines
  Process exited with code 1
```

### 2. Duplicate Read detection (~316k tokens/week saved)

Tracks which files Claude has read in each session. When Claude re-reads a file it already has in context, the hook injects a warning:

```
  [savings: DUPLICATE READ] src/auth.ts was already read in this session
  (4.2k chars re-added to context). The file content is already in your
  conversation history. Use Read with offset/limit instead.
```

This warns only once per file (not on 3rd, 4th read) to avoid nagging.

> **Why not compress Read output?** We tested it. 94% of edits to large files target the middle — exactly the part that would be stripped. Compressing Read would cause Claude to hallucinate or fail on nearly every edit. We measured this against 316 real Read→Edit sequences.

### 3. Loop detection (prevents 10-50k tokens per incident)

Detects when Claude repeats the same tool call 3+ times with identical input and output — a sign it's stuck in a retry loop:

```
  [savings: LOOP DETECTED] "npm test" has produced the same result 3 times.
  This is wasting tokens. Stop and try a different approach.
```

Doesn't fire often in normal usage (0 times in our 107-session benchmark), but when it does fire, it prevents the worst token waste — Claude burning through thousands of tokens retrying a command that will never succeed.

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

> Based on measured data: ~580k tokens saved per dev per week (264k from compression + 316k from duplicate read prevention).

### How this makes Claude Code faster

This hook doesn't speed up Claude's inference — it reduces the tokens Claude re-processes every turn:

```
  Turn 5:  Bash dumps 3,000 chars (750 tokens) into context
  Turn 50: Still re-processing those 750 tokens — for the 45th time

  With compression (3,000 → 400 chars):
  Saved: 650 tokens × 45 remaining turns = 29,250 tokens NOT re-processed
```

Effects:
- **Faster time-to-first-token** — less input per turn
- **Delayed compaction** — sessions last longer before Claude "forgets" earlier work
- **Better prompt cache hits** — stable context = more cache reuse (10x cheaper)
- **Lower rate limit pressure** — fewer tokens per request

## Why this over alternatives

| | claude-savings | [contextzip](https://github.com/jee599/contextzip) | [clauditor](https://github.com/IyadhKhalfallah/clauditor) |
|---|---|---|---|
| **Strategies** | Compression + loop detection + dup read prevention | CLI output compression only | Session rotation + cache monitoring |
| **Compresses** | Bash, Grep, Glob, WebFetch, WebSearch | CLI output only | Bash output only |
| **Loop detection** | Yes (3+ identical calls) | No | Yes (Stop hook) |
| **Duplicate reads** | Yes (warns on re-reads) | No | No |
| **Stack traces** | Collapses framework frames | Collapses framework frames | No |
| **Install** | Copy 1 file | `npx` or `cargo install` | `npm install -g` |
| **Dependencies** | None | Rust binary + `jq` | 5 npm packages |
| **Size** | 1 file, 280 lines | Full CLI + 6 filters | 31 files, TUI, daemon |

> **Why not compress Read output?** We tested it — 94% of edits target the middle of files. Compressing Read would break Claude's ability to edit code. We warn on duplicate reads instead.

## Install

```bash
# One-line install
curl -fsSL https://raw.githubusercontent.com/Cyvid7-Darus10/claude-savings/main/install.sh | bash
```

Or manually:

```bash
mkdir -p ~/.claude/hooks
curl -o ~/.claude/hooks/compress.mjs \
  https://raw.githubusercontent.com/Cyvid7-Darus10/claude-savings/main/compress.mjs
```

Add to `~/.claude/settings.json`:

```json
{
  "hooks": {
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
  ✓ Bash: passes through short output
  ✓ Bash: compresses npm install
  ✓ Bash: preserves error lines
  ✓ Bash: collapses node_modules stack frames
  ✓ Bash: collapses repeated lines
  ✓ Grep / Glob / WebFetch / WebSearch
  ✓ Read: never compressed
  ✓ Edit/Write/Agent: never compressed

── Loop Detection ──
  ✓ no warning on first two identical calls
  ✓ warns on third identical call
  ✓ resets count when command changes

── Duplicate Read Tracking ──
  ✓ no warning on first read
  ✓ warns on second read of same file
  ✓ no warning for small files (<1k)
  ✓ warns only once (not on 3rd, 4th read)

20 passed, 0 failed
```

## Configuration

Edit the constants at the top of `compress.mjs`:

| Constant | Default | Description |
|---|---|---|
| `MAX_CHARS` | 2000 | Maximum compressed output size |
| `MIN_CHARS` | 500 | Output shorter than this passes through unchanged |
| `LOOP_THRESHOLD` | 3 | Identical calls before loop warning |
| `SKIP_COMPRESS` | Read, Edit, Write, Agent, ... | Tools that are never compressed |

State files are stored in `~/.claude-savings/` (loop counts and read history per session).

## License

MIT
