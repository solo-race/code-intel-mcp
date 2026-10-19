import { stat } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";

import { Workspace, WorkspaceError } from "../workspace.ts";
import {
  runAstEditPreview,
  validateAstEditPreviewInput,
  type AstEditOperation,
  type AstEditPreviewExecution,
  type AstEditPreviewInput,
} from "./edit-preview.ts";
import {
  freezeVerification,
  PreviewRegistry,
  type PreviewPostcondition,
  type PreviewTransformationMetadata,
  type PreviewVerification,
} from "./preview-registry.ts";
import { capturePreviewState } from "./preview-state.ts";

export interface AstTransformationPostconditionInput {
  kind: "ast_match_count";
  pattern: string;
  expectedCount: number;
  path?: string;
}

export interface AstTransformationVerificationInput {
  postconditions: AstTransformationPostconditionInput[];
}

/** Descriptors may omit `path`; the normalized contract requires it. */
const verificationInputSchema: z.ZodType<AstTransformationVerificationInput> = z.object({
  postconditions: z.array(z.object({
    kind: z.literal("ast_match_count"),
    pattern: z.string().refine((value) => value.trim().length > 0, "pattern must be non-empty"),
    expectedCount: z.number().int().min(0),
    path: z.string().min(1).optional(),
  }).strict()),
}).strict();

export const astTransformationPreviewInputSchema = z.object({
  path: z.string().min(1),
  operations: z.array(z.object({
    pattern: z.string().min(1),
    replacement: z.string(),
  }).strict()).min(1),
  rationale: z.string().trim().min(1),
  symbolRefs: z.array(z.string().trim().min(1)).min(1),
  failOnParseError: z.boolean().optional(),
  verification: verificationInputSchema.optional(),
}).strict();

export const astTransformationPlanInputSchema = z.object({
  steps: z.array(astTransformationPreviewInputSchema).min(1),
}).strict();

export interface AstTransformationPreviewInput {
  path: string;
  operations: AstEditOperation[];
  rationale: string;
  symbolRefs: string[];
  failOnParseError?: boolean;
  verification?: AstTransformationVerificationInput;
}

export interface AstTransformationPlanInput {
  steps: AstTransformationPreviewInput[];
}

export interface AstTransformationStepPreview {
  readonly stepIndex: number;
  readonly target: string;
  readonly transformation: PreviewTransformationMetadata;
  readonly verification?: PreviewVerification;
  readonly result: AstEditPreviewExecution["result"];
  readonly touchedPaths: readonly string[];
  readonly previewId: string | null;
}

export interface AstTransformationPlanPreview {
  readonly steps: AstTransformationPreviewInput[];
  readonly results: readonly AstTransformationStepPreview[];
}

/** A preview failure preserves independent identities already issued by P1. */
export class AstTransformationPlanPreviewError extends Error {
  readonly failure: { readonly code?: string; readonly message: string };

  constructor(
    readonly steps: AstTransformationPreviewInput[],
    readonly stepIndex: number,
    readonly completedResults: readonly AstTransformationStepPreview[],
    readonly notAttemptedStepIndexes: readonly number[],
    cause: unknown,
  ) {
    const message = cause instanceof Error ? cause.message : String(cause);
    super(message, { cause });
    this.name = "AstTransformationPlanPreviewError";
    this.failure = {
      ...(typeof cause === "object" && cause !== null &&
        "code" in cause && typeof cause.code === "string" ? { code: cause.code } : {}),
      message,
    };
  }
}

function normalizeMetadata(
  input: AstTransformationPreviewInput,
): PreviewTransformationMetadata {
  if (typeof input.rationale !== "string" || input.rationale.trim().length === 0) {
    throw new TypeError("rationale must be a non-empty string");
  }
  if (
    !Array.isArray(input.symbolRefs) ||
    input.symbolRefs.length === 0 ||
    input.symbolRefs.some((reference) =>
      typeof reference !== "string" || reference.trim().length === 0
    )
  ) {
    throw new TypeError("symbolRefs must contain at least one non-empty string");
  }
  return Object.freeze({
    rationale: input.rationale.trim(),
    // References are opaque: retain their supplied order and duplicates.
    symbolRefs: Object.freeze(input.symbolRefs.map((reference) => reference.trim())),
  });
}

async function resolveTransformationTarget(
  workspace: Workspace,
  targetPath: string,
): Promise<string> {
  if (
    typeof targetPath !== "string" ||
    targetPath.trim().length === 0 ||
    path.isAbsolute(targetPath) ||
    path.win32.isAbsolute(targetPath) ||
    /^[a-zA-Z]:/.test(targetPath) ||
    targetPath.split(/[\\/]/).includes("..")
  ) {
    throw new WorkspaceError(
      "INVALID_WORKSPACE_TARGET",
      "transformation path must be repository-relative without parent traversal",
    );
  }

  const target = await workspace.resolveTarget(targetPath);
  let targetStats: Awaited<ReturnType<typeof stat>>;
  try {
    targetStats = await stat(target);
  } catch {
    throw new WorkspaceError(
      "INVALID_WORKSPACE_TARGET",
      "transformation target cannot be inspected",
    );
  }
  if (!targetStats.isFile()) {
    throw new WorkspaceError(
      "INVALID_WORKSPACE_TARGET",
      "transformation target must be an existing regular file",
    );
  }

  return target;
}

