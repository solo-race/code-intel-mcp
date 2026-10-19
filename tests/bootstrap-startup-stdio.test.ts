import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, test } from "bun:test";

const roots: string[] = [];
const children = new Set<ChildProcess>();
const source = 'function demo() { console.log("D1 fixture"); }\n';
const tools = ["ast_edit_apply", "ast_edit_preview", "ast_search", "ast_transform_plan_preview", "ast_transform_preview"];

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((done) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 2_000);
    child.once("close", () => { clearTimeout(timer); done(); });
    child.stdin?.end();
  });
}

afterEach(async () => {
  await Promise.all([...children].map(stop));
  children.clear();
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
  ));
});

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "code-intel-d1-"));
  roots.push(base);
  const runtimeCache = await mkdtemp(join(tmpdir(), "code-intel-d1-runtime-"));
  roots.push(runtimeCache);
  const workspace = join(base, "workspace");
  const cwd = join(base, "unrelated-cwd");
  const bin = join(base, "bin");
  const home = join(base, "home");
  const store = join(base, "provider-store");
  await Promise.all([workspace, cwd, bin, home, store].map((path) => mkdir(path)));
  // Keep permitted runtime caches outside the source/config/provider snapshot.
  // The native loader selects XDG_DATA_HOME only when its omp directory exists.
  await Promise.all(["omp", "bun-install", "bun-transpiler"].map((name) =>
    mkdir(join(runtimeCache, name)),
  ));
  await writeFile(join(workspace, "sample.ts"), source);
  await writeFile(join(cwd, "sample.ts"), "const unrelated = 1;\n");
  await writeFile(join(home, "unrelated.txt"), "unrelated HOME sentinel\n");
  return { base, workspace, cwd, bin, home, store, runtimeCache };
}

/** Protect every entry and byte in the source/config/provider fixture, including HOME. */
async function snapshot(root: string): Promise<Array<[string, Buffer | null]>> {
  const entries: Array<[string, Buffer | null]> = [];
  async function visit(directory: string, prefix: string) {
    const names = await readdir(directory, { withFileTypes: true });
    names.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of names) {
      const relative = prefix + entry.name;
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        entries.push([relative + "/", null]);
        await visit(path, relative + "/");
      } else entries.push([relative, await readFile(path)]);
    }
  }
  await visit(root, "");
  return entries;
}

async function expectSnapshotUnchanged(root: string, before: Awaited<ReturnType<typeof snapshot>>) {
  const after = await snapshot(root);
  expect(after.map(([path]) => path)).toEqual(before.map(([path]) => path));
  for (let index = 0; index < before.length; index++) {
    const [path, expected] = before[index]!;
    const actual = after[index]![1];
    // Compare exact bytes without rendering binary file contents on assertion failure.
    expect(expected === null ? actual === null : actual !== null && actual.equals(expected),
      `fixture bytes changed: ${path}`).toBe(true);
  }
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
type Mode = "global" | "fixed" | "launcher";
type Frame = {
  jsonrpc: string; id?: number; error?: unknown;
  result?: {
    tools?: Array<{ name: string }>;
    isError?: boolean;
    structuredContent?: { totalMatches?: number };
  };
};

function environment(context: Fixture, markers: boolean): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (/^(PATH|GPT_REPO_CONFIG|REPO_READER_CONFIG|HOME|USERPROFILE|CODEX_HOME|XDG_CONFIG_HOME|XDG_DATA_HOME|APPDATA|LOCALAPPDATA|BUN_INSTALL_CACHE_DIR|BUN_RUNTIME_TRANSPILER_CACHE_PATH)$/i.test(key)) delete env[key];
  }
  Object.assign(env, {
    PATH: context.bin, HOME: context.home, USERPROFILE: context.home,
    CODEX_HOME: context.home, XDG_CONFIG_HOME: context.home,
    XDG_DATA_HOME: context.runtimeCache, APPDATA: context.home, LOCALAPPDATA: context.home,
    BUN_INSTALL_CACHE_DIR: join(context.runtimeCache, "bun-install"),
    BUN_RUNTIME_TRANSPILER_CACHE_PATH: join(context.runtimeCache, "bun-transpiler"),
  });
  if (markers) {
    env.GPT_REPO_CONFIG = join(context.store, "gpt.json");
    env.REPO_READER_CONFIG = join(context.store, "reader.json");
  }
  return env;
}

async function markerProviders(context: Fixture) {
  const marker = join(context.store, "invoked");
  const windows = process.platform === "win32";
  for (const name of ["codebase-memory-mcp", "gpt-repo-local", "connect-gpt", "git"]) {
    const body = windows
      ? `@echo off\r\necho invoked>>"${marker}"\r\necho {}\r\n`
      : `#!/bin/sh\nprintf invoked >> '${marker}'\nprintf '{}\\n'\n`;
    await writeFile(join(context.bin, name + (windows ? ".cmd" : "")), body, { mode: 0o755 });
  }
  await writeFile(join(context.store, "gpt.json"), '{"repos":[]}\r\n');
  await writeFile(join(context.store, "reader.json"), '{"repos":[]}\n');
}

