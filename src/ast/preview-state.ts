import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";

import type {
  AstEditPreviewExecution,
  AstEditPreviewResult,
} from "./edit-preview.ts";
import {
  PreviewRegistry,
  PreviewStateError,
  type NormalizedMutation,
  type PreviewFileFingerprint,
} from "./preview-registry.ts";
import type { Workspace } from "../workspace.ts";

export function isWithinScope(scope: string, target: string): boolean {
  const relative = path.relative(scope, target);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

function invalidState(): never {
  throw new PreviewStateError();
}

export class AmbiguousMutationPlanError extends Error {
  readonly code = "AMBIGUOUS_MUTATION_PLAN" as const;

  constructor() {
    super(
      "AMBIGUOUS_MUTATION_PLAN: the reviewed plan contains overlapping replacements in one file, so no deterministic edit order exists and the pattern must be refined",
    );
    this.name = "AmbiguousMutationPlanError";
  }
}

/** Normalize one native relative path into a canonical, confined file path. */
export async function normalizeNativeChangePath(
  workspace: Workspace,
  target: string,
  targetKind: "file" | "directory",
  nativePath: unknown,
): Promise<string> {
  if (typeof nativePath !== "string" || nativePath.length === 0) {
    return invalidState();
  }

  try {
    const candidate =
      targetKind === "file"
        ? path.resolve(path.dirname(target), nativePath)
        : path.resolve(target, nativePath);
    const canonicalPath = await workspace.resolveTarget(candidate);
    if (targetKind === "file") {
      if (canonicalPath !== target) {
        return invalidState();
      }
    } else if (!isWithinScope(target, canonicalPath)) {
      return invalidState();
    }
    return canonicalPath;
  } catch {
    return invalidState();
  }
}

export function compareMutations(left: NormalizedMutation, right: NormalizedMutation): number {
  if (left.canonicalPath < right.canonicalPath) return -1;
  if (left.canonicalPath > right.canonicalPath) return 1;
  if (left.byteStart !== right.byteStart) return left.byteStart - right.byteStart;
  if (left.byteEnd !== right.byteEnd) return left.byteEnd - right.byteEnd;
  if (left.before < right.before) return -1;
  if (left.before > right.before) return 1;
  if (left.after < right.after) return -1;
  if (left.after > right.after) return 1;
  return 0;
}

function validByteOffset(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export interface ReadFileFingerprint {
  readonly bytes: Buffer;
  readonly fingerprint: PreviewFileFingerprint;
}

export async function readFileFingerprint(canonicalPath: string): Promise<ReadFileFingerprint> {
  let bytes: Buffer;
  try {
    bytes = await readFile(canonicalPath);
  } catch {
    return invalidState();
  }
  return {
    bytes,
    fingerprint: {
      canonicalPath,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      byteLength: bytes.byteLength,
    },
  };
}

export interface NormalizedAstEditResult {
  readonly mutationPlan: readonly NormalizedMutation[];
}

/** Normalize native mutation-relevant result fields for preview/apply comparison. */
export async function normalizeAstEditResult(
  workspace: Workspace,
  contract: AstEditPreviewExecution["contract"],
  result: AstEditPreviewResult,
): Promise<NormalizedAstEditResult> {
  if (!Array.isArray(result.changes) || !Array.isArray(result.fileChanges)) {
    return invalidState();
  }
  if (
    typeof result.totalReplacements !== "number" ||
    !Number.isInteger(result.totalReplacements) ||
    result.totalReplacements < 0
  ) {
    return invalidState();
  }

  for (const fileChange of result.fileChanges) {
    if (
      typeof fileChange !== "object" ||
      fileChange === null ||
      typeof fileChange.count !== "number" ||
      !Number.isInteger(fileChange.count) ||
      fileChange.count < 0
    ) {
      return invalidState();
    }
  }

  if (result.totalReplacements === 0) {
    if (result.changes.length !== 0 || result.fileChanges.some((change) => change.count > 0)) {
      return invalidState();
    }
    return { mutationPlan: Object.freeze([]) };
  }
  if (result.changes.length === 0 || result.changes.length !== result.totalReplacements) {
    return invalidState();
  }

  const mutationPlan: NormalizedMutation[] = [];
  for (const change of result.changes) {
    if (
      typeof change !== "object" ||
      change === null ||
      typeof change.before !== "string" ||
      typeof change.after !== "string" ||
      !validByteOffset(change.byteStart) ||
      !validByteOffset(change.byteEnd) ||
      change.byteEnd < change.byteStart
    ) {
      return invalidState();
    }
    const canonicalPath = await normalizeNativeChangePath(
      workspace,
      contract.target,
      contract.targetKind,
      change.path,
    );
    mutationPlan.push({
      canonicalPath,
      byteStart: change.byteStart,
      byteEnd: change.byteEnd,
      before: change.before,
      after: change.after,
    });
  }
  mutationPlan.sort(compareMutations);
  for (let index = 1; index < mutationPlan.length; index += 1) {
    const previous = mutationPlan[index - 1]!;
    const current = mutationPlan[index]!;
    if (previous.canonicalPath !== current.canonicalPath) continue;
    if (previous.byteEnd > current.byteStart || previous.byteStart === current.byteStart) {
      throw new AmbiguousMutationPlanError();
    }
  }

  const touchedPaths = new Set(mutationPlan.map((mutation) => mutation.canonicalPath));
  for (const fileChange of result.fileChanges) {
    if (fileChange.count > 0) {
      const canonicalPath = await normalizeNativeChangePath(
        workspace,
        contract.target,
        contract.targetKind,
        fileChange.path,
      );
      if (!touchedPaths.has(canonicalPath)) {
        return invalidState();
      }
    }
  }

  return { mutationPlan: Object.freeze(mutationPlan) };
}

export function mutationPlansEqual(
  left: readonly NormalizedMutation[],
  right: readonly NormalizedMutation[],
): boolean {
  if (left.length !== right.length) return false;
  for (let index = 0; index < left.length; index += 1) {
    const leftMutation = left[index];
    const rightMutation = right[index];
    if (
      leftMutation === undefined ||
      rightMutation === undefined ||
      compareMutations(leftMutation, rightMutation) !== 0
    ) {
      return false;
    }
  }
  return true;
}

/** Capture state after one successful native dry-run; never invokes native code. */
export async function capturePreviewState(
  registry: PreviewRegistry,
  execution: AstEditPreviewExecution,
): Promise<string | null> {
  const result = execution.result;
  if (result.applied !== false) {
    return invalidState();
  }
  const normalized = await normalizeAstEditResult(
    execution.workspace,
    execution.contract,
    result,
  );
  if (normalized.mutationPlan.length === 0) {
    return null;
  }

  const fileFingerprints: PreviewFileFingerprint[] = [];
  const touchedPaths = new Set(normalized.mutationPlan.map((mutation) => mutation.canonicalPath));
  for (const canonicalPath of [...touchedPaths].sort()) {
    fileFingerprints.push((await readFileFingerprint(canonicalPath)).fingerprint);
  }

  const state = registry.create({
    workspaceRoot: execution.workspace.root,
    contract: execution.contract,
    fileFingerprints,
    mutationPlan: normalized.mutationPlan,
  });
  return state.previewId;
}
