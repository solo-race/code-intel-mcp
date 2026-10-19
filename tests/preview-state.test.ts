import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { describe, expect, test } from "bun:test";

import {
  runAstEditPreview,
  type AstEditPreviewInput,
  type AstEditPreviewResult,
} from "../src/ast/edit-preview.ts";
import {
  AmbiguousMutationPlanError,
  capturePreviewState,
  normalizeAstEditResult,
} from "../src/ast/preview-state.ts";
import { PreviewRegistry } from "../src/ast/preview-registry.ts";
import { Workspace } from "../src/workspace.ts";

async function fixture() {
  const base = await mkdtemp(path.join(os.tmpdir(), "code-intel-mcp-preview-state-"));
  const root = path.join(base, "repo");
  await mkdir(path.join(root, "nested"), { recursive: true });
  await writeFile(
    path.join(root, "top.ts"),
    'console.log("top");\n',
  );
  await writeFile(
    path.join(root, "nested", "deep.ts"),
    'console.log("deep");\n',
  );
  return { base, root };
}

const rewrite: AstEditPreviewInput = {
  path: "top.ts",
  operations: [
    { pattern: "console.log($$$ARGS)", replacement: "logger.info($$$ARGS)" },
  ],
  glob: "*.ts",
  maxFiles: 8,
  failOnParseError: true,
};

function syntheticChange(
  nativePath: string,
  byteStart: number,
  byteEnd: number,
): AstEditPreviewResult["changes"][number] {
  return {
    path: nativePath,
    before: "x".repeat(byteEnd - byteStart),
    after: "y",
    byteStart,
    byteEnd,
    deletedLength: byteEnd - byteStart,
    startLine: 1,
    startColumn: 1,
    endLine: 1,
    endColumn: 1,
  };
}

/** Build the native result shape for a hand-chosen set of spans. */
function syntheticResult(
  changes: AstEditPreviewResult["changes"],
): AstEditPreviewResult {
  const counts = new Map<string, number>();
  for (const change of changes) {
    counts.set(change.path, (counts.get(change.path) ?? 0) + 1);
  }
  return {
    changes,
    fileChanges: [...counts].map(([nativePath, count]) => ({ path: nativePath, count })),
    totalReplacements: changes.length,
    filesTouched: counts.size,
    filesSearched: counts.size,
    applied: false,
    limitReached: false,
  };
}

