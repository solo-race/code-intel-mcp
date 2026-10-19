import { parse } from "@ltd/j-toml";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";

import { codexSnippet, type HostEntry } from "./host-entry.ts";

const BEGIN = "# >>> code-intel-mcp owned entry >>>";
const END = "# <<< code-intel-mcp owned entry <<<";

/** Only the filesystem operations needed to exercise write failures in fixtures. */
export interface ConfigIO {
  readFile: (file: string) => Promise<Buffer>;
  mkdir: (directory: string) => Promise<unknown>;
  writeExclusive: (file: string, bytes: Buffer) => Promise<unknown>;
  rename: (from: string, to: string) => Promise<unknown>;
  unlink: (file: string) => Promise<unknown>;
}

const nativeIO: ConfigIO = {
  readFile: (file) => fs.readFile(file),
  mkdir: (directory) => fs.mkdir(directory, { recursive: true }),
  writeExclusive: (file, bytes) => fs.writeFile(file, bytes, { flag: "wx" }),
  rename: (from, to) => fs.rename(from, to),
  unlink: (file) => fs.unlink(file),
};

export interface ConfigEditOptions {
  readonly dryRun: boolean;
  /** Tests pass an isolated home; CLI uses CODEX_HOME or the normal user home. */
  readonly home?: string;
  readonly io?: ConfigIO;
}

export interface ConfigEditResult {
  readonly status: "installed" | "uninstalled" | "would-install" | "would-uninstall" | "unchanged" | "externally-managed";
  readonly configPath: string;
  readonly snippet?: string;
  readonly backupPath?: string;
  readonly restore?: string;
}

function refusal(reason: string, entry: HostEntry): never {
  throw new Error(`CONFIG_EDIT_REFUSED: ${reason}\nManual configuration (not installed or verified):\n${codexSnippet(entry)}`);
}

