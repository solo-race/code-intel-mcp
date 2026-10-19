import { describe, expect, test } from "bun:test";

import {
  ApplyStateUncertainError,
  PreviewCapacityError,
  PreviewAlreadyUsedError,
  PreviewInProgressError,
  PreviewRegistry,
  StalePreviewError,
  UnknownOrExpiredPreviewError,
  type PreviewStateInput,
} from "../src/ast/preview-registry.ts";

function stateInput(label: string): PreviewStateInput {
  return {
    workspaceRoot: "/workspace",
    contract: {
      operations: [{ pattern: `call(${label})`, replacement: `next(${label})` }],
      target: `/workspace/${label}.ts`,
      targetKind: "file",
      glob: "*.ts",
      maxFiles: 4,
      failOnParseError: true,
    },
    fileFingerprints: [
      {
        canonicalPath: `/workspace/${label}.ts`,
        sha256: label.padEnd(64, "0"),
        byteLength: label.length,
      },
    ],
    mutationPlan: [
      {
        canonicalPath: `/workspace/${label}.ts`,
        byteStart: 0,
        byteEnd: label.length,
        before: label,
        after: label.toUpperCase(),
      },
    ],
  };
}

describe("PreviewRegistry", () => {
  test("generates unique IDs and retrieves active records", () => {
    const ids = ["preview-a", "preview-b"];
    const registry = new PreviewRegistry({ idFactory: () => ids.shift() ?? "" });

    const first = registry.create(stateInput("first"));
    const second = registry.create(stateInput("second"));

    expect(first.previewId).toBe("preview-a");
    expect(second.previewId).toBe("preview-b");
    expect(registry.get(first.previewId)).toBe(first);
    expect(registry.get(second.previewId)).toBe(second);
  });

  test("deep-copies caller state and keeps the stored record immutable", () => {
    const registry = new PreviewRegistry({ idFactory: () => "preview" });
    const input = stateInput("original");
    const state = registry.create(input);

    (input as { workspaceRoot: string }).workspaceRoot = "/caller-change";
    (input.contract.operations[0] as { replacement: string }).replacement = "caller-change";
    (input.fileFingerprints[0] as { sha256: string }).sha256 = "caller-change";
    (input.mutationPlan[0] as { after: string }).after = "caller-change";

    const stored = registry.get(state.previewId);
    expect(stored?.workspaceRoot).toBe("/workspace");
    expect(() => { (stored as { workspaceRoot: string }).workspaceRoot = "/redirect"; }).toThrow();
    expect(stored?.contract.operations[0]?.replacement).toBe("next(original)");
    expect(stored?.fileFingerprints[0]?.sha256).toBe("original".padEnd(64, "0"));
    expect(stored?.mutationPlan[0]?.after).toBe("ORIGINAL");
    expect(Object.isFrozen(stored)).toBe(true);
    expect(Object.isFrozen(stored?.contract)).toBe(true);
    expect(Object.isFrozen(stored?.contract.operations)).toBe(true);
  });

  test("removes expired records on lookup and merges them with unknown IDs", () => {
    let now = 100;
    const registry = new PreviewRegistry({
      ttlMs: 10,
      now: () => now,
      idFactory: () => "preview",
    });
    const state = registry.create(stateInput("expiring"));

    expect(registry.get(state.previewId)).toBe(state);
    now = 110;
    expect(registry.get(state.previewId)).toBeUndefined();
    expect(registry.size).toBe(0);
    expect(registry.get(state.previewId)).toBeUndefined();
    expect(registry.get("never-created")).toBeUndefined();
  });

  test("prunes expired records before enforcing capacity", () => {
    let now = 100;
    const ids = ["old", "new"];
    const registry = new PreviewRegistry({
      maxActive: 1,
      ttlMs: 10,
      now: () => now,
      idFactory: () => ids.shift() ?? "",
    });
    registry.create(stateInput("old"));
    now = 111;

    const replacement = registry.create(stateInput("new"));
    expect(replacement.previewId).toBe("new");
    expect(registry.get("old")).toBeUndefined();
    expect(registry.size).toBe(1);
  });

  test("size pruning makes expired records indistinguishable from unknown records", () => {
    let now = 100;
    const registry = new PreviewRegistry({
      ttlMs: 10,
      now: () => now,
      idFactory: () => "expiring",
    });
    const state = registry.create(stateInput("expiring"));

    now = 111;
    expect(registry.size).toBe(0);
    expect(registry.get(state.previewId)).toBeUndefined();
    expect(registry.get("never-created")).toBeUndefined();
  });

  test("rejects a full registry without evicting an active record", () => {
    const registry = new PreviewRegistry({
      maxActive: 1,
      idFactory: () => "only",
    });
    const first = registry.create(stateInput("first"));

    expect(() => registry.create(stateInput("second"))).toThrow(PreviewCapacityError);
    expect(registry.get(first.previewId)).toBe(first);
    expect(registry.size).toBe(1);
  });

  test("is process-local to each registry instance", () => {
    const first = new PreviewRegistry({ idFactory: () => "shared-id" });
    const second = new PreviewRegistry({ idFactory: () => "shared-id" });
    const state = first.create(stateInput("first"));

    expect(second.get(state.previewId)).toBeUndefined();
  });

  test("claims a ready record atomically and reports lifecycle-specific reuse errors", () => {
    const registry = new PreviewRegistry({ idFactory: () => "claimable" });
    const created = registry.create(stateInput("claimable"));

    const claimed = registry.claim(created.previewId);
    expect(claimed.status).toBe("applying");
    expect(claimed.workspaceRoot).toBe(created.workspaceRoot);
    expect(registry.get(created.previewId)?.status).toBe("applying");
    expect(() => registry.claim(created.previewId)).toThrow(PreviewInProgressError);

    const restored = registry.restoreReady(created.previewId);
    expect(restored?.status).toBe("ready");
    expect(restored?.workspaceRoot).toBe(created.workspaceRoot);
    const reclaimed = registry.claim(created.previewId);
    expect(reclaimed.status).toBe("applying");

    expect(registry.markSucceeded(created.previewId).workspaceRoot).toBe(created.workspaceRoot);
    expect(() => registry.claim(created.previewId)).toThrow(PreviewAlreadyUsedError);
  });

  test("controls stale and uncertain terminal transitions", () => {
    const staleRegistry = new PreviewRegistry({ idFactory: () => "stale" });
    const stale = staleRegistry.create(stateInput("stale"));
    staleRegistry.claim(stale.previewId);
    expect(staleRegistry.markStale(stale.previewId).status).toBe("stale");
    expect(() => staleRegistry.claim(stale.previewId)).toThrow(StalePreviewError);

    const uncertainRegistry = new PreviewRegistry({ idFactory: () => "uncertain" });
    const uncertain = uncertainRegistry.create(stateInput("uncertain"));
    uncertainRegistry.claim(uncertain.previewId);
    expect(uncertainRegistry.markFailedUncertain(uncertain.previewId).status).toBe(
      "failed_uncertain",
    );
    expect(() => uncertainRegistry.claim(uncertain.previewId)).toThrow(
      ApplyStateUncertainError,
    );
  });

  test("maps missing and expired claims to one unresolved-preview error", () => {
    let now = 100;
    const registry = new PreviewRegistry({
      ttlMs: 10,
      now: () => now,
      idFactory: () => "expired",
    });
    const state = registry.create(stateInput("expired"));

    now = 110;
    expect(() => registry.claim(state.previewId)).toThrow(UnknownOrExpiredPreviewError);
    expect(() => registry.claim("never-created")).toThrow(UnknownOrExpiredPreviewError);
    expect(registry.size).toBe(0);
  });
});
