#!/usr/bin/env bun
// Session-cwd launcher for the code-intel-mcp stdio server.
//
// The host starts this script from the session workspace directory; it resolves
// that directory and starts the server in this process, so no per-project
// config file is needed. stdout belongs to the MCP protocol and nothing else
// is written to stdout.
import { statSync } from "node:fs";
import { startServer } from "../index.ts";

const root = process.cwd();

try {
  if (!statSync(root).isDirectory()) {
    throw new Error("not a directory");
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(
    `code-intel-mcp launcher: session working directory is not a usable workspace root (${root}): ${message}\n`,
  );
  process.exit(1);
}

try {
  await startServer(root);
} catch (error) {
  const message = error instanceof Error ? error.message : "server startup failed";
  console.error(message);
  process.exitCode = 1;
}
