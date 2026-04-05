#!/usr/bin/env node

/**
 * Benchmark claude-compress against your real Claude Code sessions.
 *
 * Scans ~/.claude/projects/ for JSONL transcripts, finds all tool
 * results, and measures compression per tool type.
 *
 * Usage: node benchmark.mjs
 */

import { readdirSync, readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { homedir } from 'node:os'
import { compress } from './compress.mjs'

const projectsDir = resolve(homedir(), '.claude/projects')
const cutoff = Date.now() - 7 * 24 * 60 * 60 * 1000

// Per-tool stats
const toolStats = {}
let sessionsScanned = 0
let totalResults = 0
let totalShort = 0

function addStat(tool, origLen, compLen) {
  if (!toolStats[tool]) toolStats[tool] = { count: 0, compressed: 0, origChars: 0, compChars: 0 }
  toolStats[tool].count++
  if (compLen !== null) {
    toolStats[tool].compressed++
    toolStats[tool].origChars += origLen
    toolStats[tool].compChars += compLen
  }
}

console.log('')
console.log('  claude-compress benchmark')
console.log('  ────────────────────────')
console.log(`  Scanning ${projectsDir}`)
console.log('')

try {
  const dirs = readdirSync(projectsDir, { withFileTypes: true })

  for (const dir of dirs) {
    if (!dir.isDirectory()) continue
    const dirPath = resolve(projectsDir, dir.name)
    let files
    try { files = readdirSync(dirPath).filter(f => f.endsWith('.jsonl')) } catch { continue }

    for (const file of files) {
      const filePath = resolve(dirPath, file)
      try {
        const stat = statSync(filePath)
        if (stat.mtimeMs < cutoff) continue
        sessionsScanned++
        const content = readFileSync(filePath, 'utf-8')

        // Map tool_use IDs to tool names
        const toolNames = {}
        for (const line of content.split('\n')) {
          if (!line) continue
          try {
            const r = JSON.parse(line)
            if (r.type === 'assistant' && r.message?.content) {
              for (const block of r.message.content) {
                if (block.type === 'tool_use' && block.id) toolNames[block.id] = block.name
              }
            }
          } catch {}
        }

        // Analyze tool results
        for (const line of content.split('\n')) {
          if (!line) continue
          try {
            const r = JSON.parse(line)
            if (r.type === 'user' && Array.isArray(r.message?.content)) {
              for (const block of r.message.content) {
                if (block.type !== 'tool_result' || typeof block.content !== 'string') continue
                const toolName = toolNames[block.tool_use_id] || 'unknown'
                totalResults++

                if (block.content.length < 500) { totalShort++; continue }

                const compressed = compress(toolName, block.content)
                if (compressed) {
                  // Extract compressed size (content minus the header line)
                  const headerEnd = compressed.indexOf('\n')
                  const compContent = headerEnd >= 0 ? compressed.slice(headerEnd + 1) : compressed
                  addStat(toolName, block.content.length, compContent.length)
                } else {
                  addStat(toolName, block.content.length, null)
                }
              }
            }
          } catch {}
        }
      } catch { continue }
    }
  }
} catch (e) {
  console.log(`  ✗ Could not scan: ${e.message}`)
  process.exit(1)
}

// Results
console.log(`  Sessions scanned (last 7 days): ${sessionsScanned}`)
console.log(`  Total tool results:             ${totalResults}`)
console.log(`  Short output (< 500 chars):     ${totalShort} (passed through)`)
console.log('')

const totalOrig = Object.values(toolStats).reduce((s, t) => s + t.origChars, 0)
const totalComp = Object.values(toolStats).reduce((s, t) => s + t.compChars, 0)
const totalCompressed = Object.values(toolStats).reduce((s, t) => s + t.compressed, 0)

if (totalCompressed === 0) {
  console.log('  No compressible output found.')
  process.exit(0)
}

const saved = totalOrig - totalComp
const ratio = ((saved / totalOrig) * 100).toFixed(1)
const tokens = Math.round(saved / 4)

console.log('  COMPRESSION BY TOOL')
console.log('  ───────────────────')
console.log('  Tool'.padEnd(18), 'Verbose'.padStart(8), 'Compressed'.padStart(12), 'Original'.padStart(10), 'After'.padStart(10), 'Saved'.padStart(8))
console.log('  ' + '─'.repeat(64))

const sorted = Object.entries(toolStats)
  .filter(([, s]) => s.compressed > 0)
  .sort((a, b) => (b[1].origChars - b[1].compChars) - (a[1].origChars - a[1].compChars))

for (const [tool, s] of sorted) {
  const toolSaved = s.origChars - s.compChars
  const toolRatio = s.origChars > 0 ? Math.round((toolSaved / s.origChars) * 100) : 0
  console.log(
    `  ${tool.padEnd(16)}`,
    String(s.count).padStart(8),
    String(s.compressed).padStart(12),
    `${(s.origChars / 1000).toFixed(0)}k`.padStart(10),
    `${(s.compChars / 1000).toFixed(0)}k`.padStart(10),
    `${toolRatio}%`.padStart(8),
  )
}

console.log('  ' + '─'.repeat(64))
console.log(
  `  ${'TOTAL'.padEnd(16)}`,
  ''.padStart(8),
  String(totalCompressed).padStart(12),
  `${(totalOrig / 1000).toFixed(0)}k`.padStart(10),
  `${(totalComp / 1000).toFixed(0)}k`.padStart(10),
  `${ratio}%`.padStart(8),
)

console.log('')
console.log('  OVERALL')
console.log('  ───────')
console.log(`  Chars saved:       ${(saved / 1000).toFixed(0)}k`)
console.log(`  Tokens saved/week: ~${tokens.toLocaleString()}`)
console.log(`  Tokens saved/month: ~${(tokens * 4).toLocaleString()}`)
console.log('')
console.log('  COST PROJECTION')
console.log('  ───────────────')
console.log(`  Sonnet ($3/1M):    $${(tokens * 4 / 1_000_000 * 3).toFixed(2)}/month`)
console.log(`  Opus ($15/1M):     $${(tokens * 4 / 1_000_000 * 15).toFixed(2)}/month`)
console.log('')

// Prevent stdin from being read by the imported module's hook listener
process.exit(0)
