import { randomUUID } from "node:crypto";

export const DEFAULT_PREVIEW_MAX_ACTIVE = 256;
export const DEFAULT_PREVIEW_TTL_MS = 10 * 60 * 1000;

export type PreviewLifecycle =
  | "ready"
  | "applying"
  | "stale"
  | "succeeded"
  | "failed_uncertain";

export type PreviewTargetKind = "file" | "directory";

export interface PreviewOperation {
  readonly pattern: string;
  readonly replacement: string;
}

export interface PreviewTransformationMetadata {
  readonly rationale: string;
  readonly symbolRefs: readonly string[];
}

export interface PreviewPostcondition {
  readonly kind: "ast_match_count";
  readonly pattern: string;
  readonly expectedCount: number;
  readonly path: string;
}

export interface PreviewVerification {
  readonly postconditions: readonly PreviewPostcondition[];
}

export interface VerificationEntry extends PreviewPostcondition {
  readonly actualCount: number;
}

export interface VerificationPassed {
  readonly status: "passed";
  readonly results: readonly VerificationEntry[];
}

export interface VerificationFailed {
  readonly status: "failed";
  readonly results: readonly VerificationEntry[];
  readonly failedIndex: number;
  readonly path: string;
  readonly cause: string;
  readonly notEvaluatedIndexes: readonly number[];
}

export interface PreviewEditContract {
  readonly operations: readonly PreviewOperation[];
  readonly target: string;
  readonly targetKind: PreviewTargetKind;
  readonly glob?: string;
  readonly maxFiles?: number;
  readonly failOnParseError?: boolean;
  readonly transformation?: PreviewTransformationMetadata;
  readonly verification?: PreviewVerification;
}

export interface PreviewFileFingerprint {
  readonly canonicalPath: string;
  readonly sha256: string;
  readonly byteLength: number;
}

export interface NormalizedMutation {
  readonly canonicalPath: string;
  readonly byteStart: number;
  readonly byteEnd: number;
  readonly before: string;
  readonly after: string;
}

export interface PreviewStateInput {
  readonly workspaceRoot: string;
  readonly contract: PreviewEditContract;
  readonly fileFingerprints: readonly PreviewFileFingerprint[];
  readonly mutationPlan: readonly NormalizedMutation[];
}

export interface PreviewState extends PreviewStateInput {
  readonly previewId: string;
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly status: PreviewLifecycle;
}

export class PreviewStateError extends Error {
  readonly code = "PREVIEW_STATE_INVALID" as const;

  constructor() {
    super("PREVIEW_STATE_INVALID: preview state could not be safely bound");
    this.name = "PreviewStateError";
  }
}

export class PreviewCapacityError extends Error {
  readonly code = "PREVIEW_CAPACITY_EXCEEDED" as const;

  constructor() {
    super("PREVIEW_CAPACITY_EXCEEDED: preview registry capacity is exhausted");
    this.name = "PreviewCapacityError";
  }
}

export class UnknownOrExpiredPreviewError extends Error {
  readonly code = "UNKNOWN_OR_EXPIRED_PREVIEW" as const;

  constructor() {
    super("UNKNOWN_OR_EXPIRED_PREVIEW: preview identity is unknown or expired");
    this.name = "UnknownOrExpiredPreviewError";
  }
}

export class PreviewInProgressError extends Error {
  readonly code = "PREVIEW_IN_PROGRESS" as const;

  constructor() {
    super("PREVIEW_IN_PROGRESS: preview is already being applied");
    this.name = "PreviewInProgressError";
  }
}

export class StalePreviewError extends Error {
  readonly code = "STALE_PREVIEW" as const;

  constructor() {
    super("STALE_PREVIEW: preview no longer matches the reviewed workspace state");
    this.name = "StalePreviewError";
  }
}

export class PreviewAlreadyUsedError extends Error {
  readonly code = "PREVIEW_ALREADY_USED" as const;

  constructor() {
    super("PREVIEW_ALREADY_USED: preview has already completed");
    this.name = "PreviewAlreadyUsedError";
  }
}

export class ApplyStateUncertainError extends Error {
  readonly code = "APPLY_STATE_UNCERTAIN" as const;

  constructor(readonly verification?: VerificationFailed) {
    super("APPLY_STATE_UNCERTAIN: native apply completion is uncertain");
    this.name = "ApplyStateUncertainError";
  }
}

type Clock = () => number;
type IdFactory = () => string;

export interface PreviewRegistryOptions {
  readonly maxActive?: number;
  readonly ttlMs?: number;
  readonly now?: Clock;
  readonly idFactory?: IdFactory;
}

function freezeContract(contract: PreviewEditContract): PreviewEditContract {
  const operations = Object.freeze(
    contract.operations.map((operation) =>
      Object.freeze({
        pattern: operation.pattern,
        replacement: operation.replacement,
      }),
    ),
  );
  return Object.freeze({
    operations,
    target: contract.target,
    targetKind: contract.targetKind,
    glob: contract.glob,
    maxFiles: contract.maxFiles,
    failOnParseError: contract.failOnParseError,
    ...(contract.transformation === undefined ? {} : {
      transformation: Object.freeze({
        rationale: contract.transformation.rationale,
        symbolRefs: Object.freeze([...contract.transformation.symbolRefs]),
      }),
    }),
    ...(contract.verification === undefined ? {} : {
      verification: freezeVerification(contract.verification),
    }),
  });
}

