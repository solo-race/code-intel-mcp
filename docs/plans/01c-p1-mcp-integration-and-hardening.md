# P1C — MCP Integration and Hardening

Status: Complete

## Goal

Expose the reviewed P1B apply capability through MCP, prove the complete preview-to-apply lifecycle over real stdio, and close the public P1 contract without broadening the mutation surface.

## Preconditions

- P1A preview state is stable.
- P1B guarded apply passes internal success, stale-state, concurrency, and failure tests.

## In scope

- register exactly one new MCP tool: `ast_edit_apply`;
- accept only an opaque preview identity as apply input;
- reject fresh pattern, replacement, path, glob, dry-run, or mutation-option fields at the MCP boundary;
- preserve structured success output and machine-distinguishable tool errors;
- cover the full lifecycle with a real stdio client: preview -> apply -> source changed as reviewed;
- prove stale rejection for byte changes and for directory-scope expansion such as a newly matching file;
- prove repeated/concurrent reuse cannot cause a second mutation;
- prove unknown-or-expired/terminal preview identities fail clearly;
- retain protocol-clean stdout and the P0 workspace boundary;
- update README, architecture, and P1 plan statuses only after final validation.

## Public contract boundary

At P1 completion the MCP tool surface becomes:

```text
ast_search
ast_edit_preview
ast_edit_apply
```

`ast_edit_apply` is not a second edit API. It is a continuation token consumer. Its public input must not allow callers to reconstruct or override the stored mutation contract.

## Failure semantics

The public MCP layer must distinguish at least `UNKNOWN_OR_EXPIRED_PREVIEW` (for unknown, expired, or restart-invalidated identities), stale preview, already-used/in-progress preview, native apply failure, and uncertain/postcondition failure. Errors must not be returned as normal success payloads; there is no separate `EXPIRED_PREVIEW` category.

No automatic rollback is introduced. If native mutation begins and completion cannot be established, the error must communicate uncertainty and the preview must remain terminal.

## Deliverables

- `ast_edit_apply` MCP registration and schema;
- real stdio preview/apply integration coverage;
- negative tests for stale scope, repeated/concurrent apply, unknown/expired identity, and forbidden fresh mutation fields;
- final test/typecheck/smoke validation;
- README/architecture updates reflecting the settled P1 surface and residual external TOCTOU boundary;
- parent P1 and P1A/P1B/P1C statuses updated only when their acceptance gates actually pass.

## Acceptance boundary

P1C is complete when the real stdio server exposes exactly three tools, a reviewed preview applies once through `ast_edit_apply`, stale or broadened scope cannot mutate, replay/concurrent reuse cannot duplicate mutation, failures remain explicit, and all P0 guarantees remain intact.

## Out of scope

P1C does not add rollback, Git integration, LSP, HTTP/auth, persistence, remote coordination, general mutation history, background workers, or changes to external repositories.
