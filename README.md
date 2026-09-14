# @ata-project/mcp

A JSON Schema validation provider for the [Model Context Protocol][mcp]
TypeScript SDK, for runtimes that do not allow code generation.

## Why this exists

The MCP SDK validates tool call arguments against each tool's `inputSchema`,
and exposes `jsonSchemaValidator` as the extension point for how that is done.
It ships two providers: one on ajv, and one on `@cfworker/json-schema`. The
second one is there because ajv compiles a schema with `new Function`, and
Cloudflare Workers, Vercel Edge and anything under a strict CSP do not allow
that.

This is a third provider for the same slot. It needs no code generation either,
and it is faster in that environment.

## Use

```js
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { AtaJsonSchemaValidator } from '@ata-project/mcp'

const server = new McpServer(
  { name: 'my-server', version: '1.0.0' },
  { validator: new AtaJsonSchemaValidator() }
)
```

Nothing here imports the SDK. The interface is structural, so the only
dependency is the validator itself.

## On an edge runtime, compile first

The provider above compiles each tool's schema on first use. That is the right
trade on a server and the wrong one on a Worker, where an isolate cold starts
often and the per-call microseconds are invisible next to a model round trip.

Five tool schemas, minified and gzipped, and cold start measured as module
evaluation plus the first validation in a fresh process:

| | bundle | cold start |
|---|---|---|
| compiled ahead of time | 6.6 kB | 0.74 ms |
| cfworker provider | 6.4 kB | 1.36 ms |
| this provider at runtime | 85 kB | 12.07 ms |

So compile the tools at build time and serve them:

```js
// build step
import { compileTools } from '@ata-project/mcp/build'

await compileTools({
  tools: { search: searchSchema, send_email: sendEmailSchema },
  outDir: './compiled',
})
```

```js
// worker
import { AtaAotJsonSchemaValidator } from '@ata-project/mcp'
import tools from './compiled/index.mjs'

const server = new McpServer(info, { validator: new AtaAotJsonSchemaValidator(tools) })
```

The lookup is by a hash of the schema rather than by name or by object
identity. A name has to be kept in step by hand and identity does not survive a
bundler, while the hash comes from the schema itself: if the server declares a
schema that was never compiled, `getValidator` says so instead of validating
against the wrong one. Pass `onMissing: 'compile'` to fall back to compiling at
run time, though that needs code generation and will not work in the runtime
this exists for.

A constructor you registered yourself in `withKeywords.CONSTRUCTORS` cannot be
compiled, because a standalone module imports nothing and there is nowhere to
put your class. Those schemas are refused rather than silently compiled without
the check.

## Measured

Node 25, an eight-field tool schema with a nested array of objects, 20000 calls
per round, medians of 7 interleaved rounds.

With code generation blocked, which is the case this provider is for:

| provider | valid | invalid |
|---|---|---|
| ata | 191 ns | 533 ns |
| cfworker | 2861 ns | 873 ns |
| ajv | throws `EvalError` | throws `EvalError` |

With code generation allowed:

| provider | valid | invalid |
|---|---|---|
| ata | 18 ns | 225 ns |
| ajv | 56 ns | 38 ns |
| cfworker | 2962 ns | 872 ns |

ajv is the one to beat on the failing path when it can compile, and it is not
beaten there. Rejecting is where it stops early and reports almost nothing;
the numbers above include building the message string, which is the work a
provider actually does.

## Error messages

A tool call that fails validation usually goes back to the model to be retried,
so the message is not a log line, it is part of the next prompt.

The default wording matches the providers the SDK already ships, so swapping
does not change the strings anything downstream is reading:

```
/limit: must be <= 100
```

`detailed` says what was expected and what arrived, which is what a model needs
in order to fix the call rather than guess at it:

```js
new AtaJsonSchemaValidator({ detailed: true })
```

```
/mode: expected one of ["read", "write", "append"], found "delete"
/limit: expected ≤100, found 250
```

I have not measured that this reduces retries. It is a mechanism, not a result.

## Options

| option | default | meaning |
|---|---|---|
| `allErrors` | `false` | report every failure instead of stopping at the first |
| `detailed` | `false` | messages name the expectation and the value that arrived |
| `formats` | none | custom format checkers, passed through to ata |

## Drop-in

`npm test` compares this provider's verdicts against both of the SDK's own
providers over 280 tool calls each, and checks that the verdicts are identical
with code generation switched off. A provider that quietly accepted a call the
others rejected would be worse than no provider at all.

[mcp]: https://modelcontextprotocol.io
