# Later — LSP Mutation Evaluation

Status: Deferred

## Goal

Evaluate concrete semantic or LSP capability gaps beyond the Deterministic AST Execution Layer after P2, and determine whether selected LSP mutation capabilities justify an additional execution surface.

This is an evaluation gate, not a commitment to implement LSP mutation.

## Preconditions

- P0, P1, and P2 are complete and used enough to expose real capability gaps.
- P1 preview, stale-state, and apply-uncertainty contracts remain the safety baseline.
- Concrete workflows demonstrate that understanding-layer handoff plus P2 AST execution is insufficient; any read-only LSP evidence used in that assessment is identified explicitly.

`P3 — Deterministic Project Registration Bootstrap`
([`04-p3-project-registration-resolver.md`](04-p3-project-registration-resolver.md))
is independent of this evaluation: it is startup control-plane work with no LSP,
semantic, or mutation surface, and it neither gates nor is gated by any candidate
evaluated here. Neither plan reorders the other.

## In scope

Evaluate candidate LSP mutation capabilities such as:

- rename;
- file rename;
- code actions;
- other workspace-edit-producing semantic operations only when backed by a concrete use case.

For each candidate, compare:

- semantic value unavailable from understanding-layer evidence plus P2 AST execution;
- correctness advantages over a transformation compiled to AST preview, guarded apply, and verification;
- mutation scope and workspace-edit behavior;
- preview/review requirements;
- stale-state and concurrency risks;
- language-server variability;
- testing and recovery cost;
- whether the new surface duplicates an existing capability without enough benefit.

## Decision boundary

A candidate proceeds to a separate implementation plan only if the evaluation demonstrates a concrete workflow benefit that justifies its additional mutation and recovery surface.

Any proposal must preserve the separation between Knowledge/Understanding (`codebase-memory-mcp`), Execution (`code-intel-mcp`), and Repository Control (`gpt-repo-stdio`). Source semantic changes continue to prefer the AST execution workflow; the evaluation does not establish native source writes as a parallel main workflow.

The default outcome is to retain the existing architecture unless evidence supports expansion.

## Deliverables

- evidence-backed capability comparison;
- explicit go/no-go decision for each evaluated mutation class;
- architecture update only if a new mutation surface is approved;
- a new bounded implementation plan for any approved capability.

## Out of scope

This stage does not implement LSP support, rename, code actions, workspace edits, or other mutation. It does not add indexing, semantic retrieval, generic writers, or broaden transport, repository control, agent orchestration, or global skill responsibilities.
