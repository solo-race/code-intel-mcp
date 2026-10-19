import { fileURLToPath } from "node:url";

export interface HostEntry {
  readonly command: string;
  readonly args: readonly [string, "serve"];
}

export function runtimeEntry(entryUrl: string): HostEntry {
  return { command: process.execPath, args: [fileURLToPath(entryUrl), "serve"] };
}

/** JSON basic-string escaping is also valid for these TOML string values. */
export function codexSnippet(entry: HostEntry): string {
  return `[mcp_servers.code_intel_mcp]\ncommand = ${JSON.stringify(entry.command)}\nargs = [${entry.args.map((value) => JSON.stringify(value)).join(", ")}]\n`;
}
