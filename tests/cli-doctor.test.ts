import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, test } from "bun:test";

import { runDoctor, DOCTOR_LIMITS } from "../src/cli/doctor.ts";
import type { DoctorReport, DoctorStageId } from "../src/cli/doctor-preflight.ts";

const repository = path.resolve(import.meta.dir, "..");
const cli = path.join(repository, "scripts", "code-intel.mjs");
const roots: string[] = [];
const tools = ["ast_edit_apply", "ast_edit_preview", "ast_search", "ast_transform_plan_preview", "ast_transform_preview"];
const secret = "DOCTOR_RAW_CONFIG_ENV_ERROR_SENTINEL";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })));
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "code-intel-doctor-test-"));
  roots.push(root);
  const home = path.join(root, "selected home");
  await mkdir(home);
  return { root, home, config: path.join(home, "config.toml") };
}

async function snapshot(root: string): Promise<Array<[string, Buffer | null]>> {
  const result: Array<[string, Buffer | null]> = [];
  async function visit(directory: string, prefix = "") {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      const relative = prefix + entry.name;
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) { result.push([relative + "/", null]); await visit(file, relative + "/"); }
      else result.push([relative, await readFile(file)]);
    }
  }
  await visit(root);
  return result;
}

function stage(report: DoctorReport, id: DoctorStageId) { return report.stages.find((item) => item.id === id)!; }
function safe(report: DoctorReport) {
  expect(JSON.stringify(report)).not.toContain(secret);
  expect(JSON.stringify(report)).not.toContain("doctor-workspace-");
  expect(JSON.stringify(report)).not.toContain("doctor-cwd-");
  expect(JSON.stringify(report)).not.toContain("console.log(");
  expect(stage(report, "sandbox-approval")).toMatchObject({ status: "unknown", reason: "HOST_EVIDENCE_UNAVAILABLE" });
  for (const item of report.stages) {
    expect(["pass", "fail", "skipped", "unknown"]).toContain(item.status);
    expect(item.reason.length).toBeGreaterThan(0);
    expect(item.detail.length).toBeGreaterThan(0);
  }
}

function config(command: string, args: string[], extra = "") {
  return `# ${secret}\n[mcp_servers.code_intel_mcp]\ncommand = ${JSON.stringify(command)}\nargs = ${JSON.stringify(args)}\n${extra}`;
}

// A controlled stdio peer exercises actual SDK framing/handshake and failure paths.
// Its read response is derived from the supplied root's bytes, never a constant.
const peer = `
import { createInterface } from "node:readline";
import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
const mode = process.argv[2];
const state = { pid: process.pid, cwd: process.cwd() };
state.nativeData = process.env.XDG_DATA_HOME;
const save = () => writeFileSync(process.env.DOCTOR_STATE, JSON.stringify(state));
save();
process.stdin.on("end", () => { state.stdinEndedAt = Date.now(); save(); });
if (mode.endsWith("stubborn")) { setInterval(() => {}, 1000); process.on("SIGTERM", () => {}); }
const send = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id, result }) + "\\n");
createInterface({ input: process.stdin }).on("line", line => {
  const m = JSON.parse(line);
  if (m.method === "initialize") {
    if (mode === "handshake-timeout") return;
    if (mode.startsWith("handshake-error")) { process.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: m.id, error: { code: -32603, message: ${JSON.stringify(secret)} } }) + "\\n"); return; }
    send(m.id, { protocolVersion: m.params.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: "fixture", version: "1" } });
  } else if (m.method === "tools/list") {
    let names = ${JSON.stringify(tools)};
    if (mode === "catalog-extra") names.push("unexpected");
    if (mode === "catalog-missing") names.pop();
    if (mode === "catalog-duplicate") names[0] = names[1];
    send(m.id, { tools: names.map(name => ({ name, inputSchema: { type: "object" } })) });
  } else if (m.method === "tools/call") {
    state.workspace = m.params.arguments.workspaceRoot;
    state.environmentHonored = process.env.DOCTOR_SENTINEL === ${JSON.stringify(secret)};
    state.source = readFileSync(path.join(state.workspace, "sample.ts"), "utf8");
    save();
    if (mode === "read-timeout") return;
    if (mode === "read-error") { send(m.id, { isError: true, content: [{ type: "text", text: ${JSON.stringify(secret)} }] }); return; }
    const source = mode === "wrong-root" ? readFileSync(path.join(process.cwd(), "sample.ts"), "utf8") : state.source;
    if (mode === "mutate-source") writeFileSync(path.join(state.workspace, "sample.ts"), "changed");
    send(m.id, { content: [], structuredContent: { totalMatches: 1, matches: [{ path: "sample.ts", text: source.trim().replace(/;$/, "") }] } });
  }
});
`;

