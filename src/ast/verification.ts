import { astGrep } from "@oh-my-pi/pi-natives";
import { readFile, stat } from "node:fs/promises";

import type { Workspace } from "../workspace.ts";
import {
  ApplyStateUncertainError,
  type PreviewVerification,
  type VerificationEntry,
  type VerificationPassed,
} from "./preview-registry.ts";

export type AstGrepCall = typeof astGrep;

/** Evaluate only the frozen read-only targets after the mutation is verified. */
export async function verifyStructuralPostconditions(
  workspace: Workspace,
  verification: PreviewVerification,
  nativeAstGrep: AstGrepCall = astGrep,
): Promise<VerificationPassed> {
  const results: VerificationEntry[] = [];
  for (const [index, assertion] of verification.postconditions.entries()) {
    try {
      const canonicalPath = await workspace.resolveTarget(assertion.path);
      if (canonicalPath !== assertion.path || !(await stat(canonicalPath)).isFile()) {
        throw new Error("verification target no longer names the reviewed regular file");
      }
      // Native search can skip unreadable files; establish readability explicitly.
      await readFile(canonicalPath);
      const found = await nativeAstGrep({ patterns: [assertion.pattern], path: canonicalPath });
      if (found.parseErrors?.length) {
        throw new Error(found.parseErrors.join("; "));
      }
      if (found.filesSearched !== 1) {
        throw new Error("verification target was not searched");
      }
      results.push({ ...assertion, actualCount: found.totalMatches });
      if (found.totalMatches !== assertion.expectedCount) {
        throw new Error("structural match count mismatch");
      }
    } catch (cause) {
      throw new ApplyStateUncertainError({
        status: "failed",
        results,
        failedIndex: index,
        path: assertion.path,
        cause: cause instanceof Error ? cause.message : String(cause),
        notEvaluatedIndexes: verification.postconditions.slice(index + 1)
          .map((_, offset) => index + 1 + offset),
      });
    }
  }
  return { status: "passed", results };
}
