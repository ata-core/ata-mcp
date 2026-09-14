'use strict'

// Two things are being checked.
//
// The contract: the MCP SDK expects `getValidator(schema)` to return a
// function giving `{valid:true,data,errorMessage:undefined}` or
// `{valid:false,data:undefined,errorMessage:string}`, callable many times.
//
// The behaviour: this has to be a drop-in for the providers the SDK already
// ships, so its verdicts are compared against both of them over a corpus of
// tool input schemas. A provider that quietly accepts a tool call the others
// reject would be worse than no provider at all.

const assert = require('node:assert')
const { spawnSync } = require('node:child_process')
const { AtaJsonSchemaValidator, AtaAotJsonSchemaValidator } = require('./index.js')
const { compileTools, schemaKey } = require('./build.js')
const os = require('node:os')
const path = require('node:path')
const fs = require('node:fs')

// The SDK's two providers, reproduced from its source so the comparison does
// not need the SDK installed.
function cfworkerProvider () {
  const { Validator } = require('@cfworker/json-schema')
  return {
    getValidator (schema) {
      const v = new Validator(schema, '2020-12', true)
      return (input) => {
        const r = v.validate(input)
        return r.valid
          ? { valid: true, data: input, errorMessage: undefined }
          : { valid: false, data: undefined, errorMessage: r.errors.map((e) => `${e.instanceLocation}: ${e.error}`).join('; ') }
      }
    },
  }
}

function ajvProvider () {
  const Ajv = require('ajv')
  const ajv = new Ajv()
  return {
    getValidator (schema) {
      const fn = ajv.compile(schema)
      return (input) => (fn(input)
        ? { valid: true, data: input, errorMessage: undefined }
        : { valid: false, data: undefined, errorMessage: ajv.errorsText(fn.errors) })
    },
  }
}

// Tool input schemas of the shape MCP servers actually declare.
const SCHEMAS = [
  { type: 'object', properties: { path: { type: 'string' } }, required: ['path'], additionalProperties: false },
  { type: 'object', properties: { query: { type: 'string', minLength: 1 }, limit: { type: 'integer', minimum: 1, maximum: 100 } }, required: ['query'] },
  { type: 'object', properties: { mode: { enum: ['read', 'write', 'append'] } }, required: ['mode'] },
  { type: 'object', properties: { files: { type: 'array', items: { type: 'string' }, minItems: 1 } }, required: ['files'] },
  { type: 'object', properties: { config: { type: 'object', properties: { retries: { type: 'integer', minimum: 0 } }, required: ['retries'] } } },
  { type: 'object', properties: { when: { type: 'string', format: 'date-time' } } },
  { type: 'object', properties: { id: { type: ['string', 'null'] } } },
  { type: 'object', properties: { a: { type: 'number', multipleOf: 0.5 } } },
  { type: 'object', properties: { tags: { type: 'array', items: { type: 'string' }, uniqueItems: true } } },
  { type: 'object', properties: { choice: { anyOf: [{ type: 'string' }, { type: 'number' }] } } },
]

const ARGS = [
  {}, { path: 'a/b.txt' }, { path: 42 }, { path: 'x', extra: 1 },
  { query: '', limit: 5 }, { query: 'hi', limit: 0 }, { query: 'hi', limit: 101 }, { query: 'hi' },
  { mode: 'read' }, { mode: 'delete' },
  { files: [] }, { files: ['a'] }, { files: [1] },
  { config: { retries: 0 } }, { config: {} }, { config: { retries: -1 } },
  { when: '2026-01-01T00:00:00Z' }, { when: 'yesterday' },
  { id: null }, { id: 'x' }, { id: 7 },
  { a: 1.5 }, { a: 1.2 },
  { tags: ['a', 'a'] }, { tags: ['a', 'b'] },
  { choice: 'x' }, { choice: 1 }, { choice: true },
]

if (process.argv.includes('--verdicts')) {
  const provider = new AtaJsonSchemaValidator()
  const out = []
  for (const schema of SCHEMAS) {
    const validate = provider.getValidator(schema)
    for (const args of ARGS) out.push(validate(args).valid ? '1' : '0')
  }
  process.stdout.write(out.join(''))
  return
}

