# P1 — Guarded AST Mutation

Status: Complete

## Goal

Add safe structural AST mutation without allowing callers to bypass or outlive the reviewed preview state established by P0.

P1 introduces `ast_edit_apply` as a state-bound continuation of `ast_edit_preview`, not as an independent pattern/replacement mutation endpoint.

## Preconditions

- P0 is complete and committed.
- `ast_edit_preview`, workspace-root confinement, structured MCP results, and directory scan-cache freshness are stable.
- `@oh-my-pi/pi-natives` remains pinned exactly to `18.0.3`.

## Safety model

P1 uses optimistic state validation rather than pretending to provide a filesystem transaction. Apply must bind to the exact preview contract, reject relevant state drift before mutation, and make uncertainty explicit if native mutation begins but cannot be proven complete.

For directory-scoped previews, checking only files that matched during the original preview is insufficient: a new or changed file may become a match before apply. Apply therefore needs both reviewed-file byte/state binding and a fresh dry-run mutation-plan comparison before enabling native mutation.

A preview identity must be opaque, process-local, bounded, and non-reusable after terminal apply handling. Apply accepts the preview identity only; fresh patterns, replacements, paths, globs, or mutation options must not bypass preview review.

## Execution decomposition

P1 is implemented in three ordered batches:

1. [`01a-p1-preview-state-contract.md`](01a-p1-preview-state-contract.md) — establish preview identity and bounded process-local state without exposing any mutation path.
2. [`01b-p1-guarded-apply-core.md`](01b-p1-guarded-apply-core.md) — implement internal apply/revalidation semantics and lifecycle transitions, still without MCP exposure.
3. [`01c-p1-mcp-integration-and-hardening.md`](01c-p1-mcp-integration-and-hardening.md) — expose `ast_edit_apply`, add real stdio/concurrency/failure coverage, and close documentation.

Each batch requires its own focused validation and review before the next begins. P1 is not complete until all three are complete.

## Stage-wide deliverables

- preview identity/state contract;
- bounded process-local preview registry;
- byte/state and fresh mutation-plan revalidation;
- `ast_edit_apply` MCP tool accepting only preview identity;
- unknown-or-expired / stale / already-used / apply-failure semantics;
- native apply path guarded by validated preview state;
- focused unit, state-drift, concurrency, and real stdio integration tests;
- documentation updates for the settled preview/apply contract and known concurrency boundary.

## Acceptance boundary

P1 is complete when an unchanged reviewed preview can be applied once, relevant target or mutation-plan drift is rejected before mutation, directory scope cannot silently expand to newly matching files, repeated or concurrent reuse of one preview cannot cause repeated mutation, workspace confinement remains enforced, and native/apply uncertainty is distinguishable from success and stale rejection.

## Out of scope

P1 does not introduce LSP, rename/code actions, remote transport, background indexing, cross-process orchestration, general undo history, Git rollback, distributed locking, repository governance, or changes to external runtime projects.

P1 also does not claim perfect atomicity against an unrelated external process modifying files in the final interval between revalidation and native write; that residual TOCTOU boundary must be documented rather than hidden behind unsupported transactional claims.

## Next stage dependency

P2 may begin only after P1C has closed the public read/preview/apply contract and the P1 plan is marked Complete.
