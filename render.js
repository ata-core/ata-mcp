'use strict'

// The two message renderers, shared by the runtime provider (index.js) and
// the ahead-of-time one (aot.js). This module imports nothing, so the
// ahead-of-time entry carries nothing but itself into a Worker bundle.

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

module.exports = { terse, detailed }
