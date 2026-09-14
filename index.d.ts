export interface AtaJsonSchemaValidatorOptions {
  /** Report every failure instead of stopping at the first. Default false. */
  allErrors?: boolean;
  /** Error messages name the expectation and the value that arrived. Default false. */
  detailed?: boolean;
  /** Custom format checkers, passed through to ata. */
  formats?: Record<string, unknown>;
}

export type ValidationResult<T> =
  | { valid: true; data: T; errorMessage: undefined }
  | { valid: false; data: undefined; errorMessage: string };

/**
 * Implements the MCP TypeScript SDK's `jsonSchemaValidator` interface.
 * Needs no code generation, so it runs under a strict CSP and on edge runtimes.
 */
export declare class AtaJsonSchemaValidator {
  constructor(options?: AtaJsonSchemaValidatorOptions);
  getValidator<T>(schema: object): (input: unknown) => ValidationResult<T>;
}

export interface AtaAotJsonSchemaValidatorOptions extends AtaJsonSchemaValidatorOptions {
  /**
   * What to do when a schema has no compiled validator. 'throw' (default) says
   * the build is out of step. 'compile' falls back to compiling at run time,
   * which needs code generation and will not work in the runtime this exists
   * for.
   */
  onMissing?: 'throw' | 'compile';
}

/**
 * Serves validators compiled by `compileTools` instead of compiling now.
 * Measured on five tool schemas: the runtime provider costs about 85 KB
 * gzipped and 12 ms of cold start in a Worker bundle, against 0.74 ms here.
 */
export declare class AtaAotJsonSchemaValidator {
  constructor(compiled: Record<string, { name: string; module: unknown }>, options?: AtaAotJsonSchemaValidatorOptions);
  getValidator<T>(schema: object): (input: unknown) => ValidationResult<T>;
}

