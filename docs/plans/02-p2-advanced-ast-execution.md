# P2 — Advanced AST Execution

Status: **P2-A through P2-E complete by their gates; upstream final review
pending**. P2-A, P2-B, P2-C, and P2-D1 are implemented with the evidence anchors
named below, and the P2-E external validation matrix has passed.

## Goal and boundaries

Extend explicit AST transformations into ordered multi-file previews, data-only migration recipes, and structural postcondition checks. Every mutation continues through the existing P1 preview registry and `ast_edit_apply(previewId)`; P2 does not create a second mutation authority.

P0 and P1 are complete. Their workspace confinement, duplicate-pattern rejection, immutable reviewed contracts, stale-state detection, replay protection, process-local expiry/capacity, and terminal apply uncertainty remain binding. The exact `@oh-my-pi/pi-natives` pin stays at `18.0.3`; deterministic AST operations use its native primitives directly.

`codebase-memory-mcp` supplies understanding and explicit targets/rationale; `code-intel-mcp` owns structural execution and mutation verification; `gpt-repo-stdio` owns repository diff/review, allowlisted tests/build/typecheck, commit, and recovery. The agent carries the handoff. Neither external MCP is a runtime dependency of this project. `symbolRefs` remain opaque metadata, never lookup instructions or proof of semantic equivalence.

All units exclude implicit target discovery, indexing, semantic retrieval/resolution, LSP, generic file writers, Git operations, model/agent execution, cross-preview transactions, rollback, retry-all, and cross-process preview persistence. Repository validation is a separate completion gate, not an execution-layer postcondition. P1's existing directory/glob rewrite contract remains distinct from P2's explicit single-file steps.

## Delivery order

| Unit | Objective | Dependencies | Status |
| --- | --- | --- | --- |
| P2-A | Explicit single-file transformation preview | P1 | Complete |
| P2-B | Ordered multi-file plan and dry-run previews | P2-A and P1 | Implemented |
| P2-C | Data-only migration materialization into P2-B | P2-B | Implemented |
| P2-D1 | Frozen explicit structural postconditions | P1 and P2-A/B; propagate through P2-C | Implemented |
| P2-E | Focused coverage, documentation, external validation closure | P2-B/C/D1 | Complete — gates passed |

B, C, and D1 landed in that order, each with focused tests named in its unit
section; E closed integration and documentation over those implementations and
ran the external validation matrix. The shapes below are the implemented data
contracts. There is still no batch apply API: plan and recipe application
remains sequential `ast_edit_apply` orchestration.

## P2-A — Completed single-file facade

**Objective and contract.** `ast_transform_preview` is one current MCP tool alongside `ast_search`, `ast_edit_preview`, `ast_transform_plan_preview`, and `ast_edit_apply`. It accepts exactly one repository-relative `path`, existing AST `operations`, non-empty `rationale`, at least one non-empty opaque `symbolRefs` string, optional `failOnParseError`, and the optional frozen `verification` descriptor added by P2-D1.

**Invariants and sequencing.** Validate an existing regular file inside the canonical workspace before delegating to the P1 preview path. Reject absolute paths, parent traversal, missing files, directories, workspace escapes, globs, and file lists. Trim rationale/references while preserving reference order and duplicates. Reuse operation validation, duplicate-pattern rejection, mutation-plan normalization, and preview capture. Freeze normalized transformation metadata with the reviewed contract.

**Output and failures.** Return the native dry-run result, normalized `transformation` metadata, and an independent process-local `previewId`; zero matches return `previewId: null`. Successful existing guarded apply returns the stored metadata. P1 stale, replay, expiry, concurrent-apply, and uncertain-state semantics apply unchanged. This facade neither resolves symbols nor introduces a new lifecycle.

