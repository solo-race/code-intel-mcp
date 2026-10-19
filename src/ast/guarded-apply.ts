import { astEdit } from "@oh-my-pi/pi-natives";
import { readFile, stat } from "node:fs/promises";

import {
  astEditOptionsForContract,
  type AstEditPreviewResult,
} from "./edit-preview.ts";
import { invalidateDirectoryScanCache } from "./scan-cache.ts";
import {
  ApplyStateUncertainError,
  PreviewRegistry,
  StalePreviewError,
  type NormalizedMutation,
  type PreviewState,
  type PreviewTransformationMetadata,
  type VerificationPassed,
} from "./preview-registry.ts";
import { verifyStructuralPostconditions, type AstGrepCall } from "./verification.ts";
import {
  mutationPlansEqual,
  normalizeAstEditResult,
  readFileFingerprint,
  isWithinScope,
} from "./preview-state.ts";
import { Workspace } from "../workspace.ts";

export class PreApplyValidationError extends Error {
  readonly code = "PRE_APPLY_VALIDATION_FAILED" as const;

  constructor() {
    super("PRE_APPLY_VALIDATION_FAILED: preview could not be revalidated safely");
    this.name = "PreApplyValidationError";
  }
}

export type AstEditCall = (
  options: Parameters<typeof astEdit>[0],
) => ReturnType<typeof astEdit>;

export interface GuardedAstEditApplyOptions {
  /** Internal test seam; production defaults directly to pi-natives astEdit. */
  readonly astEdit?: AstEditCall;
  readonly astGrep?: AstGrepCall;
}

export interface GuardedAstEditApplyResult {
  readonly previewId: string;
  readonly workspaceRoot: string;
  readonly result: AstEditPreviewResult;
  readonly transformation?: PreviewTransformationMetadata;
  readonly verification?: VerificationPassed;
}

interface VerifiedFile {
  readonly bytes: Buffer;
}

function stale(registry: PreviewRegistry, previewId: string): never {
  try {
    registry.markStale(previewId);
  } catch {
    // The preview may have expired while it was being revalidated. It is no
    // longer usable either way, and the caller receives the stable stale code
    // for the drift that was observed.
  }
  throw new StalePreviewError();
}

function restoreReady(registry: PreviewRegistry, previewId: string): void {
  try {
    registry.restoreReady(previewId);
  } catch {
    // A preview that expires while a retry-safe validation failure is being
    // handled must not be resurrected.
  }
}

function markUncertain(
  registry: PreviewRegistry,
  previewId: string,
  error = new ApplyStateUncertainError(),
): never {
  try {
    registry.markFailedUncertain(previewId);
  } catch {
    // Preserve the uncertainty error even if the registry expired meanwhile.
  }
  throw error;
}

async function revalidateTarget(
  workspace: Workspace,
  state: PreviewState,
): Promise<void> {
  try {
    const target = await workspace.resolveTarget(state.contract.target);
    if (target !== state.contract.target) staleTarget();
    const targetKind = (await stat(target)).isDirectory() ? "directory" : "file";
    if (targetKind !== state.contract.targetKind) staleTarget();
  } catch {
    staleTarget();
  }
}

function staleTarget(): never {
  throw new StalePreviewError();
}

async function verifyFingerprints(
  workspace: Workspace,
  state: PreviewState,
): Promise<Map<string, VerifiedFile>> {
  const files = new Map<string, VerifiedFile>();
  for (const expected of state.fileFingerprints) {
    let canonicalPath: string;
    try {
      canonicalPath = await workspace.resolveTarget(expected.canonicalPath);
    } catch {
      staleTarget();
    }
    if (canonicalPath !== expected.canonicalPath) staleTarget();
    if (
      (state.contract.targetKind === "file" && canonicalPath !== state.contract.target) ||
      (state.contract.targetKind === "directory" &&
        !isWithinScope(state.contract.target, canonicalPath))
    ) {
      staleTarget();
    }

    let actual: Awaited<ReturnType<typeof readFileFingerprint>>;
    try {
      actual = await readFileFingerprint(canonicalPath);
    } catch {
      staleTarget();
    }
    if (
      actual.fingerprint.canonicalPath !== expected.canonicalPath ||
      actual.fingerprint.sha256 !== expected.sha256 ||
      actual.fingerprint.byteLength !== expected.byteLength
    ) {
      staleTarget();
    }
    files.set(canonicalPath, { bytes: actual.bytes });
  }
  return files;
}

function mutationGroups(
  plan: readonly NormalizedMutation[],
): Map<string, NormalizedMutation[]> {
  const groups = new Map<string, NormalizedMutation[]>();
  for (const mutation of plan) {
    const group = groups.get(mutation.canonicalPath);
    if (group === undefined) groups.set(mutation.canonicalPath, [mutation]);
    else group.push(mutation);
  }
  return groups;
}