export function freezeVerification(verification: PreviewVerification): PreviewVerification {
  return Object.freeze({
    postconditions: Object.freeze(verification.postconditions.map((assertion) =>
      Object.freeze({ ...assertion }),
    )),
  });
}

function freezeStateInput(input: PreviewStateInput): PreviewStateInput {
  const fileFingerprints = Object.freeze(
    input.fileFingerprints.map((fingerprint) => Object.freeze({ ...fingerprint })),
  );
  const mutationPlan = Object.freeze(
    input.mutationPlan.map((mutation) => Object.freeze({ ...mutation })),
  );
  return Object.freeze({
    workspaceRoot: input.workspaceRoot,
    contract: freezeContract(input.contract),
    fileFingerprints,
    mutationPlan,
  });
}

/** Bounded, process-local preview state owned by one MCP server instance. */
export class PreviewRegistry {
  private readonly records = new Map<string, PreviewState>();
  private readonly maxActive: number;
  private readonly ttlMs: number;
  private readonly now: Clock;
  private readonly idFactory: IdFactory;

  constructor(options: PreviewRegistryOptions = {}) {
    this.maxActive = options.maxActive ?? DEFAULT_PREVIEW_MAX_ACTIVE;
    this.ttlMs = options.ttlMs ?? DEFAULT_PREVIEW_TTL_MS;
    this.now = options.now ?? Date.now;
    this.idFactory = options.idFactory ?? randomUUID;

    if (!Number.isInteger(this.maxActive) || this.maxActive <= 0) {
      throw new RangeError("maxActive must be a positive integer");
    }
    if (!Number.isInteger(this.ttlMs) || this.ttlMs <= 0) {
      throw new RangeError("ttlMs must be a positive integer");
    }
  }

  private pruneExpired(now: number): void {
    for (const [previewId, state] of this.records) {
      if (state.expiresAt <= now) {
        // Expired records are no longer active and are discarded lazily.
        this.records.delete(previewId);
      }
    }
  }

  private nextId(): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const previewId = this.idFactory();
      if (typeof previewId === "string" && previewId.length > 0 && !this.records.has(previewId)) {
        return previewId;
      }
    }
    throw new PreviewStateError();
  }

  private transition(
    previewId: string,
    expected: PreviewLifecycle,
    status: PreviewLifecycle,
  ): PreviewState {
    const state = this.get(previewId);
    if (state === undefined) {
      throw new UnknownOrExpiredPreviewError();
    }
    if (state.status !== expected) {
      throw new PreviewStateError();
    }
    const next = Object.freeze({ ...state, status });
    this.records.set(previewId, next);
    return next;
  }

  create(input: PreviewStateInput): PreviewState {
    const createdAt = this.now();
    this.pruneExpired(createdAt);
    if (this.records.size >= this.maxActive) {
      throw new PreviewCapacityError();
    }

    const previewId = this.nextId();
    const frozenInput = freezeStateInput(input);
    const state = Object.freeze({
      ...frozenInput,
      previewId,
      createdAt,
      expiresAt: createdAt + this.ttlMs,
      status: "ready" as const,
    });
    this.records.set(previewId, state);
    return state;
  }

  get(previewId: string): PreviewState | undefined {
    const now = this.now();
    const state = this.records.get(previewId);
    if (state === undefined) {
      return undefined;
    }
    if (state.expiresAt <= now) {
      this.records.delete(previewId);
      return undefined;
    }
    return state;
  }

  /** Atomically claim a ready record without yielding between read and write. */
  claim(previewId: string): PreviewState {
    const now = this.now();
    const state = this.records.get(previewId);
    if (state === undefined || state.expiresAt <= now) {
      if (state !== undefined) this.records.delete(previewId);
      throw new UnknownOrExpiredPreviewError();
    }
    if (state.status === "ready") {
      const claimed = Object.freeze({ ...state, status: "applying" as const });
      this.records.set(previewId, claimed);
      return claimed;
    }
    switch (state.status) {
      case "applying":
        throw new PreviewInProgressError();
      case "stale":
        throw new StalePreviewError();
      case "succeeded":
        throw new PreviewAlreadyUsedError();
      case "failed_uncertain":
        throw new ApplyStateUncertainError();
    }
  }

  /** Restore a claimed preview only after a failure proven retry-safe. */
  restoreReady(previewId: string): PreviewState | undefined {
    const state = this.get(previewId);
    if (state === undefined) return undefined;
    if (state.status !== "applying") throw new PreviewStateError();
    const restored = Object.freeze({ ...state, status: "ready" as const });
    this.records.set(previewId, restored);
    return restored;
  }

  markStale(previewId: string): PreviewState {
    return this.transition(previewId, "applying", "stale");
  }

  markSucceeded(previewId: string): PreviewState {
    return this.transition(previewId, "applying", "succeeded");
  }

  markFailedUncertain(previewId: string): PreviewState {
    return this.transition(previewId, "applying", "failed_uncertain");
  }

  get size(): number {
    this.pruneExpired(this.now());
    return this.records.size;
  }
}
