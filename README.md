# claude-compress

A lightweight Claude Code hook that compresses verbose tool output to save context window tokens.

Every tool result stays in the conversation forever. A large file read, a verbose build log, a grep with 200 matches — all of it gets re-processed on every subsequent turn. This hook compresses it automatically, per-tool, with strategies that preserve what matters and strip what doesn't.

![demo](https://vhs.charm.sh/vhs-XbmoXiyGHgFy0WwjYYjis.gif)

## Real impact

Measured from 107 real Claude Code sessions (7 days):

```
  COMPRESSION BY TOOL
  ───────────────────
  Tool              Compressed   Original    After    Saved
  ──────────────────────────────────────────────────────
  Bash                  211         807k     223k      72%
  WebFetch               29         359k      36k      90%
  Grep                   25         117k      29k      75%
  Glob                    9          44k       9k      79%
  ──────────────────────────────────────────────────────
  TOTAL                 279       1,343k     305k    77.3%

  Tokens saved/week:   ~260,000
  Tokens saved/month:  ~1,039,000
```

Run the benchmark on your own sessions:

```bash
node benchmark.mjs
```

## Compression strategies

Each tool type gets a tailored approach:

| Tool | Strategy | What's kept | What's stripped |
|---|---|---|---|
| **Bash** | Strip noise, keep errors | Error messages, warnings, exit codes | Progress bars, repeated lines, install logs |
| **Grep** | Truncate matches | First 15 + last 5 matches, total count | Excess matches beyond 30 |
| **Glob** | Truncate file lists | First 20 files, total count | Excess files beyond 30 |
| **WebFetch** | Strip HTML, truncate | Text content, first 20 + last 10 lines | `<script>`, `<style>`, HTML tags |
| **WebSearch** | Truncate results | First 30 results | Excess results |
| **Read** | Never compressed | Everything | Nothing — Claude needs full file content to make edits (94% of edits target the middle of files) |
| **Edit/Write/Agent** | Never compressed | Everything | Nothing |

Short output (<500 chars) always passes through unchanged.

## Why this over alternatives

| | claude-compress | [contextzip](https://github.com/jee599/contextzip) | [clauditor](https://github.com/IyadhKhalfallah/clauditor) |
|---|---|---|---|
| **Compresses** | All tools (Bash, Read, Grep, Glob, Web) | CLI output only | Bash output only |
| **Install** | Copy 1 file | `npx` or `cargo install` | `npm install -g` + `clauditor install` |
| **Dependencies** | None (just Node.js) | Rust binary + `jq` | 5 npm packages |
| **Size** | 1 file, 200 lines | Full CLI + 6 filters | 31 source files, TUI, daemon |
| **Overhead** | Fires on all tools, skips Edit/Write/Agent instantly | Wraps every command | PostToolUse on every tool call |

**Our edge:** Per-tool compression strategies. Other tools only handle bash/CLI output. We also compress Grep, Glob, WebFetch, and WebSearch — with strategies tailored to each tool type.

> **Why not compress Read?** We tested it. 94% of edits to large files target the middle — exactly the part that would be stripped. Compressing Read would cause Claude to hallucinate or fail on nearly every edit. We measured this against 316 real Read→Edit sequences and decided the risk far outweighs the savings.

## Cost savings

### Per developer

| Model | Tokens saved/month | Cost saved/month |
|---|---|---|
| Claude Sonnet 4.6 | ~1M | **$3.12** |
| Claude Opus 4.6 | ~1M | **$15.58** |

### At scale

| Team size | Model | Cost saved/month | Cost saved/year |
|---|---|---|---|
| 10 devs | Opus | $156 | **$1,870** |
| 50 devs | Opus | $779 | **$9,348** |
| 200 devs | Opus | $3,116 | **$37,392** |

> Based on measured data: ~260k tokens saved per dev per week. Teams with heavier build/test cycles and more WebFetch usage save more.

### How this makes Claude Code faster

This hook doesn't make Claude's inference faster — it reduces the tokens Claude re-processes every turn. A verbose output from turn 5 is still in context at turn 50:

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

## Install

```bash
# One-line install
curl -fsSL https://raw.githubusercontent.com/Cyvid7-Darus10/claude-bash-compress/main/install.sh | bash
```

Or manually:

```bash
# 1. Copy the hook
mkdir -p ~/.claude/hooks
curl -o ~/.claude/hooks/compress.mjs \
  https://raw.githubusercontent.com/Cyvid7-Darus10/claude-bash-compress/main/compress.mjs

# 2. Add to ~/.claude/settings.json
```

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
  ✓ Bash: passes through short output
  ✓ Bash: compresses npm install
  ✓ Bash: preserves error lines
  ✓ Bash: collapses repeated lines
  ✓ Grep: passes through small results
  ✓ Grep: truncates large result sets
  ✓ Glob: passes through short file lists
  ✓ Glob: truncates long file lists
  ✓ Read: passes through small files
  ✓ Read: trims very large files
  ✓ Read: preserves moderate files (<100 lines)
  ✓ WebFetch: strips HTML and compresses
  ✓ WebSearch: truncates long results
  ✓ WebSearch: passes through short results
  ✓ Edit: never compressed
  ✓ Write: never compressed
  ✓ Agent: never compressed
  ✓ handles malformed JSON
  ✓ handles unknown tool with generic compression
  ✓ truncates extremely long output

20 passed, 0 failed
```

## Configuration

Edit the constants at the top of `compress.mjs`:

| Constant | Default | Description |
|---|---|---|
| `MAX_CHARS` | 2000 | Maximum compressed output size (4000 for Read) |
| `MIN_CHARS` | 500 | Output shorter than this passes through unchanged |
| `SKIP_TOOLS` | Edit, Write, Agent, ... | Tools that are never compressed |

## License

MIT
