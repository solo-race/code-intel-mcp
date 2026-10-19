import * as native from "@oh-my-pi/pi-natives";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { guardedAstEditApply } from "../src/ast/guarded-apply.ts";
import {
  materializeAstMigrationRecipe,
  runAstMigrationRecipePreview,
} from "../src/ast/migration-recipe.ts";
import { PreviewRegistry } from "../src/ast/preview-registry.ts";

import { Workspace } from "../src/workspace.ts";

const roots: string[] = [];
const source = "const value = legacy(1);\n";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "code-intel-recipe-"));
  roots.push(root);
  for (const name of ["a.ts", "b.ts", "c.ts"]) await writeFile(path.join(root, name), source);
  const workspace = await Workspace.create(root);
  return { root, workspace };
}

function step(target: string) {
  return {
    path: target,
    operations: [{ pattern: "legacy($$$ARGS)", replacement: "modern($$$ARGS)" }],
    rationale: "  Migrate the explicit API call.  ",
    symbolRefs: [" symbol:legacy ", "caller:sample", "symbol:legacy"],
    failOnParseError: true,
  };
}

describe("data-only migration recipes", () => {
  test("materializes deterministic ordered steps, preserving opaque reference order and duplicates", async () => {
    const { root, workspace } = await fixture();
    const recipe = { steps: [step("./b.ts"), step("a.ts")] };
    const first = await materializeAstMigrationRecipe(workspace, recipe);
    const second = await materializeAstMigrationRecipe(workspace, recipe);
    expect(first).toEqual(second);
    expect(first.steps.map((item) => item.path)).toEqual(["b.ts", "a.ts"]);
    expect(first.steps[0]).toEqual({
      ...step("b.ts"),
      rationale: "Migrate the explicit API call.",
      symbolRefs: ["symbol:legacy", "caller:sample", "symbol:legacy"],
    });
    const registry = new PreviewRegistry();
    const preview = await runAstMigrationRecipePreview(workspace, registry, recipe);
    expect(preview.steps).toEqual(first.steps);
    expect(preview.results.map((item) => item.stepIndex)).toEqual([0, 1]);
    expect(preview.results[0]!.previewId).toBeString();
    expect(preview.results[1]!.previewId).toBeString();
    expect(preview.results[0]!.previewId).not.toBe(preview.results[1]!.previewId);
    recipe.steps[0]!.operations[0]!.replacement = "changed()";
    recipe.steps[0]!.symbolRefs[0] = "changed";
    expect(preview.steps).toEqual(first.steps);
    for (const name of ["a.ts", "b.ts"]) expect(await readFile(path.join(root, name), "utf8")).toBe(source);
  });

  test("rejects executable or unknown recipe data and invalid later steps before native preview", async () => {
    const { workspace } = await fixture();
    const recipe = { steps: [step("a.ts"), step("b.ts")] };
    const invalidRecipes = [
      { ...recipe, script: "doWork()" },
      { ...recipe, shell: "echo migration" },
      { ...recipe, prompt: "find every caller" },
      { ...recipe, callback: () => undefined },
      { steps: [step("a.ts"), { ...step("b.ts"), discover: true }] },
      { steps: [step("a.ts"), { ...step("b.ts"), operations: [{ ...step("b.ts").operations[0]!, callback: () => undefined }] }] },
      { steps: [step("a.ts"), { ...step("b.ts"), operations: [{ pattern: "legacy($$$ARGS)", replacement: () => "modern()" }] }] },
      { steps: [step("a.ts"), { ...step("b.ts"), symbolRefs: [""] }] },
      { steps: [step("a.ts"), step("missing.ts")] },
      { steps: [step("a.ts"), step("./a.ts")] },
    ];
    const previewCall = spyOn(native, "astEdit");
    try {
      for (const recipe of invalidRecipes) {
        const registry = new PreviewRegistry();
        await expect(runAstMigrationRecipePreview(workspace, registry, recipe)).rejects.toThrow();
        expect(registry.size).toBe(0);
      }
      expect(previewCall).not.toHaveBeenCalled();
    } finally {
      previewCall.mockRestore();
    }
  });

  test("preserves zero-match steps and P1 partial apply when a later recipe step is stale", async () => {
    const { workspace, root } = await fixture();
    const registry = new PreviewRegistry();
    const preview = await runAstMigrationRecipePreview(workspace, registry, {
      steps: [step("a.ts"), {
        ...step("b.ts"), operations: [{ pattern: "missing($$$ARGS)", replacement: "noop($$$ARGS)" }],
      }, step("c.ts")],
    });
    expect(preview.results[1]).toMatchObject({ stepIndex: 1, previewId: null });
    expect(registry.size).toBe(2);
    await guardedAstEditApply(registry, preview.results[0]!.previewId!);
    await writeFile(path.join(root, "c.ts"), `${source}// external change\n`);
    await expect(guardedAstEditApply(registry, preview.results[2]!.previewId!))
      .rejects.toMatchObject({ code: "STALE_PREVIEW" });
    expect(registry.get(preview.results[0]!.previewId!)?.status).toBe("succeeded");
    expect(registry.get(preview.results[2]!.previewId!)?.status).toBe("stale");
    expect(await readFile(path.join(root, "a.ts"), "utf8")).toBe("const value = modern(1);\n");
    expect(await readFile(path.join(root, "b.ts"), "utf8")).toBe(source);
    expect(await readFile(path.join(root, "c.ts"), "utf8")).toBe(`${source}// external change\n`);
  });

  test("passes through the plan's partial preview failure and retained independent identities", async () => {
    const { workspace } = await fixture();
    const registry = new PreviewRegistry({ maxActive: 1 });
    await expect(runAstMigrationRecipePreview(workspace, registry, {
      steps: [step("a.ts"), step("b.ts"), step("c.ts")],
    })).rejects.toMatchObject({
      stepIndex: 1,
      failure: { code: "PREVIEW_CAPACITY_EXCEEDED" },
      completedResults: [{ stepIndex: 0, previewId: expect.any(String) }],
      notAttemptedStepIndexes: [2],
    });
    expect(registry.size).toBe(1);
  });
});
