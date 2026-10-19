import { astEdit } from "@oh-my-pi/pi-natives";
import { mkdir, mkdtemp, readFile, rename, rm, rmdir, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "bun:test";

import {
  guardedAstEditApply,
  PreApplyValidationError,
} from "../src/ast/guarded-apply.ts";
import {
  ApplyStateUncertainError,
  PreviewAlreadyUsedError,
  PreviewInProgressError,
  PreviewRegistry,
  StalePreviewError,
  UnknownOrExpiredPreviewError,
} from "../src/ast/preview-registry.ts";
import {
  runAstEditPreview,
  type AstEditPreviewInput,
} from "../src/ast/edit-preview.ts";
import { capturePreviewState } from "../src/ast/preview-state.ts";
import { Workspace } from "../src/workspace.ts";

type NativeResult = Awaited<ReturnType<typeof astEdit>>;
type NativeCall = (options: Parameters<typeof astEdit>[0]) => ReturnType<typeof astEdit>;

const operation = {
  pattern: "console.log($$$ARGS)",
  replacement: "logger.info($$$ARGS)",
};

async function fixture(): Promise<{ base: string; root: string; top: string }> {
  const base = await mkdtemp(path.join(os.tmpdir(), "code-intel-mcp-guarded-apply-"));
  const root = path.join(base, "repo");
  const top = path.join(root, "top.ts");
  await mkdir(root, { recursive: true });
  await writeFile(top, 'const greeting = "你好";\nconsole.log("hello");\n', "utf8");
  return { base, root, top };
}

async function createPreview(
  workspace: Workspace,
  registry: PreviewRegistry,
  input: AstEditPreviewInput = { operations: [operation], path: "top.ts" },
) {
  const execution = await runAstEditPreview(workspace, input);
  const previewId = await capturePreviewState(registry, execution);
  if (previewId === null) throw new Error("fixture preview did not produce a preview ID");
  return { execution, previewId };
}

function delayed<T>(value: T): Promise<T> {
  return new Promise((resolve) => setTimeout(() => resolve(value), 20));
}

describe("guardedAstEditApply", () => {
  test("freezes canonical authority rather than a retargetable request alias", async () => {
    const { base, root, top } = await fixture();
    try {
      const other = path.join(base, "other");
      const alias = path.join(base, "alias");
      await mkdir(other);
      const original = await readFile(top);
      const otherFile = path.join(other, "top.ts");
      await writeFile(otherFile, original);
      const linkType = process.platform === "win32" ? "junction" : "dir";
      await symlink(root, alias, linkType);
      const workspace = await Workspace.create(alias);
      const registry = new PreviewRegistry();
      const { previewId } = await createPreview(workspace, registry);
      expect(registry.get(previewId)?.workspaceRoot).toBe((await Workspace.create(root)).root);

      // Remove only the directory junction/link, leaving its target intact.
      if (process.platform === "win32") await rmdir(alias);
      else await unlink(alias);
      await symlink(other, alias, linkType);
      const applied = await guardedAstEditApply(registry, previewId);
      expect(applied.result.applied).toBe(true);
      expect(applied.workspaceRoot).toBe(workspace.root);
      expect(await readFile(top, "utf8")).toContain("logger.info");
      expect(await readFile(otherFile)).toEqual(original);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  for (const rootChange of ["missing", "file", "redirected"] as const) {
    test(`rejects a ${rootChange} saved root before any native call`, async () => {
      const { base, root, top } = await fixture();
      try {
        const workspace = await Workspace.create(root);
        const registry = new PreviewRegistry();
        const { previewId } = await createPreview(workspace, registry);
        const original = await readFile(top);
        const moved = path.join(base, "moved");
        await rename(root, moved);
        if (rootChange === "file") await writeFile(root, "not a directory");
        if (rootChange === "redirected") {
          await symlink(moved, root, process.platform === "win32" ? "junction" : "dir");
        }
        let calls = 0;
        const nativeAstEdit: NativeCall = async (options) => {
          calls += 1;
          return astEdit(options);
        };
        await expect(guardedAstEditApply(registry, previewId, { astEdit: nativeAstEdit }))
          .rejects.toThrow(StalePreviewError);
        expect(calls).toBe(0);
        expect(registry.get(previewId)?.status).toBe("stale");
        expect(await readFile(path.join(moved, "top.ts"))).toEqual(original);
      } finally {
        await rm(base, { recursive: true, force: true });
      }
    });
  }

  test("keeps separate parent and child authority for previews of the same file", async () => {
    const { base, root, top } = await fixture();
    try {
      const parent = await Workspace.create(base);
      const child = await Workspace.create(root);
      const registry = new PreviewRegistry();
      const before = await readFile(top);
      const parentPreview = await createPreview(parent, registry, {
        path: "repo/top.ts", operations: [operation],
      });
      const childPreview = await createPreview(child, registry);
      expect(parentPreview.previewId).not.toBe(childPreview.previewId);
      expect(registry.get(parentPreview.previewId)?.workspaceRoot).toBe(parent.root);
      expect(registry.get(childPreview.previewId)?.workspaceRoot).toBe(child.root);
      expect(parentPreview.execution.result.applied).toBe(false);
      expect(childPreview.execution.result.applied).toBe(false);
      expect(await readFile(top)).toEqual(before);
      await guardedAstEditApply(registry, childPreview.previewId);
      const after = await readFile(top);
      await expect(guardedAstEditApply(registry, parentPreview.previewId))
        .rejects.toThrow(StalePreviewError);
      expect(await readFile(top)).toEqual(after);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("applies an unchanged single-file preview once and verifies UTF-8 post-state", async () => {
    const { base, root, top } = await fixture();
    try {
      const workspace = await Workspace.create(root);
      const registry = new PreviewRegistry();
      const { previewId } = await createPreview(workspace, registry);
      expect(registry.get(previewId)?.workspaceRoot).toBe(workspace.root);
      const calls: boolean[] = [];
      const nativeAstEdit: NativeCall = async (options) => {
        calls.push(options.dryRun === true);
        return astEdit(options);
      };

      const applied = await guardedAstEditApply(registry, previewId, {
        astEdit: nativeAstEdit,
      });

      expect(calls).toEqual([true, false]);
      expect(applied.result.applied).toBe(true);
      expect(registry.get(previewId)?.status).toBe("succeeded");
      expect(await readFile(top, "utf8")).toBe(
        'const greeting = "你好";\nlogger.info("hello");\n',
      );
      await expect(
        guardedAstEditApply(registry, previewId, { astEdit: nativeAstEdit }),
      ).rejects.toThrow(PreviewAlreadyUsedError);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("reports unknown and expired identities through one claim error", async () => {
    const { base, root } = await fixture();
    try {
      let now = 100;
      const workspace = await Workspace.create(root);
      const registry = new PreviewRegistry({ ttlMs: 10, now: () => now });
      const { previewId } = await createPreview(workspace, registry);
      now = 110;

      await expect(guardedAstEditApply(registry, previewId)).rejects.toThrow(
        UnknownOrExpiredPreviewError,
      );
      await expect(
        guardedAstEditApply(registry, "never-created"),
      ).rejects.toThrow(UnknownOrExpiredPreviewError);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("rejects byte drift outside the matched span before native mutation", async () => {
    const { base, root, top } = await fixture();
    try {
      const workspace = await Workspace.create(root);
      const registry = new PreviewRegistry();
      const { previewId } = await createPreview(workspace, registry);
      await writeFile(top, `${await readFile(top, "utf8")}// external change\n`, "utf8");
      const nativeAstEdit: NativeCall = async () => {
        throw new Error("native must not run after fingerprint drift");
      };

      await expect(
        guardedAstEditApply(registry, previewId, { astEdit: nativeAstEdit }),
      ).rejects.toThrow(StalePreviewError);
      expect(registry.get(previewId)?.status).toBe("stale");
      expect(await readFile(top, "utf8")).toContain("// external change");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("rejects a deleted or renamed originally touched file as stale", async () => {
    const { base, root, top } = await fixture();
    try {
      const workspace = await Workspace.create(root);
      const registry = new PreviewRegistry();
      const { previewId } = await createPreview(workspace, registry);
      const renamed = path.join(root, "renamed.ts");
      await rename(top, renamed);

      await expect(guardedAstEditApply(registry, previewId)).rejects.toThrow(
        StalePreviewError,
      );
      expect(await readFile(renamed, "utf8")).toContain("console.log");
      expect(registry.get(previewId)?.status).toBe("stale");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("rejects a directory-scope expansion without mutating any file", async () => {
    const { base, root, top } = await fixture();
    try {
      const workspace = await Workspace.create(root);
      const registry = new PreviewRegistry();
      const { previewId } = await createPreview(workspace, registry, {
        operations: [operation],
        path: ".",
        glob: "**/*.ts",
      });
      const added = path.join(root, "added.ts");
      await writeFile(added, 'console.log("added");\n', "utf8");
      const beforeTop = await readFile(top);

      await expect(guardedAstEditApply(registry, previewId)).rejects.toThrow(
        StalePreviewError,
      );
      expect(await readFile(top)).toEqual(beforeTop);
      expect(await readFile(added, "utf8")).toBe('console.log("added");\n');
      expect(registry.get(previewId)?.status).toBe("stale");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("rejects a fresh dry-run mutation-plan mismatch before native apply", async () => {
    const { base, root, top } = await fixture();
    try {
      const workspace = await Workspace.create(root);
      const registry = new PreviewRegistry();
      const { execution, previewId } = await createPreview(workspace, registry);
      const mismatched: NativeResult = {
        ...execution.result,
        changes: execution.result.changes.map((change) => ({
          ...change,
          after: `${change.after}!`,
        })),
      };
      const calls: boolean[] = [];
      const nativeAstEdit: NativeCall = async (options) => {
        calls.push(options.dryRun === true);
        if (options.dryRun === true) return mismatched;
        throw new Error("native apply must not run after plan mismatch");
      };
      const before = await readFile(top);

      await expect(
        guardedAstEditApply(registry, previewId, { astEdit: nativeAstEdit }),
      ).rejects.toThrow(StalePreviewError);
      expect(calls).toEqual([true]);
      expect(await readFile(top)).toEqual(before);
      expect(registry.get(previewId)?.status).toBe("stale");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("allows only one concurrent claim to enter native work", async () => {
    const { base, root } = await fixture();
    try {
      const workspace = await Workspace.create(root);
      const registry = new PreviewRegistry();
      const { previewId } = await createPreview(workspace, registry);
      const calls: boolean[] = [];
      let firstDryRun = true;
      const nativeAstEdit: NativeCall = async (options) => {
        calls.push(options.dryRun === true);
        if (options.dryRun === true && firstDryRun) {
          firstDryRun = false;
          await delayed(undefined);
        }
        return astEdit(options);
      };

      const first = guardedAstEditApply(registry, previewId, {
        astEdit: nativeAstEdit,
      });
      expect(registry.get(previewId)?.status).toBe("applying");
      const second = guardedAstEditApply(registry, previewId, {
        astEdit: nativeAstEdit,
      });
      await expect(second).rejects.toThrow(PreviewInProgressError);
      const applied = await first;

      expect(applied.result.applied).toBe(true);
      expect(calls).toEqual([true, false]);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("restores ready after a retry-safe pre-apply native failure", async () => {
    const { base, root } = await fixture();
    try {
      const workspace = await Workspace.create(root);
      const registry = new PreviewRegistry();
      const { previewId } = await createPreview(workspace, registry);
      let failDryRun = true;
      const nativeAstEdit: NativeCall = async (options) => {
        if (options.dryRun === true && failDryRun) {
          failDryRun = false;
          throw new Error("temporary native validation failure");
        }
        return astEdit(options);
      };

      await expect(
        guardedAstEditApply(registry, previewId, { astEdit: nativeAstEdit }),
      ).rejects.toThrow(PreApplyValidationError);
      expect(registry.get(previewId)?.status).toBe("ready");

      const applied = await guardedAstEditApply(registry, previewId, {
        astEdit: nativeAstEdit,
      });
      expect(applied.result.applied).toBe(true);
      expect(registry.get(previewId)?.status).toBe("succeeded");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("marks apply failure uncertain and prevents retry after native entry", async () => {
    const { base, root, top } = await fixture();
    try {
      const workspace = await Workspace.create(root);
      const registry = new PreviewRegistry();
      const { previewId } = await createPreview(workspace, registry);
      const nativeAstEdit: NativeCall = async (options) => {
        if (options.dryRun === true) return astEdit(options);
        throw new Error("simulated native apply failure");
      };

      await expect(
        guardedAstEditApply(registry, previewId, { astEdit: nativeAstEdit }),
      ).rejects.toThrow(ApplyStateUncertainError);
      expect(registry.get(previewId)?.status).toBe("failed_uncertain");
      expect(await readFile(top, "utf8")).toContain("console.log");
      await expect(
        guardedAstEditApply(registry, previewId, { astEdit: nativeAstEdit }),
      ).rejects.toThrow(ApplyStateUncertainError);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("marks an unverifiable native postcondition uncertain", async () => {
    const { base, root, top } = await fixture();
    try {
      const workspace = await Workspace.create(root);
      const registry = new PreviewRegistry();
      const { execution, previewId } = await createPreview(workspace, registry);
      const nativeAstEdit: NativeCall = async (options) => {
        if (options.dryRun === true) return astEdit(options);
        return { ...execution.result, applied: true } as NativeResult;
      };

      await expect(
        guardedAstEditApply(registry, previewId, { astEdit: nativeAstEdit }),
      ).rejects.toThrow(ApplyStateUncertainError);
      expect(registry.get(previewId)?.status).toBe("failed_uncertain");
      expect(await readFile(top, "utf8")).toContain("console.log");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("rejects a shorter fresh mutation plan as stale before native apply", async () => {
    const { base, root, top } = await fixture();
    try {
      const second = path.join(root, "second.ts");
      await writeFile(second, 'console.log("second");\n', "utf8");
      const workspace = await Workspace.create(root);
      const registry = new PreviewRegistry();
      const { execution, previewId } = await createPreview(workspace, registry, {
        operations: [operation],
        path: ".",
        glob: "**/*.ts",
      });
      expect(execution.result.changes.length).toBeGreaterThanOrEqual(2);

      const shortenedChanges = execution.result.changes.slice(1);
      const remainingPaths = new Set(shortenedChanges.map((change) => change.path));
      const shortened: NativeResult = {
        ...execution.result,
        changes: shortenedChanges,
        totalReplacements: shortenedChanges.length,
        fileChanges: execution.result.fileChanges.map((fileChange) => ({
          ...fileChange,
          count: remainingPaths.has(fileChange.path) ? fileChange.count : 0,
        })),
      };
      const calls: boolean[] = [];
      const nativeAstEdit: NativeCall = async (options) => {
        calls.push(options.dryRun === true);
        if (options.dryRun === true) return shortened;
        throw new Error("native apply must not run after plan drift");
      };
      const beforeTop = await readFile(top);
      const beforeSecond = await readFile(second);

      await expect(
        guardedAstEditApply(registry, previewId, { astEdit: nativeAstEdit }),
      ).rejects.toThrow(StalePreviewError);
      expect(calls).toEqual([true]);
      expect(await readFile(top)).toEqual(beforeTop);
      expect(await readFile(second)).toEqual(beforeSecond);
      expect(registry.get(previewId)?.status).toBe("stale");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("rejects a stored target that stopped being valid at apply time as stale", async () => {
    const { base, root, top } = await fixture();
    try {
      const workspace = await Workspace.create(root);
      const registry = new PreviewRegistry();
      const calls: boolean[] = [];
      const nativeAstEdit: NativeCall = async (options) => {
        calls.push(options.dryRun === true);
        throw new Error("native must not run after target drift");
      };
      const original = await readFile(top);

      const { previewId: deletedPreview } = await createPreview(workspace, registry);
      await rm(top, { force: true });
      await expect(
        guardedAstEditApply(registry, deletedPreview, { astEdit: nativeAstEdit }),
      ).rejects.toThrow(StalePreviewError);
      expect(registry.get(deletedPreview)?.status).toBe("stale");

      await writeFile(top, original);
      const { previewId: replacedPreview } = await createPreview(workspace, registry);
      await rm(top, { force: true });
      await mkdir(top);
      await expect(
        guardedAstEditApply(registry, replacedPreview, { astEdit: nativeAstEdit }),
      ).rejects.toThrow(StalePreviewError);
      expect(registry.get(replacedPreview)?.status).toBe("stale");
      expect(calls).toEqual([]);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("marks an applied plan that disagrees with the reviewed plan uncertain", async () => {
    const { base, root } = await fixture();
    try {
      const workspace = await Workspace.create(root);
      const registry = new PreviewRegistry();
      const { previewId } = await createPreview(workspace, registry);
      const nativeAstEdit: NativeCall = async (options) => {
        const result = await astEdit(options);
        if (options.dryRun === true) return result;
        return {
          ...result,
          changes: result.changes.map((change) => ({ ...change, after: `${change.after}!` })),
        };
      };

      await expect(
        guardedAstEditApply(registry, previewId, { astEdit: nativeAstEdit }),
      ).rejects.toThrow(ApplyStateUncertainError);
      expect(registry.get(previewId)?.status).toBe("failed_uncertain");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("keeps an expiry crossed during apply terminal", async () => {
    const { base, root } = await fixture();
    try {
      let now = 100;
      const workspace = await Workspace.create(root);
      const registry = new PreviewRegistry({ ttlMs: 10, now: () => now });

      const { previewId: retryPreview } = await createPreview(workspace, registry);
      const retrySafe: NativeCall = async (options) => {
        now = 200;
        if (options.dryRun === true) throw new Error("temporary native validation failure");
        throw new Error("native apply must not run after a failed pre-apply validation");
      };

      await expect(
        guardedAstEditApply(registry, retryPreview, { astEdit: retrySafe }),
      ).rejects.toThrow(PreApplyValidationError);
      await expect(
        guardedAstEditApply(registry, retryPreview, { astEdit: retrySafe }),
      ).rejects.toThrow(UnknownOrExpiredPreviewError);
      expect(registry.get(retryPreview)).toBeUndefined();

      now = 300;
      const { previewId: stalePreview } = await createPreview(workspace, registry);
      const drifted: NativeCall = async (options) => {
        now = 400;
        const result = await astEdit(options);
        return {
          ...result,
          changes: result.changes.map((change) => ({ ...change, after: `${change.after}!` })),
        };
      };

      await expect(
        guardedAstEditApply(registry, stalePreview, { astEdit: drifted }),
      ).rejects.toThrow(StalePreviewError);
      expect(registry.get(stalePreview)).toBeUndefined();
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
