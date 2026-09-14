'use strict'

// A JSON Schema validation provider for the Model Context Protocol
// TypeScript SDK.
//
// The SDK validates tool call arguments against the tool's `inputSchema`, and
// exposes `jsonSchemaValidator` as the extension point for doing that. It
// ships two providers of its own: one on ajv, and one on @cfworker/json-schema
// for Cloudflare Workers, because ajv compiles a schema with `new Function`
// and edge runtimes do not allow it.
//
// This is a third. ata needs no code generation either, so it runs in the same
// places the cfworker provider was added for, and it can also compile a schema
// ahead of time into a module that imports nothing, which is the form that
// suits a Worker deployment best.
//
// The interface is structural, so nothing here imports the SDK. The only
// dependency is the validator.
//
//   import { AtaJsonSchemaValidator } from '@ata-project/mcp'
//   const server = new McpServer(info, { validator: new AtaJsonSchemaValidator() })

const { Validator } = require('ata-validator')
const { schemaKey } = require('./build.js')

// The SDK's own providers report `<instanceLocation>: <error>` joined with
// '; ', which is the specification's output wording. Matching it means
// swapping providers does not change the strings an agent already sees.
function terse (errors) {
  return errors.map((e) => `${e.instancePath || ''}: ${e.message}`).join('; ')
}

// The other option, and the reason to think about this at all: a tool call
// that fails validation usually goes back to the model to be retried, so the
// message is not a log line, it is part of the next prompt. The terse form
// says a value was wrong. This one says what was expected and what arrived,
// which is what a model needs in order to fix it rather than guess.
// Read the value the error is about out of the document. The error object
// does not carry it, and it is the half a model needs most: "you sent
// Hamburg office" is actionable, "this field is wrong" is not.
function valueAt (input, instancePath) {
  if (!instancePath) return input
  let node = input
  for (const raw of instancePath.split('/').slice(1)) {
    const key = raw.replace(/~1/g, '/').replace(/~0/g, '~')
    if (node === null || typeof node !== 'object') return undefined
    node = Array.isArray(node) ? node[Number(key)] : node[key]
  }
  return node
}

// A self-sufficient line built from `params`, for the errors that come out of
// a compiled standalone module. Those carry `params` but not the `detail` the
// runtime engine attaches, and `params` is where the decisive information
// lives: the allowed values, the rejected property, the missing one.
function fromParams (e) {
  const p = e.params || {}
  if (e.keyword === 'enum' && Array.isArray(p.allowedValues)) {
    return 'expected one of [' + p.allowedValues.map((v) => JSON.stringify(v)).join(', ') + ']'
  }
  if (e.keyword === 'additionalProperties' && p.additionalProperty !== undefined) {
    return 'unknown property ' + JSON.stringify(p.additionalProperty)
  }
  if (e.keyword === 'required' && p.missingProperty !== undefined) {
    return 'missing required property ' + JSON.stringify(p.missingProperty)
  }
  if (e.keyword === 'type' && p.type !== undefined) {
    return 'expected ' + (Array.isArray(p.type) ? p.type.join(' or ') : p.type)
  }
  return e.message
}