async function readSession(context: Fixture, mode: Mode, markers: boolean) {
  const args = mode === "global"
    ? [resolve("scripts/code-intel.mjs"), "serve"]
    : mode === "fixed"
      ? [resolve("index.ts"), "--workspace-root", context.workspace]
      : [resolve("scripts/mcp-launch.mjs")];
  const child = spawn(process.execPath, args, {
    cwd: mode === "launcher" ? context.workspace : context.cwd,
    env: environment(context, markers),
    stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  });
  children.add(child);
  let stdout = "";
  let stderr = "";
  let pending = "";
  const frames: Frame[] = [];
  const waiters = new Map<number, { resolve: (frame: Frame) => void; reject: (error: Error) => void }>();
  let failure: Error | undefined;
  function fail(error: Error) {
    failure = error;
    for (const waiter of waiters.values()) waiter.reject(error);
    waiters.clear();
  }
  child.stdout!.setEncoding("utf8");
  child.stderr!.setEncoding("utf8");
  child.stderr!.on("data", (chunk) => { stderr += String(chunk); });
  child.on("error", fail);
  child.on("close", () => fail(new Error("server closed before response")));
  child.stdout!.on("data", (chunk) => {
    stdout += String(chunk);
    pending += String(chunk);
    while (pending.includes("\n")) {
      const end = pending.indexOf("\n");
      const line = pending.slice(0, end);
      pending = pending.slice(end + 1);
      try {
        const frame = JSON.parse(line) as Frame;
        frames.push(frame);
        if (frame.id !== undefined) {
          waiters.get(frame.id)?.resolve(frame);
          waiters.delete(frame.id);
        }
      } catch { fail(new Error("non-protocol stdout")); }
    }
  });
  async function request(id: number, method: string, params: unknown = {}) {
    if (failure) throw failure;
    let timer: ReturnType<typeof setTimeout>;
    const response = new Promise<Frame>((resolveResponse, reject) => {
      timer = setTimeout(() => { waiters.delete(id); reject(new Error("MCP response timeout")); }, 10_000);
      waiters.set(id, { resolve: resolveResponse, reject });
    });
    child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    try { return await response; } finally { clearTimeout(timer!); }
  }
  try {
    const initialized = await request(1, "initialize", {
      protocolVersion: LATEST_PROTOCOL_VERSION, capabilities: {},
      clientInfo: { name: "d1-startup-test", version: "1.0.0" },
    });
    expect(initialized.error).toBeUndefined();
    expect(initialized.result).toBeDefined();
    child.stdin!.write(JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) + "\n");
    const listed = await request(2, "tools/list");
    expect(listed.result?.tools?.map((tool) => tool.name).sort()).toEqual(tools);
    const searched = await request(3, "tools/call", {
      name: "ast_search",
      arguments: {
        pattern: "console.log($$$ARGS)", path: "sample.ts",
        ...(mode === "global" ? { workspaceRoot: context.workspace } : {}),
      },
    });
    expect(searched.error).toBeUndefined();
    expect(searched.result?.isError).not.toBe(true);
    expect(searched.result?.structuredContent?.totalMatches).toBe(1);
  } finally {
    await stop(child);
    children.delete(child);
  }
  expect(pending).toBe("");
  expect(stdout.trim().length).toBeGreaterThan(0);
  expect(frames.every((frame) => frame.jsonrpc === "2.0")).toBe(true);
  for (const line of stdout.trim().split(/\r?\n/u)) {
    expect(JSON.parse(line).jsonrpc).toBe("2.0");
  }
  expect(stderr).not.toContain("BOOTSTRAP");
}

describe("provider-independent startup", () => {
  for (const mode of ["global", "fixed", "launcher"] as const) {
    test(`${mode}: initializes, lists five tools and reads without Git/providers/config`, async () => {
      const context = await fixture();
      const env = environment(context, false);
      expect(env.GPT_REPO_CONFIG).toBeUndefined();
      expect(env.REPO_READER_CONFIG).toBeUndefined();
      expect(await readdir(context.bin)).toEqual([]);
      expect(await readdir(context.workspace)).toEqual(["sample.ts"]);
      const before = await snapshot(context.base);
      await readSession(context, mode, false);
      await expectSnapshotUnchanged(context.base, before);
      expect(await readFile(join(context.workspace, "sample.ts"), "utf8")).toBe(source);
    }, 30_000);

    test(`${mode}: invokes no markers and changes no provider bytes or entries`, async () => {
      const context = await fixture();
      await markerProviders(context);
      const before = await snapshot(context.base);
      await readSession(context, mode, true);
      await expectSnapshotUnchanged(context.base, before);
      expect((await readdir(context.store)).sort()).toEqual(["gpt.json", "reader.json"]);
      expect(await readFile(join(context.workspace, "sample.ts"), "utf8")).toBe(source);
    }, 30_000);
  }

  test("rejects a missing explicit startup root before serving", async () => {
    const context = await fixture();
    const child = spawn(process.execPath, [
      resolve("index.ts"), "--workspace-root", join(context.base, "missing"),
    ], { cwd: context.cwd, env: environment(context, false), stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    children.add(child);
    let stdout = "";
    let stderr = "";
    child.stdout!.on("data", (chunk) => { stdout += String(chunk); });
    child.stderr!.on("data", (chunk) => { stderr += String(chunk); });
    const code = await new Promise<number | null>((done, reject) => {
      child.once("error", reject);
      child.once("close", done);
    });
    children.delete(child);
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("WORKSPACE_ROOT_NOT_FOUND");
    expect(stderr).not.toContain("BOOTSTRAP");
  }, 30_000);
});
