import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport, getDefaultEnvironment } from "@modelcontextprotocol/client/stdio";
import { constants, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { access, stat } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import path from "node:path";

import { inspectCodexConfig } from "./codex-config.ts";
import { newDoctorReport, setDoctorStage, type DoctorReport, type DoctorStageId } from "./doctor-preflight.ts";

const TOOLS = ["ast_edit_apply", "ast_edit_preview", "ast_search", "ast_transform_plan_preview", "ast_transform_preview"];
export const DOCTOR_LIMITS = { request: 10_000, overall: 30_000, graceful: 2_000, termination: 1_000 } as const;

/** Prestart separates spawn errors from handshake errors; connect reuses that child. */
class ProbeTransport extends StdioClientTransport {
  private started = false;
  private closing: Promise<void> | undefined;
  ownedPid: number | null = null;
  override async start(): Promise<void> {
    if (this.started) return;
    await super.start();
    this.ownedPid = this.pid;
    this.started = true;
  }
  override close(): Promise<void> {
    // Failed initialize starts SDK teardown before connect rejects. Reuse that
    // close instead of mistaking its cleared public pid for completed cleanup.
    return this.closing ??= super.close();
  }
}

class ProbeTimeout extends Error {}
async function bounded<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new ProbeTimeout()), Math.max(1, milliseconds));
    })]);
  } finally { clearTimeout(timer!); }
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

interface Launch { command: string; args: string[]; env: Record<string, string> }
async function launchSpecification(entry: Record<string, unknown>): Promise<Launch | "invalid" | "missing-runtime"> {
  if (typeof entry.command !== "string" || !path.isAbsolute(entry.command) || entry.command.includes("\0") ||
      /\.(cmd|bat)$/i.test(entry.command) || !Array.isArray(entry.args) ||
      !entry.args.every((arg): arg is string => typeof arg === "string" && !arg.includes("\0")) ||
      (entry.enabled !== undefined && typeof entry.enabled !== "boolean")) return "invalid";
  const env = getDefaultEnvironment();
  if (entry.env_vars !== undefined) {
    if (!Array.isArray(entry.env_vars) || !entry.env_vars.every((key) => typeof key === "string" && /^[^=\0]+$/.test(key))) return "invalid";
    for (const key of entry.env_vars as string[]) if (process.env[key] !== undefined) env[key] = process.env[key]!;
  }
  if (entry.env !== undefined) {
    if (!record(entry.env)) return "invalid";
    for (const [key, value] of Object.entries(entry.env)) {
      if (!/^[^=\0]+$/.test(key) || typeof value !== "string" || value.includes("\0")) return "invalid";
      env[key] = value;
    }
  }
  if (entry.cwd !== undefined) {
    if (typeof entry.cwd !== "string" || !path.isAbsolute(entry.cwd)) return "invalid";
    try { if (!(await stat(entry.cwd)).isDirectory()) return "invalid"; } catch { return "invalid"; }
  }
  try {
    if (!(await stat(entry.command)).isFile()) return "missing-runtime";
    await access(entry.command, process.platform === "win32" ? constants.F_OK : constants.X_OK);
  } catch { return "missing-runtime"; }
  return { command: entry.command, args: [...entry.args], env };
}

