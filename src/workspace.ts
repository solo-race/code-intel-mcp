import { realpath, stat } from "node:fs/promises";
import path from "node:path";

export type WorkspaceErrorCode =
  | "WORKSPACE_ROOT_REQUIRED"
  | "WORKSPACE_ROOT_NOT_ABSOLUTE"
  | "WORKSPACE_ROOT_MISMATCH"
  | "WORKSPACE_ROOT_NOT_FOUND"
  | "WORKSPACE_ROOT_NOT_DIRECTORY"
  | "WORKSPACE_ROOT_INVALID"
  | "WORKSPACE_ESCAPE"
  | "TARGET_NOT_FOUND"
  | "INVALID_WORKSPACE_TARGET";

export class WorkspaceError extends Error {
  readonly code: WorkspaceErrorCode;

  constructor(code: WorkspaceErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = "WorkspaceError";
    this.code = code;
  }
}

function isMissingPathError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    ((error as { code?: unknown }).code === "ENOENT" ||
      (error as { code?: unknown }).code === "ENOTDIR")
  );
}

function isWithinRoot(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (relative !== ".." &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

/** Drive-less Windows roots still depend on the process cwd's drive. */
export function isAbsoluteWorkspaceRoot(root: string): boolean {
  return path.isAbsolute(root) &&
    (process.platform !== "win32" || path.parse(root).root.length > 1);
}

/**
 * Canonical, server-owned workspace boundary.
 *
 * The root is canonicalized on creation. Tool paths are first checked
 * lexically, then canonicalized with realpath so symlink indirection cannot
 * move an existing target outside the boundary.
 */
export class Workspace {
  readonly root: string;

  private constructor(root: string) {
    this.root = root;
  }

  /** Request roots must never acquire meaning from the server process cwd. */
  static async createAbsolute(rootInput: string | undefined): Promise<Workspace> {
    if (typeof rootInput === "string" && rootInput.length > 0 && !isAbsoluteWorkspaceRoot(rootInput)) {
      throw new WorkspaceError(
        "WORKSPACE_ROOT_NOT_ABSOLUTE",
        "workspaceRoot must be an absolute directory path",
      );
    }
    return Workspace.create(rootInput);
  }

  static async create(rootInput: string | undefined): Promise<Workspace> {
    if (typeof rootInput !== "string" || rootInput.length === 0) {
      throw new WorkspaceError(
        "WORKSPACE_ROOT_REQUIRED",
        "workspace root must name an existing directory",
      );
    }

    let canonicalRoot: string;
    try {
      canonicalRoot = await realpath(rootInput);
    } catch (error) {
      if (isMissingPathError(error)) {
        throw new WorkspaceError(
          "WORKSPACE_ROOT_NOT_FOUND",
          "configured workspace root does not exist",
        );
      }
      throw new WorkspaceError(
        "WORKSPACE_ROOT_INVALID",
        "configured workspace root cannot be canonicalized",
      );
    }

    let rootStats: Awaited<ReturnType<typeof stat>>;
    try {
      rootStats = await stat(canonicalRoot);
    } catch {
      throw new WorkspaceError(
        "WORKSPACE_ROOT_INVALID",
        "configured workspace root cannot be inspected",
      );
    }
    if (!rootStats.isDirectory()) {
      throw new WorkspaceError(
        "WORKSPACE_ROOT_NOT_DIRECTORY",
        "configured workspace root is not a directory",
      );
    }

    return new Workspace(canonicalRoot);
  }

  /** Resolve an existing file or directory inside the canonical root. */
  async resolveTarget(targetInput?: string): Promise<string> {
    if (targetInput === undefined) {
      return this.root;
    }
    if (typeof targetInput !== "string" || targetInput.length === 0) {
      throw new WorkspaceError(
        "INVALID_WORKSPACE_TARGET",
        "target path must be a non-empty string",
      );
    }

    const lexicalTarget = path.resolve(this.root, targetInput);
    if (!isWithinRoot(this.root, lexicalTarget)) {
      throw new WorkspaceError(
        "WORKSPACE_ESCAPE",
        "target resolves outside the configured workspace",
      );
    }

    let canonicalTarget: string;
    try {
      canonicalTarget = await realpath(lexicalTarget);
    } catch (error) {
      if (isMissingPathError(error)) {
        throw new WorkspaceError(
          "TARGET_NOT_FOUND",
          "target path does not exist",
        );
      }
      throw new WorkspaceError(
        "INVALID_WORKSPACE_TARGET",
        "target path cannot be canonicalized",
      );
    }

    if (!isWithinRoot(this.root, canonicalTarget)) {
      throw new WorkspaceError(
        "WORKSPACE_ESCAPE",
        "target resolves outside the configured workspace",
      );
    }

    return canonicalTarget;
  }
}