**Acceptance and completion evidence.** Existing focused coverage includes the input boundary, metadata, no-write preview, preview lifecycle, and stdio surface. Implementation anchors are `src/ast/transformation-plan.ts`, the shared P1 preview/apply modules, and `src/server.ts`; relevant coverage includes `tests/ast-transformation-preview.test.ts` and `tests/guarded-apply.test.ts`. P2-E must retain these regressions. P2-A completion does not establish completion of the remaining units.

## P2-B — Ordered explicit multi-file planning

**Objective.** Preview a caller-ordered list of independent single-file transformations with different operations and rationale per file.

**Input contract.** Accept a non-empty ordered `steps` array. Each step reuses all P2-A fields without plan-level overrides:

```text
{
  steps: [
    { path, operations, rationale, symbolRefs, failOnParseError? },
    ...
  ]
}
```

Each target is an explicit repository-relative existing regular file. Each operation list uses the existing validator, including duplicate-pattern rejection. Do not introduce glob, directory, implicit file-list expansion, symbol resolution, or a dependency between one step's rewrite and a prior step's output. Reject duplicate canonical targets, including alternate spellings such as `a.ts` and `./a.ts`; multiple rewrites for one file belong in that file's operation list.

**Sequencing and invariants.**

1. Validate the whole envelope and every step's fields, normalize metadata, resolve every target through the existing workspace boundary, and reject duplicate canonical targets. This preflight also covers every D1 verification descriptor and its assertion targets. Any invalid input/target fails before the first native preview and creates no preview IDs.
2. Preserve caller order; do not sort steps by path. Run each step through the P2-A/P1 dry-run machinery in that order. Preserve P1 native-plan validation, including overlapping-edit rejection. Native-result failures are preview failures, distinct from input preflight.
3. Return ordered step results with a stable zero-based `stepIndex`, normalized target/metadata, native structured dry-run result, touched paths, and that step's `previewId`. Each non-empty step has its own identity; zero-match steps have a null identity and consume no active preview state.

Equal inputs and source bytes must yield equal normalized ordered plans, excluding opaque IDs and other existing lifecycle metadata. Planning never writes source files. Reuse `runAstTransformationPreview`, `capturePreviewState`, `PreviewRegistry`, and `guardedAstEditApply`; do not change native edit options or create an aggregate registry record/preview identity.

**Failure and partial-result contract.** If native preview or preview registration fails after earlier steps have completed, stop previewing later steps. Surface the underlying failure with its `stepIndex`, the completed ordered step results/IDs, and the later indexes not attempted. Do not claim that a complete plan exists or hide already-created independent IDs. Earlier IDs retain their ordinary P1 lifetime; this is no source mutation and requires no transaction or rollback. The caller reviews a complete successful plan before consuming its identities; the runtime performs no automatic plan application.

Application is caller-side orchestration of existing `ast_edit_apply` calls, one non-null ID at a time in supplied order; the runtime adds no plan-level apply entry point. Record each step's index, ID, structured success/error, and whether it was skipped for zero matches or not attempted. These are reporting outcomes, not new registry states. On an apply error stop automatic continuation, retaining the error's existing meaning:

- `STALE_PREVIEW` means the affected step did not write; earlier successful steps remain applied.
- `APPLY_STATE_UNCERTAIN` means mutation may have occurred; the affected preview remains terminal `failed_uncertain`, and later steps are not automatically applied.
- Replay, expiry, and concurrent claims keep their existing codes. `PRE_APPLY_VALIDATION_FAILED` retains P1's retry-safe `ready` behavior, but does not trigger automatic retry or retry-all.

There is no aggregate apply endpoint, transaction, rollback, or sequence-level success authority. Partial apply is an expected observable outcome. Later unconsumed IDs retain normal P1 state and need review before any resumed application; repository reconciliation belongs to `gpt-repo-stdio`.

**Acceptance tests.**

