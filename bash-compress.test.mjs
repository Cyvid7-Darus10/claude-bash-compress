import { execFileSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { strict as assert } from 'node:assert'

const __dirname = dirname(fileURLToPath(import.meta.url))
const HOOK = resolve(__dirname, 'bash-compress.mjs')

function runHook(input) {
  const result = execFileSync('node', [HOOK], {
    input: JSON.stringify(input),
    encoding: 'utf-8',
    timeout: 5000,
  })
  return JSON.parse(result.trim())
}

let passed = 0
let failed = 0

function test(name, fn) {
  try {
    fn()
    passed++
    console.log(`  ✓ ${name}`)
  } catch (e) {
    failed++
    console.log(`  ✗ ${name}`)
    console.log(`    ${e.message}`)
  }
}

console.log('\nbash-compress tests\n')

test('passes through short output unchanged', () => {
  const result = runHook({ tool_name: 'Bash', tool_response: 'Hello world' })
  assert.deepStrictEqual(result, {})
})

test('passes through non-Bash tools', () => {
  const result = runHook({ tool_name: 'Read', tool_response: 'x'.repeat(1000) })
  assert.deepStrictEqual(result, {})
})

test('compresses verbose npm install output', () => {
  const lines = Array.from({ length: 100 }, (_, i) => `npm install line ${i}`)
  lines.push('added 245 packages in 12s')
  lines.push('5 packages are looking for funding')
  lines.push('found 0 vulnerabilities')

  const result = runHook({ tool_name: 'Bash', tool_response: lines.join('\n') })
  assert.ok(result.additionalContext, 'should have additionalContext')
  assert.ok(result.additionalContext.includes('bash-compress:'), 'should have compression header')
  assert.ok(result.additionalContext.includes('added 245 packages'), 'should preserve summary')
})

test('preserves error lines in build output', () => {
  const lines = Array.from({ length: 80 }, (_, i) => `compiling module ${i}...`)
  lines.splice(50, 0, 'Error: Cannot find module "express"')
  lines.splice(60, 0, 'Warning: deprecated API used')

  const result = runHook({ tool_name: 'Bash', tool_response: lines.join('\n') })
  assert.ok(result.additionalContext, 'should compress')
  assert.ok(result.additionalContext.includes('Cannot find module'), 'should preserve error')
  assert.ok(result.additionalContext.includes('deprecated API'), 'should preserve warning')
})

test('collapses repeated identical lines', () => {
  const lines = ['Building...', ...Array(50).fill('processing chunk'), 'Done!']

  const result = runHook({ tool_name: 'Bash', tool_response: lines.join('\n') })
  assert.ok(result.additionalContext, 'should compress')
  assert.ok(result.additionalContext.includes('repeated'), 'should note repetition')
})

test('strips progress bars', () => {
  const lines = [
    'Downloading...',
    '[========>          ] 40%',
    '[===============>   ] 75%',
    '[====================] 100%',
    'Done!',
    ...Array.from({ length: 40 }, (_, i) => `extra line ${i}`),
  ]

  const result = runHook({ tool_name: 'Bash', tool_response: lines.join('\n') })
  assert.ok(!result.additionalContext?.includes('========'), 'should strip progress bars')
})

test('handles malformed JSON gracefully', () => {
  const result = execFileSync('node', [HOOK], {
    input: 'not json',
    encoding: 'utf-8',
    timeout: 5000,
  })
  assert.deepStrictEqual(JSON.parse(result.trim()), {})
})

test('truncates extremely long output', () => {
  const result = runHook({ tool_name: 'Bash', tool_response: 'x'.repeat(10000) })
  assert.ok(result.additionalContext, 'should compress')
  assert.ok(result.additionalContext.length < 3000, `should be under 3k`)
  assert.ok(result.additionalContext.includes('truncated'), 'should note truncation')
})

console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed > 0 ? 1 : 0)
