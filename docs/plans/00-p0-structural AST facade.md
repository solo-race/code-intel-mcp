# P0 — Structural AST Facade

Status: Complete

## Goal

Establish `code-intel-mcp` as a functional local MCP runtime that exposes deterministic structural AST intelligence directly to Codex through a bounded stdio interface.

P0 is the first production-facing slice of the project. It turns the already-verified native `astGrep(...)` and `astEdit(..., dryRun: true)` capabilities from `@oh-my-pi/pi-natives@18.0.3` into stable MCP tool contracts without introducing mutation apply semantics or LSP.

## Preconditions

- `@oh-my-pi/pi-natives` remains pinned exactly to `18.0.3`.
- Native `astGrep` and `astEdit` loading has already been verified in the current Windows + Bun environment.
- `AGENTS.md` and `docs/architecture.md` remain authoritative for repository rules and durable architecture.

## In scope

P0 provides exactly two code-intelligence tools:

- `ast_search` for structural AST search;
- `ast_edit_preview` for dry-run structural rewrite preview.

P0 also establishes the common MCP/runtime boundary required by both tools:

- one explicit workspace root bound at server startup;
- canonical workspace-root confinement for every user-supplied target path;
- structured MCP success results that retain useful native result data;
- clear tool-level failure reporting;
- explicit duplicate rewrite-pattern rejection before conversion to native `Record<string, string>` rewrites;
- stdio transport suitable for local Codex integration;
- focused unit and real stdio integration tests.

`ast_search` must directly map its structural pattern to `astGrep(...)` with metadata enabled. `ast_edit_preview` must directly map validated rewrite operations to `astEdit(...)` with `dryRun: true` fixed by the server.

## Safety and contract boundaries

Workspace root is server-owned configuration, not a tool-call authorization parameter. User paths must not escape the configured root through relative traversal, absolute outside paths, path-prefix tricks, or canonicalized indirection.

P0 exposes no apply path and no caller-controlled `dryRun` switch. Preview must not modify target source files.

Native structured output should be preserved where practical instead of being reduced to human prose. Input validation belongs at the MCP boundary; native failures must not be disguised as successful tool results.

## Deliverables

- functional local stdio MCP server entry point;
- `ast_search` MCP tool;
- `ast_edit_preview` MCP tool;
- reusable workspace confinement utility;
- focused tests for tool contracts, error cases, boundary enforcement, and dry-run safety;
- real stdio MCP integration coverage proving tool discovery and structured results;
- minimal README update reflecting the now-operational P0 surface.

## Acceptance boundary

P0 is complete when Codex-compatible stdio MCP interaction can discover and invoke exactly the two P0 tools, workspace escapes are rejected, search metadata remains observable, duplicate rewrite patterns are rejected, preview cannot perform mutation, and final focused validation passes against the integrated worktree.

## Out of scope

P0 does not include `ast_edit_apply`, preview persistence/state, stale-file detection, rollback/recovery, LSP, OMP agent integration, changes to `omp-bridge`, `gpt-repo-mcp`, or `global-skill-set`, remote/network transport, authentication, multi-workspace serving, indexing/watchers, CI/CD, publishing, or telemetry.

## Next stage dependency

P1 may begin only after the P0 preview contract, workspace confinement, and structured result behavior are stable enough to serve as the mutation safety boundary.