// The other option, and the reason to think about this at all: a tool call
// that fails validation usually goes back to the model to be retried, so the
// message is not a log line, it is part of the next prompt. The terse form
// says a value was wrong. This one says what was expected and what arrived,
// which is what a model needs in order to fix it rather than guess.
//
// It reads the same on both providers. The runtime engine attaches `detail`
// and `received`; a compiled module carries neither, so those are rebuilt from
// `params` and from the document itself.
function detailed (errors, input) {
  return errors.map((e) => {
    const where = e.instancePath || e.path || ''
    const body = typeof e.detail === 'string' && e.detail ? e.detail : fromParams(e)
    let raw = e.received === undefined || e.received === null ? '' : String(e.received)
    if (!raw && input !== undefined) {
      const v = valueAt(input, e.instancePath || '')
      if (v !== undefined && (v === null || typeof v !== 'object')) raw = JSON.stringify(v)
    }
    const useless = /^\[(object|array)\b/.test(raw)
    const got = !useless && raw && body && !body.includes(raw) ? `, found ${raw}` : ''
    return `${where || '/'}: ${body}${got}`
  }).join('; ')
}

class AtaJsonSchemaValidator {
  /**
   * options.allErrors  report every failure instead of stopping at the first
   *                    (default false, matching the SDK's other providers)
   * options.detailed   error messages name the expectation and the value that
   *                    arrived (default false, which matches the SDK's wording)
   * options.formats    custom format checkers, passed through to ata
   */
  constructor (options) {
    const opts = options || {}
    this.allErrors = opts.allErrors === true
    this.detailed = opts.detailed === true
    this.formats = opts.formats
    // One compiled validator per schema object. Tools register their schema
    // once and call it for every request, so this is the shape that matters.
    this._cache = new WeakMap()
  }

  getValidator (schema) {
    let validator = null
    if (schema !== null && typeof schema === 'object') validator = this._cache.get(schema) || null
    if (validator === null) {
      // The terse message is `<instancePath>: <message>`, which needs none of
      // the enrichment ata adds by default (the received value, suggestions,
      // source frames). Turning it off costs nothing here and measured 303 ns
      // against 696 ns on the failing path, which is the path that matters:
      // it is the one that builds a string. `detailed` reads the received
      // value, so it keeps enrichment on.
      validator = new Validator(schema, {
        abortEarly: false,
        richErrors: this.detailed,
        formats: this.formats,
      })
      if (schema !== null && typeof schema === 'object') this._cache.set(schema, validator)
    }
    const render = this.detailed ? detailed : terse
    const all = this.allErrors
    return (input) => {
      const result = validator.validate(input)
      if (result.valid) return { valid: true, data: input, errorMessage: undefined }
      const errors = all ? result.errors : result.errors.slice(0, 1)
      return { valid: false, data: undefined, errorMessage: render(errors, input) }
    }
  }
}

// The ahead-of-time provider. Same interface, but `getValidator` looks up a
// validator that was compiled at build time instead of compiling one now.
//
// Why it exists: measured on five tool schemas, the runtime provider costs
// about 85 KB gzipped in a Worker bundle and 12 ms of cold start, against
// 0.74 ms for compiled modules. A Worker isolate cold starts often, and the
// per-call microseconds the runtime path wins are invisible next to a model
// round trip. On a Node server the runtime provider is the simpler choice and
// this one is unnecessary.
//
//   import tools from './compiled/index.mjs'
//   new McpServer(info, { validator: new AtaAotJsonSchemaValidator(tools) })
//
// Lookup is by a hash of the schema, so a tool whose schema changed without
// the build being re-run misses rather than validating against the old one.
class AtaAotJsonSchemaValidator {
  /**
   * options.onMissing  'throw' (default) or 'compile'. A schema with no
   *                    compiled validator is a build that is out of step, and
   *                    the default says so. 'compile' falls back to compiling
   *                    at run time, which needs code generation and will not
   *                    work in the runtime this was built for.
   * options.detailed   as above
   * options.allErrors  as above
   */
  constructor (compiled, options) {
    if (!compiled || typeof compiled !== 'object') {
      throw new TypeError('AtaAotJsonSchemaValidator: pass the index generated by compileTools()')
    }
    const opts = options || {}
    this._compiled = compiled
    this._onMissing = opts.onMissing === 'compile' ? 'compile' : 'throw'
    this._fallback = new AtaJsonSchemaValidator(opts)
    this.detailed = opts.detailed === true
    this.allErrors = opts.allErrors === true
  }

  getValidator (schema) {
    const entry = this._compiled[schemaKey(schema)]
    if (!entry) {
      if (this._onMissing === 'compile') return this._fallback.getValidator(schema)
      const names = Object.values(this._compiled).map((e) => e.name).join(', ')
      throw new Error(
        'AtaAotJsonSchemaValidator: no compiled validator for this schema. ' +
        'Re-run the build step; a schema that changed after it was compiled will not match. ' +
        (names ? `Compiled: ${names}.` : 'Nothing is compiled.'),
      )
    }
    const mod = entry.module && entry.module.default ? entry.module.default : entry.module
    const render = this.detailed ? detailed : terse
    const all = this.allErrors
    return (input) => {
      const result = mod.validate(input)
      if (result.valid) return { valid: true, data: input, errorMessage: undefined }
      const errors = all ? result.errors : result.errors.slice(0, 1)
      return { valid: false, data: undefined, errorMessage: render(errors, input) }
    }
  }
}

module.exports = { AtaJsonSchemaValidator, AtaAotJsonSchemaValidator }
