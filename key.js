'use strict'

// The lookup key of a compiled validator: a hash of the schema's canonical
// form. In a module of its own, with no dependency, because the ahead-of-time
// provider needs it on a Worker, where build.js's `node:fs` does not resolve.

// Key ordering is not significant in JSON Schema, so the canonical form sorts
// it. Two schemas that differ only in key order compile to the same validator
// and must hash the same.
function canonical (value) {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']'
  if (value && typeof value === 'object') {
    const keys = Object.keys(value).sort()
    return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(value[k])).join(',') + '}'
  }
  return JSON.stringify(value === undefined ? null : value)
}

// FNV-1a over the canonical form. Not a security boundary, just a stable key,
// and synchronous everywhere including a Worker, which WebCrypto is not.
function schemaKey (schema) {
  const s = canonical(schema)
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193) >>> 0
  }
  return h.toString(16).padStart(8, '0') + s.length.toString(16)
}

module.exports = { schemaKey }