function expectedPostState(
  files: Map<string, VerifiedFile>,
  plan: readonly NormalizedMutation[],
): Map<string, Buffer> {
  const groups = mutationGroups(plan);
  const expected = new Map<string, Buffer>();

  for (const [canonicalPath, mutations] of groups) {
    const file = files.get(canonicalPath);
    if (file === undefined) staleTarget();

    const ascending = [...mutations].sort((left, right) => {
      if (left.byteStart !== right.byteStart) return left.byteStart - right.byteStart;
      return left.byteEnd - right.byteEnd;
    });

    let postState = file.bytes;
    for (const mutation of [...ascending].reverse()) {
      if (
        mutation.byteEnd > postState.byteLength ||
        mutation.byteStart > mutation.byteEnd
      ) {
        staleTarget();
      }
      const beforeBytes = Buffer.from(mutation.before, "utf8");
      const actualBefore = file.bytes.subarray(mutation.byteStart, mutation.byteEnd);
      if (!actualBefore.equals(beforeBytes) || beforeBytes.byteLength !== mutation.byteEnd - mutation.byteStart) {
        staleTarget();
      }
      const afterBytes = Buffer.from(mutation.after, "utf8");
      postState = Buffer.concat([
        postState.subarray(0, mutation.byteStart),
        afterBytes,
        postState.subarray(mutation.byteEnd),
      ]);
    }
    expected.set(canonicalPath, postState);
  }
  return expected;
}

async function verifyPostState(
  expected: Map<string, Buffer>,
): Promise<void> {
  for (const [canonicalPath, expectedBytes] of expected) {
    let actual: Buffer;
    try {
      actual = await readFile(canonicalPath);
    } catch {
      throw new Error("post-state read failed");
    }
    if (!actual.equals(expectedBytes)) {
      throw new Error("post-state mismatch");
    }
  }
}

/**
 * Apply one stored preview after process-local claim and complete
 * pre-mutation revalidation. This function is intentionally not registered
 * as an MCP tool; its only rewrite authority is the registry state.
 */
export async function guardedAstEditApply(
  registry: PreviewRegistry,
  previewId: string,
  dependencies: GuardedAstEditApplyOptions = {},
): Promise<GuardedAstEditApplyResult> {
  const claimed = registry.claim(previewId);
  const nativeAstEdit = dependencies.astEdit ?? astEdit;

  try {
    let workspace: Workspace;
    try {
      workspace = await Workspace.create(claimed.workspaceRoot);
      if (workspace.root !== claimed.workspaceRoot) staleTarget();
    } catch {
      stale(registry, previewId);
    }

    try {
      await revalidateTarget(workspace, claimed);
    } catch {
      stale(registry, previewId);
    }

    let verifiedFiles: Map<string, VerifiedFile>;
    try {
      verifiedFiles = await verifyFingerprints(workspace, claimed);
    } catch {
      stale(registry, previewId);
    }

    let expectedPost: Map<string, Buffer>;
    try {
      expectedPost = expectedPostState(verifiedFiles, claimed.mutationPlan);
    } catch {
      stale(registry, previewId);
    }

    let dryRunResult: AstEditPreviewResult;
    try {
      await invalidateDirectoryScanCache(claimed.contract.target);
      dryRunResult = await nativeAstEdit(astEditOptionsForContract(claimed.contract, true));
    } catch {
      restoreReady(registry, previewId);
      throw new PreApplyValidationError();
    }

    if (dryRunResult.applied !== false) {
      restoreReady(registry, previewId);
      throw new PreApplyValidationError();
    }

    let freshPlan: readonly NormalizedMutation[];
    try {
      freshPlan = (await normalizeAstEditResult(
        workspace,
        claimed.contract,
        dryRunResult,
      )).mutationPlan;
    } catch {
      restoreReady(registry, previewId);
      throw new PreApplyValidationError();
    }
    if (!mutationPlansEqual(claimed.mutationPlan, freshPlan)) {
      stale(registry, previewId);
    }

    let applyResult: AstEditPreviewResult;
    try {
      await invalidateDirectoryScanCache(claimed.contract.target);
    } catch {
      restoreReady(registry, previewId);
      throw new PreApplyValidationError();
    }

    try {
      applyResult = await nativeAstEdit(astEditOptionsForContract(claimed.contract, false));
    } catch {
      markUncertain(registry, previewId);
    }

    if (applyResult.applied !== true) {
      markUncertain(registry, previewId);
    }

    let appliedPlan: readonly NormalizedMutation[];
    try {
      appliedPlan = (await normalizeAstEditResult(
        workspace,
        claimed.contract,
        applyResult,
      )).mutationPlan;
    } catch {
      markUncertain(registry, previewId);
    }
    if (!mutationPlansEqual(claimed.mutationPlan, appliedPlan)) {
      markUncertain(registry, previewId);
    }

    try {
      await verifyPostState(expectedPost);
    } catch {
      markUncertain(registry, previewId);
    }

    let verification: VerificationPassed | undefined;
    if (claimed.contract.verification !== undefined) {
      try {
        verification = await verifyStructuralPostconditions(
          workspace,
          claimed.contract.verification,
          dependencies.astGrep,
        );
      } catch (error) {
        markUncertain(registry, previewId,
          error instanceof ApplyStateUncertainError ? error : new ApplyStateUncertainError());
      }
    }

    try {
      registry.markSucceeded(previewId);
    } catch {
      markUncertain(registry, previewId);
    }
    return {
      previewId,
      workspaceRoot: claimed.workspaceRoot,
      result: applyResult,
      ...(claimed.contract.transformation === undefined ? {} : {
        transformation: claimed.contract.transformation,
      }),
      ...(verification === undefined ? {} : { verification }),
    };
  } catch (error) {
    if (
      error instanceof StalePreviewError ||
      error instanceof PreApplyValidationError ||
      error instanceof ApplyStateUncertainError
    ) {
      throw error;
    }
    // Any unexpected error before native mutation is retry-safe; the only
    // native mutation call is below and all post-call failures are converted
    // to APPLY_STATE_UNCERTAIN in their phase-specific handlers.
    restoreReady(registry, previewId);
    throw new PreApplyValidationError();
  }
}
