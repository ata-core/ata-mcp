import type { AtaAotJsonSchemaValidatorOptions, ValidationResult } from './index.js';

export type { AtaAotJsonSchemaValidatorOptions, ValidationResult };

/**
 * The ahead-of-time provider on its own, for Workers and other bundles that
 * should carry no validator engine: this entry imports neither ata-validator
 * nor any Node builtin. `onMissing: 'compile'` needs `options.fallback` here.
 */
export declare class AtaAotJsonSchemaValidator {
  constructor(compiled: Record<string, { name: string; module: unknown }>, options?: AtaAotJsonSchemaValidatorOptions);
  getValidator<T>(schema: object): (input: unknown) => ValidationResult<T>;
}