function parseConfig(bytes: Buffer, entry: HostEntry): Record<string, unknown> {
  try {
    return parse(bytes.toString("utf8"), 1.0, "\n", true, null) as Record<string, unknown>;
  } catch {
    return refusal("invalid TOML; original configuration was not replaced", entry);
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function selectedCodexConfigPath(home = process.env.CODEX_HOME ?? path.join(homedir(), ".codex")): string {
  if (!home) throw new Error("CONFIG_HOME_INVALID");
  return path.resolve(home, "config.toml");
}

export type ConfigInspection =
  | { readonly status: "usable"; readonly entry: Record<string, unknown> }
  | { readonly status: "absent" | "unreadable" | "malformed" | "missing-entry" | "disabled-entry" | "invalid-entry" };

/** Read-only inspection: no installer ownership, directory creation, or writes. */
export async function inspectCodexConfig(configPath = selectedCodexConfigPath()): Promise<ConfigInspection> {
  let bytes: Buffer;
  try { bytes = await fs.readFile(configPath); }
  catch (error) {
    return { status: (error as NodeJS.ErrnoException).code === "ENOENT" ? "absent" : "unreadable" };
  }
  let config: Record<string, unknown>;
  try { config = parse(bytes.toString("utf8"), 1.0, "\n", true, null) as Record<string, unknown>; }
  catch { return { status: "malformed" }; }
  if (config.mcp_servers === undefined) return { status: "missing-entry" };
  if (!object(config.mcp_servers)) return { status: "invalid-entry" };
  const entry = config.mcp_servers.code_intel_mcp;
  if (entry === undefined) return { status: "missing-entry" };
  if (!object(entry)) return { status: "invalid-entry" };
  if (entry.enabled === false) return { status: "disabled-entry" };
  return { status: "usable", entry };
}

function configuredEntry(config: Record<string, unknown>, entry: HostEntry): unknown {
  const servers = config.mcp_servers;
  if (servers === undefined) return undefined;
  if (!object(servers)) return refusal("ambiguous mcp_servers configuration", entry);
  return servers.code_intel_mcp;
}

function equivalent(value: unknown, entry: HostEntry): boolean {
  return object(value) && Object.keys(value).length === 2 &&
    value.command === entry.command && Array.isArray(value.args) &&
    value.args.length === entry.args.length &&
    value.args.every((argument, index) => argument === entry.args[index]);
}

function ownedTail(entry: HostEntry): Buffer {
  // This leading newline belongs to us even when the original has no final EOL.
  return Buffer.from(`\n${BEGIN}\n${codexSnippet(entry)}${END}\n`);
}

async function readOptional(io: ConfigIO, file: string): Promise<Buffer | undefined> {
  try {
    return await io.readFile(file);
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT") return undefined;
    throw error;
  }
}

/** Explicit user-scope edit; never called by serve or module import. */
export async function editCodexConfig(
  operation: "install" | "uninstall",
  entry: HostEntry,
  options: ConfigEditOptions,
): Promise<ConfigEditResult> {
  const io = options.io ?? nativeIO;
  const home = options.home ?? process.env.CODEX_HOME ?? path.join(homedir(), ".codex");
  if (!home) throw new Error("CONFIG_HOME_INVALID: CODEX_HOME must not be empty");
  const configPath = path.resolve(home, "config.toml");
  const original = await readOptional(io, configPath);
  const bytes = original ?? Buffer.alloc(0);
  const parsed = parseConfig(bytes, entry);
  const existing = configuredEntry(parsed, entry);
  const tail = ownedTail(entry);
  const begin = bytes.indexOf(BEGIN);
  const end = bytes.indexOf(END);
  let candidate: Buffer;

  if (begin !== -1 || end !== -1) {
    if (begin === -1 || end === -1 || begin !== bytes.lastIndexOf(BEGIN) || end !== bytes.lastIndexOf(END) ||
      bytes.length < tail.length || !bytes.subarray(bytes.length - tail.length).equals(tail)) {
      return refusal("owned block is modified, duplicated, or no longer an exact tail", entry);
    }
    const prefix = bytes.subarray(0, bytes.length - tail.length);
    if (configuredEntry(parseConfig(prefix, entry), entry) !== undefined || !equivalent(existing, entry)) {
      return refusal("ambiguous owned entry", entry);
    }
    if (operation === "install") return { status: "unchanged", configPath };
    candidate = prefix;
  } else if (existing !== undefined) {
    if (operation === "uninstall" || equivalent(existing, entry)) {
      return { status: "externally-managed", configPath, snippet: codexSnippet(entry) };
    }
    return refusal("conflicting externally managed entry; no takeover is permitted", entry);
  } else {
    if (operation === "uninstall") return { status: "unchanged", configPath };
    candidate = Buffer.concat([bytes, tail]);
  }

  parseConfig(candidate, entry);
  if (options.dryRun) {
    return { status: operation === "install" ? "would-install" : "would-uninstall", configPath, snippet: codexSnippet(entry) };
  }

  await io.mkdir(path.dirname(configPath));
  let backupPath: string | undefined;
  let temporaryPath: string | undefined;
  try {
    if (original !== undefined) {
      const proposedBackupPath = `${configPath}.code-intel-backup-${randomUUID()}`;
      await io.writeExclusive(proposedBackupPath, original);
      backupPath = proposedBackupPath;
    }
    const proposedTemporaryPath = `${configPath}.code-intel-tmp-${randomUUID()}`;
    await io.writeExclusive(proposedTemporaryPath, candidate);
    temporaryPath = proposedTemporaryPath;
    const current = await readOptional(io, configPath);
    if (original === undefined ? current !== undefined : current === undefined || !current.equals(original)) {
      throw new Error("configuration changed before replacement");
    }
    await io.rename(temporaryPath, configPath);
    temporaryPath = undefined;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`CONFIG_WRITE_ABORTED: ${message}; no truncate fallback was attempted.${backupPath === undefined ? "" : ` Backup: ${backupPath}. Restore its exact bytes to ${configPath} after checking concurrent edits.`}`);
  } finally {
    if (temporaryPath !== undefined) await io.unlink(temporaryPath).catch(() => undefined);
  }
  return {
    status: operation === "install" ? "installed" : "uninstalled",
    configPath,
    ...(backupPath === undefined ? {} : {
      backupPath,
      restore: `Restore the exact bytes from ${backupPath} to ${configPath} after checking concurrent edits.`,
    }),
  };
}
