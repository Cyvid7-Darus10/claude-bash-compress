#!/usr/bin/env node

/**
 * claude-savings — Save tokens in Claude Code sessions.
 *
 * A PostToolUse hook with three savings strategies:
 *
 * 1. OUTPUT COMPRESSION — Reduces noisy output from Bash, Grep, Glob,
 *    WebFetch, WebSearch before it bloats the context window.
 *
 * 2. LOOP DETECTION — Warns when Claude repeats the same failing
 *    command, preventing 10-50k tokens wasted per loop.
 *
 * 3. DUPLICATE READ TRACKING — Warns when Claude re-reads a file
 *    it already has in context, preventing full file duplication.
 *
 * MIT License — https://github.com/Cyvid7-Darus10/claude-savings
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'

const MAX_CHARS = 2000
const MIN_CHARS = 500
const STATE_DIR = resolve(homedir(), '.claude-savings')
const LOOP_THRESHOLD = 3

// Tools that should never be compressed
// Read: Claude needs full file content to edit (94% of edits target the middle)
const SKIP_COMPRESS = new Set(['Edit', 'Write', 'Read', 'TodoWrite', 'TaskCreate',
  'TaskUpdate', 'TaskGet', 'Skill', 'ToolSearch', 'AskUserQuestion',
  'EnterPlanMode', 'ExitPlanMode', 'NotebookEdit', 'Agent'])

const ERROR_PATTERNS = [/error/i, /warn/i, /fail/i, /exception/i, /✗/, /ENOENT/, /EACCES/,
  /TypeError/, /SyntaxError/, /ReferenceError/, /Cannot find/]

// ═══════════════════════════════════════════════════════════════════
// 1. OUTPUT COMPRESSION
// ═══════════════════════════════════════════════════════════════════

function compressBash(output) {
  const lines = output.split('\n')

  // Strip progress bars
  const filtered = lines.filter(
    l => !/\[=+[>\s]*\]/.test(l) && !/[█░▓▒]{3,}/.test(l)
  )

  const collapsed = collapseRepeats(filtered)

  // Package manager output
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

  // Smart stack trace compression — collapse node_modules frames
  const appFrames = []
  const frameworkCount = { count: 0 }
  let inStackTrace = false

  for (const line of collapsed) {
    const isFrame = /^\s+at\s/.test(line)
    if (isFrame) {
      inStackTrace = true
      if (/node_modules/.test(line) || /internal\//.test(line)) {
        frameworkCount.count++
      } else {
        if (frameworkCount.count > 0) {
          appFrames.push(`    (+ ${frameworkCount.count} framework frames hidden)`)
          frameworkCount.count = 0
        }
        appFrames.push(line)
      }
    } else {
      if (inStackTrace && frameworkCount.count > 0) {
        appFrames.push(`    (+ ${frameworkCount.count} framework frames hidden)`)
        frameworkCount.count = 0
      }
      inStackTrace = false
      appFrames.push(line)
    }
  }
  if (frameworkCount.count > 0) {
    appFrames.push(`    (+ ${frameworkCount.count} framework frames hidden)`)
  }

  // If stack trace compression saved lines, use it
  if (appFrames.length < collapsed.length) {
    const important = appFrames.filter(l => ERROR_PATTERNS.some(p => p.test(l)))
    if (important.length > 0 && important.length < appFrames.length * 0.5) {
      return [
        ...appFrames.slice(0, 5),
        `\n[... ${Math.max(0, appFrames.length - 10)} lines omitted, ${important.length} important lines below ...]\n`,
        ...important,
        '\n[... end of important lines ...]\n',
        ...appFrames.slice(-5),
      ].join('\n')
    }
    return appFrames.join('\n')
  }

  // General: keep error/warn lines
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
  if (lines.length <= 30) return null
  return [...lines.slice(0, 15), '', `[... ${lines.length - 20} more matches omitted (${lines.length} total) ...]`, '', ...lines.slice(-5)].join('\n')
}

function compressGlob(output) {
  const lines = output.split('\n').filter(Boolean)
  if (lines.length <= 30) return null
  return [...lines.slice(0, 20), '', `[... ${lines.length - 20} more files omitted (${lines.length} total) ...]`].join('\n')
}

function compressWebFetch(output) {
  let text = output
  if (/<[a-z][\s\S]*>/i.test(text)) {
    text = text
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s{2,}/g, ' ')
      .trim()
  }
  const lines = text.split('\n').filter(l => l.trim().length > 0)
  if (lines.length <= 30) return lines.join('\n')
  return [...lines.slice(0, 20), '', `[... ${lines.length - 30} lines of web content omitted (${lines.length} total) ...]`, '', ...lines.slice(-10)].join('\n')
}

function compressWebSearch(output) {
  const lines = output.split('\n').filter(l => l.trim().length > 0)
  if (lines.length <= 40) return null
  return [...lines.slice(0, 30), '', `[... ${lines.length - 30} more lines omitted (${lines.length} total) ...]`].join('\n')
}

function compressGeneric(output) {
  const lines = output.split('\n')
  const collapsed = collapseRepeats(lines)
  const important = collapsed.filter(l => ERROR_PATTERNS.some(p => p.test(l)))
  if (important.length > 0 && important.length < collapsed.length * 0.5) {
    return [...collapsed.slice(0, 5), `\n[... ${Math.max(0, collapsed.length - 10)} lines omitted, ${important.length} important lines below ...]\n`, ...important, ...collapsed.slice(-5)].join('\n')
  }
  if (collapsed.length > 50) {
    return [...collapsed.slice(0, 20), '', `[... ${collapsed.length - 30} lines omitted (${collapsed.length} total) ...]`, '', ...collapsed.slice(-10)].join('\n')
  }
  return collapsed.join('\n')
}

// ═══════════════════════════════════════════════════════════════════
// 2. LOOP DETECTION
// ═══════════════════════════════════════════════════════════════════

function detectLoop(sessionId, toolName, toolInput, toolResponse) {
  const stateFile = resolve(STATE_DIR, 'loop-state.json')
  let state = readState(stateFile, {})

  // Hash the tool call signature
  const hash = createHash('sha256')
    .update(toolName + '|' + JSON.stringify(toolInput || '') + '|' + (toolResponse || '').slice(0, 500))
    .digest('hex')
    .slice(0, 16)

  const key = sessionId || 'default'
  if (!state[key]) state[key] = { lastHash: '', count: 0, warned: {} }

  if (state[key].lastHash === hash) {
    state[key].count++
  } else {
    state[key].lastHash = hash
    state[key].count = 1
  }

  writeState(stateFile, state)

  if (state[key].count >= LOOP_THRESHOLD && !state[key].warned[hash]) {
    state[key].warned[hash] = true
    writeState(stateFile, state)

    const cmd = typeof toolInput?.command === 'string' ? toolInput.command.slice(0, 80) : toolName
    return `[savings: LOOP DETECTED] "${cmd}" has produced the same result ${state[key].count} times. ` +
      `This is wasting tokens. Stop and try a different approach — read the error, check assumptions, or ask the user for help.`
  }

  return null
}

// ═══════════════════════════════════════════════════════════════════
// 3. DUPLICATE READ TRACKING
// ═══════════════════════════════════════════════════════════════════

function trackDuplicateRead(sessionId, toolName, toolInput, outputLength) {
  if (toolName !== 'Read') return null

  const filePath = toolInput?.file_path
  if (!filePath) return null

  // Only warn for substantial reads (>1k chars)
  if (outputLength < 1000) return null

  const stateFile = resolve(STATE_DIR, 'read-state.json')
  let state = readState(stateFile, {})

  const key = sessionId || 'default'
  if (!state[key]) state[key] = {}

  const shortPath = filePath.split('/').slice(-3).join('/')

  if (state[key][filePath]) {
    const count = state[key][filePath] + 1
    state[key][filePath] = count

    // Only warn on 2nd read, not every subsequent one
    if (count === 2) {
      writeState(stateFile, state)
      return `[savings: DUPLICATE READ] ${shortPath} was already read in this session (${(outputLength / 1000).toFixed(1)}k chars re-added to context). ` +
        `The file content is already in your conversation history. If you need specific lines, use Read with offset/limit instead of re-reading the whole file.`
    }

    writeState(stateFile, state)
    return null
  }

  state[key][filePath] = 1
  writeState(stateFile, state)
  return null
}

// ═══════════════════════════════════════════════════════════════════
// Shared utilities
// ═══════════════════════════════════════════════════════════════════

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
  const h = Math.floor(max * 0.4), t = Math.floor(max * 0.4)
  return text.slice(0, h) + `\n\n[... truncated ${text.length - h - t} chars ...]\n\n` + text.slice(-t)
}

function readState(file, fallback) {
  try { return JSON.parse(readFileSync(file, 'utf-8')) } catch { return fallback }
}

function writeState(file, data) {
  try { mkdirSync(STATE_DIR, { recursive: true }); writeFileSync(file, JSON.stringify(data)) } catch {}
}

// ═══════════════════════════════════════════════════════════════════
// Main compression entry point
// ═══════════════════════════════════════════════════════════════════

function compress(toolName, output) {
  if (!output || output.length < MIN_CHARS) return null
  if (SKIP_COMPRESS.has(toolName)) return null

  let result
  switch (toolName) {
    case 'Bash':      result = compressBash(output); break
    case 'Grep':      result = compressGrep(output); break
    case 'Glob':      result = compressGlob(output); break
    case 'WebFetch':  result = compressWebFetch(output); break
    case 'WebSearch': result = compressWebSearch(output); break
    default:          result = compressGeneric(output); break
  }

  if (!result) return null
  result = truncate(result, MAX_CHARS)
  if (result.length >= output.length) return null

  const origK = (output.length / 1000).toFixed(1)
  const compK = (result.length / 1000).toFixed(1)
  const pct = Math.round((1 - result.length / output.length) * 100)
  return `[savings: ${toolName} compressed ${origK}k → ${compK}k chars (${pct}% saved)]\n${result}`
}

// ═══════════════════════════════════════════════════════════════════
// Hook entry point
// ═══════════════════════════════════════════════════════════════════

let data = ''
process.stdin.setEncoding('utf-8')
process.stdin.on('data', chunk => { data += chunk })
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(data)
    const toolName = input.tool_name || ''
    const sessionId = input.session_id || ''
    const output = input.tool_response || ''
    const parts = []

    // 1. Compression
    const compressed = compress(toolName, output)
    if (compressed) parts.push(compressed)

    // 2. Loop detection (all tools)
    const loopWarning = detectLoop(sessionId, toolName, input.tool_input, output)
    if (loopWarning) parts.push(loopWarning)

    // 3. Duplicate read tracking
    const dupWarning = trackDuplicateRead(sessionId, toolName, input.tool_input, output.length)
    if (dupWarning) parts.push(dupWarning)

    if (parts.length > 0) {
      process.stdout.write(JSON.stringify({ additionalContext: parts.join('\n\n') }))
    } else {
      process.stdout.write('{}')
    }
  } catch {
    process.stdout.write('{}')
  }
})

export { compress, compressBash, compressGrep, compressGlob, compressWebFetch, compressWebSearch, detectLoop, trackDuplicateRead }
