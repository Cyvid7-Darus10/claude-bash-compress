#!/usr/bin/env node

/**
 * claude-compress — Compress verbose tool output in Claude Code sessions.
 *
 * A PostToolUse hook that reduces noisy output from Bash, Grep, Glob,
 * WebFetch, WebSearch, and Read before it bloats your context window.
 *
 * Each tool type has a tailored compression strategy:
 * - Bash:      Strip progress bars, collapse repeats, keep errors
 * - Grep:      Truncate after N matches, preserve match count
 * - Glob:      Truncate long file lists, show total count
 * - Read:      Trim very large files, keep head/tail
 * - WebFetch:  Strip HTML tags, truncate to content
 * - WebSearch: Truncate verbose result blocks
 *
 * MIT License — https://github.com/Cyvid7-Darus10/claude-bash-compress
 */

const MAX_CHARS = 2000
const MIN_CHARS = 500

// Tools that should never be compressed
// - Edit/Write: output is small, always essential
// - Read: Claude needs full file content to make edits (94% of edits target the middle
//   of files — compressing it would cause hallucinations and failed edits)
// - Agent/Task/Skill: control flow, not content
const SKIP_TOOLS = new Set(['Edit', 'Write', 'Read', 'TodoWrite', 'TaskCreate', 'TaskUpdate',
  'TaskGet', 'Skill', 'ToolSearch', 'AskUserQuestion', 'EnterPlanMode', 'ExitPlanMode',
  'NotebookEdit', 'Agent'])

const ERROR_PATTERNS = [/error/i, /warn/i, /fail/i, /exception/i, /✗/, /ENOENT/, /EACCES/,
  /TypeError/, /SyntaxError/, /ReferenceError/, /Cannot find/]

// ── Per-tool compression strategies ──────────────────────────────

function compressBash(output) {
  const lines = output.split('\n')

  // Strip progress bars
  const filtered = lines.filter(
    l => !/\[=+[>\s]*\]/.test(l) && !/[█░▓▒]{3,}/.test(l)
  )

  const collapsed = collapseRepeats(filtered)

  // Package manager output — summarize heavily
  if (/added \d+ packages?/i.test(output) || /packages? are looking for funding/i.test(output)) {
    const head = collapsed.slice(0, 5), tail = collapsed.slice(-5)
    const parts = [...head, '', `[... ${Math.max(0, collapsed.length - 10)} lines of install output omitted ...]`, '']
    const m = output.match(/added (\d+) packages?/i)
    const v = output.match(/(\d+) vulnerabilit/i)
    if (m) parts.push(`Summary: ${m[0]}`)
    if (v) parts.push(`Vulnerabilities: ${v[0]}`)
    if (!m && !v) parts.push('(install output summarized)')
    parts.push('', ...tail)
    return parts.join('\n')
  }

  // Build/general output — keep error/warn lines
  const important = collapsed.filter(l => ERROR_PATTERNS.some(p => p.test(l)))
  if (important.length > 0 && important.length < collapsed.length * 0.5) {
    return [
      ...collapsed.slice(0, 5),
      `\n[... ${Math.max(0, collapsed.length - 10)} lines omitted, ${important.length} important lines below ...]\n`,
      ...important,
      '\n[... end of important lines ...]\n',
      ...collapsed.slice(-5),
    ].join('\n')
  }

  return collapsed.join('\n')
}

function compressGrep(output) {
  const lines = output.split('\n').filter(Boolean)
  if (lines.length <= 30) return null // Already manageable

  const head = lines.slice(0, 15)
  const tail = lines.slice(-5)
  return [
    ...head,
    '',
    `[... ${lines.length - 20} more matches omitted (${lines.length} total) ...]`,
    '',
    ...tail,
  ].join('\n')
}

function compressGlob(output) {
  const lines = output.split('\n').filter(Boolean)
  if (lines.length <= 30) return null

  const head = lines.slice(0, 20)
  return [
    ...head,
    '',
    `[... ${lines.length - 20} more files omitted (${lines.length} total) ...]`,
  ].join('\n')
}

function compressRead(output) {
  // Only compress very large reads (>5k chars)
  // Be conservative — Claude often needs file content to make edits
  if (output.length < 5000) return null

  const lines = output.split('\n')
  if (lines.length <= 100) return null

  // Scale kept lines to fit within MAX_CHARS
  // Keep ~60% head, ~30% tail, proportional to max budget
  const maxLines = Math.min(40, Math.floor(lines.length * 0.3))
  const headLines = Math.floor(maxLines * 0.65)
  const tailLines = maxLines - headLines
  const head = lines.slice(0, headLines)
  const tail = lines.slice(-tailLines)
  return [
    ...head,
    '',
    `[... ${lines.length - headLines - tailLines} lines omitted from middle of file (${lines.length} lines total, ${(output.length / 1000).toFixed(1)}k chars) ...]`,
    `[... if you need the full file, use Read with offset/limit parameters ...]`,
    '',
    ...tail,
  ].join('\n')
}

