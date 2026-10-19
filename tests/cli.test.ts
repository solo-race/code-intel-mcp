import { spawnSync } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterEach, describe, expect, test } from "bun:test";

import { codexSnippet, runtimeEntry } from "../src/cli/host-entry.ts";
import { parseCommand } from "../src/cli/main.ts";

const repository = path.resolve(import.meta.dir, "..");
const entry = path.join(repository, "scripts", "code-intel.mjs");
const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
  ));
});

async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), "code-intel-cli-"));
  temporaryRoots.push(root);
  const cwd = path.join(root, "unrelated cwd");
  await mkdir(cwd);
  return { root, cwd, home: path.join(root, "isolated home") };
}

function invoke(cli: string, args: string[], cwd: string, home: string, environment: NodeJS.ProcessEnv = {}) {
  const result = spawnSync(process.execPath, [cli, ...args], {
    cwd,
    env: { ...process.env, CODEX_HOME: home, PATH: path.dirname(process.execPath), ...environment },
    encoding: "utf8",
    windowsHide: true,
  });
  return { ...result, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
}

/** Copy runtime source only; the working installation's dependencies stay intact. */
async function copyRuntime(root: string, dependencies: boolean): Promise<string> {
  const install = path.join(root, "工作 space", "运行 install");
  await mkdir(path.join(install, "scripts"), { recursive: true });
  for (const file of ["index.ts", "package.json", "bun.lock"]) {
    await cp(path.join(repository, file), path.join(install, file));
  }
  await cp(path.join(repository, "src"), path.join(install, "src"), { recursive: true });
  await cp(entry, path.join(install, "scripts", "code-intel.mjs"));
  if (dependencies) {
    await symlink(path.join(repository, "node_modules"), path.join(install, "node_modules"),
      process.platform === "win32" ? "junction" : "dir");
  }
  return path.join(install, "scripts", "code-intel.mjs");
}

describe("stable CLI", () => {
  test("accepts only supported explicit commands, hosts, scopes and flags", () => {
    expect(parseCommand([])).toEqual({ command: "help" });
    expect(parseCommand(["--help"])).toEqual({ command: "help" });
    expect(parseCommand(["serve"])).toEqual({ command: "serve" });
    expect(parseCommand(["install", "--scope", "user", "--host", "codex", "--dry-run"]))
      .toEqual({ command: "install", dryRun: true });
    expect(parseCommand(["uninstall", "--host", "codex", "--scope", "user"]))
      .toEqual({ command: "uninstall", dryRun: false });
    expect(parseCommand(["print-config", "--host", "generic-stdio"]))
      .toEqual({ command: "print-config" });
    expect(parseCommand(["doctor", "--host", "codex"]))
      .toEqual({ command: "doctor" });
    expect(parseCommand(["doctor", "--host", "codex", "--config", "fixture config.toml"]))
      .toEqual({ command: "doctor", configPath: "fixture config.toml" });
    for (const args of [
      ["doctor"], ["inspect"], ["serve", "--workspace-root", "/tmp"],
      ["doctor", "--host", "other"], ["doctor", "--host", "codex", "--dry-run"],
      ["doctor", "--host", "codex", "--scope", "user"],
      ["doctor", "--host", "codex", "--config"],
      ["doctor", "--host", "codex", "--config", "a", "--config", "b"],
      ["install"], ["install", "--host", "codex"],
      ["install", "--host", "omp", "--scope", "user"],
      ["install", "--host", "codex", "--scope", "system"],
      ["install", "--host", "--scope", "user"],
      ["install", "--host", "codex", "--scope", "user", "--host", "codex"],
      ["install", "--host", "codex", "--scope", "user", "--dry-run", "--dry-run"],
      ["print-config", "--host", "generic-stdio", "--dry-run"],
      ["print-config", "--host", "generic-stdio", "--scope", "user"],
      ["install", "--host=codex", "--scope", "user"],
    ]) expect(() => parseCommand(args)).toThrow();
  });

  test("preserves argv values and native UNC strings in TOML without shell quoting", () => {
    const nativeEntry = runtimeEntry(pathToFileURL(entry).href);
    expect(nativeEntry).toEqual({ command: process.execPath, args: [entry, "serve"] });
    const uncEntry = { command: "\\\\server\\工作 space\\bun.exe", args: ["\\\\server\\安装 path\\scripts\\code-intel.mjs", "serve"] as const };
    expect(Bun.TOML.parse(codexSnippet(uncEntry))).toEqual({ mcp_servers: { code_intel_mcp: uncEntry } });
  });

  test("help, dry-run and malformed invocation create no config directories", async () => {
    const { root, cwd, home } = await fixture();
    const before = await readdir(root);
    const help = invoke(entry, ["--help"], cwd, home);
    expect(help.status).toBe(0);
    expect(help.stdout).toContain("code-intel serve");
    const dry = invoke(entry, ["install", "--host", "codex", "--scope", "user", "--dry-run"], cwd, home);
    expect(dry.status).toBe(0);
    expect(JSON.parse(dry.stdout).status).toBe("would-install");
    for (const args of [
      ["install", "--host", "omp", "--scope", "user"],
      ["install", "--host", "codex", "--scope", "system"],
      ["serve", "--quoted-path=\"broken"],
    ]) {
      const invalid = invoke(entry, args, cwd, home);
      expect(invalid.status).toBe(1);
      expect(invalid.stdout).toBe("");
      expect(invalid.stderr).toContain("CODE_INTEL_ERROR");
    }
    expect(await readdir(root)).toEqual(before);
  });

  test("conflicting configuration returns a manual snippet without takeover", async () => {
    const { cwd, home } = await fixture();
    await mkdir(home);
    const config = path.join(home, "config.toml");
    const original = Buffer.from('[mcp_servers.code_intel_mcp]\ncommand = "another-runtime"\nargs = []\n');
    await writeFile(config, original);
    const result = invoke(entry, ["install", "--host", "codex", "--scope", "user"], cwd, home);
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Manual configuration (not installed or verified)");
    expect(result.stderr).toContain(codexSnippet(runtimeEntry(pathToFileURL(entry).href)));
    expect(await readFile(config)).toEqual(original);
    expect(await readdir(home)).toEqual(["config.toml"]);
  });

  test("space/Unicode installation generates argv, installs reversibly, and serves five tools from another cwd", async () => {
    const { root, cwd, home } = await fixture();
    const cli = await copyRuntime(root, true);
    const printed = invoke(cli, ["print-config", "--host", "generic-stdio"], cwd, home);
    expect(printed.status).toBe(0);
    const generated = JSON.parse(printed.stdout) as { command: string; args: string[] };
    expect(generated).toEqual({ command: process.execPath, args: [cli, "serve"] });
    await mkdir(home);
    const config = path.join(home, "config.toml");
    const original = Buffer.from('# unrelated comment\nmodel = "fixture-model"\n[mcp_servers.other]\ncommand = "fixture-other"\nargs = []');
    await writeFile(config, original);
    const args = ["--host", "codex", "--scope", "user"];
    const installed = invoke(cli, ["install", ...args], cwd, home);
    expect(installed.status).toBe(0);
    expect(JSON.parse(installed.stdout).status).toBe("installed");
    const installedBytes = await readFile(config);
    const parsed = Bun.TOML.parse(installedBytes) as { mcp_servers: { code_intel_mcp: typeof generated } };
    expect(parsed.mcp_servers.code_intel_mcp).toEqual(generated);
    const files = await readdir(home);
    expect(JSON.parse(invoke(cli, ["install", ...args], cwd, home).stdout).status).toBe("unchanged");
    expect(await readFile(config)).toEqual(installedBytes);
    expect(await readdir(home)).toEqual(files);

    const transport = new StdioClientTransport({
      ...parsed.mcp_servers.code_intel_mcp,
      cwd,
      env: { ...process.env, CODEX_HOME: home, PATH: path.dirname(process.execPath) },
      stderr: "pipe",
    });
    let diagnostics = "";
    transport.stderr?.on("data", (chunk) => { diagnostics += String(chunk); });
    const client = new Client({ name: "code-intel-cli-test", version: "0.1.0" });
    try {
      await client.connect(transport);
      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
        "ast_edit_apply", "ast_edit_preview", "ast_search", "ast_transform_plan_preview", "ast_transform_preview",
      ]);
      const search = listed.tools.find((tool) => tool.name === "ast_search")!;
      expect(search.inputSchema.required).toContain("workspaceRoot");
    } finally {
      await client.close();
    }
    expect(diagnostics).not.toContain("BOOTSTRAP");
    const uninstalled = invoke(cli, ["uninstall", ...args], cwd, home);
    expect(uninstalled.status).toBe(0);
    expect(JSON.parse(uninstalled.stdout).status).toBe("uninstalled");
    expect(await readFile(config)).toEqual(original);
  }, 20_000);

  test("missing runtime and missing dependency fail in isolated fixtures", async () => {
    const { root, cwd, home } = await fixture();
    const missing = spawnSync(path.join(root, "absent-bun.exe"), [entry, "--help"], { windowsHide: true });
    expect((missing.error as NodeJS.ErrnoException).code).toBe("ENOENT");
    const cli = await copyRuntime(root, false);
    const failed = invoke(cli, ["serve"], cwd, home);
    expect(failed.status).toBe(1);
    expect(failed.stdout).toBe("");
    expect(failed.stderr).toContain("CODE_INTEL_ERROR");
    expect(failed.stderr).toContain("MISSING_RUNTIME_DEPENDENCY");
    expect(await readdir(path.resolve(cli, "../.."))).not.toContain("node_modules");
    expect(await readdir(root)).not.toContain("isolated home");
  });

  for (const operation of ["install", "uninstall"] as const) {
    for (const dryRun of [false, true]) {
      for (const existing of [false, true]) {
        test(`missing parser rejects ${operation} dryRun=${dryRun} existingConfig=${existing} without any artifacts`, async () => {
          const { root, cwd, home } = await fixture();
          const cli = await copyRuntime(root, false);
          const config = path.join(home, "config.toml");
          const original = Buffer.from('# preserved configuration\nmodel = "fixture"\n');
          if (existing) {
            await mkdir(home);
            await writeFile(config, original);
          }
          const before = (await readdir(root, { recursive: true })).sort();
          const result = invoke(cli, [operation, "--host", "codex", "--scope", "user", ...(dryRun ? ["--dry-run"] : [])], cwd, home, {
            BUN_INSTALL: path.join(root, "isolated bun"),
            BUN_INSTALL_CACHE_DIR: path.join(root, "isolated bun cache"),
          });
          expect(result.error).toBeUndefined();
          expect(result.status).toBe(1);
          expect(result.stdout).toBe("");
          expect(result.stderr).toContain("CODE_INTEL_ERROR: MISSING_RUNTIME_DEPENDENCY: @ltd/j-toml");
          // Includes config, node_modules, backup/temp files and both Bun paths.
          expect((await readdir(root, { recursive: true })).sort()).toEqual(before);
          if (existing) expect(await readFile(config)).toEqual(original);
        });
      }
    }
  }
});
