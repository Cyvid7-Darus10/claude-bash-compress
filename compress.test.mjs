import { execFileSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { strict as assert } from 'node:assert'

const __dirname = dirname(fileURLToPath(import.meta.url))
const HOOK = resolve(__dirname, 'compress.mjs')

function run(input) {
  const result = execFileSync('node', [HOOK], {
    input: JSON.stringify(input),
    encoding: 'utf-8',
    timeout: 5000,
  })
  return JSON.parse(result.trim())
}

let passed = 0, failed = 0

function test(name, fn) {
  try { fn(); passed++; console.log(`  ✓ ${name}`) }
  catch (e) { failed++; console.log(`  ✗ ${name}\n    ${e.message}`) }
}

console.log('\ncompress.mjs tests\n')

// ── Bash ──

test('Bash: passes through short output', () => {
  assert.deepStrictEqual(run({ tool_name: 'Bash', tool_response: 'ok' }), {})
})

test('Bash: compresses npm install', () => {
  const lines = Array.from({ length: 100 }, (_, i) => `pkg ${i}`)
  lines.push('added 245 packages in 12s', 'found 0 vulnerabilities')
  const r = run({ tool_name: 'Bash', tool_response: lines.join('\n') })
  assert.ok(r.additionalContext?.includes('added 245 packages'))
  assert.ok(r.additionalContext?.includes('compress: Bash'))
})

test('Bash: preserves error lines', () => {
  const lines = Array.from({ length: 80 }, (_, i) => `line ${i}`)
  lines.splice(40, 0, 'Error: ENOENT: no such file')
  const r = run({ tool_name: 'Bash', tool_response: lines.join('\n') })
  assert.ok(r.additionalContext?.includes('ENOENT'))
})

test('Bash: collapses repeated lines', () => {
  const lines = ['start', ...Array(50).fill('processing...'), 'done']
  const r = run({ tool_name: 'Bash', tool_response: lines.join('\n') })
  assert.ok(r.additionalContext?.includes('repeated'))
})

// ── Grep ──

test('Grep: passes through small results', () => {
  const lines = Array.from({ length: 10 }, (_, i) => `file${i}.ts:5: match`)
  assert.deepStrictEqual(run({ tool_name: 'Grep', tool_response: lines.join('\n') }), {})
})

test('Grep: truncates large result sets', () => {
  const lines = Array.from({ length: 100 }, (_, i) => `src/file${i}.ts:10: const foo = bar`)
  const r = run({ tool_name: 'Grep', tool_response: lines.join('\n') })
  assert.ok(r.additionalContext?.includes('100 total'))
  assert.ok(r.additionalContext?.includes('compress: Grep'))
})

// ── Glob ──

test('Glob: passes through short file lists', () => {
  const lines = Array.from({ length: 10 }, (_, i) => `src/file${i}.ts`)
  assert.deepStrictEqual(run({ tool_name: 'Glob', tool_response: lines.join('\n') }), {})
})

test('Glob: truncates long file lists', () => {
  const lines = Array.from({ length: 200 }, (_, i) => `src/components/deep/nested/file${i}.tsx`)
  const r = run({ tool_name: 'Glob', tool_response: lines.join('\n') })
  assert.ok(r.additionalContext?.includes('200 total'))
})

// ── Read (never compressed — Claude needs full content to edit) ──

test('Read: never compressed (small files)', () => {
  const content = Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n')
  assert.deepStrictEqual(run({ tool_name: 'Read', tool_response: content }), {})
})

test('Read: never compressed (large files)', () => {
  const lines = Array.from({ length: 300 }, (_, i) => `  ${i + 1}\tconst x${i} = "some value that makes this line longer for testing purposes"`)
  assert.deepStrictEqual(run({ tool_name: 'Read', tool_response: lines.join('\n') }), {})
})

// ── WebFetch ──

test('WebFetch: strips HTML and compresses', () => {
  const html = '<html><head><style>body{}</style></head><body>' +
    '<script>alert(1)</script>' +
    Array.from({ length: 60 }, (_, i) => `<p>Paragraph ${i} with content</p>`).join('') +
    '</body></html>'
  const r = run({ tool_name: 'WebFetch', tool_response: html })
  assert.ok(r.additionalContext)
  assert.ok(!r.additionalContext.includes('<script>'))
  assert.ok(!r.additionalContext.includes('<style>'))
})

// ── WebSearch ──

test('WebSearch: truncates long results', () => {
  const lines = Array.from({ length: 80 }, (_, i) => `Result ${i}: Some search result about topic ${i}`)
  const r = run({ tool_name: 'WebSearch', tool_response: lines.join('\n') })
  assert.ok(r.additionalContext?.includes('more lines omitted'))
})

test('WebSearch: passes through short results', () => {
  const lines = Array.from({ length: 10 }, (_, i) => `Result ${i}: short`)
  assert.deepStrictEqual(run({ tool_name: 'WebSearch', tool_response: lines.join('\n') }), {})
})

// ── Skipped tools ──

test('Edit: never compressed', () => {
  assert.deepStrictEqual(run({ tool_name: 'Edit', tool_response: 'x'.repeat(5000) }), {})
})

test('Write: never compressed', () => {
  assert.deepStrictEqual(run({ tool_name: 'Write', tool_response: 'x'.repeat(5000) }), {})
})

test('Agent: never compressed', () => {
  assert.deepStrictEqual(run({ tool_name: 'Agent', tool_response: 'x'.repeat(5000) }), {})
})

// ── Edge cases ──

test('handles malformed JSON', () => {
  const r = execFileSync('node', [HOOK], { input: 'bad', encoding: 'utf-8', timeout: 5000 })
  assert.deepStrictEqual(JSON.parse(r.trim()), {})
})

test('handles unknown tool with generic compression', () => {
  const lines = Array.from({ length: 100 }, (_, i) => `data line ${i}`)
  const r = run({ tool_name: 'SomeNewTool', tool_response: lines.join('\n') })
  assert.ok(r.additionalContext?.includes('lines omitted'))
})

test('truncates extremely long output', () => {
  const r = run({ tool_name: 'Bash', tool_response: 'x'.repeat(20000) })
  assert.ok(r.additionalContext?.length < 3000)
})

console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed > 0 ? 1 : 0)
