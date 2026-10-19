# P1A — Preview State Contract

Status: Complete

## Goal

Turn a successful P0 `ast_edit_preview` into a bounded, state-bound mutation intent without introducing any mutation-capable code path.

P1A is intentionally non-mutating. Its purpose is to settle the preview identity, stored contract, file-state evidence, and lifecycle model that P1B will consume.

## In scope

- extend successful edit preview handling with an opaque preview identity suitable for later `ast_edit_apply`;
- introduce a process-local bounded preview registry owned by the MCP server/runtime;
- store the validated immutable rewrite contract and canonical target scope needed to reproduce the preview;
- retain enough original preview information to compare a later fresh dry-run mutation plan;
- fingerprint the complete bytes/state of every file the original preview intends to modify;
- define lifecycle states sufficient for ready, applying, stale, consumed/succeeded, and failed/uncertain handling; expiry removes pending records rather than retaining an expired lifecycle state;
- define finite capacity/expiry behavior so preview state cannot grow without bound;
- add focused tests for identity uniqueness, registry bounds/expiry, state capture, and preview immutability.

The exact registry constants and internal representation are implementation details, but persistence remains in-memory and process-local. Expiry removes pending records lazily; after removal, expired and never-existing identities are intentionally merged for later apply semantics as `UNKNOWN_OR_EXPIRED_PREVIEW`. Server restart invalidates outstanding preview identities.

## Safety boundary

No code introduced in P1A may call `astEdit(..., dryRun: false)` or expose `ast_edit_apply` over MCP.

State binding must not rely only on native change coordinates. Whole-file fingerprinting is required for files intended to be mutated so unrelated byte changes in those files invalidate later apply.

For directory targets, P1A need not fingerprint every non-matching file in the workspace. P1B will address scope expansion by rerunning the exact stored preview contract and comparing the resulting mutation plan before mutation.

Preview identities are capabilities to a pending mutation intent; callers must not be able to choose their own stored rewrite/path options when later applying them.

## Deliverables

- bounded process-local preview state/registry abstraction;
- opaque preview identity emitted by applicable edit previews;
- immutable stored rewrite/target/options contract;
- stored original mutation-plan evidence;
- whole-file fingerprints for originally touched files;
- focused registry/state tests;
- no public mutation tool and no production write path.

## Acceptance boundary

P1A is complete when preview state can be created, retrieved while active, lazily removed after expiry, and correlated with the exact dry-run contract while all existing P0 behavior remains non-mutating and the MCP tool list still contains only the P0 tools. Expired and never-existing identities are both unresolved after pruning.

## Out of scope

P1A does not implement native mutation, apply-time revalidation, `ast_edit_apply`, rollback, file locking, LSP, HTTP, persistence across process restart, or external coordination.

## Next batch dependency

P1B may begin only after the state model is stable enough that apply can consume it without changing the public preview contract again.