function compressWebFetch(output) {
  // Strip HTML tags if present
  let text = output
  if (/<[a-z][\s\S]*>/i.test(text)) {
    text = text
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim()
  }

  // Collapse whitespace-heavy content
  const lines = text.split('\n').filter(l => l.trim().length > 0)
  if (lines.length <= 30) return lines.join('\n')

  const head = lines.slice(0, 20)
  const tail = lines.slice(-10)
  return [
    ...head,
    '',
    `[... ${lines.length - 30} lines of web content omitted (${lines.length} total) ...]`,
    '',
    ...tail,
  ].join('\n')
}

function compressWebSearch(output) {
  const lines = output.split('\n').filter(l => l.trim().length > 0)
  if (lines.length <= 40) return null

  const head = lines.slice(0, 30)
  return [
    ...head,
    '',
    `[... ${lines.length - 30} more lines omitted (${lines.length} total) ...]`,
  ].join('\n')
}

// ── Generic fallback ─────────────────────────────────────────────

function compressGeneric(output) {
  const lines = output.split('\n')
  const collapsed = collapseRepeats(lines)

  const important = collapsed.filter(l => ERROR_PATTERNS.some(p => p.test(l)))
  if (important.length > 0 && important.length < collapsed.length * 0.5) {
    return [
      ...collapsed.slice(0, 5),
      `\n[... ${Math.max(0, collapsed.length - 10)} lines omitted, ${important.length} important lines below ...]\n`,
      ...important,
      ...collapsed.slice(-5),
    ].join('\n')
  }

  // Just head + tail for long output
  if (collapsed.length > 50) {
    return [
      ...collapsed.slice(0, 20),
      '',
      `[... ${collapsed.length - 30} lines omitted (${collapsed.length} total) ...]`,
      '',
      ...collapsed.slice(-10),
    ].join('\n')
  }

  return collapsed.join('\n')
}

// ── Shared utilities ─────────────────────────────────────────────

function collapseRepeats(lines) {
  const result = []
  let last = '', count = 0
  for (const line of lines) {
    if (line === last) { count++ } else {
      if (count > 1) result.push(`[previous line repeated ${count} times]`)
      result.push(line); last = line; count = 1
    }
  }
  if (count > 1) result.push(`[previous line repeated ${count} times]`)
  return result
}

function truncate(text, max) {
  if (text.length <= max) return text
  const h = Math.floor(max * 0.4)
  const t = Math.floor(max * 0.4)
  return text.slice(0, h) +
    `\n\n[... truncated ${text.length - h - t} chars ...]\n\n` +
    text.slice(-t)
}

// ── Main compression entry point ─────────────────────────────────

function compress(toolName, output) {
  if (!output || output.length < MIN_CHARS) return null
  if (SKIP_TOOLS.has(toolName)) return null

  // Select strategy — Read gets a higher budget since Claude needs file content
  const maxChars = toolName === 'Read' ? 4000 : MAX_CHARS
  let result
  switch (toolName) {
    case 'Bash':      result = compressBash(output); break
    case 'Grep':      result = compressGrep(output); break
    case 'Glob':      result = compressGlob(output); break
    case 'Read':      result = compressRead(output); break
    case 'WebFetch':  result = compressWebFetch(output); break
    case 'WebSearch': result = compressWebSearch(output); break
    default:          result = compressGeneric(output); break
  }

  if (!result) return null

  // Final truncation safety net
  result = truncate(result, maxChars)

  // Only return if we actually saved space
  if (result.length >= output.length) return null

  const origK = (output.length / 1000).toFixed(1)
  const compK = (result.length / 1000).toFixed(1)
  const pct = Math.round((1 - result.length / output.length) * 100)
  return `[compress: ${toolName} ${origK}k → ${compK}k chars (${pct}% saved)]\n${result}`
}

// ── Hook entry point ─────────────────────────────────────────────

let data = ''
process.stdin.setEncoding('utf-8')
process.stdin.on('data', chunk => { data += chunk })
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(data)
    const toolName = input.tool_name || ''

    if (SKIP_TOOLS.has(toolName)) {
      process.stdout.write('{}')
      return
    }

    const output = input.tool_response || ''
    const compressed = compress(toolName, output)

    if (compressed) {
      process.stdout.write(JSON.stringify({ additionalContext: compressed }))
    } else {
      process.stdout.write('{}')
    }
  } catch {
    process.stdout.write('{}')
  }
})

// Export for testing
export { compress, compressBash, compressGrep, compressGlob, compressRead, compressWebFetch, compressWebSearch }