async function configuredPeer(mode: string) {
  const f = await fixture();
  const script = path.join(f.root, "peer.mjs");
  const state = path.join(f.root, "child-state.json");
  await writeFile(script, peer);
  await writeFile(f.config, config(process.execPath, [script, mode],
    `cwd = ${JSON.stringify(repository)}\n[mcp_servers.code_intel_mcp.env]\nDOCTOR_STATE = ${JSON.stringify(state)}\nDOCTOR_SENTINEL = ${JSON.stringify(secret)}\n`));
  return { ...f, state };
}

async function inspectPreserved(f: { config: string; home: string }) {
  const before = await snapshot(f.home);
  const report = await runDoctor({ configPath: f.config });
  expect(await snapshot(f.home)).toEqual(before);
  safe(report);
  return report;
}

async function closedFixture(statePath: string) {
  const state = JSON.parse(await readFile(statePath, "utf8")) as { pid: number; cwd: string; workspace?: string; nativeData?: string; environmentHonored?: boolean; source?: string; stdinEndedAt?: number };
  expect(await stat(state.cwd).catch(() => undefined)).toBeUndefined();
  if (state.workspace) expect(await stat(state.workspace).catch(() => undefined)).toBeUndefined();
  expect(state.nativeData).toBe(path.join(path.dirname(state.cwd), "native-data"));
  expect(await stat(state.nativeData!).catch(() => undefined)).toBeUndefined();
  let exists = true;
  try { process.kill(state.pid, 0); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ESRCH") exists = false; }
  expect(exists).toBe(false);
  return state;
}

describe("read-only Codex doctor", () => {
  test("uses sealed request and lifecycle limits", () => {
    expect(DOCTOR_LIMITS).toEqual({ request: 10_000, overall: 30_000, graceful: 2_000, termination: 1_000 });
  });

  for (const [text, reason] of [
    [undefined, "CONFIG_ABSENT"], ["[broken", "CONFIG_MALFORMED"],
    ['model = "fixture"\n', "CONFIG_MISSING_ENTRY"],
    ['mcp_servers = 3\n', "CONFIG_INVALID_ENTRY"],
    ['[mcp_servers]\ncode_intel_mcp = 3\n', "CONFIG_INVALID_ENTRY"],
    [config(process.execPath, [cli, "serve"], "enabled = false\n"), "CONFIG_DISABLED_ENTRY"],
  ] as const) {
    test(`${reason}: preserves config bytes and directory entries`, async () => {
      const f = await fixture();
      if (text !== undefined) await writeFile(f.config, text);
      const report = await inspectPreserved(f);
      expect(stage(report, "configuration")).toMatchObject({ status: "fail", reason });
      expect(stage(report, "spawn").status).toBe("skipped");
      expect(report.ok).toBe(false);
    });
  }

  test("missing selected home stays absent", async () => {
    const f = await fixture();
    const missing = path.join(f.root, "not created", "config.toml");
    const before = await snapshot(f.root);
    expect(stage(await runDoctor({ configPath: missing }), "configuration").reason).toBe("CONFIG_ABSENT");
    expect(await snapshot(f.root)).toEqual(before);
  });

  test("unreadable configuration remains a directory without side effects", async () => {
    const f = await fixture();
    await mkdir(f.config);
    const report = await inspectPreserved(f);
    expect(stage(report, "configuration")).toMatchObject({ status: "fail", reason: "CONFIG_UNREADABLE" });
    expect(stage(report, "spawn").status).toBe("skipped");
  });

  for (const extra of ['enabled = "yes"\n', 'cwd = "relative"\n', 'env_vars = [3]\n', '[mcp_servers.code_intel_mcp.env]\nINVALID = 3\n']) {
    test(`rejects invalid launch fields without spawn: ${extra.trim()}`, async () => {
      const f = await fixture();
      await writeFile(f.config, config(process.execPath, [cli, "serve"], extra));
      const report = await inspectPreserved(f);
      expect(stage(report, "executable")).toMatchObject({ status: "fail", reason: "INVALID_LAUNCH_SPECIFICATION" });
      expect(stage(report, "spawn").status).toBe("skipped");
    });
  }

  for (const [command, args, reason] of [
    ["relative-runtime", [], "INVALID_LAUNCH_SPECIFICATION"],
    [path.join(repository, "missing-doctor-runtime.exe"), [], "CONFIGURED_RUNTIME_MISSING"],
  ] as const) {
    test(reason, async () => {
      const f = await fixture();
      await writeFile(f.config, config(command, [...args]));
      const report = await inspectPreserved(f);
      expect(stage(report, "executable")).toMatchObject({ status: "fail", reason });
      expect(stage(report, "spawn").status).toBe("skipped");
    });
  }

  test("available runtime with oversized argv distinguishes actual spawn failure", async () => {
    const f = await fixture();
    // The previous shebang image made cross-spawn launch cmd.exe successfully.
    // Use the actual runtime and one argument beyond Windows/POSIX argv limits:
    // the OS must reject creating the child, independently of image fallback.
    await writeFile(f.config, config(process.execPath, ["x".repeat(1024 * 1024)]));
    const report = await inspectPreserved(f);
    expect(stage(report, "executable").status).toBe("pass");
    expect(stage(report, "spawn")).toMatchObject({ status: "fail", reason: "SPAWN_FAILED" });
    expect(stage(report, "initialize").status).toBe("skipped");
    expect(stage(report, "cleanup").status).toBe("pass");
  });

  for (const args of [[path.join(repository, "index.ts"), "--workspace-root", repository], [path.join(repository, "scripts", "mcp-launch.mjs")]]) {
    test(`diagnoses fixed startup root: ${path.basename(args[0]!)}`, async () => {
      const f = await fixture();
      await writeFile(f.config, config(process.execPath, args));
      const report = await inspectPreserved(f);
      expect(stage(report, "root-binding")).toMatchObject({ status: "fail", reason: "FIXED_ROOT_LAUNCH" });
      expect(stage(report, "spawn").status).toBe("skipped");
    });
  }

  for (const [mode, failed, reason] of [
    ["handshake-error", "initialize", "INITIALIZE_FAILED"],
    ["handshake-error-stubborn", "initialize", "INITIALIZE_FAILED"],
    ["handshake-timeout", "initialize", "REQUEST_TIMEOUT"],
    ["catalog-extra", "catalog", "CATALOG_MISMATCH"],
    ["catalog-missing", "catalog", "CATALOG_MISMATCH"],
    ["catalog-duplicate", "catalog", "CATALOG_MISMATCH"],
    ["read-error", "fixture-read", "AST_TOOL_ERROR"],
    ["read-timeout", "fixture-read", "REQUEST_TIMEOUT"],
    ["wrong-root", "fixture-read", "UNEXPECTED_AST_RESULT"],
    ["mutate-source", "fixture-read", "FIXTURE_SOURCE_CHANGED"],
  ] as const) {
    test(`${mode}: classifies failure and closes owned child and fixtures`, async () => {
      const f = await configuredPeer(mode);
      const report = await inspectPreserved(f);
      expect(stage(report, failed)).toMatchObject({ status: "fail", reason });
      expect(report.ok).toBe(false);
      if (mode === "wrong-root") expect(stage(report, "root-binding").status).toBe("fail");
      if (mode === "mutate-source") expect(stage(report, "cleanup").reason).toBe("CLEANUP_FAILED");
      else expect(stage(report, "cleanup").status).toBe("pass");
      await closedFixture(f.state);
    }, 16_000);
  }

  for (const mode of ["healthy", "stubborn"]) {
    test(`${mode}: honors configured env and validates a distinct explicit root, then reaps child`, async () => {
      const f = await configuredPeer(mode);
      const report = await inspectPreserved(f);
      expect(report.ok).toBe(true);
      expect(stage(report, "root-binding").reason).toBe("EXPLICIT_WORKSPACE_HONORED");
      expect(stage(report, "cleanup").status).toBe("pass");
      const state = await closedFixture(f.state);
      expect(state.cwd).not.toBe(state.workspace);
      expect(state.cwd).not.toBe(repository);
      expect(state.environmentHonored).toBe(true);
      expect(state.source).toContain("doctor-workspace-");
      expect(JSON.stringify(report)).not.toContain(state.source!);
      if (mode === "stubborn") {
        expect(state.stdinEndedAt).toBeNumber();
        // Measure from actual EOF, excluding startup/handshake time. The child
        // keeps its event loop alive, requiring escalation after the grace.
        const cleanupElapsed = Date.now() - state.stdinEndedAt!;
        expect(cleanupElapsed).toBeGreaterThanOrEqual(DOCTOR_LIMITS.graceful - 100);
        expect(cleanupElapsed).toBeLessThan(DOCTOR_LIMITS.graceful + DOCTOR_LIMITS.termination + 500);
      }
    }, 10_000);
  }

  test("real global CLI initializes, discovers exact five tools, and reads fixture without mutation", async () => {
    const f = await fixture();
    await writeFile(f.config, config(process.execPath, [cli, "serve"]));
    const report = await inspectPreserved(f);
    expect(report.ok).toBe(true);
    expect(stage(report, "catalog").reason).toBe("EXACT_AST_CATALOG");
    expect(stage(report, "fixture-read").reason).toBe("EXPECTED_AST_RESULT");
    expect(stage(report, "cleanup").status).toBe("pass");
  }, 20_000);

  test("CLI selects CODEX_HOME or explicit config and emits only a safe JSON report", async () => {
    const f = await fixture();
    await writeFile(f.config, "[broken " + secret);
    const before = await snapshot(f.home);
    for (const args of [["doctor", "--host", "codex"], ["doctor", "--host", "codex", "--config", f.config]]) {
      const result = spawnSync(process.execPath, [cli, ...args], { env: { ...process.env, CODEX_HOME: f.home }, encoding: "utf8", timeout: 35_000, windowsHide: true });
      expect(result.status).toBe(1);
      expect(result.stderr).toBe("");
      const report = JSON.parse(result.stdout) as DoctorReport;
      safe(report);
      expect(stage(report, "configuration").reason).toBe("CONFIG_MALFORMED");
    }
    expect(await snapshot(f.home)).toEqual(before);
  });

  for (const [mode, failed, reason] of [
    ["handshake-error", "initialize", "INITIALIZE_FAILED"],
    ["catalog-extra", "catalog", "CATALOG_MISMATCH"],
    ["read-error", "fixture-read", "AST_TOOL_ERROR"],
    ["wrong-root", "root-binding", "INCORRECT_WORKSPACE_RESULT"],
  ] as const) {
    test(`CLI ${mode}: stdout is only a safe failure report and resources close`, async () => {
      const f = await configuredPeer(mode);
      const before = await snapshot(f.home);
      const result = spawnSync(process.execPath, [cli, "doctor", "--host", "codex", "--config", f.config], {
        encoding: "utf8", timeout: 35_000, windowsHide: true,
      });
      expect(result.error).toBeUndefined();
      expect(result.status).toBe(1);
      expect(result.stderr).toBe("");
      const report = JSON.parse(result.stdout) as DoctorReport;
      safe(report);
      expect(stage(report, failed)).toMatchObject({ status: "fail", reason });
      expect(stage(report, "cleanup").status).toBe("pass");
      expect(await snapshot(f.home)).toEqual(before);
      const state = await closedFixture(f.state);
      if (state.source) expect(result.stdout).not.toContain(state.source);
      expect(result.stdout).not.toContain(f.config);
      expect(result.stdout).not.toContain(f.state);
    }, 40_000);
  }

  const prerequisiteCases = [
    { existing: false, missing: "all" },
    { existing: true, missing: "all" },
    ...["@ltd/j-toml", "@modelcontextprotocol/client", "@modelcontextprotocol/server", "@oh-my-pi/pi-natives", "zod", "transitive", "native-addon"].map((missing) => ({ existing: true, missing })),
  ];
  for (const { existing, missing } of prerequisiteCases) {
    test(`missing ${missing} reports before doctor import; no autoinstall, config or cache writes (config=${existing})`, async () => {
      const f = await fixture();
      const install = path.join(f.root, "source install");
      await mkdir(path.join(install, "scripts"), { recursive: true });
      await cp(path.join(repository, "src", "cli"), path.join(install, "src", "cli"), { recursive: true });
      await cp(cli, path.join(install, "scripts", "code-intel.mjs"));
      // A poison module proves the builtin preflight wins before import evaluation.
      await writeFile(path.join(install, "src", "cli", "doctor.ts"), `throw new Error(${JSON.stringify(secret)});`);
      if (missing !== "all") {
        for (const name of ["@ltd/j-toml", "@modelcontextprotocol/client", "@modelcontextprotocol/server", "@oh-my-pi/pi-natives", "zod"]) {
          if (name === missing) continue;
          const directory = path.join(install, "node_modules", name);
          await mkdir(directory, { recursive: true });
          await writeFile(path.join(directory, "package.json"), JSON.stringify({
            name, version: "1.0.0", dependencies: missing === "transitive" && name === "@ltd/j-toml" ? { "doctor-missing-transitive-fixture": "1.0.0" } : {},
          }));
        }
      }
      if (existing) await writeFile(f.config, "[broken " + secret);
      const before = await snapshot(f.root);
      const result = spawnSync(process.execPath, [path.join(install, "scripts", "code-intel.mjs"), "doctor", "--host", "codex"], {
        env: { ...process.env, CODEX_HOME: f.home, BUN_INSTALL: path.join(f.root, "bun install"), BUN_INSTALL_CACHE_DIR: path.join(f.root, "bun cache") },
        cwd: f.root, encoding: "utf8", timeout: 5_000, windowsHide: true,
      });
      expect(result.status).toBe(1);
      expect(result.stderr).toBe("");
      const report = JSON.parse(result.stdout) as DoctorReport;
      expect(stage(report, "prerequisites")).toMatchObject({ status: "fail", reason: "MISSING_RUNTIME_DEPENDENCY" });
      expect(stage(report, "configuration").status).toBe("skipped");
      safe(report);
      expect(await snapshot(f.root)).toEqual(before);
    });
  }
});
