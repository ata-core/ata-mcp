// Measured in the environment this provider exists for: code generation off.
// ajv is included only to show what happens to it there, which is the reason
// the SDK carries a second provider at all.
//
// Rounds are interleaved rather than run back to back, so a slow moment on the
// machine lands on both contenders instead of one.

import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { AtaJsonSchemaValidator } = require('./index.js')

const SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['query', 'limit'],
  properties: {
    query: { type: 'string', minLength: 1, maxLength: 200 },
    limit: { type: 'integer', minimum: 1, maximum: 100 },
    filters: {
      type: 'array', maxItems: 10,
      items: { type: 'object', required: ['field', 'op'], properties: { field: { type: 'string' }, op: { enum: ['eq', 'lt', 'gt'] }, value: {} } },
    },
    dryRun: { type: 'boolean' },
  },
}
const GOOD = { query: 'invoices from march', limit: 25, filters: [{ field: 'total', op: 'gt', value: 100 }], dryRun: false }
const BAD = { query: 'invoices', limit: 250, filters: [{ field: 'total', op: 'between' }] }

const providers = []
providers.push(['ata', () => new AtaJsonSchemaValidator()])
try {
  const { Validator } = require('@cfworker/json-schema')
  providers.push(['cfworker', () => ({
    getValidator (s) { const v = new Validator(s, '2020-12', true); return (i) => (v.validate(i).valid ? { valid: true } : { valid: false }) },
  })])
} catch {}
try {
  const Ajv = require('ajv')
  providers.push(['ajv', () => { const a = new Ajv(); return { getValidator (s) { const f = a.compile(s); return (i) => ({ valid: f(i) }) } } }])
} catch {}

const codegen = (() => { try { new Function('return 1'); return true } catch { return false } })()
console.log(`code generation: ${codegen ? 'allowed' : 'blocked'}\n`)

const N = 20000
const ROUNDS = 7
const results = new Map()

for (const [name] of providers) results.set(name, { good: [], bad: [], failed: null })

for (let round = 0; round < ROUNDS; round++) {
  for (const [name, build] of providers) {
    const slot = results.get(name)
    if (slot.failed) continue
    let validate
    try {
      validate = build().getValidator(SCHEMA)
      validate(GOOD)
    } catch (e) {
      slot.failed = e.constructor.name + ': ' + e.message.split('\n')[0].slice(0, 60)
      continue
    }
    for (const [key, input] of [['good', GOOD], ['bad', BAD]]) {
      for (let i = 0; i < 2000; i++) validate(input)
      const t = process.hrtime.bigint()
      for (let i = 0; i < N; i++) validate(input)
      slot[key].push(Number(process.hrtime.bigint() - t) / N)
    }
  }
}

const median = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[s.length >> 1] }
console.log('provider    valid       invalid')
for (const [name] of providers) {
  const s = results.get(name)
  if (s.failed) { console.log(`${name.padEnd(11)} ${s.failed}`); continue }
  console.log(`${name.padEnd(11)} ${median(s.good).toFixed(0).padStart(5)} ns   ${median(s.bad).toFixed(0).padStart(5)} ns`)
}
