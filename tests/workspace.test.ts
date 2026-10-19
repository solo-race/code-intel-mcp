import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { isAbsoluteWorkspaceRoot, Workspace, WorkspaceError } from "../src/workspace.ts";

async function createFixture() {
  const base = await mkdtemp(path.join(os.tmpdir(), "code-intel-mcp-workspace-"));
  const root = path.join(base, "repo");
  const outside = path.join(base, "outside");
  await mkdir(root, { recursive: true });
  await mkdir(outside, { recursive: true });
  return { base, root, outside };
}

async function cleanup(base: string) {
  await rm(base, { recursive: true, force: true });
}

function isSymlinkUnavailable(error: unknown): boolean {
  if (process.platform !== "win32" || typeof error !== "object" || error === null) {
    return false;
  }
  const code = "code" in error ? (error as { code?: unknown }).code : undefined;
  return code === "EPERM" || code === "EACCES" || code === "ENOTSUP";
}

describe("Workspace", () => {
  test("request roots reject omitted and relative paths before cwd resolution", async () => {
    await expect(Workspace.createAbsolute(undefined)).rejects.toMatchObject({
      code: "WORKSPACE_ROOT_REQUIRED",
    });
    for (const root of [".", "repo", "../repo", ...(process.platform === "win32" ? ["/", "\\", "C:relative"] : [])]) {
      await expect(Workspace.createAbsolute(root)).rejects.toMatchObject({
        code: "WORKSPACE_ROOT_NOT_ABSOLUTE",
      });
    }
    if (process.platform === "win32") {
      expect(isAbsoluteWorkspaceRoot("C:\\workspace")).toBe(true);
      expect(isAbsoluteWorkspaceRoot("\\\\server\\share\\workspace")).toBe(true);
    }
  });

  test("accepts an existing directory and resolves root/nested targets", async () => {
    const fixture = await createFixture();
    try {
      await writeFile(path.join(fixture.root, "sample.ts"), "const value = 1;\n");
      const workspace = await Workspace.create(fixture.root);

      expect(workspace.root).toBe(await import("node:fs/promises").then(({ realpath }) => realpath(fixture.root)));
      expect(await workspace.resolveTarget()).toBe(workspace.root);
      expect(await workspace.resolveTarget("sample.ts")).toBe(path.join(workspace.root, "sample.ts"));
    } finally {
      await cleanup(fixture.base);
    }
  });

  test("rejects missing and non-directory roots", async () => {
    const fixture = await createFixture();
    try {
      await expect(Workspace.create(path.join(fixture.root, "missing"))).rejects.toMatchObject({
        code: "WORKSPACE_ROOT_NOT_FOUND",
      });
      const file = path.join(fixture.root, "not-a-directory");
      await writeFile(file, "content");
      await expect(Workspace.create(file)).rejects.toMatchObject({
        code: "WORKSPACE_ROOT_NOT_DIRECTORY",
      });
      await expect(Workspace.create(undefined)).rejects.toMatchObject({
        code: "WORKSPACE_ROOT_REQUIRED",
      });
    } finally {
      await cleanup(fixture.base);
    }
  });

  test("rejects relative traversal, absolute outside paths, and sibling prefix traps", async () => {
    const fixture = await createFixture();
    try {
      const sibling = path.join(fixture.base, "repo-other");
      await mkdir(sibling, { recursive: true });
      await writeFile(path.join(fixture.outside, "outside.ts"), "const outside = true;\n");
      await writeFile(path.join(sibling, "sibling.ts"), "const sibling = true;\n");
      const workspace = await Workspace.create(fixture.root);

      for (const target of ["../outside", "../../outside", path.join(fixture.outside, "outside.ts"), path.join(sibling, "sibling.ts")]) {
        await expect(workspace.resolveTarget(target)).rejects.toMatchObject({
          code: "WORKSPACE_ESCAPE",
        });
      }
    } finally {
      await cleanup(fixture.base);
    }
  });

  test("reports an in-workspace nonexistent target explicitly", async () => {
    const fixture = await createFixture();
    try {
      const workspace = await Workspace.create(fixture.root);
      await expect(workspace.resolveTarget("missing.ts")).rejects.toMatchObject({
        code: "TARGET_NOT_FOUND",
      });
    } finally {
      await cleanup(fixture.base);
    }
  });

  test("rejects a symlink whose canonical target is outside when symlinks are available", async () => {
    const fixture = await createFixture();
    try {
      const outsideFile = path.join(fixture.outside, "outside.ts");
      const link = path.join(fixture.root, "linked.ts");
      await writeFile(outsideFile, "const outside = true;\n");
      try {
        await symlink(outsideFile, link);
      } catch (error) {
        if (!isSymlinkUnavailable(error)) {
          throw error;
        }
        // Windows hosts without symlink privileges cannot exercise this case.
        return;
      }
      const workspace = await Workspace.create(fixture.root);
      await expect(workspace.resolveTarget("linked.ts")).rejects.toMatchObject({
        code: "WORKSPACE_ESCAPE",
      });
    } finally {
      await cleanup(fixture.base);
    }
  });
});
