import { astGrep } from "@oh-my-pi/pi-natives";

import { Workspace, WorkspaceError } from "../workspace.ts";
import { invalidateDirectoryScanCache } from "./scan-cache.ts";

export interface AstSearchInput {
  pattern: string;
  path?: string;
  glob?: string;
  offset?: number;
  limit?: number;
}

export class AstNativeError extends Error {
  readonly code = "AST_NATIVE_ERROR" as const;

  constructor() {
    super("AST_NATIVE_ERROR: native AST operation failed");
    this.name = "AstNativeError";
  }
}

export type AstSearchResult = Awaited<ReturnType<typeof astGrep>>;

function validateInput(input: AstSearchInput): void {
  if (typeof input.pattern !== "string" || input.pattern.length === 0) {
    throw new TypeError("pattern must be a non-empty string");
  }
  if (input.glob !== undefined && (typeof input.glob !== "string" || input.glob.length === 0)) {
    throw new TypeError("glob must be a non-empty string");
  }
  if (input.offset !== undefined && (!Number.isInteger(input.offset) || input.offset < 0)) {
    throw new TypeError("offset must be an integer greater than or equal to zero");
  }
  if (input.limit !== undefined && (!Number.isInteger(input.limit) || input.limit <= 0)) {
    throw new TypeError("limit must be a positive integer");
  }
}

export async function astSearch(
  workspace: Workspace,
  input: AstSearchInput,
): Promise<AstSearchResult> {
  validateInput(input);
  const resolvedTarget = await workspace.resolveTarget(input.path);

  const options: Parameters<typeof astGrep>[0] = {
    patterns: [input.pattern],
    path: resolvedTarget,
    includeMeta: true,
  };
  if (input.glob !== undefined) options.glob = input.glob;
  if (input.offset !== undefined) options.offset = input.offset;
  if (input.limit !== undefined) options.limit = input.limit;

  try {
    await invalidateDirectoryScanCache(resolvedTarget);
    return await astGrep(options);
  } catch (error) {
    if (error instanceof WorkspaceError) throw error;
    throw new AstNativeError();
  }
}
