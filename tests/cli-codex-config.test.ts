import { parse } from "@ltd/j-toml";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import { editCodexConfig, type ConfigIO } from "../src/cli/codex-config.ts";
import { codexSnippet, type HostEntry } from "../src/cli/host-entry.ts";

const entry: HostEntry = { command: process.execPath, args: [path.resolve("工作 space", "code-intel.mjs"), "serve"] };
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })));
});

async function fixture(original?: string): Promise<{ home: string; config: string }> {
  const base = await fs.mkdtemp(path.join(tmpdir(), "code-intel-install-"));
  roots.push(base);
  const home = path.join(base, "隔离 home");
  const config = path.join(home, "config.toml");
  if (original !== undefined) {
    await fs.mkdir(home);
    await fs.writeFile(config, original);
  }
  return { home, config };
}

const actualIO: ConfigIO = {
  readFile: (file) => fs.readFile(file),
  mkdir: (directory) => fs.mkdir(directory, { recursive: true }),
  writeExclusive: (file, bytes) => fs.writeFile(file, bytes, { flag: "wx" }),
  rename: (from, to) => fs.rename(from, to),
  unlink: (file) => fs.unlink(file),
};

describe("explicit Codex user configuration editing", () => {
  for (const original of [undefined, "", '# comment\nmodel = "fixture"', '# comments\r\nunknown_setting = 42\r\n[mcp_servers.other]\r\ncommand = "other"\r\nargs = []\r\n']) {
    test(`install/reinstall/uninstall preserves exact bytes: ${JSON.stringify(original)}`, async () => {
      const { home, config } = await fixture(original);
      const installed = await editCodexConfig("install", entry, { home, dryRun: false });
      expect(installed.status).toBe("installed");
      expect(parse(await fs.readFile(config, "utf8"), 1.0, "\n", true, null)).toMatchObject({ mcp_servers: { code_intel_mcp: entry } });
      if (original === undefined) expect(installed.backupPath).toBeUndefined();
      else {
        expect(await fs.readFile(installed.backupPath!, "utf8")).toBe(original);
        expect(installed.restore).toContain(installed.backupPath!);
      }
      const installedBytes = await fs.readFile(config);
      const installedFiles = (await fs.readdir(home)).sort();
      expect((await editCodexConfig("install", entry, { home, dryRun: false })).status).toBe("unchanged");
      expect(await fs.readFile(config)).toEqual(installedBytes);
      expect((await fs.readdir(home)).sort()).toEqual(installedFiles);
      const removed = await editCodexConfig("uninstall", entry, { home, dryRun: false });
      expect(removed.status).toBe("uninstalled");
      expect(await fs.readFile(config)).toEqual(Buffer.from(original ?? ""));
      expect(await fs.readFile(removed.backupPath!)).toEqual(installedBytes);
      const finalFiles = (await fs.readdir(home)).sort();
      expect((await editCodexConfig("uninstall", entry, { home, dryRun: false })).status).toBe("unchanged");
      expect((await fs.readdir(home)).sort()).toEqual(finalFiles);
    });
  }

  test("dry-run and absent uninstall create no directories or backups", async () => {
    const { home } = await fixture();
    expect((await editCodexConfig("install", entry, { home, dryRun: true })).status).toBe("would-install");
    expect((await editCodexConfig("uninstall", entry, { home, dryRun: false })).status).toBe("unchanged");
    expect(await fs.stat(home).then(() => true, () => false)).toBe(false);
  });

  test("both dry-run operations leave configuration bytes and directory contents untouched", async () => {
    const { home, config } = await fixture('# unrelated\nmodel = "fixture"\n');
    for (const operation of ["install", "uninstall"] as const) {
      if (operation === "uninstall") await editCodexConfig("install", entry, { home, dryRun: false });
      const before = await fs.readFile(config);
      const files = (await fs.readdir(home)).sort();
      const result = await editCodexConfig(operation, entry, { home, dryRun: true });
      expect(result.status).toBe(`would-${operation}`);
      expect(await fs.readFile(config)).toEqual(before);
      expect((await fs.readdir(home)).sort()).toEqual(files);
    }
  });

  test("equivalent unowned entry is externally managed and never removed", async () => {
    const original = `# managed elsewhere\n${codexSnippet(entry)}`;
    const { home, config } = await fixture(original);
    for (const operation of ["install", "uninstall"] as const) {
      expect((await editCodexConfig(operation, entry, { home, dryRun: false })).status).toBe("externally-managed");
      expect(await fs.readFile(config, "utf8")).toBe(original);
      expect(await fs.readdir(home)).toEqual(["config.toml"]);
    }
  });

  test("conflicting unowned entry refuses takeover with an exact manual snippet", async () => {
    const original = '[mcp_servers.code_intel_mcp]\ncommand = "other"\nargs = []\n';
    const { home, config } = await fixture(original);
    await expect(editCodexConfig("install", entry, { home, dryRun: false })).rejects.toThrow(codexSnippet(entry));
    expect((await editCodexConfig("uninstall", entry, { home, dryRun: false })).status).toBe("externally-managed");
    expect(await fs.readFile(config, "utf8")).toBe(original);
    expect(await fs.readdir(home)).toEqual(["config.toml"]);
  });

  for (const change of ["modified", "non-tail", "duplicate-marker", "duplicate-entry", "invalid"] as const) {
    test(`unsafe ${change} state fails closed for install and uninstall`, async () => {
      const { home, config } = await fixture('# preserved\nmodel = "fixture"\n');
      await editCodexConfig("install", entry, { home, dryRun: false });
      const installed = await fs.readFile(config, "utf8");
      const changed = change === "modified" ? installed.replace('"serve"', '"serve-changed"')
        : change === "non-tail" ? `${installed}# moved tail\n`
        : change === "duplicate-marker" ? `# >>> code-intel-mcp owned entry >>>\n${installed}`
        : change === "duplicate-entry" ? `${installed}\n${codexSnippet(entry)}`
        : "[invalid\n";
      await fs.writeFile(config, changed);
      const files = (await fs.readdir(home)).sort();
      for (const operation of ["install", "uninstall"] as const) {
        await expect(editCodexConfig(operation, entry, { home, dryRun: false })).rejects.toThrow("CONFIG_EDIT_REFUSED");
        expect(await fs.readFile(config, "utf8")).toBe(changed);
        expect((await fs.readdir(home)).sort()).toEqual(files);
      }
    });
  }

  for (const [name, invalid] of [
    ["unclosed table header", "[invalid\n"],
    ["unterminated quoted string", 'model = "unterminated\n'],
    ["duplicate key", 'model = "first"\nmodel = "second"\n'],
    ["duplicate table", '[settings]\nvalue = 1\n[settings]\nother = 2\n'],
  ] as const) {
    test(`${name} rejects every edit mode before filesystem mutation`, async () => {
      const { home, config } = await fixture(invalid);
      const bytes = await fs.readFile(config);
      const files = (await fs.readdir(home)).sort();
      const mutations: string[] = [];
      const rejectMutation = async (operation: string): Promise<never> => {
        mutations.push(operation);
        throw new Error(`unexpected filesystem mutation: ${operation}`);
      };
      const io: ConfigIO = {
        readFile: actualIO.readFile,
        mkdir: () => rejectMutation("mkdir"),
        writeExclusive: () => rejectMutation("writeExclusive"),
        rename: () => rejectMutation("rename"),
        unlink: () => rejectMutation("unlink"),
      };
      for (const operation of ["install", "uninstall"] as const) {
        for (const dryRun of [false, true]) {
          await expect(editCodexConfig(operation, entry, { home, dryRun, io })).rejects.toThrow("CONFIG_EDIT_REFUSED");
          expect(mutations).toEqual([]);
          expect(await fs.readFile(config)).toEqual(bytes);
          expect((await fs.readdir(home)).sort()).toEqual(files);
        }
      }
    });
  }

  test("candidate TOML rejection precedes all filesystem mutation", async () => {
    // A valid inline table cannot be extended by the appended owned table.
    const original = 'mcp_servers = { other = { command = "other" } }\n';
    const { home, config } = await fixture(original);
    expect(parse(original, 1.0, "\n", true, null)).toBeDefined();
    const files = (await fs.readdir(home)).sort();
    const mutations: string[] = [];
    const rejectMutation = async (operation: string): Promise<never> => {
      mutations.push(operation);
      throw new Error(`unexpected filesystem mutation: ${operation}`);
    };
    const io: ConfigIO = {
      readFile: actualIO.readFile,
      mkdir: () => rejectMutation("mkdir"),
      writeExclusive: () => rejectMutation("writeExclusive"),
      rename: () => rejectMutation("rename"),
      unlink: () => rejectMutation("unlink"),
    };
    for (const dryRun of [false, true]) {
      await expect(editCodexConfig("install", entry, { home, dryRun, io })).rejects.toThrow("CONFIG_EDIT_REFUSED");
      expect(mutations).toEqual([]);
      expect(await fs.readFile(config, "utf8")).toBe(original);
      expect((await fs.readdir(home)).sort()).toEqual(files);
    }
  });

  for (const failure of ["backup", "temporary", "rename", "concurrent"] as const) {
    test(`${failure} failure does not overwrite the configuration`, async () => {
      const original = '# original bytes\nmodel = "fixture"';
      const { home, config } = await fixture(original);
      let renameCalls = 0;
      const concurrent = `${original}\n# changed by another writer\n`;
      const io: ConfigIO = {
        ...actualIO,
        async writeExclusive(file, bytes) {
          if ((failure === "backup" && file.includes("-backup-")) || (failure === "temporary" && file.includes("-tmp-"))) {
            throw new Error(`controlled ${failure} failure`);
          }
          await actualIO.writeExclusive(file, bytes);
          if (failure === "concurrent" && file.includes("-tmp-")) await fs.writeFile(config, concurrent);
        },
        async rename(from, to) {
          renameCalls += 1;
          if (failure === "rename") throw new Error("controlled rename failure");
          await actualIO.rename(from, to);
        },
      };
      await expect(editCodexConfig("install", entry, { home, dryRun: false, io })).rejects.toThrow("CONFIG_WRITE_ABORTED");
      expect(await fs.readFile(config, "utf8")).toBe(failure === "concurrent" ? concurrent : original);
      expect(renameCalls).toBe(failure === "rename" ? 1 : 0);
      const files = await fs.readdir(home);
      expect(files.some((file) => file.includes("-tmp-"))).toBe(false);
      const backups = files.filter((file) => file.includes("-backup-"));
      expect(backups).toHaveLength(failure === "backup" ? 0 : 1);
      if (backups[0]) expect(await fs.readFile(path.join(home, backups[0]), "utf8")).toBe(original);
    });
  }

  test("a configuration appearing during fresh install is preserved", async () => {
    const { home, config } = await fixture();
    const concurrent = '# another writer\nmodel = "fixture"\n';
    const io: ConfigIO = {
      ...actualIO,
      async writeExclusive(file, bytes) {
        await actualIO.writeExclusive(file, bytes);
        if (file.includes("-tmp-")) await fs.writeFile(config, concurrent);
      },
    };
    await expect(editCodexConfig("install", entry, { home, dryRun: false, io })).rejects.toThrow("configuration changed");
    expect(await fs.readFile(config, "utf8")).toBe(concurrent);
    expect(await fs.readdir(home)).toEqual(["config.toml"]);
  });
});
