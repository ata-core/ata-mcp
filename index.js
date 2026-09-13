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
function detailed (errors) {
  return errors.map((e) => {
    const where = e.instancePath || ''
    const detail = e.detail || e.message
    // ata's own detail usually quotes the offending value already. Appending
    // it again reads like a stutter, and this string is going into a prompt.
    const received = e.received === undefined ? '' : String(e.received)
    const got = received && !detail.includes(received) ? `, got ${received}` : ''
    return `${where}: ${detail}${got}`
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
      return { valid: false, data: undefined, errorMessage: render(errors) }
    }
  }
}

module.exports = { AtaJsonSchemaValidator }
