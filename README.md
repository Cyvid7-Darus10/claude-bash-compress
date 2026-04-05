# claude-bash-compress

A lightweight Claude Code hook that compresses verbose bash output to save context window tokens.

Every time Claude runs a bash command, the full output is added to the conversation context. A single `npm install` can dump 3,000+ characters of noise. Over a session with many tool calls, this bloat adds up — wasting tokens on progress bars, repeated lines, and install logs instead of your actual work.

This hook intercepts bash output and compresses it before it reaches the context window.

## Before & after

```
Without hook:        npm install → 2,800 chars in context
With bash-compress:  npm install →   400 chars in context (86% reduction)
```

## What it compresses

- **Package manager output** (npm/pnpm/yarn install) → head + tail + summary
- **Progress bars** (`[=====>   ]`, `████░░`) → stripped entirely
- **Repeated lines** (50x "processing chunk") → collapsed to 1 line + count
- **Build logs** → keeps error/warn/fail lines, omits noise
- **Any output >2,000 chars** → truncated with head/tail preserved

What it **preserves**:
- Error messages, warnings, failures, exceptions
- Short output (<500 chars) passes through unchanged
- Non-Bash tool output is never touched

## Install

```bash
# 1. Copy the hook
mkdir -p ~/.claude/hooks
curl -o ~/.claude/hooks/bash-compress.mjs \
  https://raw.githubusercontent.com/Cyvid7-Darus10/claude-bash-compress/main/bash-compress.mjs

# 2. Add to ~/.claude/settings.json under "hooks"
```

Add this to your `hooks.PostToolUse` array in `~/.claude/settings.json`:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Bash",
        "hooks": [
          {
            "type": "command",
            "command": "node \"$HOME/.claude/hooks/bash-compress.mjs\""
          }
        ]
      }
    ]
  }
}
```

That's it. No dependencies, no build step, no daemon. One file, zero config.

Requires Node.js 20+.

## How it works

Claude Code's [PostToolUse hook](https://docs.anthropic.com/en/docs/claude-code/hooks) fires after every tool call. This hook:

1. Reads the tool result from stdin (JSON with `tool_name` and `tool_response`)
2. If it's not a Bash call or the output is short, returns `{}` (no-op)
3. Otherwise, compresses the output and returns `{ additionalContext: "..." }`
4. Claude sees the compressed version alongside the original

The `matcher: "Bash"` config ensures it only runs for Bash tool calls — zero overhead on Read, Edit, Write, Grep, etc.

## Tests

```bash
node bash-compress.test.mjs
```

## Configuration

Edit the constants at the top of `bash-compress.mjs`:

| Constant | Default | Description |
|---|---|---|
| `MAX_CHARS` | 2000 | Maximum compressed output size |
| `MIN_CHARS` | 500 | Output shorter than this passes through unchanged |
| `PRESERVE_PATTERNS` | error, warn, fail, ... | Regex patterns for lines to always keep |

## License

MIT
