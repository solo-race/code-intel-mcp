import * as native from "@oh-my-pi/pi-natives";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { guardedAstEditApply } from "../src/ast/guarded-apply.ts";
import { PreviewRegistry } from "../src/ast/preview-registry.ts";
import {
  AstTransformationPlanPreviewError,
  runAstTransformationPlanPreview,
  type AstTransformationPreviewInput,
} from "../src/ast/transformation-plan.ts";
import { Workspace } from "../src/workspace.ts";

const temporaryRoots: string[] = [];
const source = "const value = compute(1);\n";

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const base = await mkdtemp(path.join(os.tmpdir(), "code-intel-plan-"));
  temporaryRoots.push(base);
  const root = path.join(base, "repo");
  const outside = path.join(base, "outside");
  await mkdir(root);
  await mkdir(outside);
  for (const name of ["a.ts", "b.ts", "c.ts"]) await writeFile(path.join(root, name), source);
  await writeFile(path.join(outside, "external.ts"), source);
  return { root, outside, workspace: await Workspace.create(root) };
}

function step(target: string, replacement = "memo($$$ARGS)"): AstTransformationPreviewInput {
  return {
    path: target,
    operations: [{ pattern: "compute($$$ARGS)", replacement }],
    rationale: `  Update ${target}  `,
    symbolRefs: [" graph:compute ", "opaque:call", "graph:compute"],
  };
}