- Two distinct targets with different operations preserve caller order, yield independent IDs, and remain byte-identical after preview; swapping input order swaps result order without hidden sorting.
- Invalid fields or a bad target in the last step reject the whole input before native preview/registration. Cover absolute, traversal, missing, directory, and outside-workspace targets plus duplicate canonical targets and duplicate patterns.
- A zero-match step returns null while matching siblings retain independent IDs. Native-plan ambiguity and registry/preview failure after an earlier successful preview expose completed IDs and not-attempted indexes without writes.
- Sequential application touches only each addressed file. A later stale or uncertain step stops continuation, preserves earlier success, and exposes partial results. Replay, expiry, and concurrent-apply behavior remain P1 behavior per ID.

**Completion evidence.** Implemented in `src/ast/transformation-plan.ts` (`astTransformationPlanInputSchema`, `prepareAstTransformationPlan`, `runAstTransformationPlanPreview`) and exposed as the `ast_transform_plan_preview` tool, which returns the ordered `steps`/`results` payload or an `isError` payload carrying the normalized `steps`, `stepIndex`, `completedResults`, `notAttemptedStepIndexes`, and the underlying failure code/message. Focused coverage is `tests/ast-transformation-plan.test.ts` (order preservation, independent identities, no writes, all-input preflight, zero-match steps, registry failure exposing completed IDs, ambiguity, stale/uncertain partial apply) together with the five-tool stdio surface in `tests/mcp-stdio.test.ts`. P2-E must retain these regressions and still owes the external validation matrix.

## P2-C — Ordered migration materialization

**Objective and input.** Represent a reusable migration as data-only ordered steps. A recipe uses `{ steps: [...] }` with the same fully explicit per-step fields as B, including per-step rationale, opaque references, and D1's optional verification descriptor. Reuse means submitting the explicit recipe against a workspace; it does not imply parameter expansion, recipe discovery, a registry, or executable templates.

**Output and sequencing.** Materialize the recipe into the B input without changing step order or inferring targets/operations. Pass the entire materialized plan through B's full preflight and preview path. Return the materialized ordered steps and their B preview results/independent IDs so the caller can trace every preview to its recipe index. Identical recipe data and source bytes yield identical normalized steps/plans, apart from existing opaque lifecycle values.

**Invariants and non-goals.** Recipes contain no callbacks, shell commands, scripts, model prompts, hidden discovery, Git, or LSP actions. No second validator, mutation lifecycle, batch apply mechanism, or runtime dependency on an understanding/repository-control server is introduced. Duplicate canonical targets remain invalid; recipes cannot chain repeated transformations of one target through multiple independent previews.

**Failure and partial apply.** Invalid recipe data fails before preview identities are issued. Native preview failure uses B's ordered partial-preview reporting. Apply remains sequential existing `ast_edit_apply` consumption with B's stop-on-error and observable partial-apply semantics; successful steps remain applied. There is no transaction, rollback, or retry-all. Diff/review, tests/build/typecheck, commit, and recovery are subsequent `gpt-repo-stdio` work carried by the orchestrator.

**Acceptance tests.** Materialize a two-file recipe deterministically and preserve indexes, targets, operations, rationale, and reference order/duplicates. Reject executable/unrecognized recipe fields and invalid later steps before any preview. Verify duplicate-target rejection, zero-match handling, independent IDs, and a mid-sequence stale/uncertain result with later steps not attempted. Verification declarations are preserved through materialization.

