// End-to-end against the real SDK: a Server and Client over
// InMemoryTransport, the tool declares an outputSchema, and the client
// validates the structured result through the jsonSchemaValidator option.
//
// Run it twice; the second run is the one this provider exists for:
//
//   npm i --no-save @modelcontextprotocol/sdk @cfworker/json-schema
//   node e2e-sdk.mjs
//   node --disallow-code-generation-from-strings e2e-sdk.mjs
//
// With code generation allowed all three providers behave identically. With
// it blocked, the SDK's default provider fails the tool call even when the
// result is VALID; cfworker and ata keep answering.
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { AjvJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/ajv'
import { CfWorkerJsonSchemaValidator } from '@modelcontextprotocol/sdk/validation/cfworker'
import { createRequire } from 'node:module'
const require = createRequire(import.meta.url)
const { AtaJsonSchemaValidator } = require('@ata-project/mcp')

const outputSchema = {
  type: 'object',
  properties: {
    total: { type: 'number', minimum: 0 },
    currency: { type: 'string', minLength: 3, maxLength: 3 },
    lines: {
      type: 'array',
      items: {
        type: 'object',
        properties: { sku: { type: 'string' }, qty: { type: 'integer', minimum: 1 } },
        required: ['sku', 'qty'],
      },
    },
  },
  required: ['total', 'currency'],
}

async function runWith (name, makeValidator, misbehave) {
  const server = new Server({ name: 'quotes', version: '1.0.0' }, { capabilities: { tools: {} } })
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: [{ name: 'quote', description: 'price a basket', inputSchema: { type: 'object' }, outputSchema }],
  }))
  server.setRequestHandler(CallToolRequestSchema, async () => {
    const good = { total: 12.5, currency: 'EUR', lines: [{ sku: 'A1', qty: 2 }] }
    const bad = { total: -1, currency: 'EURO' }
    const payload = misbehave ? bad : good
    return { content: [{ type: 'text', text: JSON.stringify(payload) }], structuredContent: payload }
  })

  const opts = makeValidator ? { jsonSchemaValidator: makeValidator() } : undefined
  const client = new Client({ name: 'agent', version: '1.0.0' }, opts)
  const [ct, st] = InMemoryTransport.createLinkedPair()
  await Promise.all([server.connect(st), client.connect(ct)])
  try {
    await client.listTools()
    const r = await client.callTool({ name: 'quote', arguments: {} })
    return { ok: true, isError: !!r.isError }
  } catch (e) {
    return { ok: false, message: String(e.message).slice(0, 100) }
  } finally {
    await client.close()
    await server.close()
  }
}

const providers = [
  ['sdk default (ajv)', null],
  ['cfworker', () => new CfWorkerJsonSchemaValidator()],
  ['ata', () => new AtaJsonSchemaValidator()],
]

const codegen = (() => { try { new Function('return 1'); return true } catch { return false } })()
console.log('code generation:', codegen ? 'allowed' : 'blocked')

for (const [name, make] of providers) {
  let good, bad
  try { good = await runWith(name, make, false) } catch (e) { good = { ok: false, message: String(e.message).slice(0, 100) } }
  try { bad = await runWith(name, make, true) } catch (e) { bad = { ok: false, message: String(e.message).slice(0, 100) } }
  const verdictGood = good.ok ? 'accepted' : `THREW: ${good.message}`
  const verdictBad = bad.ok ? 'ACCEPTED (wrong)' : 'rejected'
  console.log(`${name.padEnd(20)} valid output: ${verdictGood} | invalid output: ${verdictBad}${bad.ok ? '' : ' (' + bad.message.slice(0, 60) + ')'}`)
}