describe("preview state capture", () => {
  test("captures an immutable single-file contract, plan, and whole-file fingerprint", async () => {
    const { base, root } = await fixture();
    try {
      const workspace = await Workspace.create(root);
      const original = JSON.parse(JSON.stringify(rewrite)) as AstEditPreviewInput;
      const execution = await runAstEditPreview(workspace, original);
      original.operations[0]!.replacement = "caller-change";

      const registry = new PreviewRegistry({ idFactory: () => "single-file" });
      const previewId = await capturePreviewState(registry, execution);
      expect(previewId).toBe("single-file");

      const state = registry.get(previewId!);
      const target = await workspace.resolveTarget("top.ts");
      expect(state?.workspaceRoot).toBe(workspace.root);
      expect(state?.contract.target).toBe(target);
      expect(state?.contract.targetKind).toBe("file");
      expect(state?.contract.operations[0]?.replacement).toBe("logger.info($$$ARGS)");
      expect(state?.contract.glob).toBe("*.ts");
      expect(state?.contract.maxFiles).toBe(8);
      expect(state?.contract.failOnParseError).toBe(true);
      expect(state?.fileFingerprints).toHaveLength(1);
      expect(state?.fileFingerprints[0]?.canonicalPath).toBe(target);
      expect(state?.mutationPlan).toHaveLength(1);
      expect(state?.mutationPlan[0]?.canonicalPath).toBe(target);
      expect(state?.mutationPlan[0]?.before).toContain("console.log");
      expect(state?.mutationPlan[0]?.after).toContain("logger.info");
      expect(await readFile(target, "utf8")).toContain("console.log");
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("fingerprint changes when bytes outside the matched span change", async () => {
    const { base, root } = await fixture();
    try {
      const workspace = await Workspace.create(root);
      const execution = await runAstEditPreview(workspace, rewrite);
      const registry = new PreviewRegistry({ idFactory: () => "fingerprint" });
      const previewId = await capturePreviewState(registry, execution);
      const state = registry.get(previewId!);
      const target = await workspace.resolveTarget("top.ts");
      const beforeHash = state?.fileFingerprints[0]?.sha256;

      await writeFile(target, `${await readFile(target, "utf8")}/* external change */\n`);
      const afterHash = createHash("sha256").update(await readFile(target)).digest("hex");
      expect(afterHash).not.toBe(beforeHash);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("normalizes root-directory and nested-directory native paths", async () => {
    const { base, root } = await fixture();
    try {
      const workspace = await Workspace.create(root);
      const rootExecution = await runAstEditPreview(workspace, {
        ...rewrite,
        path: ".",
        glob: "**/*.ts",
      });
      const rootRegistry = new PreviewRegistry({ idFactory: () => "root" });
      const rootId = await capturePreviewState(rootRegistry, rootExecution);
      const rootState = rootRegistry.get(rootId!);
      expect(rootState?.contract.targetKind).toBe("directory");
      expect(rootState?.fileFingerprints.map(({ canonicalPath }) => canonicalPath)).toEqual([
        await workspace.resolveTarget("nested/deep.ts"),
        await workspace.resolveTarget("top.ts"),
      ].sort());
      expect(rootState?.mutationPlan.map(({ canonicalPath }) => canonicalPath)).toEqual([
        await workspace.resolveTarget("nested/deep.ts"),
        await workspace.resolveTarget("top.ts"),
      ].sort());

      const nestedExecution = await runAstEditPreview(workspace, {
        ...rewrite,
        path: "nested",
      });
      const nestedRegistry = new PreviewRegistry({ idFactory: () => "nested" });
      const nestedId = await capturePreviewState(nestedRegistry, nestedExecution);
      const nestedState = nestedRegistry.get(nestedId!);
      expect(nestedState?.contract.target).toBe(await workspace.resolveTarget("nested"));
      expect(nestedState?.contract.targetKind).toBe("directory");
      expect(nestedState?.fileFingerprints).toHaveLength(1);
      expect(nestedState?.fileFingerprints[0]?.canonicalPath).toBe(
        await workspace.resolveTarget("nested/deep.ts"),
      );
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("does not create state for a zero-match preview", async () => {
    const { base, root } = await fixture();
    try {
      const workspace = await Workspace.create(root);
      const execution = await runAstEditPreview(workspace, {
        path: "top.ts",
        operations: [{ pattern: "missing($$$ARGS)", replacement: "noop($$$ARGS)" }],
      });
      const registry = new PreviewRegistry({ idFactory: () => "unused" });

      expect(execution.result.totalReplacements).toBe(0);
      expect(await capturePreviewState(registry, execution)).toBeNull();
      expect(registry.size).toBe(0);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("rejects a native change path outside the intended directory scope", async () => {
    const { base, root } = await fixture();
    try {
      const workspace = await Workspace.create(root);
      const execution = await runAstEditPreview(workspace, {
        ...rewrite,
        path: ".",
        glob: "**/*.ts",
      });
      const firstChange = execution.result.changes[0];
      if (firstChange === undefined) throw new Error("fixture preview did not produce a change");
      firstChange.path = "../outside.ts";

      const registry = new PreviewRegistry({ idFactory: () => "escaped" });
      await expect(capturePreviewState(registry, execution)).rejects.toMatchObject({
        code: "PREVIEW_STATE_INVALID",
      });
      expect(registry.size).toBe(0);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("does not leave a partial record when fingerprint capture fails", async () => {
    const { base, root } = await fixture();
    try {
      const workspace = await Workspace.create(root);
      const execution = await runAstEditPreview(workspace, {
        ...rewrite,
        path: ".",
        glob: "**/*.ts",
      });
      const firstChange = execution.result.changes[0];
      const firstFileChange = execution.result.fileChanges[0];
      if (firstChange === undefined || firstFileChange === undefined) {
        throw new Error("fixture preview did not produce a change");
      }
      // `nested` is a valid in-scope path but a directory, so fingerprinting
      // it as a file fails after path normalization.
      firstChange.path = "nested";
      firstFileChange.path = "nested";

      const registry = new PreviewRegistry({ idFactory: () => "fingerprint-failure" });
      await expect(capturePreviewState(registry, execution)).rejects.toMatchObject({
        code: "PREVIEW_STATE_INVALID",
      });
      expect(registry.size).toBe(0);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("rejects overlapping spans in one file and accepts coherent plans", async () => {
    const { base, root } = await fixture();
    try {
      const workspace = await Workspace.create(root);
      const contract = {
        operations: [{ pattern: "f($$$ARGS)", replacement: "g($$$ARGS)" }],
        target: workspace.root,
        targetKind: "directory" as const,
      };

      const overlapping = syntheticResult([
        syntheticChange("top.ts", 10, 17),
        syntheticChange("top.ts", 12, 16),
      ]);
      await expect(normalizeAstEditResult(workspace, contract, overlapping)).rejects.toThrow(
        AmbiguousMutationPlanError,
      );

      const acrossFiles = syntheticResult([
        syntheticChange("top.ts", 10, 17),
        syntheticChange("nested/deep.ts", 12, 16),
      ]);
      expect(
        (await normalizeAstEditResult(workspace, contract, acrossFiles)).mutationPlan,
      ).toHaveLength(2);

      const touching = syntheticResult([
        syntheticChange("top.ts", 10, 16),
        syntheticChange("top.ts", 16, 20),
      ]);
      expect(
        (await normalizeAstEditResult(workspace, contract, touching)).mutationPlan,
      ).toHaveLength(2);

      const single = syntheticResult([syntheticChange("top.ts", 10, 17)]);
      expect(
        (await normalizeAstEditResult(workspace, contract, single)).mutationPlan,
      ).toHaveLength(1);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });

  test("rejects a nested native match and issues no preview identity", async () => {
    const { base, root } = await fixture();
    try {
      const workspace = await Workspace.create(root);
      const target = await workspace.resolveTarget("top.ts");
      const nested = "const v = f(f(1));\n";
      await writeFile(target, nested, "utf8");

      const execution = await runAstEditPreview(workspace, {
        path: "top.ts",
        operations: [{ pattern: "f($$$A)", replacement: "g($$$A)" }],
      });
      const spans = execution.result.changes.map(({ byteStart, byteEnd }) => [
        byteStart,
        byteEnd,
      ]);
      expect(spans).toEqual([
        [10, 17],
        [12, 16],
      ]);

      const registry = new PreviewRegistry({ idFactory: () => "ambiguous" });
      await expect(capturePreviewState(registry, execution)).rejects.toThrow(
        AmbiguousMutationPlanError,
      );
      expect(registry.size).toBe(0);
      expect(await readFile(target, "utf8")).toBe(nested);
    } finally {
      await rm(base, { recursive: true, force: true });
    }
  });
});