**Completion evidence.** Implemented as the thin named surface `materializeAstMigrationRecipe` (`prepareAstTransformationPlan`) and `runAstMigrationRecipePreview` (`runAstTransformationPlanPreview`) with the `AstMigrationRecipe` type alias in `src/ast/migration-recipe.ts`; the module defines no recipe tool, validator, lifecycle, or discovery. Focused coverage is `tests/ast-migration-recipe.test.ts` (deterministic ordered materialization, rejection of executable/unknown fields and invalid later steps before native preview, zero-match passthrough, P1 partial apply when a later step is stale, and passthrough of B's partial-preview failure with retained identities). P2-E must retain these regressions and still owes the external validation matrix.

## P2-D1 — Explicit structural postconditions

**Objective and input.** Add an optional frozen verification descriptor to each transformation step, including the P2-A facade and the B/C step contracts. The first version accepts only:

```text
verification: {
  postconditions: [
    {
      kind: "ast_match_count",
      pattern: explicit non-empty structural AST pattern,
      expectedCount: non-negative integer,
      path?: repository-relative existing regular file
    },
    ...
  ]
}
```

An omitted assertion `path` defaults to the current step's target in A, B, and C. An explicit path is validated/canonicalized under the same regular-file/workspace boundary; it is a read-only verification target and grants no mutation authority. Preserve declaration order. Assertions describe the state immediately after that step applies, not an implied final state after later steps. There are no globs, inferred paths, min/max predicates, additional assertion kinds, semantic/type checks, compiler invocations, LSP, repository gates, or Git hooks.

**Preflight and frozen contract.** Validate the descriptor shape, supported kind, pattern, integer count, and every assertion target before native preview. Reject unexpected fields and invalid descriptors with no preview ID; B/C preflight all steps before any preview. An omitted descriptor adds no checks; an empty postcondition array adds none. Copy/freeze the normalized ordered descriptor with the reviewed preview contract and return it in the preview for review. Caller mutation of the original objects must not change apply behavior. `ast_edit_apply` still accepts only `previewId`; no fresh verification inputs can be supplied at apply time.

**Apply sequencing and output.** Keep all existing claim, target/fingerprint, fresh dry-run, native apply, applied-plan comparison, and exact-byte post-state checks. Only after the applied-plan and exact-byte checks pass, evaluate the stored assertions in declaration order using native structural matching on their explicit canonical files. Establish the complete match count rather than the length of a truncated result page. Revalidate verification-path confinement before reading it; inability to establish the check after mutation is uncertainty, not success.

On success, add structured `verification` evidence with `status: "passed"` and ordered entries containing `path`, `kind`, `pattern`, `expectedCount`, and `actualCount`, then mark the preview `succeeded`. For a requested empty array the evidence contains an empty results array; absent verification preserves existing output behavior. A zero-match preview still returns null and never runs apply-time postconditions.

**Failures and partial apply.** A count mismatch after mutation reuses `APPLY_STATE_UNCERTAIN` and terminal `failed_uncertain`. Return structured assertion evidence identifying the mismatching index/path and expected/actual count. Preserve completed check results and identify checks not evaluated if evaluation cannot continue. A search/read failure after mutation uses the same terminal uncertainty, with available evidence and its cause. Do not add an error code or lifecycle state, make the ID retryable, undo the mutation, or cause later steps to be applied automatically. Earlier successful B/C steps remain applied.

Existing stale and retry-safe pre-apply errors retain their P1 semantics and run neither native mutation nor postconditions. Existing applied-plan or exact-byte post-state failures precede these checks and remain terminal uncertainty. Passing structural assertions proves only those explicit counts at evaluation time; it does not establish semantic correctness or replace repository validation.

**Acceptance tests.**

- Reject invalid kind, empty/invalid pattern, negative/fractional count, unexpected fields, and invalid assertion targets before native preview; issue no ID, including when the bad descriptor is in a later B/C step.
- Cover omitted paths defaulting to the owning step in A/B/C, explicit confined assertion paths, declaration order, empty/omitted descriptors, and defensive copying/freezing of caller-owned arrays/objects.
- A matching count yields ordered actual/expected evidence and normal `succeeded` state; count enough matches to detect accidental pagination truncation.
- A post-mutation mismatch or evaluation failure yields `APPLY_STATE_UNCERTAIN`, terminal `failed_uncertain`, retained source for review, and no automatic continuation. Reapplying that identity retains terminal uncertainty.
- Stale pre-state/fresh-plan failure, retry-safe pre-apply failure, and applied-plan/exact-byte failure prevent postcondition evaluation. Zero-match previews remain no-write/null-ID results with no check execution.

**Completion evidence.** Implemented across `src/ast/transformation-plan.ts` (`verificationInputSchema`, `normalizeVerification`, which canonicalizes and defaults assertion paths during preflight), `src/ast/preview-registry.ts` (`PreviewPostcondition`, `PreviewVerification`, `freezeVerification`, `VerificationPassed`/`VerificationFailed`, and the optional `verification` payload on `ApplyStateUncertainError`), `src/ast/verification.ts` (`verifyStructuralPostconditions`, the native count path), and `src/ast/guarded-apply.ts`, whose order is claim, target/fingerprint revalidation, fresh dry-run, native apply, applied-plan comparison, exact-byte post-state, then assertions, before `markSucceeded`. The `ast_edit_apply` tool returns the passed evidence in its success payload and the failure evidence in the `isError` structured content. Focused coverage is `tests/ast-verification.test.ts` (descriptor preflight, defaulted and explicit assertion targets, declaration order and empty descriptors, freeze/copy semantics, evaluation after mutation, count mismatch and search failure as terminal uncertainty, and skipped evaluation on pre-apply failure), with the `ast_edit_apply` wire-level behavior retained in `tests/mcp-apply-stdio.test.ts`; P2-E must retain them and still owes the external validation matrix.

## P2-E — Integration, documentation, and validation closure

**Objective and input/output.** Consume implemented B/C/D1 changes and their focused evidence. Produce a reviewed implementation with passing required validation and documentation that distinguishes implemented contracts from deferred capabilities. E adds no transformation inputs, mutation authority, or runtime verification hook.

**Sequencing and invariants.** Retain the five current tools' existing accepted inputs/results and P1 meanings for callers not opting into the new contracts. Cover B/C/D1 together: order, duplicate canonical targets, all-input preflight, independent IDs, zero matches, partial preview/apply reporting, stale/replay/expiry/concurrency/uncertainty, and verification success/mismatch/invalid input. Existing directory/glob P1 behavior and duplicate-pattern/overlap rejection remain regression requirements. `README.md`, `docs/architecture.md`, and this plan's unit statuses are updated for the implemented B/C/D1 surface; the focused coverage those units name is the starting point for E's combined regression run.

Validation is delegated externally through repository control: run typecheck, focused and full tests, the existing native smoke check, `repo_validate`, and `gpt-repo-stdio` repository diff/review. Use existing allowlisted gates; do not invent commands or add unrelated dependencies. Build gates, where configured, remain repository-control work. Record actual commands/gates, outcomes, and unresolved findings in the completion handoff rather than adding routine command history to long-lived documentation.

**Failure semantics and non-goals.** A failing or unavailable required gate leaves the affected unit/E incomplete with the concrete blocker recorded. Do not reinterpret failed verification as success or use repository recovery as an execution-layer rollback. E does not authorize runtime Git, commits, architectural expansion, LSP, or semantic discovery.

**Acceptance and completion evidence.** Required evidence is a passing focused/regression test matrix, typecheck/test/smoke and repository validation results, reviewed diff with findings resolved or explicitly bounded, and accurate public documentation. Only after B/C/D1/E meet these gates may P2 overall be marked complete. These gates now pass: typecheck is clean; the focused matrix (`tests/ast-transformation-preview.test.ts`, `tests/ast-transformation-plan.test.ts`, `tests/ast-migration-recipe.test.ts`, `tests/ast-verification.test.ts`) and the full suite (86 tests across 12 files) pass; the native smoke check passes; the repository validation profile `all` reports 3/3 commands passed; and the reviewed diff's one finding — a duplicated operations validation in the facade — was resolved before the gates were re-run. `README.md` and `docs/architecture.md` were updated to the implemented five-tool surface.

## Later-stage gate

Only demonstrated gaps beyond explicit AST execution may justify a separate semantic/LSP evaluation after P2. This plan does not implement or authorize that later capability.
