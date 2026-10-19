import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  astEditPreview,
  DuplicatePatternError,
} from "../src/ast/edit-preview.ts";
import { Workspace, WorkspaceError } from "../src/workspace.ts";

async function createFixture() {
  const base = await mkdtemp(path.join(os.tmpdir(), "code-intel-mcp-edit-"));
  const root = path.join(base, "repo");
  const outside = path.join(base, "outside");
  await mkdir(root, { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(
    path.join(root, "sample.ts"),
    'function demo() {\n  console.log("hello");\n  console.log("world");\n  alert("done");\n}\n',
  );
  await writeFile(path.join(outside, "outside.ts"), 'console.log("outside");\n');
  return { base, root, outside };
}

describe("astEditPreview", () => {
  test("returns dry-run changes and leaves source bytes unchanged", async () => {
    const fixture = await createFixture();
    try {
      const target = path.join(fixture.root, "sample.ts");
      const before = await readFile(target);
      const workspace = await Workspace.create(fixture.root);
      const result = await astEditPreview(workspace, {
        path: "sample.ts",
        operations: [
          { pattern: "console.log($$$ARGS)", replacement: "logger.info($$$ARGS)" },
          { pattern: "alert($$$ARGS)", replacement: "notify($$$ARGS)" },
        ],
      });

      expect(result.applied).toBe(false);
      expect(result.totalReplacements).toBe(3);
      expect(result.changes.length).toBeGreaterThan(0);
      expect(await readFile(target)).toEqual(before);
    } finally {
      await rm(fixture.base, { recursive: true, force: true });
    }
  });

  test("accepts empty replacements and ignores any caller dryRun field", async () => {
    const fixture = await createFixture();
    try {
      const target = path.join(fixture.root, "sample.ts");
      const before = await readFile(target);
      const workspace = await Workspace.create(fixture.root);
      const result = await astEditPreview(workspace, {
        path: "sample.ts",
        operations: [{ pattern: "alert($$$ARGS)", replacement: "" }],
        dryRun: false,
      } as never);

      expect(result.applied).toBe(false);
      expect(result.totalReplacements).toBe(1);
      expect(await readFile(target)).toEqual(before);
    } finally {
      await rm(fixture.base, { recursive: true, force: true });
    }
  });

  test("rejects duplicate patterns before native invocation", async () => {
    const fixture = await createFixture();
    try {
      const workspace = await Workspace.create(fixture.root);
      await expect(
        astEditPreview(workspace, {
          path: "sample.ts",
          operations: [
            { pattern: "console.log($$$ARGS)", replacement: "a($$$ARGS)" },
            { pattern: "console.log($$$ARGS)", replacement: "b($$$ARGS)" },
          ],
        }),
      ).rejects.toBeInstanceOf(DuplicatePatternError);
    } finally {
      await rm(fixture.base, { recursive: true, force: true });
    }
  });

  test("rejects an outside path", async () => {
    const fixture = await createFixture();
    try {
      const workspace = await Workspace.create(fixture.root);
      await expect(
        astEditPreview(workspace, {
          path: path.join(fixture.outside, "outside.ts"),
          operations: [{ pattern: "console.log($$$ARGS)", replacement: "logger.info($$$ARGS)" }],
        }),
      ).rejects.toMatchObject({ code: "WORKSPACE_ESCAPE" });
    } finally {
      await rm(fixture.base, { recursive: true, force: true });
    }
  });
});
