#!/usr/bin/env bun

// Resolve from this durable installation, never from the caller's cwd.
try {
  if (!globalThis.Bun) throw new Error("Bun is required; invoke this entry with an absolute Bun executable");
  const { runCli } = await import("../src/cli/main.ts");
  await runCli(process.argv.slice(2), import.meta.url);
} catch (error) {
  console.error(`CODE_INTEL_ERROR: ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
}
