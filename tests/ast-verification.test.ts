import * as native from "@oh-my-pi/pi-natives";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { appendFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { guardedAstEditApply, type AstEditCall } from "../src/ast/guarded-apply.ts";
import { runAstMigrationRecipePreview } from "../src/ast/migration-recipe.ts";
import {
  ApplyStateUncertainError,
  PreviewRegistry,
  type PreviewPostcondition,
} from "../src/ast/preview-registry.ts";
import { capturePreviewState } from "../src/ast/preview-state.ts";
import {
  runAstTransformationPlanPreview,
  runAstTransformationPreview,
  type AstTransformationPreviewInput,
} from "../src/ast/transformation-plan.ts";
import type { AstGrepCall } from "../src/ast/verification.ts";
import { Workspace } from "../src/workspace.ts";

const temporaryRoots: string[] = [];
const source = "const value = compute(1);\n";
const mutated = "const value = compute(1).memo();\n";
const operation = { pattern: "compute($$$ARGS)", replacement: "compute($$$ARGS).memo()" };

/** `$_.memo($$$ARGS)` is the post-mutation shape of the shared one-call fixture. */
function postcondition(overrides: Partial<PreviewPostcondition> = {}): PreviewPostcondition {
  // The reviewed contract always stores a canonical path; inputs that omit it
  // exercise the defaulting rule and are passed as raw descriptor data.
  return {
    kind: "ast_match_count",
    pattern: "$_.memo($$$ARGS)",
    expectedCount: 1,
    ...overrides,
  } as PreviewPostcondition;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const base = await mkdtemp(path.join(os.tmpdir(), "code-intel-mcp-verify-"));
  temporaryRoots.push(base);
  const root = path.join(base, "repo");
  const outside = path.join(base, "outside");
  await mkdir(root);
  await mkdir(outside);
  await mkdir(path.join(root, "nested"));
  for (const name of ["a.ts", "b.ts", "c.ts"]) await writeFile(path.join(root, name), source);
  await writeFile(path.join(outside, "external.ts"), source);
  return { root, outside, workspace: await Workspace.create(root) };
}

function descriptor(...postconditions: unknown[]): unknown {
  return { postconditions };
}

function step(target: string, verification?: unknown): AstTransformationPreviewInput {
  return {
    path: target,
    operations: [{ ...operation }],
    rationale: `Verify the explicit call site in ${target}.`,
    symbolRefs: ["opaque:compute"],
    ...(verification === undefined ? {} : {
      verification: verification as NonNullable<AstTransformationPreviewInput["verification"]>,
    }),
  };
}

async function singleStepPreview(
  workspace: Workspace,
  target: string,
  verification: unknown,
): Promise<{ registry: PreviewRegistry; previewId: string; canonicalTarget: string }> {
  const registry = new PreviewRegistry();
  const plan = await runAstTransformationPlanPreview(workspace, registry, {
    steps: [step(target, verification)],
  });
  const result = plan.results[0]!;
  const previewId = result.previewId;
  if (typeof previewId !== "string") throw new Error("fixture preview produced no identity");
  return { registry, previewId, canonicalTarget: result.target };
}

function uncertaintyOf(error: unknown): ApplyStateUncertainError {
  expect(error).toBeInstanceOf(ApplyStateUncertainError);
  return error as ApplyStateUncertainError;
}

describe("structural postcondition preflight", () => {
  test("rejects invalid descriptors and assertion targets before any preview identity", async () => {
    const { workspace, root, outside } = await fixture();
    await symlink(outside, path.join(root, "linked"), process.platform === "win32" ? "junction" : "dir");

    const invalidVerifications: Array<{ label: string; verification: unknown; code?: string }> = [
      { label: "unsupported kind", verification: descriptor({ kind: "typescript_symbol", pattern: "compute($$$ARGS)", expectedCount: 1 }) },
      { label: "missing kind", verification: descriptor({ pattern: "compute($$$ARGS)", expectedCount: 1 }) },
      { label: "empty pattern", verification: descriptor({ ...postcondition(), pattern: "" }) },
      { label: "blank pattern", verification: descriptor({ ...postcondition(), pattern: " \t " }) },
      { label: "negative count", verification: descriptor({ ...postcondition(), expectedCount: -1 }) },
      { label: "fractional count", verification: descriptor({ ...postcondition(), expectedCount: 1.5 }) },
      { label: "missing count", verification: descriptor({ ...postcondition(), expectedCount: undefined }) },
      { label: "unexpected assertion field", verification: descriptor({ ...postcondition(), maxCount: 3 }) },
      { label: "unknown assertion kind field", verification: descriptor({ ...postcondition(), kind2: "ast_match_count" }) },
      { label: "unexpected descriptor field", verification: { postconditions: [postcondition()], minCount: 1 } },
      { label: "non-array postconditions", verification: { postconditions: postcondition() } },
      { label: "empty assertion path", verification: descriptor({ ...postcondition(), path: "" }) },
      { label: "absolute assertion path", verification: descriptor({ ...postcondition(), path: path.join(root, "b.ts") }), code: "INVALID_WORKSPACE_TARGET" },
      { label: "traversing assertion path", verification: descriptor({ ...postcondition(), path: "../outside/external.ts" }), code: "INVALID_WORKSPACE_TARGET" },
      { label: "missing assertion path", verification: descriptor({ ...postcondition(), path: "missing.ts" }), code: "TARGET_NOT_FOUND" },
      { label: "directory assertion path", verification: descriptor({ ...postcondition(), path: "nested" }), code: "INVALID_WORKSPACE_TARGET" },
      { label: "escaping assertion path", verification: descriptor({ ...postcondition(), path: "linked/external.ts" }), code: "WORKSPACE_ESCAPE" },
    ];

    const previewCall = spyOn(native, "astEdit");
    try {
      for (const invalid of invalidVerifications) {
        const facadeError = await runAstTransformationPreview(workspace, step("a.ts", invalid.verification))
          .catch((error: unknown) => error);
        expect(facadeError, `facade accepted ${invalid.label}`).toBeInstanceOf(Error);
        if (invalid.code !== undefined) expect(facadeError).toMatchObject({ code: invalid.code });

        // The bad descriptor sits in the second step, after a previewable first step.
        for (const preview of [runAstTransformationPlanPreview, runAstMigrationRecipePreview]) {
          const registry = new PreviewRegistry();
          const error = await preview(workspace, registry, {
            steps: [step("a.ts", descriptor(postcondition())), step("b.ts", invalid.verification)],
          }).catch((failure: unknown) => failure);
          expect(error, `plan accepted ${invalid.label}`).toBeInstanceOf(Error);
          if (invalid.code !== undefined) expect(error).toMatchObject({ code: invalid.code });
          expect(registry.size).toBe(0);
        }
      }

      await expect(runAstTransformationPlanPreview(workspace, new PreviewRegistry(), {
        steps: [step("a.ts")],
        batch: true,
      })).rejects.toThrow();
      await expect(runAstMigrationRecipePreview(workspace, new PreviewRegistry(), {
        steps: [step("a.ts", descriptor(postcondition()))],
        shell: "echo migration",
      })).rejects.toThrow();
      await expect(runAstTransformationPlanPreview(workspace, new PreviewRegistry(), {
        steps: [step("a.ts", descriptor(postcondition())), { ...step("b.ts", descriptor(postcondition())), discover: true }],
      })).rejects.toThrow();
      await expect(runAstMigrationRecipePreview(workspace, new PreviewRegistry(), {
        steps: [{ ...step("a.ts", descriptor(postcondition())), callback: () => undefined }],
      })).rejects.toThrow();
      expect(previewCall).not.toHaveBeenCalled();
    } finally {
      previewCall.mockRestore();
    }
  });
});

describe("defaulted and explicit assertion targets", () => {
  test("defaults an omitted assertion path to the owning step target in the facade, plan, and recipe", async () => {
    const { workspace } = await fixture();

    const facade = await runAstTransformationPreview(workspace, step("a.ts", descriptor(postcondition())));
    const facadePath = facade.contract.verification?.postconditions[0]?.path;
    expect(facadePath).toBe(facade.contract.target);
    const facadeRegistry = new PreviewRegistry();
    const facadeId = await capturePreviewState(facadeRegistry, facade);
    const facadeApplied = await guardedAstEditApply(facadeRegistry, facadeId!);
    expect(facadeApplied.verification).toEqual({
      status: "passed",
      results: [{ ...postcondition({ path: facade.contract.target }), actualCount: 1 }],
    });

    const plan = await runAstTransformationPlanPreview(workspace, new PreviewRegistry(), {
      steps: [step("b.ts", descriptor(postcondition()))],
    });
    const planResult = plan.results[0]!;
    expect(planResult.verification?.postconditions[0]?.path).toBe(planResult.target);
    expect(plan.steps[0]?.verification?.postconditions[0]?.path).toBe("b.ts");

    const recipe = await runAstMigrationRecipePreview(workspace, new PreviewRegistry(), {
      steps: [step("c.ts", descriptor(postcondition()))],
    });
    const recipeResult = recipe.results[0]!;
    expect(recipeResult.verification?.postconditions[0]?.path).toBe(recipeResult.target);
    expect(recipe.steps[0]?.verification?.postconditions[0]?.path).toBe("c.ts");
    expect(await readFile(recipeResult.target, "utf8")).toBe(source);

    const recipeRegistry = new PreviewRegistry();
    const captured = await runAstMigrationRecipePreview(workspace, recipeRegistry, {
      steps: [step("c.ts", descriptor(postcondition()))],
    });
    const applied = await guardedAstEditApply(recipeRegistry, captured.results[0]!.previewId!);
    expect(applied.verification?.results[0]?.path).toBe(captured.results[0]!.target);
  });

  test("keeps an explicit confined assertion path read-only during apply", async () => {
    const { workspace } = await fixture();
    const canonicalB = await workspace.resolveTarget("b.ts");
    const { registry, previewId, canonicalTarget } = await singleStepPreview(
      workspace,
      "a.ts",
      descriptor({ ...postcondition(), pattern: "compute($$$ARGS)", expectedCount: 1, path: "b.ts" }),
    );
    expect(canonicalTarget).toBe(await workspace.resolveTarget("a.ts"));
    expect(registry.get(previewId)!.contract.verification?.postconditions[0]?.path).toBe(canonicalB);

    const applied = await guardedAstEditApply(registry, previewId);
    expect(applied.verification).toEqual({
      status: "passed",
      results: [{ ...postcondition({ pattern: "compute($$$ARGS)", expectedCount: 1, path: canonicalB }), actualCount: 1 }],
    });
    expect(registry.size).toBe(1);
    expect(await readFile(canonicalTarget, "utf8")).toBe(mutated);
    // The reviewed assertion target granted no mutation authority of its own.
    expect(await readFile(canonicalB, "utf8")).toBe(source);
  });
});

describe("frozen declaration order and empty descriptors", () => {
  test("preserves declaration order in the preview contract and in apply evidence", async () => {
    const { workspace } = await fixture();
    const declarations = [
      postcondition({ pattern: "$_.memo($$$ARGS)", expectedCount: 1 }),
      postcondition({ pattern: "compute($$$ARGS)", expectedCount: 1 }),
      postcondition({ pattern: "absent($$$ARGS)", expectedCount: 0 }),
    ];

    const facade = await runAstTransformationPreview(workspace, step("a.ts", descriptor(...declarations)));
    expect(facade.contract.verification?.postconditions.map(({ pattern }) => pattern)).toEqual([
      "$_.memo($$$ARGS)",
      "compute($$$ARGS)",
      "absent($$$ARGS)",
    ]);

    const { registry, previewId, canonicalTarget } = await singleStepPreview(
      workspace,
      "b.ts",
      descriptor(...declarations),
    );
    const stored = registry.get(previewId)!.contract.verification!;
    expect(stored.postconditions.map(({ pattern }) => pattern)).toEqual([
      "$_.memo($$$ARGS)",
      "compute($$$ARGS)",
      "absent($$$ARGS)",
    ]);

    const applied = await guardedAstEditApply(registry, previewId);
    expect(applied.verification).toEqual({
      status: "passed",
      results: [
        { ...postcondition({ pattern: "$_.memo($$$ARGS)", expectedCount: 1, path: canonicalTarget }), actualCount: 1 },
        { ...postcondition({ pattern: "compute($$$ARGS)", expectedCount: 1, path: canonicalTarget }), actualCount: 1 },
        { ...postcondition({ pattern: "absent($$$ARGS)", expectedCount: 0, path: canonicalTarget }), actualCount: 0 },
      ],
    });
  });

  test("omits an absent descriptor and reports an empty one as a passing empty result", async () => {
    const { workspace } = await fixture();
    const registry = new PreviewRegistry();
    const plan = await runAstTransformationPlanPreview(workspace, registry, {
      steps: [step("a.ts"), step("b.ts", descriptor())],
    });
    expect("verification" in plan.results[0]!).toBe(false);
    expect(plan.results[1]!.verification).toEqual({ postconditions: [] });

    const withoutDescriptor = await guardedAstEditApply(
      registry,
      plan.results[0]!.previewId!,
    );
    expect("verification" in withoutDescriptor).toBe(false);

    const withEmptyDescriptor = await guardedAstEditApply(
      registry,
      plan.results[1]!.previewId!,
    );
    expect(withEmptyDescriptor.verification).toEqual({ status: "passed", results: [] });
    expect(registry.get(plan.results[1]!.previewId!)!.status).toBe("succeeded");
    expect(await readFile(plan.results[0]!.target, "utf8")).toBe(mutated);
    expect(await readFile(plan.results[1]!.target, "utf8")).toBe(mutated);
  });

  test("freezes caller-owned verification data against post-preview mutation", async () => {
    const { workspace } = await fixture();
    const supplied = {
      postconditions: [{ kind: "ast_match_count" as const, pattern: "$_.memo($$$ARGS)", expectedCount: 1 }],
    };
    const { registry, previewId, canonicalTarget } = await singleStepPreview(workspace, "a.ts", supplied);
    const stored = registry.get(previewId)!.contract.verification!;
    const expected = { postconditions: [postcondition({ path: canonicalTarget })] };
    expect(stored).toEqual(expected);

    supplied.postconditions[0]!.expectedCount = 42;
    supplied.postconditions[0]!.pattern = "changed($$$ARGS)";
    supplied.postconditions.push(postcondition({ pattern: "extra($$$ARGS)", expectedCount: 7 }));

    // Re-reading the stored contract proves the caller mutation did not reach it.
    expect(registry.get(previewId)!.contract.verification!).toEqual(expected);
    expect(Object.isFrozen(stored)).toBe(true);
    expect(Object.isFrozen(stored.postconditions)).toBe(true);
    expect(Object.isFrozen(stored.postconditions[0])).toBe(true);

    const applied = await guardedAstEditApply(registry, previewId);
    expect(applied.verification).toEqual({
      status: "passed",
      results: [{ ...postcondition({ path: canonicalTarget, expectedCount: 1 }), actualCount: 1 }],
    });
  });

  test("freezes facade verification data against post-preview mutation", async () => {
    const { workspace } = await fixture();
    const supplied = {
      postconditions: [{ kind: "ast_match_count" as const, pattern: "compute($$$ARGS)", expectedCount: 1 }],
    };
    const facade = await runAstTransformationPreview(workspace, step("c.ts", supplied));
    const expected = {
      postconditions: [postcondition({ pattern: "compute($$$ARGS)", expectedCount: 1, path: facade.contract.target })],
    };
    expect(facade.contract.verification).toEqual(expected);

    supplied.postconditions[0]!.expectedCount = 9;
    supplied.postconditions.length = 0;

    expect(facade.contract.verification).toEqual(expected);
    expect(Object.isFrozen(facade.contract.verification)).toBe(true);
    const registry = new PreviewRegistry();
    const previewId = await capturePreviewState(registry, facade);
    const applied = await guardedAstEditApply(registry, previewId!);
    expect(applied.verification?.results).toEqual([{
      ...postcondition({ pattern: "compute($$$ARGS)", expectedCount: 1, path: facade.contract.target }),
      actualCount: 1,
    }]);
  });
});

describe("postcondition evaluation after mutation", () => {
  test("establishes the complete match count beyond any truncated result page", async () => {
    const { root, workspace } = await fixture();
    const bulk = Array.from({ length: 256 }, (_, index) => `export const value${index} = compute(${index});`).join("\n") + "\n";
    await writeFile(path.join(root, "bulk.ts"), bulk);

    const { registry, previewId, canonicalTarget } = await singleStepPreview(workspace, "bulk.ts", descriptor(
      postcondition({ pattern: "$_.memo($$$ARGS)", expectedCount: 256 }),
      postcondition({ pattern: "compute($$$ARGS)", expectedCount: 256 }),
    ));
    const applied = await guardedAstEditApply(registry, previewId);
    expect(applied.result.totalReplacements).toBe(256);
    expect(applied.verification).toEqual({
      status: "passed",
      results: [
        { ...postcondition({ pattern: "$_.memo($$$ARGS)", expectedCount: 256, path: canonicalTarget }), actualCount: 256 },
        { ...postcondition({ pattern: "compute($$$ARGS)", expectedCount: 256, path: canonicalTarget }), actualCount: 256 },
      ],
    });
    expect(registry.get(previewId)!.status).toBe("succeeded");
    const content = await readFile(canonicalTarget, "utf8");
    expect(content.split(".memo()").length - 1).toBe(256);
  });

  test("passes a zero-count expectation and never evaluates a zero-match step", async () => {
    const { root, workspace } = await fixture();
    const registry = new PreviewRegistry();
    const zeroMatch = {
      ...step("b.ts", descriptor(postcondition({ pattern: "absent($$$ARGS)", expectedCount: 5 }))),
      operations: [{ pattern: "missing($$$ARGS)", replacement: "noop($$$ARGS)" }],
    };
    const plan = await runAstTransformationPlanPreview(workspace, registry, {
      steps: [step("a.ts", descriptor(postcondition({ pattern: "absent($$$ARGS)", expectedCount: 0 }))), zeroMatch],
    });
    expect(plan.results[1]).toMatchObject({ previewId: null, touchedPaths: [], result: { totalReplacements: 0 } });
    expect(registry.size).toBe(1);

    const grepCall = spyOn(native, "astGrep");
    try {
      const applied = await guardedAstEditApply(registry, plan.results[0]!.previewId!);
      expect(applied.verification).toEqual({
        status: "passed",
        results: [{
          ...postcondition({ pattern: "absent($$$ARGS)", expectedCount: 0, path: plan.results[0]!.target }),
          actualCount: 0,
        }],
      });
      expect(grepCall).toHaveBeenCalledTimes(1);
      expect(grepCall.mock.calls[0]![0]).toMatchObject({
        patterns: ["absent($$$ARGS)"],
        path: plan.results[0]!.target,
      });
    } finally {
      grepCall.mockRestore();
    }
    expect(await readFile(path.join(root, "b.ts"), "utf8")).toBe(source);
  });

  test("a post-mutation count mismatch is terminal uncertainty without continuing later steps", async () => {
    const { root, workspace } = await fixture();
    const registry = new PreviewRegistry();
    const plan = await runAstTransformationPlanPreview(workspace, registry, {
      steps: [
        step("a.ts", descriptor(
          postcondition({ pattern: "$_.memo($$$ARGS)", expectedCount: 1 }),
          postcondition({ pattern: "absent($$$ARGS)", expectedCount: 1 }),
          postcondition({ pattern: "compute($$$ARGS)", expectedCount: 1 }),
        )),
        step("b.ts", descriptor(postcondition())),
      ],
    });
    const target = plan.results[0]!.target;

    const outcomes: Array<{ stepIndex: number; status: string }> = [];
    let failure: unknown;
    for (const result of plan.results) {
      try {
        await guardedAstEditApply(registry, result.previewId!);
        outcomes.push({ stepIndex: result.stepIndex, status: "succeeded" });
      } catch (error) {
        failure = error;
        outcomes.push({ stepIndex: result.stepIndex, status: "failed" });
        break;
      }
    }

    expect(outcomes).toEqual([{ stepIndex: 0, status: "failed" }]);
    const uncertain = uncertaintyOf(failure);
    expect(uncertain.code).toBe("APPLY_STATE_UNCERTAIN");
    expect(uncertain.verification).toEqual({
      status: "failed",
      results: [
        { ...postcondition({ pattern: "$_.memo($$$ARGS)", expectedCount: 1, path: target }), actualCount: 1 },
        { ...postcondition({ pattern: "absent($$$ARGS)", expectedCount: 1, path: target }), actualCount: 0 },
      ],
      failedIndex: 1,
      path: target,
      cause: expect.any(String),
      notEvaluatedIndexes: [2],
    });
    expect(registry.get(plan.results[0]!.previewId!)!.status).toBe("failed_uncertain");
    expect(registry.get(plan.results[1]!.previewId!)!.status).toBe("ready");
    expect(await readFile(target, "utf8")).toBe(mutated);
    expect(await readFile(path.join(root, "b.ts"), "utf8")).toBe(source);

    await expect(guardedAstEditApply(registry, plan.results[0]!.previewId!))
      .rejects.toMatchObject({ code: "APPLY_STATE_UNCERTAIN" });
    expect(registry.get(plan.results[0]!.previewId!)!.status).toBe("failed_uncertain");
    expect(await readFile(target, "utf8")).toBe(mutated);
  });

  test("a search failure after mutation is terminal uncertainty with its cause", async () => {
    const { workspace } = await fixture();
    const { registry, previewId, canonicalTarget } = await singleStepPreview(
      workspace,
      "a.ts",
      descriptor(postcondition()),
    );
    const failingAstGrep: AstGrepCall = async () => {
      throw new Error("structural search unavailable");
    };

    const uncertain = uncertaintyOf(
      await guardedAstEditApply(registry, previewId, { astGrep: failingAstGrep })
        .catch((error: unknown) => error),
    );
    expect(uncertain.code).toBe("APPLY_STATE_UNCERTAIN");
    expect(uncertain.verification).toEqual({
      status: "failed",
      results: [],
      failedIndex: 0,
      path: canonicalTarget,
      cause: "structural search unavailable",
      notEvaluatedIndexes: [],
    });
    expect(registry.get(previewId)!.status).toBe("failed_uncertain");
    expect(await readFile(canonicalTarget, "utf8")).toBe(mutated);
  });

  test("an assertion target replaced by a directory after preview is terminal uncertainty", async () => {
    const { workspace } = await fixture();
    const canonicalB = await workspace.resolveTarget("b.ts");
    const { registry, previewId, canonicalTarget } = await singleStepPreview(
      workspace,
      "a.ts",
      descriptor({ ...postcondition(), pattern: "compute($$$ARGS)", expectedCount: 1, path: "b.ts" }),
    );
    await rm(canonicalB);
    await mkdir(canonicalB);

    const uncertain = uncertaintyOf(
      await guardedAstEditApply(registry, previewId).catch((error: unknown) => error),
    );
    expect(uncertain.code).toBe("APPLY_STATE_UNCERTAIN");
    expect(uncertain.verification).toMatchObject({
      status: "failed",
      results: [],
      failedIndex: 0,
      path: canonicalB,
      cause: expect.any(String),
      notEvaluatedIndexes: [],
    });
    expect(registry.get(previewId)!.status).toBe("failed_uncertain");
    expect(await readFile(canonicalTarget, "utf8")).toBe(mutated);
  });

  test("stale, retry-safe pre-apply, and post-state failures skip postcondition evaluation", async () => {
    const { root, workspace } = await fixture();
    const grepCall = spyOn(native, "astGrep");
    try {
      // Stale pre-state: unreviewed bytes already replaced the reviewed ones.
      const stale = await singleStepPreview(workspace, "a.ts", descriptor(postcondition()));
      const drifted = `${source}// external edit\n`;
      await writeFile(stale.canonicalTarget, drifted);
      await expect(guardedAstEditApply(stale.registry, stale.previewId))
        .rejects.toMatchObject({ code: "STALE_PREVIEW" });
      expect(stale.registry.get(stale.previewId)!.status).toBe("stale");
      expect(await readFile(stale.canonicalTarget, "utf8")).toBe(drifted);

      // Retry-safe pre-apply failure keeps the identity ready and unconsumed.
      const retry = await singleStepPreview(workspace, "b.ts", descriptor(postcondition()));
      let failDryRun = true;
      const failingDryRun: AstEditCall = async (options) => {
        if (options.dryRun === true && failDryRun) {
          failDryRun = false;
          throw new Error("temporary native validation failure");
        }
        return native.astEdit(options);
      };
      await expect(guardedAstEditApply(retry.registry, retry.previewId, { astEdit: failingDryRun }))
        .rejects.toMatchObject({ code: "PRE_APPLY_VALIDATION_FAILED" });
      expect(retry.registry.get(retry.previewId)!.status).toBe("ready");
      expect(await readFile(retry.canonicalTarget, "utf8")).toBe(source);

      // Applied-plan disagreement is terminal and precedes postconditions.
      const driftedPlan = await singleStepPreview(workspace, "c.ts", descriptor(postcondition()));
      const rewritingApply: AstEditCall = async (options) => {
        const result = await native.astEdit(options);
        if (options.dryRun === true) return result;
        return {
          ...result,
          changes: result.changes.map((change) => ({ ...change, after: `${change.after}!` })),
        };
      };
      const appliedPlanFailure = uncertaintyOf(
        await guardedAstEditApply(driftedPlan.registry, driftedPlan.previewId, { astEdit: rewritingApply })
          .catch((error: unknown) => error),
      );
      expect(appliedPlanFailure.verification).toBeUndefined();
      expect(driftedPlan.registry.get(driftedPlan.previewId)!.status).toBe("failed_uncertain");

      // Exact-byte post-state disagreement is terminal and precedes postconditions.
      await writeFile(path.join(root, "d.ts"), source);
      const exactBytes = await singleStepPreview(workspace, "d.ts", descriptor(postcondition()));
      const trailingWrite: AstEditCall = async (options) => {
        const result = await native.astEdit(options);
        if (options.dryRun === false) await appendFile(exactBytes.canonicalTarget, "// unreviewed trailing bytes\n");
        return result;
      };
      const exactByteFailure = uncertaintyOf(
        await guardedAstEditApply(exactBytes.registry, exactBytes.previewId, { astEdit: trailingWrite })
          .catch((error: unknown) => error),
      );
      expect(exactByteFailure.verification).toBeUndefined();
      expect(exactBytes.registry.get(exactBytes.previewId)!.status).toBe("failed_uncertain");
      expect(await readFile(exactBytes.canonicalTarget, "utf8")).toBe(`${mutated}// unreviewed trailing bytes\n`);
      expect(grepCall).not.toHaveBeenCalled();

      // Only the retained retry-safe identity evaluates postconditions.
      const retried = await guardedAstEditApply(retry.registry, retry.previewId);
      expect(retried.verification).toEqual({
        status: "passed",
        results: [{ ...postcondition({ path: retry.canonicalTarget }), actualCount: 1 }],
      });
      expect(grepCall).toHaveBeenCalledTimes(1);
      expect(retry.registry.get(retry.previewId)!.status).toBe("succeeded");
      expect(await readFile(retry.canonicalTarget, "utf8")).toBe(mutated);
    } finally {
      grepCall.mockRestore();
    }
  });
});