describe("ordered transformation plan preview", () => {
  test("preserves supplied order and per-file operations with independent identities and no writes", async () => {
    const { workspace, root } = await fixture();
    const registry = new PreviewRegistry();
    const steps = [step("b.ts", "second($$$ARGS)"), step("./a.ts", "first($$$ARGS)")];
    const plan = await runAstTransformationPlanPreview(workspace, registry, { steps });
    expect(plan.steps.map((item) => item.path)).toEqual(["b.ts", "a.ts"]);
    expect(plan.results.map((item) => item.stepIndex)).toEqual([0, 1]);
    expect(new Set(plan.results.map((item) => item.previewId)).size).toBe(2);
    for (const result of plan.results) {
      expect(result.previewId).toBeString();
      expect(result.result.applied).toBe(false);
      expect(result.result.totalReplacements).toBe(1);
      expect(result.touchedPaths).toEqual([result.target]);
      expect(result.transformation.symbolRefs).toEqual(["graph:compute", "opaque:call", "graph:compute"]);
      expect(await readFile(result.target, "utf8")).toBe(source);
    }
    const swapped = await runAstTransformationPlanPreview(workspace, new PreviewRegistry(), { steps: [...steps].reverse() });
    expect(swapped.steps).toEqual([...plan.steps].reverse());
    expect(swapped.results.map((item) => item.target)).toEqual(plan.results.map((item) => item.target).reverse());
    await guardedAstEditApply(registry, plan.results[0]!.previewId!);
    expect(await readFile(path.join(root, "b.ts"), "utf8")).toBe("const value = second(1);\n");
    expect(await readFile(path.join(root, "a.ts"), "utf8")).toBe(source);
    await guardedAstEditApply(registry, plan.results[1]!.previewId!);
    expect(await readFile(path.join(root, "a.ts"), "utf8")).toBe("const value = first(1);\n");
  });

  test("rejects invalid late fields and targets before any native preview or identity allocation", async () => {
    const { workspace, root, outside } = await fixture();
    await symlink(outside, path.join(root, "linked"), process.platform === "win32" ? "junction" : "dir");
    const invalidSteps = [
      { ...step("b.ts"), rationale: " " },
      { ...step("b.ts"), symbolRefs: [] },
      { ...step("b.ts"), operations: [] },
      { ...step("b.ts"), operations: [{ pattern: "", replacement: "x" }] },
      { ...step("b.ts"), operations: [...step("b.ts").operations, ...step("b.ts").operations] },
      { ...step("b.ts"), failOnParseError: "true" },
      { ...step("b.ts"), glob: "**/*.ts" },
      ...[path.join(root, "b.ts"), "../outside/external.ts", "missing.ts", ".", "linked/external.ts", "./a.ts"].map((target) => step(target)),
    ];
    const nativePreview = spyOn(native, "astEdit");
    try {
      for (const invalid of invalidSteps) {
        const registry = new PreviewRegistry();
        await expect(runAstTransformationPlanPreview(workspace, registry, { steps: [step("a.ts"), invalid] })).rejects.toThrow();
        expect(registry.size).toBe(0);
      }
      for (const input of [{ steps: [] }, { steps: [step("a.ts")], script: "run()" }]) {
        await expect(runAstTransformationPlanPreview(workspace, new PreviewRegistry(), input)).rejects.toThrow();
      }
      expect(nativePreview).not.toHaveBeenCalled();
    } finally {
      nativePreview.mockRestore();
    }
  });

  test("zero-match steps keep their index and consume no state beside matching siblings", async () => {
    const { workspace } = await fixture();
    const registry = new PreviewRegistry();
    const empty = { ...step("b.ts"), operations: [{ pattern: "missing($$$ARGS)", replacement: "noop($$$ARGS)" }] };
    const plan = await runAstTransformationPlanPreview(workspace, registry, { steps: [step("a.ts"), empty, step("c.ts")] });
    expect(plan.results.map((item) => item.stepIndex)).toEqual([0, 1, 2]);
    expect(plan.results[1]).toMatchObject({ previewId: null, touchedPaths: [], result: { totalReplacements: 0 } });
    expect(plan.results[0]!.previewId).toBeString();
    expect(plan.results[2]!.previewId).toBeString();
    expect(registry.size).toBe(2);
  });

  test("a late registry failure exposes earlier IDs and later not-attempted indexes", async () => {
    const { workspace, root } = await fixture();
    const registry = new PreviewRegistry({ maxActive: 1 });
    const error = await runAstTransformationPlanPreview(workspace, registry, {
      steps: [step("a.ts"), step("b.ts"), step("c.ts")],
    }).catch((failure: unknown) => failure);
    expect(error).toBeInstanceOf(AstTransformationPlanPreviewError);
    const failure = error as AstTransformationPlanPreviewError;
    expect(failure.stepIndex).toBe(1);
    expect(failure.failure.code).toBe("PREVIEW_CAPACITY_EXCEEDED");
    expect(failure.completedResults).toHaveLength(1);
    expect(failure.notAttemptedStepIndexes).toEqual([2]);
    const retainedId = failure.completedResults[0]!.previewId!;
    expect(registry.get(retainedId)?.status).toBe("ready");
    for (const name of ["a.ts", "b.ts", "c.ts"]) expect(await readFile(path.join(root, name), "utf8")).toBe(source);
    await guardedAstEditApply(registry, retainedId);
    expect(registry.get(retainedId)?.status).toBe("succeeded");
  });

  test("native-plan ambiguity retains completed IDs without continuing later previews", async () => {
    const { workspace, root } = await fixture();
    const nested = "const value = f(f(1));\n";
    await writeFile(path.join(root, "b.ts"), nested);
    const registry = new PreviewRegistry();
    const error = await runAstTransformationPlanPreview(workspace, registry, {
      steps: [step("a.ts"), { ...step("b.ts"), operations: [{ pattern: "f($$$A)", replacement: "g($$$A)" }] }, step("c.ts")],
    }).catch((failure: unknown) => failure) as AstTransformationPlanPreviewError;
    expect(error.failure.code).toBe("AMBIGUOUS_MUTATION_PLAN");
    expect(error.stepIndex).toBe(1);
    expect(error.completedResults).toHaveLength(1);
    expect(error.notAttemptedStepIndexes).toEqual([2]);
    expect(registry.size).toBe(1);
    expect(await readFile(path.join(root, "b.ts"), "utf8")).toBe(nested);
  });

  for (const failureMode of ["stale", "uncertain"] as const) {
    test(`caller sequential apply stops on ${failureMode}, retaining earlier success and later ready state`, async () => {
      const { workspace, root } = await fixture();
      const registry = new PreviewRegistry();
      const plan = await runAstTransformationPlanPreview(workspace, registry, { steps: [step("a.ts"), step("b.ts"), step("c.ts")] });
      if (failureMode === "stale") await writeFile(path.join(root, "b.ts"), `${source}// external\n`);
      const outcomes: Array<{ stepIndex: number; status: string; code?: string }> = [];
      for (const result of plan.results) {
        try {
          await guardedAstEditApply(registry, result.previewId!, {
            astEdit: async (options) => {
              if (failureMode === "uncertain" && result.stepIndex === 1 && options.dryRun !== true) {
                throw new Error("native write completion unavailable");
              }
              return native.astEdit(options);
            },
          });
          outcomes.push({ stepIndex: result.stepIndex, status: "succeeded" });
        } catch (error) {
          outcomes.push({ stepIndex: result.stepIndex, status: "failed", code: (error as { code: string }).code });
          break;
        }
      }
      const code = failureMode === "stale" ? "STALE_PREVIEW" : "APPLY_STATE_UNCERTAIN";
      expect(outcomes).toEqual([{ stepIndex: 0, status: "succeeded" }, { stepIndex: 1, status: "failed", code }]);
      expect(registry.get(plan.results[0]!.previewId!)?.status).toBe("succeeded");
      expect(registry.get(plan.results[1]!.previewId!)?.status).toBe(failureMode === "stale" ? "stale" : "failed_uncertain");
      expect(registry.get(plan.results[2]!.previewId!)?.status).toBe("ready");
      expect(await readFile(path.join(root, "a.ts"), "utf8")).toBe("const value = memo(1);\n");
      expect(await readFile(path.join(root, "c.ts"), "utf8")).toBe(source);
      await expect(guardedAstEditApply(registry, plan.results[0]!.previewId!)).rejects.toMatchObject({ code: "PREVIEW_ALREADY_USED" });
    });
  }
});
