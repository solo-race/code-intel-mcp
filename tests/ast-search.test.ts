import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { astSearch } from "../src/ast/search.ts";
import { Workspace, WorkspaceError } from "../src/workspace.ts";

async function createFixture() {
  const base = await mkdtemp(path.join(os.tmpdir(), "code-intel-mcp-search-"));
  const root = path.join(base, "repo");
  const outside = path.join(base, "outside");
  await mkdir(root, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(
    path.join(root, "sample.ts"),
    'function demo() {\n  console.log("hello");\n  console.log("world");\n}\n',
  );
  await writeFile(path.join(root, "sample.js"), 'console.log("javascript");\n');
  await writeFile(path.join(outside, "outside.ts"), 'console.log("outside");\n');
  return { base, root, outside };
}

describe("astSearch", () => {
  test("returns structural matches and metavariable metadata", async () => {
    const fixture = await createFixture();
    try {
      const workspace = await Workspace.create(fixture.root);
      const result = await astSearch(workspace, { pattern: "console.log($$$ARGS)" });

      expect(result.totalMatches).toBe(3);
      expect(result.matches).toHaveLength(3);
      expect(result.matches[0]?.path).toMatch(/sample\.(ts|js)$/);
      expect(result.matches[0]?.text).toContain("console.log");
      expect(result.matches[0]?.metaVariables).toBeDefined();
      expect(result.filesWithMatches).toBeGreaterThan(0);
      expect(result.filesSearched).toBeGreaterThan(0);
    } finally {
      await rm(fixture.base, { recursive: true, force: true });
    }
  });

  test("respects path, glob, offset, and limit", async () => {
    const fixture = await createFixture();
    try {
      const workspace = await Workspace.create(fixture.root);
      const inFile = await astSearch(workspace, {
        pattern: "console.log($$$ARGS)",
        path: "sample.ts",
      });
      expect(inFile.totalMatches).toBe(2);

      const tsOnly = await astSearch(workspace, {
        pattern: "console.log($$$ARGS)",
        glob: "*.ts",
      });
      expect(tsOnly.totalMatches).toBe(2);

      const paged = await astSearch(workspace, {
        pattern: "console.log($$$ARGS)",
        offset: 1,
        limit: 1,
      });
      expect(paged.matches).toHaveLength(1);
      expect(paged.limitReached).toBe(true);
    } finally {
      await rm(fixture.base, { recursive: true, force: true });
    }
  });

  test("rejects an outside path before invoking native search", async () => {
    const fixture = await createFixture();
    try {
      const workspace = await Workspace.create(fixture.root);
      await expect(
        astSearch(workspace, {
          pattern: "console.log($$$ARGS)",
          path: path.join(fixture.outside, "outside.ts"),
        }),
      ).rejects.toMatchObject({ code: "WORKSPACE_ESCAPE" });
    } finally {
      await rm(fixture.base, { recursive: true, force: true });
    }
  });

  test("does not alter the searched source", async () => {
    const fixture = await createFixture();
    try {
      const target = path.join(fixture.root, "sample.ts");
      const before = await readFile(target);
      const workspace = await Workspace.create(fixture.root);
      await astSearch(workspace, { pattern: "console.log($$$ARGS)", path: "sample.ts" });
      expect(await readFile(target)).toEqual(before);
    } finally {
      await rm(fixture.base, { recursive: true, force: true });
    }
  });

  test("observes external create, rename, and delete changes in repeated directory scans", async () => {
    const fixture = await createFixture();
    try {
      const workspace = await Workspace.create(fixture.root);
      const pattern = "console.log($$$ARGS)";

      const initial = await astSearch(workspace, { pattern });
      expect(initial.totalMatches).toBe(3);
      expect(initial.matches.some((match) => match.path.endsWith("sample.ts"))).toBe(true);
      expect(initial.matches.some((match) => match.path.endsWith("sample.js"))).toBe(true);

      const added = path.join(fixture.root, "added.ts");
      await writeFile(added, 'console.log("added");\n');
      const afterCreate = await astSearch(workspace, { pattern });
      expect(afterCreate.totalMatches).toBe(4);
      expect(afterCreate.matches.some((match) => match.path.endsWith("added.ts"))).toBe(true);

      const renamed = path.join(fixture.root, "renamed.ts");
      await rename(added, renamed);
      const afterRename = await astSearch(workspace, { pattern });
      expect(afterRename.totalMatches).toBe(4);
      expect(afterRename.matches.some((match) => match.path.endsWith("renamed.ts"))).toBe(true);
      expect(afterRename.matches.some((match) => match.path.endsWith("added.ts"))).toBe(false);

      await rm(renamed);
      const afterDelete = await astSearch(workspace, { pattern });
      expect(afterDelete.totalMatches).toBe(3);
      expect(afterDelete.matches.some((match) => match.path.endsWith("renamed.ts"))).toBe(false);
    } finally {
      await rm(fixture.base, { recursive: true, force: true });
    }
  });
});