let checks = 0
function ok (name, cond) { assert.strictEqual(cond, true, name); checks++ }

// --- contract ---------------------------------------------------------------
{
  const provider = new AtaJsonSchemaValidator()
  const validate = provider.getValidator({ type: 'object', properties: { n: { type: 'number' } }, required: ['n'] })

  const good = validate({ n: 1 })
  ok('accepts and returns the input as data', good.valid === true && good.data.n === 1)
  ok('no errorMessage when valid', good.errorMessage === undefined)

  const bad = validate({ n: 'x' })
  ok('rejects', bad.valid === false)
  ok('no data when invalid', bad.data === undefined)
  ok('errorMessage is a non-empty string', typeof bad.errorMessage === 'string' && bad.errorMessage.length > 0)

  ok('the validator is reusable', validate({ n: 2 }).valid === true && validate({}).valid === false)

  const schema = { type: 'object', properties: { n: { type: 'number' } } }
  ok('same schema object returns a working validator each time',
    provider.getValidator(schema)({ n: 1 }).valid === true && provider.getValidator(schema)({ n: 'x' }).valid === false)
}

// --- the detailed option ----------------------------------------------------
{
  const terse = new AtaJsonSchemaValidator().getValidator({ type: 'object', properties: { mode: { enum: ['read', 'write'] } } })
  const rich = new AtaJsonSchemaValidator({ detailed: true }).getValidator({ type: 'object', properties: { mode: { enum: ['read', 'write'] } } })
  const t = terse({ mode: 'delete' }).errorMessage
  const r = rich({ mode: 'delete' }).errorMessage
  ok('terse message names the location', t.includes('/mode'))
  // The reason the option exists: a failed tool call goes back to the model,
  // and a message that lists the allowed values can be acted on.
  ok('detailed message names the allowed values', /read/.test(r) && /write/.test(r))
  ok('detailed message names what arrived', /delete/.test(r))
}

// --- allErrors --------------------------------------------------------------
{
  const schema = { type: 'object', properties: { a: { type: 'number' }, b: { type: 'number' } }, required: ['a', 'b'] }
  const one = new AtaJsonSchemaValidator().getValidator(schema)({})
  const all = new AtaJsonSchemaValidator({ allErrors: true }).getValidator(schema)({})
  ok('default reports one failure', one.errorMessage.split(';').length === 1)
  ok('allErrors reports more', all.errorMessage.split(';').length > 1)
}

// --- drop-in: the same verdicts as the providers the SDK ships ---------------
for (const [name, build] of [['cfworker', cfworkerProvider], ['ajv', ajvProvider]]) {
  let other
  try { other = build() } catch { console.log(`  (${name} not installed, comparison skipped)`); continue }
  const mine = new AtaJsonSchemaValidator()
  const disagreements = []
  for (const schema of SCHEMAS) {
    let a, b
    try { a = mine.getValidator(schema) } catch (e) { disagreements.push(`ata threw compiling ${JSON.stringify(schema)}: ${e.message}`); continue }
    try { b = other.getValidator(schema) } catch { continue }
    for (const args of ARGS) {
      const mineValid = a(args).valid
      const otherValid = b(args).valid
      if (mineValid !== otherValid) {
        disagreements.push(`${JSON.stringify(schema)} with ${JSON.stringify(args)}: ata=${mineValid} ${name}=${otherValid}`)
      }
    }
  }
  if (disagreements.length) {
    console.error(`FAIL: ${disagreements.length} verdicts differ from ${name}`)
    for (const d of disagreements.slice(0, 8)) console.error('  ' + d)
    process.exit(1)
  }
  ok(`same verdicts as the ${name} provider on ${SCHEMAS.length * ARGS.length} calls`, true)
}

