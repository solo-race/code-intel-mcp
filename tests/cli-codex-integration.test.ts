import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { expect, test } from "bun:test";

// The independent C3 gate must supply a native Codex executable explicitly.
// Ordinary unit runs neither discover a host installation nor use its live home.
const codex = process.env.CODE_INTEL_TEST_CODEX;

test.skipIf(!codex)("real Codex recognizes isolated installation and its returned argv serves MCP", async () => {
  expect(path.isAbsolute(codex!)).toBe(true);
  const repository = path.resolve(import.meta.dir, "..");
  const root = await mkdtemp(path.join(tmpdir(), "code-intel-codex-"));
  try {
    const install = path.join(root, "工作 space", "安装 runtime");
    const home = path.join(root, "isolated codex home");
    const cwd = path.join(root, "unrelated cwd");
    await mkdir(path.join(install, "scripts"), { recursive: true });
    await mkdir(home);
    await mkdir(cwd);
    for (const file of ["index.ts", "package.json", "bun.lock", "scripts/code-intel.mjs"]) {
      await cp(path.join(repository, file), path.join(install, file));
    }
    await cp(path.join(repository, "src"), path.join(install, "src"), { recursive: true });
    await symlink(path.join(repository, "node_modules"), path.join(install, "node_modules"),
      process.platform === "win32" ? "junction" : "dir");
    const cli = path.join(install, "scripts", "code-intel.mjs");
    const env = { ...process.env, CODEX_HOME: home };
    function run(command: string, args: string[]) {
      const result = spawnSync(command, args, { cwd, env, encoding: "utf8", windowsHide: true, timeout: 15_000 });
      expect(result.error).toBeUndefined();
      return { ...result, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
    }
    const flags = ["--host", "codex", "--scope", "user"];
    const invoke = (args: string[]) => run(process.execPath, [cli, ...args]);
    const config = path.join(home, "config.toml");
    const original = Buffer.from('# retained comment\nmodel = "fixture-model"\n[mcp_servers.other]\ncommand = "fixture-other"\nargs = []');
    await writeFile(config, original);
    const initialFiles = await readdir(home);
    expect(invoke(["install", ...flags, "--dry-run"]).status).toBe(0);
    expect(await readFile(config)).toEqual(original);
    expect(await readdir(home)).toEqual(initialFiles);
    expect(invoke(["install", ...flags]).status).toBe(0);
    const installed = await readFile(config);
    const listed = run(codex!, ["mcp", "list", "--json"]);
    expect(listed.status).toBe(0);
    expect(JSON.parse(listed.stdout).some((item: { name: string }) => item.name === "code_intel_mcp")).toBe(true);
    const got = run(codex!, ["mcp", "get", "code_intel_mcp", "--json"]);
    expect(got.status).toBe(0);
    const readback = JSON.parse(got.stdout) as { transport: { type: string; command: string; args: string[]; cwd?: string | null; env?: unknown } };
    expect(readback.transport.type).toBe("stdio");
    expect(readback.transport.command).toBe(process.execPath);
    expect(readback.transport.args).toEqual([cli, "serve"]);
    expect(readback.transport.cwd ?? null).toBeNull();
    expect(readback.transport.env ?? null).toBeNull();
    const transport = new StdioClientTransport({
      command: readback.transport.command, args: readback.transport.args, cwd,
      env: { ...env, PATH: path.dirname(process.execPath) }, stderr: "pipe",
    });
    let diagnostics = "";
    transport.stderr?.on("data", (chunk) => { diagnostics += String(chunk); });
    const client = new Client({ name: "isolated-real-codex", version: "0.1.0" });
    try {
      await client.connect(transport);
      expect((await client.listTools()).tools.map((tool) => tool.name).sort()).toEqual([
        "ast_edit_apply", "ast_edit_preview", "ast_search", "ast_transform_plan_preview", "ast_transform_preview",
      ]);
    } finally {
      await client.close();
    }
    expect(diagnostics).not.toContain("BOOTSTRAP");
    const beforeRepeat = await readdir(home);
    expect(JSON.parse(invoke(["install", ...flags]).stdout).status).toBe("unchanged");
    expect(await readFile(config)).toEqual(installed);
    expect(await readdir(home)).toEqual(beforeRepeat);
    expect(invoke(["uninstall", ...flags]).status).toBe(0);
    expect(await readFile(config)).toEqual(original);
    const afterUninstall = run(codex!, ["mcp", "list", "--json"]);
    expect(afterUninstall.status).toBe(0);
    expect(JSON.parse(afterUninstall.stdout).map((item: { name: string }) => item.name)).toEqual(["other"]);
    await writeFile(config, "[unclosed");
    const invalidFiles = await readdir(home);
    expect(invoke(["install", ...flags]).status).toBe(1);
    expect(run(codex!, ["mcp", "list", "--json"]).status).not.toBe(0);
    expect(await readFile(config, "utf8")).toBe("[unclosed");
    expect(await readdir(home)).toEqual(invalidFiles);
  } finally {
    await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 });
  }
}, 60_000);