async function closeProbe(client: Client | undefined, transport: ProbeTransport): Promise<boolean> {
  // The public SDK pid identifies only the child this transport owns.
  const pid = transport.ownedPid;
  let monitoring = true;
  const closing = (async () => {
    let clean = true;
    try { await client?.close(); } catch { clean = false; }
    try { await transport.close(); } catch { clean = false; }
    // SDK close may return immediately after its last signal. Confirm exit too.
    if (pid !== null) {
      while (monitoring) {
        try { process.kill(pid, 0); }
        catch (error) {
          if ((error as NodeJS.ErrnoException).code === "ESRCH") break;
          return false;
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
    }
    return clean;
  })();
  try {
    try { return await bounded(closing, DOCTOR_LIMITS.graceful); }
    catch {
      if (pid !== null) {
        try { process.kill(pid, "SIGKILL"); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") return false; }
      }
      try { return await bounded(closing, DOCTOR_LIMITS.termination); } catch { return false; }
    }
  } finally { monitoring = false; }
}

export interface DoctorOptions {
  readonly configPath?: string;
  /** CLI supplies the builtin-only preflight report before importing this module. */
  readonly report?: DoctorReport;
}

export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorReport> {
  const report = options.report ?? newDoctorReport();
  if (!options.report) setDoctorStage(report, "prerequisites", "pass", "LOCAL_DEPENDENCIES_LOADED", "Local diagnostic dependencies loaded.");
  const deadline = Date.now() + DOCTOR_LIMITS.overall;
  let active: DoctorStageId = "configuration";
  let fixture: string | undefined;
  let transport: ProbeTransport | undefined;
  let client: Client | undefined;
  let sources: Array<[string, string]> = [];
  const remaining = () => {
    const time = deadline - Date.now();
    if (time <= 0) throw new ProbeTimeout();
    return Math.min(DOCTOR_LIMITS.request, time);
  };
  const stage = (id: DoctorStageId, status: "pass" | "fail" | "unknown", reason: string, detail: string) =>
    setDoctorStage(report, id, status, reason, detail);
  try {
    const config = await bounded(inspectCodexConfig(options.configPath), remaining());
    if (config.status !== "usable") {
      stage("configuration", "fail", `CONFIG_${config.status.replaceAll("-", "_").toUpperCase()}`, "Selected configuration has no usable enabled code_intel_mcp entry; no configuration was written.");
      return report;
    }
    stage("configuration", "pass", "CONFIG_ENTRY_AVAILABLE", "Selected configuration contains an enabled entry.");
    active = "executable";
    const launch = await bounded(launchSpecification(config.entry), remaining());
    if (typeof launch === "string") {
      stage("executable", "fail", launch === "invalid" ? "INVALID_LAUNCH_SPECIFICATION" : "CONFIGURED_RUNTIME_MISSING", "Entry requires an available absolute executable and string argument array.");
      return report;
    }
    stage("executable", "pass", "EXECUTABLE_AVAILABLE", "Absolute executable and argv are usable; diagnostic cwd is a separate disposable fixture.");
    if (launch.args.some((arg) => arg === "--workspace-root" || arg.startsWith("--workspace-root=") || path.basename(arg) === "mcp-launch.mjs")) {
      stage("root-binding", "fail", "FIXED_ROOT_LAUNCH", "Configured legacy launch binds a startup root instead of the explicit request workspace.");
      return report;
    }

    active = "spawn";
    // Synchronous local fixture setup keeps ownership immediate: no timed-out
    // mkdir/write promise can finish later and recreate a removed fixture.
    remaining();
    fixture = mkdtempSync(path.join(tmpdir(), "code-intel-doctor-"));
    const cwd = path.join(fixture, "child-cwd");
    const workspace = path.join(fixture, "workspace");
    const nativeData = path.join(fixture, "native-data");
    mkdirSync(cwd);
    mkdirSync(workspace);
    // The pinned native loader stages Windows binaries and prunes old caches
    // under XDG_DATA_HOME/omp when that directory exists. Keep those writes local.
    mkdirSync(path.join(nativeData, "omp"), { recursive: true });
    const token = randomUUID();
    const expected = `console.log("doctor-workspace-${token}")`;
    sources = [
      [path.join(workspace, "sample.ts"), `${expected};\n`],
      [path.join(cwd, "sample.ts"), `console.log("doctor-cwd-${token}");\n`],
    ];
    for (const [file, source] of sources) writeFileSync(file, source);
    remaining();
    transport = new ProbeTransport({ ...launch, env: { ...launch.env, XDG_DATA_HOME: nativeData }, cwd, stderr: "pipe" });
    // Drain but never print child stderr, which may contain config or source data.
    transport.stderr?.on("data", () => {});
    await bounded(transport.start(), remaining());
    stage("spawn", "pass", "CHILD_STARTED", "Configured entry started without shell reconstruction.");
    active = "initialize";
    client = new Client({ name: "code-intel-doctor", version: "1.0.0" });
    await bounded(client.connect(transport, { timeout: remaining() }), remaining());
    stage("initialize", "pass", "MCP_INITIALIZED", "MCP initialization succeeded.");
    active = "catalog";
    const listed = await bounded(client.listTools(undefined, { timeout: remaining() }), remaining());
    const names = listed.tools.map((tool) => tool.name).sort();
    if (names.length !== TOOLS.length || names.some((name, index) => name !== TOOLS[index])) {
      stage("catalog", "fail", "CATALOG_MISMATCH", "Catalog must contain exactly the five AST tool names, without duplicates.");
      return report;
    }
    stage("catalog", "pass", "EXACT_AST_CATALOG", "All five expected tools are present exactly once.");
    active = "fixture-read";
    const result = await bounded(client.callTool({ name: "ast_search", arguments: {
      workspaceRoot: workspace, path: "sample.ts", pattern: "console.log($$$ARGS)",
    } }, { timeout: remaining() }), remaining());
    if (result.isError) {
      stage("fixture-read", "fail", "AST_TOOL_ERROR", "Fixture AST read returned a tool error.");
      setDoctorStage(report, "root-binding", "skipped", "READ_NOT_PASSED", "A failed read cannot establish workspace binding.");
      return report;
    }
    const data = result.structuredContent;
    const matches = record(data) && Array.isArray(data.matches) ? data.matches : [];
    const match: unknown = matches[0];
    const expectedPath = record(match) && typeof match.path === "string" &&
      (match.path === "sample.ts" || path.normalize(match.path) === path.join(workspace, "sample.ts"));
    if (!record(data) || data.totalMatches !== 1 || matches.length !== 1 || !record(match) || match.text !== expected || !expectedPath) {
      stage("fixture-read", "fail", "UNEXPECTED_AST_RESULT", "Fixture read did not return its unique expected structural match.");
      stage("root-binding", "fail", "INCORRECT_WORKSPACE_RESULT", "Observed result does not establish the explicit fixture workspace; cwd or installation binding is possible.");
      return report;
    }
    stage("fixture-read", "pass", "EXPECTED_AST_RESULT", "Fixture AST search returned the expected unique structural match.");
    stage("root-binding", "pass", "EXPLICIT_WORKSPACE_HONORED", "Read matched the explicit workspace fixture, distinct from child cwd and installation.");
  } catch (error) {
    const timeout = error instanceof ProbeTimeout || (record(error) && error.code === -32001);
    stage(active, "fail", timeout ? (Date.now() >= deadline ? "OVERALL_TIMEOUT" : "REQUEST_TIMEOUT") : `${active.replaceAll("-", "_").toUpperCase()}_FAILED`,
      timeout ? "Diagnostic stage exceeded its time limit." : "Diagnostic stage failed; raw errors are suppressed.");
  } finally {
    let clean = true;
    if (transport) clean = await closeProbe(client, transport);
    if (fixture) {
      try {
        for (const [file, source] of sources) {
          if (!readFileSync(file).equals(Buffer.from(source))) {
            clean = false;
            stage("fixture-read", "fail", "FIXTURE_SOURCE_CHANGED", "Diagnostic child changed a fixture source.");
          }
        }
        if (sources.length && (readdirSync(path.join(fixture, "workspace")).length !== 1 ||
            readdirSync(path.join(fixture, "child-cwd")).length !== 1)) clean = false;
      } catch { clean = false; }
      try { rmSync(fixture, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 }); } catch { clean = false; }
    }
    if (transport || fixture) stage("cleanup", clean ? "pass" : "fail", clean ? "RESOURCES_CLOSED" : "CLEANUP_FAILED",
      clean ? "Owned process resources closed; fixture sources preserved and disposable fixtures removed." : "Process cleanup, fixture preservation, or fixture removal failed.");
    report.ok = report.stages.every((item) => item.id === "sandbox-approval" || item.status === "pass");
  }
  return report;
}
