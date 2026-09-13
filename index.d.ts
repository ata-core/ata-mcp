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
