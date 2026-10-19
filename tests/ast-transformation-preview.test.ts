import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { astEditOptionsForContract, DuplicatePatternError } from "../src/ast/edit-preview.ts";
import { guardedAstEditApply } from "../src/ast/guarded-apply.ts";
import { PreviewRegistry } from "../src/ast/preview-registry.ts";
import { capturePreviewState } from "../src/ast/preview-state.ts";
import { runAstTransformationPreview } from "../src/ast/transformation-plan.ts";
import { Workspace } from "../src/workspace.ts";

const temporaryRoots: string[] = [];
const source = "const value = compute(1);\n";
const operation = { pattern: "compute($$$ARGS)", replacement: "compute($$$ARGS).memo()" };

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const base = await mkdtemp(path.join(os.tmpdir(), "code-intel-mcp-transform-"));
  temporaryRoots.push(base);
  const root = path.join(base, "repo");
  const outside = path.join(base, "outside");
  await mkdir(root);
  await mkdir(outside);
  const target = path.join(root, "sample.ts");
  await writeFile(target, source);
  await writeFile(path.join(outside, "sample.ts"), source);
  return { root, outside, target, workspace: await Workspace.create(root) };
}

function input() {
  return {
    path: "sample.ts",
    operations: [{ ...operation }],
    rationale: "  Memoize this explicit call site.  ",
    symbolRefs: [" graph:compute ", "opaque:not-resolved", "graph:compute"],
    failOnParseError: true,
  };
}

describe("single-file transformation preview", () => {
  test("normalizes metadata deterministically, freezes it, and keeps native options and source unchanged", async () => {
    const { workspace, target } = await fixture();
    const supplied = input();
    const first = await runAstTransformationPreview(workspace, supplied);
    const second = await runAstTransformationPreview(workspace, input());
    const expected = {
      rationale: "Memoize this explicit call site.",
      symbolRefs: ["graph:compute", "opaque:not-resolved", "graph:compute"],
    };
    expect(first.contract.transformation).toEqual(expected);
    expect(second.contract).toEqual(first.contract);
    expect(first.result.applied).toBe(false);
    expect(first.result.totalReplacements).toBe(1);
    expect(await readFile(target, "utf8")).toBe(source);
    expect(astEditOptionsForContract(first.contract, true)).toEqual({
      rewrites: { [operation.pattern]: operation.replacement },
      path: first.contract.target,
      dryRun: true,
      failOnParseError: true,
    });

    const registry = new PreviewRegistry();
    const previewId = await capturePreviewState(registry, first);
    expect(previewId).toBeString();
    supplied.rationale = "changed";
    supplied.symbolRefs[0] = "changed";
    supplied.operations[0]!.replacement = "changed()";
    const stored = registry.get(previewId!)!;
    expect(stored.contract.transformation).toEqual(expected);
    expect(stored.contract.operations).toEqual([operation]);
    expect(Object.isFrozen(stored.contract.transformation)).toBe(true);
    expect(Object.isFrozen(stored.contract.transformation!.symbolRefs)).toBe(true);

    const applied = await guardedAstEditApply(registry, previewId!);
    expect(applied.transformation).toEqual(expected);
    expect(await readFile(target, "utf8")).toBe("const value = compute(1).memo();\n");
    await expect(guardedAstEditApply(registry, previewId!))
      .rejects.toMatchObject({ code: "PREVIEW_ALREADY_USED" });
  });

  test("rejects empty rationale, symbol references, and operations", async () => {
    const { workspace } = await fixture();
    for (const invalid of [
      { rationale: "" },
      { rationale: " \n " },
      { symbolRefs: [] },
      { symbolRefs: [""] },
      { symbolRefs: ["valid", " \t"] },
      { operations: [] },
      { operations: [{ pattern: "", replacement: "x" }] },
    ]) {
      await expect(runAstTransformationPreview(workspace, { ...input(), ...invalid }))
        .rejects.toBeInstanceOf(TypeError);
    }
  });

  test("requires a repository-relative existing regular file without parent traversal", async () => {
    const { workspace, target, outside } = await fixture();
    for (const targetPath of ["", ".", target, "../outside/sample.ts", "nested/../sample.ts", "C:sample.ts", "/sample.ts", "\\\\server\\share\\sample.ts", path.join(outside, "sample.ts")]) {
      await expect(runAstTransformationPreview(workspace, { ...input(), path: targetPath }))
        .rejects.toMatchObject({ code: "INVALID_WORKSPACE_TARGET" });
    }
    await expect(runAstTransformationPreview(workspace, { ...input(), path: "missing.ts" }))
      .rejects.toMatchObject({ code: "TARGET_NOT_FOUND" });
    expect(await readFile(target, "utf8")).toBe(source);
  });

  test("rejects a repository-relative link whose target is outside the workspace", async () => {
    const { workspace, root, outside } = await fixture();
    await symlink(outside, path.join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
    await expect(runAstTransformationPreview(workspace, { ...input(), path: "linked/sample.ts" }))
      .rejects.toMatchObject({ code: "WORKSPACE_ESCAPE" });
  });

  test("returns no pending identity for zero matches and reuses duplicate-pattern rejection", async () => {
    const { workspace, target } = await fixture();
    const registry = new PreviewRegistry();
    const empty = await runAstTransformationPreview(workspace, {
      ...input(), operations: [{ pattern: "missing($$$ARGS)", replacement: "noop($$$ARGS)" }],
    });
    expect(empty.result.totalReplacements).toBe(0);
    expect(await capturePreviewState(registry, empty)).toBeNull();
    expect(registry.size).toBe(0);
    await expect(runAstTransformationPreview(workspace, {
      ...input(), operations: [operation, { ...operation, replacement: "other($$$ARGS)" }],
    })).rejects.toBeInstanceOf(DuplicatePatternError);
    expect(await readFile(target, "utf8")).toBe(source);
  });

  test("rejects stale source using the existing guarded apply lifecycle", async () => {
    const { workspace, target } = await fixture();
    const registry = new PreviewRegistry();
    const execution = await runAstTransformationPreview(workspace, input());
    const previewId = await capturePreviewState(registry, execution);
    const drifted = `${source}// external edit\n`;
    await writeFile(target, drifted);
    await expect(guardedAstEditApply(registry, previewId!))
      .rejects.toMatchObject({ code: "STALE_PREVIEW" });
    expect(await readFile(target, "utf8")).toBe(drifted);
    expect(registry.get(previewId!)!.status).toBe("stale");
  });
});