async function normalizeVerification(
  workspace: Workspace,
  target: string,
  verification: AstTransformationVerificationInput | undefined,
): Promise<PreviewVerification | undefined> {
  if (verification === undefined) return undefined;
  // Descriptors that reach a contract are schema-valid: the plan envelope
  // parses them, and direct callers are checked here before any target work.
  const { postconditions: descriptors } = verificationInputSchema.parse(verification);
  const postconditions: PreviewPostcondition[] = [];
  for (const assertion of descriptors) {
    postconditions.push({
      ...assertion,
      path: assertion.path === undefined ? target :
        await resolveTransformationTarget(workspace, assertion.path),
    });
  }
  return freezeVerification({ postconditions });
}

/** Compile an explicit single-file transformation into the P1 preview lifecycle. */
export async function runAstTransformationPreview(
  workspace: Workspace,
  input: AstTransformationPreviewInput,
): Promise<AstEditPreviewExecution> {
  // Order is contractual: metadata, then target resolution, then the
  // verification descriptor, then operations. Each stage owns its error shape.
  const transformation = normalizeMetadata(input);
  const target = await resolveTransformationTarget(workspace, input.path);
  const verification = await normalizeVerification(workspace, target, input.verification);
  const previewInput: AstEditPreviewInput = {
    path: target,
    operations: input.operations,
    ...(input.failOnParseError === undefined ? {} : { failOnParseError: input.failOnParseError }),
    transformation,
    ...(verification === undefined ? {} : { verification }),
  };

  return runAstEditPreview(workspace, previewInput);
}

/** Complete all input/target checks before native work or registry allocation. */
export async function prepareAstTransformationPlan(
  workspace: Workspace,
  input: unknown,
): Promise<AstTransformationPlanInput> {
  const parsed = astTransformationPlanInputSchema.parse(input);
  const targets = new Set<string>();
  const steps: AstTransformationPreviewInput[] = [];
  for (const step of parsed.steps) {
    const transformation = normalizeMetadata(step);
    const target = await resolveTransformationTarget(workspace, step.path);
    const verification = await normalizeVerification(workspace, target, step.verification);
    // Preflight every step before native work or preview identity allocation.
    validateAstEditPreviewInput({
      path: target,
      operations: step.operations,
      ...(step.failOnParseError === undefined ? {} : { failOnParseError: step.failOnParseError }),
      ...(verification === undefined ? {} : { verification }),
    });
    if (targets.has(target)) {
      throw new WorkspaceError(
        "INVALID_WORKSPACE_TARGET",
        "transformation steps must name distinct canonical targets",
      );
    }
    targets.add(target);
    steps.push({
      path: path.relative(workspace.root, target).split(path.sep).join("/"),
      operations: step.operations,
      rationale: transformation.rationale,
      symbolRefs: [...transformation.symbolRefs],
      ...(step.failOnParseError === undefined ? {} : {
        failOnParseError: step.failOnParseError,
      }),
      ...(verification === undefined ? {} : {
        verification: {
          postconditions: verification.postconditions.map((assertion) => ({
            ...assertion,
            path: path.relative(workspace.root, assertion.path).split(path.sep).join("/"),
          })),
        },
      }),
    });
  }
  return { steps };
}

/** Preview independent explicit steps in caller order; never applies a plan. */
export async function runAstTransformationPlanPreview(
  workspace: Workspace,
  registry: PreviewRegistry,
  input: unknown,
): Promise<AstTransformationPlanPreview> {
  const { steps } = await prepareAstTransformationPlan(workspace, input);
  const results: AstTransformationStepPreview[] = [];
  for (const [stepIndex, step] of steps.entries()) {
    try {
      const execution = await runAstTransformationPreview(workspace, step);
      const previewId = await capturePreviewState(registry, execution);
      results.push({
        stepIndex,
        target: execution.contract.target,
        transformation: execution.contract.transformation!,
        ...(execution.contract.verification === undefined ? {} : {
          verification: execution.contract.verification,
        }),
        result: execution.result,
        touchedPaths: previewId === null ? [] : [execution.contract.target],
        previewId,
      });
    } catch (cause) {
      throw new AstTransformationPlanPreviewError(
        steps,
        stepIndex,
        results,
        steps.slice(stepIndex + 1).map((_, index) => stepIndex + 1 + index),
        cause,
      );
    }
  }
  return { steps, results };
}
