# P1B — Guarded Apply Core

Status: Complete

## Goal

Implement the internal one-shot apply path that consumes P1A preview state, proves the reviewed mutation is still current, and only then enables native `astEdit(..., dryRun: false)`.

P1B remains an internal capability: it is tested directly but is not yet registered as an MCP tool.

## Preconditions

- P1A is complete and its preview-state contract is stable.
- Outstanding preview identities are process-local, bounded, and tied to immutable stored rewrite/target/options state.

## In scope

- atomically claim a ready preview so concurrent reuse cannot trigger duplicate mutation;
- revalidate workspace confinement and existence of the stored target scope;
- verify whole-file fingerprints for every file the original preview intended to modify;
- rerun the exact stored edit contract with `dryRun: true` immediately before apply;
- compare the fresh mutation plan with the stored reviewed plan so newly matching, removed, renamed, or otherwise changed mutation targets cause stale rejection;
- invoke native `astEdit(...)` with `dryRun: false` only after all preconditions pass;
- verify returned apply result/postconditions sufficiently to distinguish completed mutation from failure or uncertainty;
- define terminal preview lifecycle behavior: successful previews are consumed; stale or unknown-or-expired previews cannot be applied; a preview whose native apply begins and then fails or becomes uncertain must not be blindly reusable;
- add focused tests for unchanged success, byte drift, new matching files, removed/renamed targets, repeated use, concurrent claims, and native/apply failure semantics.

## Mutation-plan comparison

Directory scope may change between preview and apply even when originally touched files are unchanged. Revalidation must therefore compare the fresh dry-run mutation plan against the stored reviewed plan before enabling mutation.

The comparison should be based on deterministic mutation-relevant data rather than incidental presentation ordering. It must detect any change in the set of files/spans/replacements that would be written.

## Concurrency boundary

P1B must serialize or atomically claim application of one preview identity inside the process. It must not claim distributed or cross-process transactional guarantees that the underlying filesystem/native API does not provide.

There remains an unavoidable external TOCTOU interval between the final validation read/dry-run and native write unless the native/filesystem contract supplies a real compare-and-write primitive. Tests and documentation must not imply otherwise.

## Deliverables

- internal guarded apply function/service;
- stale-state and mutation-plan comparison logic;
- one-shot/concurrent claim lifecycle behavior;
- explicit success, stale/rejected, unknown-or-expired/already-used, native failure, and uncertain-apply result/error semantics;
- focused internal apply tests;
- no MCP registration yet.

## Acceptance boundary

P1B is complete when unchanged state mutates exactly the reviewed plan once, relevant drift is rejected before mutation, directory scope cannot expand silently, concurrent/repeated use cannot repeat mutation, and failure after entering native mutation leaves the preview terminal rather than retryable by default.

## Out of scope

P1B does not expose a new MCP tool, implement rollback/Git recovery, create distributed locks, persist state across restarts, add LSP, or modify external projects.

## Next batch dependency

P1C may begin only after the internal apply path and its failure semantics pass focused review.