// --- the reason this provider exists ---------------------------------------
// ajv compiles with `new Function`, which edge runtimes and a strict CSP do
// not allow. That is why the SDK carries a cfworker provider at all. This has
// to answer identically with code generation switched off.
{
  const run = (flags) => spawnSync(process.execPath, [...flags, __filename, '--verdicts'], { encoding: 'utf8' })
  const normal = run([])
  const blocked = run(['--disallow-code-generation-from-strings'])
  ok('runs with code generation blocked', blocked.status === 0)
  ok('identical verdicts with code generation blocked', normal.stdout === blocked.stdout && normal.stdout.length > 0)
}

// --- the ahead-of-time provider ---------------------------------------------
// On an edge runtime the runtime provider is the wrong half: measured on five
// tool schemas it costs about 85 KB gzipped and 12 ms of cold start, against
// 0.74 ms for compiled modules. What is checked here is that the compiled path
// answers the same way, says so when a schema was never compiled, and produces
// the same message as the runtime path.
{
  const TOOLS = {
    pick: {
      type: 'object', additionalProperties: false, required: ['status'],
      properties: { status: { enum: ['AWAITING_CLEARANCE', 'PART_SETTLED', 'CLOSED_OUT'] } },
    },
    search: {
      type: 'object', additionalProperties: false, required: ['query'],
      properties: { query: { type: 'string', minLength: 1 }, limit: { type: 'integer', minimum: 1, maximum: 100 } },
    },
  }
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ata-mcp-'))
  const built = require('node:child_process').spawnSync(process.execPath, ['-e', `
    const { compileTools } = require(${JSON.stringify(require.resolve('./build.js'))})
    compileTools({ tools: ${JSON.stringify(TOOLS)}, outDir: ${JSON.stringify(outDir)}, format: 'cjs' })
      .then((r) => process.stdout.write(JSON.stringify(r)))
  `], { encoding: 'utf8' })
  const result = JSON.parse(built.stdout || '{}')
  ok('both tools compiled', Array.isArray(result.compiled) && result.compiled.length === 2)
  ok('nothing was declined', Array.isArray(result.declined) && result.declined.length === 0)

  const index = require(result.index)
  const aot = new AtaAotJsonSchemaValidator(index, { detailed: true })
  const pick = aot.getValidator(TOOLS.pick)
  ok('the compiled validator accepts', pick({ status: 'CLOSED_OUT' }).valid === true)
  ok('the compiled validator rejects', pick({ status: 'paid in part' }).valid === false)

  // The whole point of the detailed form, and it has to survive compilation:
  // a standalone module carries `params` but not the `detail` the runtime
  // engine attaches, so the message is rebuilt from params and the document.
  const aotMsg = pick({ status: 'paid in part' }).errorMessage
  const rtMsg = new AtaJsonSchemaValidator({ detailed: true }).getValidator(TOOLS.pick)({ status: 'paid in part' }).errorMessage
  ok('the compiled path names every allowed value',
    ['AWAITING_CLEARANCE', 'PART_SETTLED', 'CLOSED_OUT'].every((v) => aotMsg.includes(v)))
  ok('the compiled path names what arrived', aotMsg.includes('paid in part'))
  ok('both providers word it identically', aotMsg === rtMsg)

  // A schema nobody compiled is a build that is out of step. Saying so beats
  // validating against the wrong thing or silently letting it through.
  let threw = null
  try { aot.getValidator({ type: 'object', properties: { nope: { type: 'string' } } }) } catch (e) { threw = e }
  ok('an uncompiled schema is refused', threw !== null && /no compiled validator/.test(threw.message))
  ok('the refusal names what is compiled', /pick/.test(threw.message) && /search/.test(threw.message))

  // Key order is not significant in JSON Schema, so the lookup cannot depend
  // on it. It hashes a canonical form for that reason.
  const reordered = { properties: TOOLS.search.properties, required: ['query'], additionalProperties: false, type: 'object' }
  ok('the lookup ignores key order', schemaKey(reordered) === schemaKey(TOOLS.search))
  ok('a reordered schema still resolves', aot.getValidator(reordered)({ query: 'hi' }).valid === true)

  fs.rmSync(outDir, { recursive: true, force: true })
}

console.log(`ata-mcp: ${checks} checks passed`)
