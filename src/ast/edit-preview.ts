import { astEdit } from "@oh-my-pi/pi-natives";
import { stat } from "node:fs/promises";

import { Workspace, WorkspaceError } from "../workspace.ts";
import { AstNativeError } from "./search.ts";
import type {
  PreviewEditContract,
  PreviewTargetKind,
  PreviewTransformationMetadata,
  PreviewVerification,
} from "./preview-registry.ts";
import { freezeVerification } from "./preview-registry.ts";
import { invalidateDirectoryScanCache } from "./scan-cache.ts";

export interface AstEditOperation {
  pattern: string;
  replacement: string;
}

export interface AstEditPreviewInput {
  operations: AstEditOperation[];
  path: string;
  glob?: string;
  maxFiles?: number;
  failOnParseError?: boolean;
  transformation?: PreviewTransformationMetadata;
  verification?: PreviewVerification;
}

export type AstEditPreviewResult = Awaited<ReturnType<typeof astEdit>>;

export interface AstEditPreviewExecution {
  readonly result: AstEditPreviewResult;
  readonly workspace: Workspace;
  readonly contract: PreviewEditContract;
}

/** Build the native request from the validated, stored edit contract. */
export function astEditOptionsForContract(
  contract: PreviewEditContract,
  dryRun: boolean,
): Parameters<typeof astEdit>[0] {
  const options: Parameters<typeof astEdit>[0] = {
    rewrites: Object.fromEntries(
      contract.operations.map(({ pattern, replacement }) => [pattern, replacement]),
    ),
    path: contract.target,
    dryRun,
  };
  if (contract.glob !== undefined) options.glob = contract.glob;
  if (contract.maxFiles !== undefined) options.maxFiles = contract.maxFiles;
  if (contract.failOnParseError !== undefined) {
    options.failOnParseError = contract.failOnParseError;
  }
  return options;
}

export class DuplicatePatternError extends Error {
  readonly code = "DUPLICATE_PATTERN" as const;

  constructor() {
    super(
      "DUPLICATE_PATTERN: operations contain the same structural pattern more than once",
    );
    this.name = "DuplicatePatternError";
  }
}

export function validateAstEditPreviewInput(input: AstEditPreviewInput): void {
  if (!Array.isArray(input.operations) || input.operations.length === 0) {
    throw new TypeError("operations must be a non-empty array");
  }
  const patterns = new Set<string>();
  for (const operation of input.operations) {
    if (
      operation === null ||
      typeof operation !== "object" ||
      typeof operation.pattern !== "string" ||
      operation.pattern.length === 0
    ) {
      throw new TypeError("each operation pattern must be a non-empty string");
    }
    if (typeof operation.replacement !== "string") {
      throw new TypeError("each operation replacement must be a string");
    }
    if (patterns.has(operation.pattern)) {
      throw new DuplicatePatternError();
    }
    patterns.add(operation.pattern);
  }
  if (typeof input.path !== "string" || input.path.length === 0) {
    throw new TypeError("path must be a non-empty string");
  }
  if (input.glob !== undefined && (typeof input.glob !== "string" || input.glob.length === 0)) {
    throw new TypeError("glob must be a non-empty string");
  }
  if (input.maxFiles !== undefined && (!Number.isInteger(input.maxFiles) || input.maxFiles <= 0)) {
    throw new TypeError("maxFiles must be a positive integer");
  }
  if (input.failOnParseError !== undefined && typeof input.failOnParseError !== "boolean") {
    throw new TypeError("failOnParseError must be a boolean");
  }
}

export async function runAstEditPreview(
  workspace: Workspace,
  input: AstEditPreviewInput,
): Promise<AstEditPreviewExecution> {
  validateAstEditPreviewInput(input);
  const resolvedTarget = await workspace.resolveTarget(input.path);
  let targetKind: PreviewTargetKind;
  try {
    targetKind = (await stat(resolvedTarget)).isDirectory() ? "directory" : "file";
  } catch {
    throw new AstNativeError();
  }
  const operations = Object.freeze(
    input.operations.map(({ pattern, replacement }) =>
      Object.freeze({ pattern, replacement }),
    ),
  );
  const contract: PreviewEditContract = {
    operations,
    target: resolvedTarget,
    targetKind,
    glob: input.glob,
    maxFiles: input.maxFiles,
    failOnParseError: input.failOnParseError,
    ...(input.transformation === undefined ? {} : {
      transformation: Object.freeze({
        rationale: input.transformation.rationale,
        symbolRefs: Object.freeze([...input.transformation.symbolRefs]),
      }),
    }),
    ...(input.verification === undefined ? {} : {
      verification: freezeVerification(input.verification),
    }),
  };
  const options = astEditOptionsForContract(contract, true);

  try {
    await invalidateDirectoryScanCache(resolvedTarget);
    const result = await astEdit(options);
    return { result, workspace, contract };
  } catch (error) {
    if (error instanceof WorkspaceError) throw error;
    throw new AstNativeError();
  }
}

export async function astEditPreview(
  workspace: Workspace,
  input: AstEditPreviewInput,
): Promise<AstEditPreviewResult> {
  return (await runAstEditPreview(workspace, input)).result;
}
