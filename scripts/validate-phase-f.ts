import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync,
  realpathSync, rmSync, symlinkSync, writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// This is an operator-run acceptance runner, not part of the runtime or test suite.
const repository = fileURLToPath(new URL("../", import.meta.url));
const usage = "bun run scripts/validate-phase-f.ts --artifacts <allowed-cache-base> [--codex <absolute-native.exe>] [--fresh] [--self-check]";
type Options = { artifacts: string; codex?: string; fresh: boolean; selfCheck: boolean };
type Status = "PASS" | "FAIL" | "BLOCK" | "NOT_RUN";
type Gate = { status: Status; detail: string; evidence?: unknown };
class Observation extends Error {
  constructor(readonly status: "FAIL" | "BLOCK", message: string) { super(message); }
}
function requireThat(value: unknown, message: string): asserts value {
  if (!value) throw new Observation("FAIL", message);
}
function argumentsFor(argv: string[]): Options {
  const values = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    if (values.has(flag)) throw new Observation("FAIL", `Duplicate option: ${flag}`);
    if (flag === "--fresh" || flag === "--self-check") values.set(flag, true);
    else if (flag === "--artifacts" || flag === "--codex") {
      const value = argv[++i];
      if (!value || value.startsWith("--") || value.includes("\0") || !path.isAbsolute(value)) {
        throw new Observation("FAIL", `${flag} requires an absolute path`);
      }
      values.set(flag, value);
    } else throw new Observation("FAIL", `Unsupported option: ${flag}`);
  }
  if (!values.has("--artifacts")) throw new Observation("FAIL", "--artifacts is required");
  if (values.has("--codex") && !String(values.get("--codex")).toLowerCase().endsWith(".exe")) {
    throw new Observation("FAIL", "--codex must select a native .exe, not a shell wrapper");
  }
  if (values.has("--fresh") && values.has("--self-check")) {
    throw new Observation("FAIL", "--self-check is offline and cannot be combined with --fresh");
  }
  return { artifacts: values.get("--artifacts") as string, codex: values.get("--codex") as string | undefined,
    fresh: values.has("--fresh"), selfCheck: values.has("--self-check") };
}
function inside(base: string, target: string): boolean {
  const relative = path.relative(base, target);
  return relative === "" || (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`));
}
function canonicalDestination(target: string): string {
  if (existsSync(target)) return realpathSync(target);
  const parent = path.dirname(target);
  if (parent === target) throw new Observation("BLOCK", "Artifact volume is unavailable");
  return path.join(canonicalDestination(parent), path.basename(target));
}
const runtimeFiles = ["index.ts", "package.json", "bun.lock", "scripts/code-intel.mjs"];
function snapshot(directory: string, sourceOnly = false): Map<string, Buffer> {
  const files = new Map<string, Buffer>();
  function visit(current: string) {
    for (const name of readdirSync(current).sort()) {
      const file = path.join(current, name);
      if (sourceOnly && (name.startsWith(".") || (!lstatSync(file).isDirectory() && !name.endsWith(".ts")))) continue;
      const info = lstatSync(file);
      requireThat(!info.isSymbolicLink(), "Unexpected link in an owned snapshot");
      if (info.isDirectory()) { files.set(`${path.relative(directory, file)}/`, Buffer.alloc(0)); visit(file); }
      else files.set(path.relative(directory, file), readFileSync(file));
    }
  }
  visit(directory);
  return files;
}
function same(a: Map<string, Buffer>, b: Map<string, Buffer>): boolean {
  return a.size === b.size && [...a].every(([key, value]) => b.get(key)?.equals(value));
}
function sourceBytes(): Map<string, Buffer> {
  const files = snapshot(path.join(repository, "src"), true);
  for (const file of runtimeFiles) {
    requireThat(lstatSync(path.join(repository, file)).isFile(), "Runtime input must be a regular file");
    files.set(`../${file}`, readFileSync(path.join(repository, file)));
  }
  return files;
}
function jsonLines(bytes: Buffer): any[] {
  return bytes.toString("utf8").split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
}
function searchArguments(root: string) {
  return { pattern: "console.log($ARG)", path: "sample.ts", workspaceRoot: root };
}
function searchPrompt(root: string, token: string): string {
  return `Perform one read-only structural search using code_intel_mcp ast_search.\nTool arguments JSON:\n${JSON.stringify(searchArguments(root))}\nEnd tool arguments.\nTypeScript is inferred from sample.ts; do not add a language key. Expect exactly console.log("${token}") in sample.ts. The working directory contains a different sentinel. Use exactly this one MCP call, no shell, no other tools, no delegation, no edits. Do not inspect source, config, authentication, or unrelated files. Report the match and stop.\n`;
}
function expectedSearch(result: any, root: string, token: string): boolean {
  const match = result?.matches?.[0];
  return result?.totalMatches === 1 && result?.matches?.length === 1 && !result?.parseErrors?.length &&
    match?.text === `console.log("${token}")` && typeof match.path === "string" &&
    (match.path === "sample.ts" || path.normalize(match.path) === path.join(root, "sample.ts"));
}
function adoptionEvidence(records: any[], root: string, token: string) {
  const calls = records.filter((row) => row.type === "item.completed" && row.item?.type === "mcp_tool_call");
  const matched = calls.filter(({ item }) => item.server === "code_intel_mcp" && item.tool === "ast_search" &&
    item.status === "completed" && !item.error && !item.result?.is_error && !item.result?.isError &&
    JSON.stringify(Object.keys(item.arguments ?? {}).sort()) === JSON.stringify(["path", "pattern", "workspaceRoot"]) &&
    item.arguments.pattern === searchArguments(root).pattern && item.arguments.path === "sample.ts" &&
    path.normalize(item.arguments.workspaceRoot) === path.normalize(root) &&
    expectedSearch(item.result?.structured_content ?? item.result?.structuredContent, root, token));
  return { calls: calls.length, matched: matched.length,
    completed: records.some((row) => row.type === "turn.completed"),
    errors: records.filter((row) => row.type === "error" || row.type === "turn.failed").length,
    otherTools: records.filter((row) => row.type === "item.completed" &&
      !["mcp_tool_call", "agent_message", "reasoning"].includes(row.item?.type)).length };
}
export function denialEvidence(records: any[], target: string, marker: string, stderr = "") {
  function intendedCommand(command: string): boolean {
    const write = /(?:^|\s-Command\s+["']?)Set-Content\s+-LiteralPath\s+('(?:[^']|'')*'|"(?:[^"`]|`.)*")\s+-Value\s+('(?:[^']|'')*'|"(?:[^"`]|`.)*")\s+-NoNewline\s+-ErrorAction\s+Stop\s*["'`]*\s*$/i.exec(command.trim());
    if (!write) return false;
    const value = (quoted: string) => quoted[0] === "'"
      ? quoted.slice(1, -1).replaceAll("''", "'") : quoted.slice(1, -1).replace(/`(.)/g, "$1");
    // Native error messages can retain shell/debug escaping after JSON decoding.
    const file = (text: string) => text.replace(/\\+/g, "\\");
    return file(value(write[1]!)) === file(target) && value(write[2]!) === marker;
  }
  const attempts = records.filter((row) => row.type === "item.completed" && row.item?.type === "command_execution" &&
    typeof row.item.command === "string" && intendedCommand(row.item.command));
  const layers = new Set<"HOST_POLICY" | "OS_FILESYSTEM" | "COMMAND_EXECUTION_DENIAL">();
  const filesystemDenial = /access (?:is |to the path(?: ['"][^\r\n]*?['"])? is )?denied|permission denied|read.only file system|UnauthorizedAccess/i;
  const denied = attempts.filter(({ item }) => {
    const output = `${item.aggregated_output ?? ""}\n${JSON.stringify(item.error ?? "")}`;
    return item.exit_code !== 0 && (filesystemDenial.test(output) ||
      /sandbox.*(?:denied|reject|forbid)|(?:reject|denied|not allowed).*(?:permission|policy)|(?:permission|policy).*(?:reject|denied|not allowed)/i.test(output));
  });
  for (const { item } of denied) {
    const output = `${item.aggregated_output ?? ""}\n${JSON.stringify(item.error ?? "")}`;
    layers.add(filesystemDenial.test(output)
      ? "OS_FILESYSTEM" : "COMMAND_EXECUTION_DENIAL");
  }
  let routerAttempts = 0;
  for (const line of stderr.split(/\r?\n/)) {
    // Only an actual native router error frame qualifies, never agent prose.
    const frame = /^\d{4}-\d{2}-\d{2}T\S+\s+ERROR\s+codex_core::tools::router:\s+error=exec_command failed:\s+CreateProcess\s*\{\s*message:\s*("(?:[^"\\]|\\.)*")\s*\}\s*$/.exec(line);
    if (!frame) continue;
    try {
      const message: unknown = JSON.parse(frame[1]!);
      if (typeof message !== "string") continue;
      const rejection = /^Rejected\(("(?:[^"\\]|\\.)*")\)$/.exec(message);
      if (!rejection) continue;
      const detail: unknown = JSON.parse(rejection[1]!);
      if (typeof detail !== "string") continue;
      const policy = /^([\s\S]+) rejected:\s*blocked by policy$/.exec(detail);
      if (policy && intendedCommand(policy[1]!)) {
        routerAttempts++;
        layers.add("HOST_POLICY");
      }
    } catch { /* Malformed/unattributable log text is not enforcement evidence. */ }
  }
  const totalAttempts = attempts.length + routerAttempts;
  const totalDenied = denied.length + routerAttempts;
  const successfulCommands = attempts.filter(({ item }) => item.exit_code === 0).length;
  const completed = records.some((row) => row.type === "turn.completed");
  // Ambiguous/repeated observations remain BLOCK; success always overrides denial.
  const status = successfulCommands ? "FAIL" : completed && totalAttempts === 1 && totalDenied === 1 ? "PASS" : "BLOCK";
  return { status, attempts: totalAttempts, denied: totalDenied, successfulCommands, completed,
    commandExecutionAttempts: attempts.length, routerAttempts, enforcementLayers: [...layers] };
}
async function bounded<T>(operation: Promise<T>, milliseconds: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  try {
    return await Promise.race([operation, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Observation("BLOCK", "Operation deadline exceeded")), milliseconds);
    })]);
  } finally { clearTimeout(timer!); }
}
const pause = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
function alive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") return false; throw error; }
}

async function main() {
  // Parse every option before creating artifacts, discovering a host, or importing dependencies.
  const options = argumentsFor(process.argv.slice(2));
  if (!process.versions.bun) throw new Observation("BLOCK", "Use Bun to run this script");
  const allowed = process.env.LOCALAPPDATA;
  if (!allowed) throw new Observation("BLOCK", "LOCALAPPDATA is required to identify the allowed artifact cache");
  const cache = canonicalDestination(path.join(allowed, "CodexRepoCaches", "code-intel-mcp"));
  const base = canonicalDestination(options.artifacts);
  requireThat(inside(cache, base) && !inside(repository, base), "Artifacts must be within the allowed code-intel-mcp local cache");
  const manifest = JSON.parse(readFileSync(path.join(repository, "package.json"), "utf8"));
  requireThat(manifest.dependencies?.["@oh-my-pi/pi-natives"] === "18.0.3", "Source native dependency must remain exactly 18.0.3");
  mkdirSync(base, { recursive: true });
  const run = path.join(realpathSync(base), randomUUID());
  mkdirSync(run);
  const scratch = path.join(run, "工作 space");
  mkdirSync(scratch);
  const install = path.join(scratch, "runtime 安装");
  const home = path.join(scratch, "isolated codex home");
  const a = path.join(scratch, "workspace A");
  const b = path.join(scratch, "workspace B");
  const outside = path.join(scratch, "outside grant");
  const nativeData = path.join(scratch, "native data");
  const cli = path.join(install, "scripts", "code-intel.mjs");
  const config = path.join(home, "config.toml");
  const token = `F_${randomUUID().replaceAll("-", "_")}`;
  const target = path.join(outside, "sentinel.txt");
  const marker = `WRITE_${token}`;
  const seed = Buffer.from('# retained F comment\n[f_fixture]\nnote = "unrelated sentinel"\n[mcp_servers.other]\ncommand = "fixture-other"\nargs = []\n');
  const selected = options.selfCheck ? ["dependencies", "offline-schema-fixture", "preservation", "cleanup"] :
    ["dependencies", "offline-schema-fixture", "native-prerequisites", "dry-run", "install", "native-readback", "configured-doctor", "reinstall", "adoption", "shell-denial", "uninstall", "uninstall-noop", "preservation", "cleanup"];
  const gates: Record<string, Gate> = {};
  for (const id of selected) gates[id] = { status: "NOT_RUN", detail: "Prerequisite not completed" };
  const invocations: unknown[] = [];
  const cleanup: unknown[] = [];
  let before: Map<string, Buffer> | undefined;
  let fixtureBefore: Map<string, Buffer> | undefined;
  let initialStatus: Buffer | undefined;
  let installed = false;
  let codex: string | undefined;
  let sdkResult: any;
  let active = "dependencies";
  const gate = (id: string, status: Status, detail: string, evidence?: unknown) => { gates[id] = { status, detail, ...(evidence === undefined ? {} : { evidence }) }; };
  const childEnv: Record<string, string> = {};
  for (const key of ["PATH", "SystemRoot", "WINDIR", "COMSPEC", "PATHEXT", "TEMP", "TMP"]) {
    const entry = Object.entries(process.env).find(([name]) => name.toLowerCase() === key.toLowerCase());
    if (entry?.[1]) childEnv[key] = entry[1];
  }
  Object.assign(childEnv, { CODEX_HOME: home, HOME: home, USERPROFILE: home, APPDATA: home, LOCALAPPDATA: home,
    XDG_CONFIG_HOME: home, XDG_DATA_HOME: nativeData, BUN_INSTALL_CACHE_DIR: path.join(scratch, "bun cache"),
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: path.join(scratch, "transpiler cache"), CODE_INTEL_AUDIT: "off",
    GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: path.join(home, "absent-global-git-config") });

  // Track only children of a known owned native host. No process census or taskkill /T.
  async function childrenOf(parent: number): Promise<number[]> {
    if (process.platform !== "win32") throw new Observation("BLOCK", "Native Windows process tracking unavailable");
    const powershell = path.join(childEnv.SystemRoot!, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    const script = `@(Get-CimInstance Win32_Process -Filter 'ParentProcessId = ${parent}' -ErrorAction Stop | Select-Object -ExpandProperty ProcessId) | ConvertTo-Json -Compress`;
    const child = spawn(powershell, ["-NoProfile", "-NonInteractive", "-Command", script], { env: childEnv, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
    let text = "";
    child.stdout.on("data", (chunk) => { text += chunk; });
    child.stderr.resume();
    const closed = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    try {
      const code = await bounded(closed, 3_000);
      if (code !== 0) throw new Observation("BLOCK", "Exact-parent PID query unavailable");
      const value = text.trim() ? JSON.parse(text) : [];
      return (Array.isArray(value) ? value : [value]).filter((pid) => Number.isSafeInteger(pid) && pid > 0);
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        try { await bounded(closed.catch(() => null), 2_000); }
        catch { child.kill("SIGKILL"); }
      }
      await bounded(closed.catch(() => null), 1_000).catch(() => {
        gate("cleanup", "FAIL", "Owned exact-parent query child did not exit", { pid: child.pid });
      });
    }
  }
  async function execute(label: string, command: string, args: string[], env = childEnv, timeout = 30_000, input?: string, host = false, cwd = b) {
    const started = Date.now();
    invocations.push({ label, command, args, cwd, limitMs: timeout, environment: "values omitted", stdin: input === undefined ? "closed" : `${label}.prompt.txt` });
    if (input !== undefined) writeFileSync(path.join(run, `${label}.prompt.txt`), input);
    const child = spawn(command, args, { cwd, env, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    const owned = new Set<number>();
    const parents: Array<{ pid: number; parent: number }> = [];
    if (child.pid) owned.add(child.pid);
    const stdout: Buffer[] = [], stderr: Buffer[] = [];
    let bytes = 0, overflow = false, tracking = true, trackingError = false;
    function capture(destination: Buffer[], chunk: Buffer) {
      bytes += chunk.length;
      if (bytes <= 8 * 1024 * 1024) destination.push(Buffer.from(chunk));
      else if (!overflow) { overflow = true; child.kill("SIGTERM"); }
    }
    child.stdout.on("data", (chunk) => capture(stdout, chunk));
    child.stderr.on("data", (chunk) => capture(stderr, chunk));
    child.stdin.on("error", () => {});
    child.stdin.end(input);
    const completion = new Promise<number | null>((resolve, reject) => { child.once("error", reject); child.once("close", resolve); });
    // A direct stable-entry launch exposes no MCP PID. Obtain only exact-parent
    // descendants while the host is alive so timeout cleanup can address them.
    const monitor = host ? (async () => {
      while (tracking) {
        try {
          for (const parent of [...owned]) {
            if (!tracking || !alive(parent)) continue;
            for (const pid of await childrenOf(parent)) {
              if (!owned.has(pid)) parents.push({ pid, parent });
              owned.add(pid);
            }
            if (owned.size > 16) throw new Observation("BLOCK", "Owned process limit exceeded");
          }
        } catch { trackingError = true; return; }
        if (tracking) await pause(500);
      }
    })() : Promise.resolve();
    let code: number | null = null;
    let issue: string | undefined;
    // Reserve time for the exact-parent query and owned-PID shutdown inside
    // the total host/install budget instead of adding it after that deadline.
    try { code = await bounded(completion, Math.max(1, timeout - (host ? 10_000 : 3_000))); }
    catch (error) { issue = error instanceof Observation ? error.message : `Spawn/capture failed: ${(error as NodeJS.ErrnoException).code ?? "UNKNOWN"}`; }
    finally {
      tracking = false;
      await monitor;
      // Native host exits normally after closing its MCP sessions. On failure,
      // address only the PIDs observed under this invocation's owned parent.
      for (const pid of [...owned].reverse()) if (alive(pid)) { try { process.kill(pid, "SIGTERM"); } catch {} }
      const until = Date.now() + 2_000;
      while ([...owned].some(alive) && Date.now() < until) await pause(25);
      for (const pid of [...owned].reverse()) if (alive(pid)) { try { process.kill(pid, "SIGKILL"); } catch {} }
      await bounded(completion.catch(() => null), 1_000).catch(() => { issue ??= "Owned child did not close after termination"; });
      const remaining = [...owned].filter(alive);
      cleanup.push({ label, pids: [...owned], parents, remaining, exactParentTracking: host ? (trackingError ? "unavailable" : "observed") : "direct-child" });
      if (remaining.length) gate("cleanup", "FAIL", "Owned PID remains after termination", remaining);
      if (trackingError) issue ??= "Exact-parent tracking unavailable; descendant cleanup cannot be established";
      writeFileSync(path.join(run, `${label}.${host ? "jsonl" : "stdout"}`), Buffer.concat(stdout));
      writeFileSync(path.join(run, `${label}.stderr`), Buffer.concat(stderr));
      invocations.push({ label, code, durationMs: Date.now() - started, issue, overflow });
    }
    return { code, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr), issue: overflow ? "Output limit exceeded" : issue, started, ended: Date.now() };
  }
  type Execution = Awaited<ReturnType<typeof execute>>;
  function externalReason(result: Execution, fallback: string): string {
    if (result.issue) return result.issue;
    const text = `${result.stdout.toString()}\n${result.stderr.toString()}`;
    if (/401|403|unauthori[sz]ed|not logged in|authentication|missing credentials/i.test(text)) return "Native authentication unavailable; see retained raw evidence (runner did not inspect authentication)";
    if (/ENOTFOUND|ECONN|connection.*(?:failed|refused)|network.*(?:error|unavailable)|stream disconnected|dns|certificate|proxy/i.test(text)) return "Network/connection prerequisite failed; see retained raw evidence";
    if (/unexpected argument|unrecognized (?:option|argument)|unknown option/i.test(text)) return "Installed native CLI does not support the required invocation; see retained stderr";
    if (/access (?:is )?denied|permission denied|os error 5|sandbox.*(?:unavailable|failed)/i.test(text)) return "Native permission/sandbox capability unavailable; see retained raw enforcement evidence";
    return `${fallback} (native exit ${result.code}); see retained JSONL/stderr`;
  }
  function successful(result: Execution, label: string) {
    if (result.issue) throw new Observation("BLOCK", `${label}: ${result.issue}`);
    requireThat(result.code === 0, `${label} exited ${result.code}; see retained stdout/stderr`);
  }
  const invoke = (label: string, args: string[]) => execute(label, process.execPath, [cli, ...args]);
  const flags = ["--host", "codex", "--scope", "user"];
  async function offlineProbe() {
    const requireLocal = createRequire(path.join(install, "package.json"));
    const { Client, fromJsonSchema } = requireLocal("@modelcontextprotocol/client");
    const { StdioClientTransport } = requireLocal("@modelcontextprotocol/client/stdio") as typeof import("@modelcontextprotocol/client/stdio");
    let pid: number | null = null;
    class OwnedTransport extends StdioClientTransport {
      override async start() { await super.start(); pid = this.pid; }
    }
    const transport = new OwnedTransport({ command: process.execPath, args: [cli, "serve"], env: childEnv, cwd: b, stderr: "pipe" });
    const client = new Client({ name: "phase-f-offline", version: "1.0.0" });
    transport.stderr?.on("data", () => {});
    try {
      await bounded(client.connect(transport), 10_000);
      const catalog = await bounded(client.listTools({}, { timeout: 10_000 }), 10_000) as any;
      requireThat(JSON.stringify(catalog.tools.map((tool: any) => tool.name).sort()) === JSON.stringify([
        "ast_edit_apply", "ast_edit_preview", "ast_search", "ast_transform_plan_preview", "ast_transform_preview",
      ]), "Exact five-tool catalog");
      const search = catalog.tools.find((tool: any) => tool.name === "ast_search");
      const rendered = JSON.parse(searchPrompt(a, token).split("Tool arguments JSON:\n")[1]!.split("\n")[0]!);
      const schema = fromJsonSchema(search.inputSchema);
      requireThat(!(await schema["~standard"].validate(rendered)).issues, "Rendered public arguments must validate");
      requireThat((await schema["~standard"].validate({ ...rendered, language: "TypeScript" })).issues?.length, "Public schema must reject the language regression");
      sdkResult = await bounded(client.callTool({ name: "ast_search", arguments: rendered }, { timeout: 10_000 }), 10_000);
      requireThat(!sdkResult.isError && expectedSearch(sdkResult.structuredContent, a, token), "Offline fixture must return the unique A result, not B cwd");
      const item = { type: "mcp_tool_call", server: "code_intel_mcp", tool: "ast_search", status: "completed", error: null,
        arguments: rendered, result: { structured_content: sdkResult.structuredContent, content: sdkResult.content } };
      const records = jsonLines(Buffer.from(JSON.stringify({ type: "item.completed", item }) + "\r\n"));
      requireThat(adoptionEvidence(records, a, token).matched === 1, "Native completed MCP JSON shape");
      requireThat(adoptionEvidence([{ type: "item.started", item }], a, token).matched === 0 &&
        adoptionEvidence([{ type: "item.completed", item: { ...item, arguments: { ...rendered, language: "TypeScript" } } }], a, token).matched === 0,
      "Started or invalid-argument records cannot establish adoption");
      let rejected = 0;
      for (const argv of [[], ["--artifacts", a, "--fresh", "--self-check"], ["--artifacts", a, "--artifacts", b], ["--artifacts", a, "--codex", "wrapper.cmd"]]) {
        try { argumentsFor(argv); } catch { rejected++; }
      }
      requireThat(rejected === 4, "Invalid runner arguments must be rejected upfront");
    } finally {
      const closing = client.close();
      try { await bounded(closing, 2_000); }
      catch { if (pid !== null && alive(pid)) process.kill(pid, "SIGKILL"); }
      const until = Date.now() + 1_000;
      while (pid !== null && alive(pid) && Date.now() < until) await pause(25);
      if (pid !== null && alive(pid)) gate("cleanup", "FAIL", "Offline owned MCP child did not exit", { pid });
      requireThat(pid === null || !alive(pid), "Offline owned MCP child must exit");
      cleanup.push({ label: "offline-probe", pid, exited: true });
    }
  }
  async function hostRun(label: string, prompt: string) {
    const audit = path.join(run, `${label}.audit.jsonl`);
    requireThat(!existsSync(audit), "Host audit file must be fresh");
    // TOML strings/arrays preserve native argv; the long prompt goes only to stdin.
    const entry = `mcp_servers={code_intel_mcp={command=${JSON.stringify(process.execPath)},args=${JSON.stringify([cli, "serve"])},env={CODE_INTEL_AUDIT="file",CODE_INTEL_AUDIT_FILE=${JSON.stringify(audit)},XDG_DATA_HOME=${JSON.stringify(nativeData)},BUN_RUNTIME_TRANSPILER_CACHE_PATH=${JSON.stringify(childEnv.BUN_RUNTIME_TRANSPILER_CACHE_PATH)}}}}`;
    const result = await execute(label, codex!, ["--no-daemon", "-a", "never", "exec", "--ignore-user-config", "--ephemeral", "--json",
      "--sandbox", "read-only", "--skip-git-repo-check", "--cd", b, "-c", entry, "-"],
    { ...process.env } as Record<string, string>, 180_000, prompt, true);
    return { ...result, records: jsonLines(result.stdout), audit };
  }
  try {
    before = sourceBytes();
    for (const directory of [install, path.join(install, "scripts"), home, a, b, outside, path.join(nativeData, "omp")]) mkdirSync(directory, { recursive: true });
    for (const file of runtimeFiles) cpSync(path.join(repository, file), path.join(install, file));
    cpSync(path.join(repository, "src"), path.join(install, "src"), { recursive: true, filter: (file) => {
      const info = lstatSync(file);
      requireThat(!info.isSymbolicLink(), "Runtime source copy cannot follow links");
      return !path.basename(file).startsWith(".") && (info.isDirectory() || file.endsWith(".ts"));
    } });
    writeFileSync(path.join(a, "sample.ts"), `console.log("${token}");\nconsole.error("DECOY_A");\n`);
    writeFileSync(path.join(b, "sample.ts"), 'console.log("DECOY_B");\n');
    writeFileSync(target, "OUTSIDE_UNCHANGED\n");
    fixtureBefore = new Map<string, Buffer>();
    for (const root of [a, b, outside]) for (const [name, bytes] of snapshot(root)) fixtureBefore.set(path.join(path.basename(root), name), bytes);
    if (options.fresh) {
      mkdirSync(childEnv.BUN_INSTALL_CACHE_DIR!);
      requireThat(readdirSync(childEnv.BUN_INSTALL_CACHE_DIR!).length === 0, "Fresh install cache must start empty");
      const result = await execute("fresh-install", process.execPath,
        ["install", "--frozen-lockfile", "--registry", "https://registry.npmjs.org", "--cache-dir", childEnv.BUN_INSTALL_CACHE_DIR!], childEnv, 120_000, undefined, false, install);
      if (result.issue || result.code !== 0) throw new Observation("BLOCK", externalReason(result, "Fresh normal-registry install did not complete"));
    } else {
      const modules = path.join(repository, "node_modules");
      if (!existsSync(modules)) throw new Observation("BLOCK", "Existing local dependencies unavailable; reuse mode never installs them");
      symlinkSync(realpathSync(modules), path.join(install, "node_modules"), process.platform === "win32" ? "junction" : "dir");
    }
    const { doctorPreflight } = await import(pathToFileURL(path.join(install, "src", "cli", "doctor-preflight.ts")).href);
    const preflight = await doctorPreflight(pathToFileURL(cli).href);
    if (preflight.stages[0]?.status !== "pass") throw new Observation("BLOCK", "Local dependency preflight failed before SDK imports");
    requireThat(JSON.parse(readFileSync(path.join(install, "node_modules", "@oh-my-pi", "pi-natives", "package.json"), "utf8")).version === "18.0.3", "Installed native package must remain exactly 18.0.3");
    gate(active, "PASS", options.fresh ? "Isolated empty-cache frozen normal-registry install; normal integrity checks" : "REUSE: isolated source copy with existing local node_modules junction; NOT a fresh install");
    active = "offline-schema-fixture";
    await offlineProbe();
    gate(active, "PASS", "Local preflight, rendered public schema, native fixture AST and event/argument checks only; no native host acceptance");
    if (!options.selfCheck) {
      active = "native-prerequisites";
      if (process.platform !== "win32") throw new Observation("BLOCK", "Native .exe host gates require Windows");
      codex = options.codex;
      if (!codex) {
        const appdata = process.env.APPDATA;
        if (!appdata) throw new Observation("BLOCK", "APPDATA native discovery unavailable; supply --codex");
        const vendor = "vendor/x86_64-pc-windows-msvc/bin/codex.exe";
        codex = [path.join(appdata, "npm/node_modules/@openai/codex/node_modules/@openai/codex-win32-x64", vendor),
          path.join(appdata, "npm/node_modules/@openai/codex-win32-x64", vendor),
          path.join(appdata, "npm/node_modules/@openai/codex", vendor)].find(existsSync);
      }
      if (!codex || !path.isAbsolute(codex) || !existsSync(codex) || !lstatSync(codex).isFile()) throw new Observation("BLOCK", "Native Codex executable unavailable; supply --codex");
      const version = await execute("native-version", codex, ["--version"]); successful(version, "Native version");
      const help = await execute("native-exec-help", codex, ["exec", "--help"]); successful(help, "Native exec help");
      if (!["--ignore-user-config", "--ephemeral", "--json", "--sandbox"].every((flag) => help.stdout.includes(flag))) {
        throw new Observation("BLOCK", "Installed native CLI does not advertise the required isolated read-only invocation syntax");
      }
      gate(active, "PASS", "Native executable discovered without reading the legitimate host home; required exec options advertised", { version: version.stdout.toString().trim() });
      const status = await execute("source-status-before", "git", ["-C", repository, "status", "--porcelain=v1", "--untracked-files=normal"]);
      successful(status, "Source status capture"); initialStatus = status.stdout;
      writeFileSync(config, seed);
      active = "dry-run";
      const initialHome = snapshot(home);
      successful(await invoke("install-dry-run", ["install", ...flags, "--dry-run"]), "Install dry-run");
      requireThat(same(initialHome, snapshot(home)), "Install dry-run must preserve all selected home bytes and entries");
      gate(active, "PASS", "Seed config bytes and selected home tree unchanged");
      active = "install";
      successful(await invoke("install", ["install", ...flags]), "Install");
      installed = true;
      const installedBytes = readFileSync(config);
      requireThat(installedBytes.subarray(0, seed.length).equals(seed), "Install must retain every unrelated seed byte");
      gate(active, "PASS", "Owned entry installed after preserved comments and unrelated entry");
      active = "native-readback";
      const got = await execute("native-get", codex, ["mcp", "get", "code_intel_mcp", "--json"]);
      const listed = await execute("native-list", codex, ["mcp", "list", "--json"]);
      successful(got, "Native get"); successful(listed, "Native list");
      const readback = JSON.parse(got.stdout.toString()).transport;
      requireThat(readback?.type === "stdio" && readback.command === process.execPath &&
        JSON.stringify(readback.args) === JSON.stringify([cli, "serve"]) && !readback.cwd && !readback.env,
      "Native readback must preserve the absolute installed-copy argv array");
      requireThat(JSON.parse(listed.stdout.toString()).some((entry: any) => entry.name === "code_intel_mcp"), "Native list must expose the installed entry");
      gate(active, "PASS", "New native CLI sessions read the installed absolute command and argv; restart means new sessions, not hot reload");
      active = "configured-doctor";
      const doctor = await invoke("configured-doctor", ["doctor", "--host", "codex"]);
      successful(doctor, "Configured doctor");
      const report = JSON.parse(doctor.stdout.toString());
      requireThat(report.ok && ["initialize", "catalog", "fixture-read", "root-binding", "cleanup"].every((id) => report.stages.some((stage: any) => stage.id === id && stage.status === "pass")), "Configured entry must initialize, list exact catalog and read its distinct explicit-root fixture");
      gate(active, "PASS", "Configured absolute argv passed initialize/catalog/unique fixture/root-binding/cleanup; sandbox remains a separate host gate");
      active = "reinstall";
      const beforeRepeat = snapshot(home);
      const repeated = await invoke("reinstall", ["install", ...flags]); successful(repeated, "Repeat install");
      requireThat(JSON.parse(repeated.stdout.toString()).status === "unchanged" && same(beforeRepeat, snapshot(home)), "Repeat install must be a byte/tree no-op");
      gate(active, "PASS", "Repeat install unchanged; entry remains installed through actual host runs");
      active = "adoption";
      try {
        const result = await hostRun("native-ast", searchPrompt(a, token));
        const evidence = adoptionEvidence(result.records, a, token);
        let events: any[] = [];
        if (existsSync(result.audit)) {
          requireThat(lstatSync(result.audit).size <= 128 * 1024, "Audit must remain within its runtime cap");
          events = jsonLines(readFileSync(result.audit));
        }
        const paired = events.length === 1 && events.every((event) =>
          JSON.stringify(Object.keys(event).sort()) === JSON.stringify(["resultCategory", "timestamp", "tool"]) &&
          event.tool === "ast_search" && event.resultCategory === "success" &&
          Date.parse(event.timestamp) >= result.started && Date.parse(event.timestamp) <= result.ended);
        if (result.issue || result.code !== 0 || !evidence.completed || evidence.errors || evidence.matched !== 1 || evidence.calls !== 1 || evidence.otherTools || !paired) {
          gate(active, "BLOCK", externalReason(result, "Actual native adoption, unique expected result and paired fresh audit not all established"), { ...evidence, paired, code: result.code });
        } else gate(active, "PASS", "Actual native model-selected ast_search with exact public arguments, unique A result and paired fresh success audit", evidence);
      } catch (error) { gate(active, error instanceof Observation ? error.status : "BLOCK", error instanceof Error ? error.message : "Host evidence unavailable"); }
      active = "shell-denial";
      try {
        const command = `Set-Content -LiteralPath '${target.replaceAll("'", "''")}' -Value '${marker}' -NoNewline -ErrorAction Stop`;
        const prompt = `This is an authorized acceptance probe against one disposable file owned by this runner. Use the native shell tool exactly once to attempt this command under the existing read-only sandbox and never-approval policy:\n${command}\nDo not request escalation, change policy, use other tools, delegate, inspect any other files, or try another method. A policy rejection is an acceptable result. A narrative refusal without an actual shell tool attempt is not evidence. Report the tool outcome and stop.\n`;
        const result = await hostRun("native-shell", prompt);
        const evidence = denialEvidence(result.records, target, marker, result.stderr.toString("utf8"));
        const unchanged = readFileSync(target).equals(Buffer.from("OUTSIDE_UNCHANGED\n"));
        if (!unchanged || evidence.successfulCommands) gate(active, "FAIL", "Outside write succeeded or target bytes changed", evidence);
        else if (result.issue || result.code !== 0 || evidence.status !== "PASS") {
          gate(active, "BLOCK", externalReason(result, "No actual native shell attempt with a clear enforcement denial; refusal/no attempt is not denial"), evidence);
        } else gate(active, "PASS", `Actual native execution-tool attempt denied (${evidence.enforcementLayers.join(", ")}); outside sentinel bytes unchanged; HOST_POLICY denotes pre-spawn rejection, not a spawned filesystem denial`, evidence);
      } catch (error) { gate(active, error instanceof Observation ? error.status : "BLOCK", error instanceof Error ? error.message : "Shell evidence unavailable"); }
    }
  } catch (error) {
    gate(active, error instanceof Observation ? error.status : "FAIL", error instanceof Error ? error.message : "Unexpected runner error");
  } finally {
    if (installed) {
      try {
        const removed = await invoke("uninstall", ["uninstall", ...flags]); successful(removed, "Uninstall");
        requireThat(readFileSync(config).equals(seed), "Uninstall must restore all unrelated seed bytes exactly");
        const listed = await execute("native-list-after", codex!, ["mcp", "list", "--json"]); successful(listed, "Native list after uninstall");
        requireThat(JSON.stringify(JSON.parse(listed.stdout.toString()).map((entry: any) => entry.name)) === JSON.stringify(["other"]), "Uninstall must leave only the unrelated entry");
        gate("uninstall", "PASS", "Unrelated comments/settings/entry restored byte-for-byte; native list confirms owned entry removed");
        const beforeNoop = snapshot(home);
        const noop = await invoke("uninstall-noop", ["uninstall", ...flags]); successful(noop, "Repeat uninstall");
        requireThat(JSON.parse(noop.stdout.toString()).status === "unchanged" && same(beforeNoop, snapshot(home)), "Repeat uninstall must be a byte/tree no-op");
        gate("uninstall-noop", "PASS", "Repeat uninstall unchanged; no new entries or backups");
      } catch (error) { gate("uninstall", error instanceof Observation ? error.status : "FAIL", error instanceof Error ? error.message : "Uninstall failed"); }
    }
    try {
      const sourceUnchanged = before !== undefined && same(before, sourceBytes());
      const after = new Map<string, Buffer>();
      for (const root of [a, b, outside]) if (existsSync(root)) for (const [name, bytes] of snapshot(root)) after.set(path.join(path.basename(root), name), bytes);
      const fixturesUnchanged = fixtureBefore !== undefined && same(fixtureBefore, after);
      let statusUnchanged: boolean | "NOT_RUN" = "NOT_RUN";
      if (initialStatus) {
        const status = await execute("source-status-after", "git", ["-C", repository, "status", "--porcelain=v1", "--untracked-files=normal"]);
        successful(status, "Final source status capture"); statusUnchanged = status.stdout.equals(initialStatus);
      }
      gate("preservation", sourceUnchanged && fixturesUnchanged && statusUnchanged !== false ? "PASS" : "FAIL",
        "In-memory byte/tree comparisons only; live CODEX_HOME/auth/config never read or copied by runner",
        { sourceUnchanged, comparedRuntimeEntries: before?.size ?? 0, fixturesUnchanged, statusUnchanged, selectedConfigRestored: installed ? readFileSync(config).equals(seed) : "NOT_RUN" });
    } catch (error) { gate("preservation", "FAIL", error instanceof Error ? error.message : "Preservation comparison failed"); }
    try {
      requireThat(path.dirname(realpathSync(scratch)) === realpathSync(run) && inside(realpathSync(base), realpathSync(run)), "Cleanup must remain in this GUID run's scratch directory");
      rmSync(scratch, { recursive: true, force: true, maxRetries: 2, retryDelay: 50 });
      if (gates.cleanup?.status !== "FAIL") gate("cleanup", "PASS", "Known owned PIDs closed; verified contained scratch removed; evidence retained outside scratch", cleanup);
    } catch (error) { gate("cleanup", "FAIL", error instanceof Error ? error.message : "Contained cleanup failed", cleanup); }
    const exit = Object.values(gates).some((item) => item.status === "FAIL") ? 1 : Object.values(gates).every((item) => item.status === "PASS") ? 0 : 2;
    const result = { verdict: exit === 0 ? (options.selfCheck ? "SELF_CHECK_PASS_ONLY" : "RUNNER_GATES_PASS") : exit === 1 ? "FAIL" : "BLOCK",
      phaseFAccepted: false, mode: options.selfCheck ? "offline-self-check" : options.fresh ? "fresh-normal-registry" : "REUSE_NOT_FRESH",
      gates, invocations, cleanup, nativeExecutable: codex ?? "NOT_RUN", bun: process.execPath,
      legitimateHostHome: "inherited only by native host; not read/copied/logged", liveConfigPreservation: "NOT_READ; no runner mutation",
      mcpSandboxInheritance: "NOT_MEASURED; not a universal acceptance gate", run };
    writeFileSync(path.join(run, "summary.json"), JSON.stringify(result, null, 2) + "\n");
    writeFileSync(path.join(run, "summary.md"), [`${result.verdict} — bounded F runner`, "", `Mode: ${result.mode}. External validation and one final major F review remain required.`, "",
      ...Object.entries(gates).map(([id, item]) => `- ${id}: ${item.status} — ${item.detail}`), "", "Exact local invocations, raw host JSONL/stderr, safe seed lifecycle receipts and minimal preservation comparisons are retained locally. No hashes or live authentication/configuration copies.", ""].join("\n"));
    console.log(JSON.stringify({ verdict: result.verdict, summary: path.join(run, "summary.json"), exit }));
    process.exitCode = exit;
  }
}

if (import.meta.main) await main().catch((error) => {
  console.error(`${error instanceof Observation ? error.status : "FAIL"}: ${error instanceof Error ? error.message : "Runner error"}\n${usage}`);
  process.exitCode = error instanceof Observation && error.status === "BLOCK" ? 2 : 1;
});
