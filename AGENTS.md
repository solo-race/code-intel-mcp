# AGENTS.md

This file defines repository-local rules for Codex and other implementation agents working in `code-intel-mcp`.

## Start here

Before changing code, read `README.md` for current project state and `docs/architecture.md` for normative architecture and component boundaries. Read files under `docs/plans/` only when the active task refers to that plan.

## Scope and change discipline

Keep changes limited to the requested capability. Prefer targeted reads, searches, edits, and tests over broad repository inspection. Do not add speculative infrastructure, CI, abstractions, compatibility layers, or documentation that does not change an implementation decision.

`README.md` is the developer-facing project entry point. `docs/architecture.md` owns durable architecture, responsibility boundaries, and safety contracts. `docs/plans/` owns bounded implementation plans. Update the owning document when code makes it inaccurate rather than duplicating the same rule across documents.

Do not stage or commit changes unless the task explicitly requests it.

## Technical constraints

- Keep `@oh-my-pi/pi-natives` pinned exactly to `18.0.3` unless an explicit compatibility task changes that decision.
- Use `pi-natives` directly for AST primitives; do not route deterministic AST operations through `omp-bridge`, `omp_run`, or an OMP agent.
- Do not import OMP agent/session/TUI glue merely to reuse AST or LSP behavior.
- Preserve structured native results where practical instead of flattening them into prose.
- Treat workspace-root confinement as a hard boundary for user-provided paths.
- Reject duplicate AST rewrite patterns explicitly; do not allow `Record<string, string>` construction to overwrite them silently.
- Keep mutation preview-first. P1 apply behavior must revalidate reviewed file state before mutation.
- LSP work begins read-only. Rename, file rename, code actions, and other LSP mutations remain deferred until separately justified.

If OMP source is copied or substantially adapted, preserve the applicable MIT attribution and license notice.

## Validation

During implementation, run the smallest relevant checks first. Add focused tests for new contracts and failure cases. For AST mutation work, verify dry-run behavior does not modify source files and verify boundary/stale-state failures explicitly. Do not upgrade or install unrelated dependencies as part of validation.
