#!/usr/bin/env node

/**
 * claude-bash-compress — Compress verbose bash output in Claude Code sessions.
 *
 * A lightweight PostToolUse hook that reduces noisy bash output before it
 * bloats your context window. Saves tokens on every npm install, build log,
 * and verbose command output.
 *
 * MIT License — https://github.com/Cyvid7-Darus10/claude-bash-compress
 */

const PRESERVE_PATTERNS = [/error/i, /warn/i, /fail/i, /exception/i, /✗/, /ENOENT/, /EACCES/]
const MAX_CHARS = 2000
const MIN_CHARS = 500

/**
 * Compress verbose bash output.
 * Returns compressed string or null if no compression needed.
 */
function compress(output) {
  if (output.length < MIN_CHARS) return null

  const lines = output.split('\n')

  // Strip progress bars
  const filtered = lines.filter(
    l => !/\[=+[>\s]*\]/.test(l) && !/[█░▓▒]{3,}/.test(l)
  )

  // Collapse repeated identical lines
  const collapsed = collapseRepeats(filtered)

  let result

  // Package manager output — summarize heavily
  if (isPackageManagerOutput(output)) {
    result = summarizePackageManager(collapsed, output)
  } else {
    // General output — keep error/warn/fail lines + head/tail
    const important = collapsed.filter(l => PRESERVE_PATTERNS.some(p => p.test(l)))
    if (important.length > 0 && important.length < collapsed.length * 0.5) {
      result = [
        ...collapsed.slice(0, 5),
        `\n[... ${collapsed.length - 10} lines omitted, ${important.length} important lines below ...]\n`,
        ...important,
        '\n[... end of important lines ...]\n',
        ...collapsed.slice(-5),
      ].join('\n')
    } else {
      result = collapsed.join('\n')
    }
  }

  // Final truncation if still over budget
  if (result.length > MAX_CHARS) {
    const headSize = Math.floor(MAX_CHARS * 0.4)
    const tailSize = Math.floor(MAX_CHARS * 0.4)
    result = result.slice(0, headSize) +
      `\n\n[... truncated ${result.length - headSize - tailSize} chars ...]\n\n` +
      result.slice(-tailSize)
  }

  if (result.length >= output.length) return null

  const origK = (output.length / 1000).toFixed(1)
  const compK = (result.length / 1000).toFixed(1)
  return `[bash-compress: ${origK}k → ${compK}k chars]\n${result}`
}

function collapseRepeats(lines) {
  const result = []
  let lastLine = ''
  let count = 0

  for (const line of lines) {
    if (line === lastLine) {
      count++
    } else {
      if (count > 1) result.push(`[previous line repeated ${count} times]`)
      result.push(line)
      lastLine = line
      count = 1
    }
  }
  if (count > 1) result.push(`[previous line repeated ${count} times]`)
  return result
}

function isPackageManagerOutput(output) {
  return /added \d+ packages?/i.test(output) ||
    /packages? are looking for funding/i.test(output) ||
    /^(npm|pnpm|yarn)\s+(install|add|i)\b/m.test(output)
}

function summarizePackageManager(lines, raw) {
  const head = lines.slice(0, 5)
  const tail = lines.slice(-5)
  const addedMatch = raw.match(/added (\d+) packages?/i)
  const vulnMatch = raw.match(/(\d+) vulnerabilit/i)

  const parts = [...head, '', `[... ${lines.length - 10} lines of install output omitted ...]`, '']
  if (addedMatch) parts.push(`Summary: ${addedMatch[0]}`)
  if (vulnMatch) parts.push(`Vulnerabilities: ${vulnMatch[0]}`)
  if (!addedMatch && !vulnMatch) parts.push('(install output summarized)')
  parts.push('', ...tail)
  return parts.join('\n')
}

// --- Hook entry point ---
let data = ''
process.stdin.setEncoding('utf-8')
process.stdin.on('data', chunk => { data += chunk })
process.stdin.on('end', () => {
  try {
    const input = JSON.parse(data)
    if (input.tool_name !== 'Bash') {
      process.stdout.write('{}')
      return
    }
    const compressed = compress(input.tool_response || '')
    if (compressed) {
      process.stdout.write(JSON.stringify({ additionalContext: compressed }))
    } else {
      process.stdout.write('{}')
    }
  } catch {
    process.stdout.write('{}')
  }
})
