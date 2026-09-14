export interface CompileToolsOptions {
  /** Tool name to its inputSchema. */
  tools: Record<string, object>;
  /** Where the compiled modules and the index are written. */
  outDir: string;
  /** Module format for the emitted validators. Default 'esm'. */
  format?: 'esm' | 'cjs';
}

export interface CompileToolsResult {
  /** Tools that produced a compiled validator. */
  compiled: string[];
  /** Tools the compiler refused, with the reason. */
  declined: Array<{ name: string; reason: string }>;
  /** Path to the generated index, which is what the provider takes. */
  index: string;
}

/** Compile each tool's inputSchema into a standalone module plus an index. */
export declare function compileTools(options: CompileToolsOptions): Promise<CompileToolsResult>;

/** The lookup key for a schema: a hash of its canonical form. */
export declare function schemaKey(schema: object): string;
