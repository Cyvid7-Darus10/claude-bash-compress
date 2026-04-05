import { execFileSync } from 'node:child_process'
import { resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { strict as assert } from 'node:assert'
import { rmSync } from 'node:fs'
import { homedir } from 'node:os'

const __dirname = dirname(fileURLToPath(import.meta.url))
const HOOK = resolve(__dirname, 'compress.mjs')
const STATE_DIR = resolve(homedir(), '.claude-savings')

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

// Clean state between test runs
try { rmSync(STATE_DIR, { recursive: true, force: true }) } catch {}

console.log('\nclaude-savings tests\n')
console.log('── Output Compression ──')

test('Bash: passes through short output', () => {
  assert.deepStrictEqual(run({ tool_name: 'Bash', tool_response: 'ok' }), {})
})

test('Bash: compresses npm install', () => {
  const lines = Array.from({ length: 100 }, (_, i) => `pkg ${i}`)
  lines.push('added 245 packages in 12s', 'found 0 vulnerabilities')
  const r = run({ tool_name: 'Bash', tool_response: lines.join('\n') })
  assert.ok(r.additionalContext?.includes('added 245 packages'))
})

test('Bash: preserves error lines', () => {
  const lines = Array.from({ length: 80 }, (_, i) => `line ${i}`)
  lines.splice(40, 0, 'Error: ENOENT: no such file')
  const r = run({ tool_name: 'Bash', tool_response: lines.join('\n') })
  assert.ok(r.additionalContext?.includes('ENOENT'))
})

test('Bash: collapses node_modules stack frames', () => {
  const lines = [
    'TypeError: Cannot read property "id" of undefined',
    '    at getUserProfile (src/users.ts:47:12)',
    '    at processAuth (src/auth.ts:12:5)',
    '    at Layer.handle (node_modules/express/lib/router/layer.js:95:5)',
    '    at next (node_modules/express/lib/router/route.js:144:13)',
    '    at Route.dispatch (node_modules/express/lib/router/route.js:114:3)',
    '    at Layer.handle (node_modules/express/lib/router/layer.js:95:5)',
    '    at Function.process_params (node_modules/express/lib/router/index.js:346:12)',
    '    at next (node_modules/express/lib/router/index.js:280:10)',
    '    at expressInit (node_modules/express/lib/middleware/init.js:40:5)',
    '    at Layer.handle (node_modules/express/lib/router/layer.js:95:5)',
    ...Array.from({ length: 30 }, (_, i) => `    at internal/modules/run_main:${i}`),
    'Process exited with code 1',
  ]
  const r = run({ tool_name: 'Bash', tool_response: lines.join('\n') })
  assert.ok(r.additionalContext, 'should compress')
  assert.ok(r.additionalContext.includes('getUserProfile'), 'should keep app frames')
  assert.ok(r.additionalContext.includes('processAuth'), 'should keep app frames')
  assert.ok(r.additionalContext.includes('framework frames hidden'), 'should collapse node_modules')
  assert.ok(!r.additionalContext.includes('Layer.handle'), 'should not include framework frames')
})

test('Bash: collapses repeated lines', () => {
  const lines = ['start', ...Array(50).fill('processing...'), 'done']
  const r = run({ tool_name: 'Bash', tool_response: lines.join('\n') })
  assert.ok(r.additionalContext?.includes('repeated'))
})

test('Grep: passes through small results', () => {
  const lines = Array.from({ length: 10 }, (_, i) => `file${i}.ts:5: match`)
  assert.deepStrictEqual(run({ tool_name: 'Grep', tool_response: lines.join('\n') }), {})
})

test('Grep: truncates large result sets', () => {
  const lines = Array.from({ length: 100 }, (_, i) => `src/file${i}.ts:10: const foo = bar`)
  const r = run({ tool_name: 'Grep', tool_response: lines.join('\n') })
  assert.ok(r.additionalContext?.includes('100 total'))
})

test('Glob: truncates long file lists', () => {
  const lines = Array.from({ length: 200 }, (_, i) => `src/components/file${i}.tsx`)
  const r = run({ tool_name: 'Glob', tool_response: lines.join('\n') })
  assert.ok(r.additionalContext?.includes('200 total'))
})

test('WebFetch: strips HTML and compresses', () => {
  const html = '<html><head><style>body{}</style></head><body>' +
    '<script>alert(1)</script>' +
    Array.from({ length: 60 }, (_, i) => `<p>Paragraph ${i}</p>`).join('') +
    '</body></html>'
  const r = run({ tool_name: 'WebFetch', tool_response: html })
  assert.ok(r.additionalContext)
  assert.ok(!r.additionalContext.includes('<script>'))
})

test('WebSearch: truncates long results', () => {
  const lines = Array.from({ length: 80 }, (_, i) => `Result ${i}: Some search result`)
  const r = run({ tool_name: 'WebSearch', tool_response: lines.join('\n') })
  assert.ok(r.additionalContext?.includes('more lines omitted'))
})

test('Read: never compressed', () => {
  const lines = Array.from({ length: 300 }, (_, i) => `const x${i} = "value that pads the line"`)
  assert.deepStrictEqual(run({ tool_name: 'Read', tool_response: lines.join('\n') }), {})
})

test('Edit/Write/Agent: never compressed', () => {
  assert.deepStrictEqual(run({ tool_name: 'Edit', tool_response: 'x'.repeat(5000) }), {})
  assert.deepStrictEqual(run({ tool_name: 'Write', tool_response: 'x'.repeat(5000) }), {})
  assert.deepStrictEqual(run({ tool_name: 'Agent', tool_response: 'x'.repeat(5000) }), {})
})

test('handles malformed JSON', () => {
  const r = execFileSync('node', [HOOK], { input: 'bad', encoding: 'utf-8', timeout: 5000 })
  assert.deepStrictEqual(JSON.parse(r.trim()), {})
})

console.log('\n── Loop Detection ──')

// Clean state for loop tests
try { rmSync(STATE_DIR, { recursive: true, force: true }) } catch {}

test('no warning on first two identical calls', () => {
  const input = { tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: 'FAIL', session_id: 'loop-test-1' }
  const r1 = run(input)
  const r2 = run(input)
  assert.ok(!r1.additionalContext?.includes('LOOP'), 'first call should not warn')
  assert.ok(!r2.additionalContext?.includes('LOOP'), 'second call should not warn')
})

test('warns on third identical call', () => {
  const input = { tool_name: 'Bash', tool_input: { command: 'npm test' }, tool_response: 'FAIL', session_id: 'loop-test-2' }
  run(input)
  run(input)
  const r3 = run(input)
  assert.ok(r3.additionalContext?.includes('LOOP DETECTED'), 'third call should warn')
  assert.ok(r3.additionalContext?.includes('npm test'), 'should mention the command')
})

test('resets count when command changes', () => {
  const base = { tool_name: 'Bash', tool_response: 'ok', session_id: 'loop-test-3' }
  run({ ...base, tool_input: { command: 'npm test' } })
  run({ ...base, tool_input: { command: 'npm test' } })
  run({ ...base, tool_input: { command: 'npm run build' } }) // different command
  const r = run({ ...base, tool_input: { command: 'npm test' } })
  // Count reset — should not warn (only 1st call of npm test after reset)
  assert.ok(!r.additionalContext?.includes('LOOP'), 'should not warn after command change')
})

console.log('\n── Duplicate Read Tracking ──')

// Clean state for dup tests
try { rmSync(STATE_DIR, { recursive: true, force: true }) } catch {}

test('no warning on first read', () => {
  const r = run({
    tool_name: 'Read',
    tool_input: { file_path: '/project/src/index.ts' },
    tool_response: 'x'.repeat(2000),
    session_id: 'dup-test-1',
  })
  assert.ok(!r.additionalContext?.includes('DUPLICATE'))
})

test('warns on second read of same file', () => {
  const input = {
    tool_name: 'Read',
    tool_input: { file_path: '/project/src/app.ts' },
    tool_response: 'x'.repeat(2000),
    session_id: 'dup-test-2',
  }
  run(input)
  const r2 = run(input)
  assert.ok(r2.additionalContext?.includes('DUPLICATE READ'), 'should warn on re-read')
  assert.ok(r2.additionalContext?.includes('app.ts'), 'should mention the file')
})

test('no warning for small files (<1k)', () => {
  const input = {
    tool_name: 'Read',
    tool_input: { file_path: '/project/package.json' },
    tool_response: '{"name": "test"}',
    session_id: 'dup-test-3',
  }
  run(input)
  const r2 = run(input)
  assert.ok(!r2.additionalContext?.includes('DUPLICATE'), 'small files should not warn')
})

test('warns only once (not on 3rd, 4th read)', () => {
  const input = {
    tool_name: 'Read',
    tool_input: { file_path: '/project/src/repeat.ts' },
    tool_response: 'x'.repeat(2000),
    session_id: 'dup-test-4',
  }
  run(input)        // 1st — no warn
  run(input)        // 2nd — warn
  const r3 = run(input)  // 3rd — should NOT warn again
  assert.ok(!r3.additionalContext?.includes('DUPLICATE'), '3rd read should not re-warn')
})

// Final cleanup
try { rmSync(STATE_DIR, { recursive: true, force: true }) } catch {}

console.log(`\n${passed} passed, ${failed} failed\n`)
process.exit(failed > 0 ? 1 : 0)
