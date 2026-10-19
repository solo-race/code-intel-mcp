# P4-D/E — Provider Bootstrap Retirement and Diagnosable Agent Use

Status: **SEALED; A–E accepted; C-NET-01 and E3-01 RESOLVED. C/D PHASE_ACCEPTED is unchanged; E PHASE_ACCEPTED by final major E reviewer PASS with no findings after independent retained-evidence VALIDATION_PASS. Prior DE4 validation remains historical; F not executed.**

D1 implementation record: legacy startup no longer invokes provider bootstrap;
the provider-only source and tests are retired without an optional replacement.
Startup/stdio tests cover global serving, explicit-root serving, and the
session-cwd launcher in non-Git fixtures, with separate provider-absence and
marker/store nonmutation cases. These tests have not been run by the implementer;
validation belongs to the external tester. The five-tool and AST authority
contracts are unchanged. C's earlier ConnectionRefused and local/private-proxy
limitations are superseded for C acceptance by the user-supplied fresh-install
receipt, independent post-install checks, and reviewer PASS recorded below.
No independent agent registry download or tarball-provenance check is claimed.
E1 doctor and E2 metadata/audit retain their prior validation as recorded below.
D is `PHASE_ACCEPTED` because its prior mechanical/source review remains valid
and the sole inherited C-NET-01 block is resolved. E is `PHASE_ACCEPTED` after
the E3 follow-up recorded below; F has not been executed. P4 is not complete.

### Bounded implementation and acceptance record

The records below are supplied independent evidence, not validation performed
by the documentation implementer. Original D/E baseline user commit:
`8098507bb8a445073fccf47b413b6553a799b327`; C follow-up baseline:
`2aeb5e781976480e0f2d5ca1eedef20e0ab99efc`. Historical A–C acceptance and
the 186-test result in 05a remain historical. Repository paths below are relative to the repository root; host executable paths are relative to the user home. Evidence locations are relative to `AppData/Local/CodexRepoCaches/code-intel-mcp/` under that home; private session identifiers are omitted. Recorded runtime invocations used absolute paths.

| Unit | Current evidence and limitation |
| --- | --- |
| C / C-NET-01 | RESOLVED; C PHASE_ACCEPTED by reviewer PASS. User-performed fresh normal-registry empty-cache frozen installation and ordinary Bun integrity checks succeeded: 22 packages, 5.71 seconds, exit 0. Independent post-install validation: 38 passed, 0 failed, 342 assertions, no skips; all 22 versions match the lockfile and actual dependency resolutions stay inside the fresh installed tree. Receipt and agent-observed checks are separated below; no independent agent registry download is claimed. |
| D1 | Bootstrap caller, implementation, and exclusive tests retired; global, fixed-root, and cwd-launcher coverage passed. D-FIX-02 isolates native/Bun runtime caches outside the protected fixture via supported XDG/Bun environment settings. Entire fixture HOME/source/config/provider/bin/cwd trees and bytes, including the unrelated HOME sentinel, remain protected without snapshot exclusions. Independent targeted run: 9 passed, 0 failed, 183 expectations, 4.96 seconds; no skips. D is PHASE_ACCEPTED: the reviewer confirmed its prior mechanical/source review remains valid and its sole inherited C-NET-01 block is resolved. |
| E1 | Independent focused run at 16:50Z: 59 passed, 0 failed, 1936 assertions, 32.61 seconds. Evidence: `e1-validation-20261018T164937Z-31963f06`. Final regression passed; the single major review found no concrete source defects. E1 is mechanically ready. |
| E2 | Independent focused run: 11 passed, 0 failed, 2359 expectations, 3.92 seconds. Evidence: `e2-validation-20261018T164035Z`. Final regression and integrated typecheck passed; the single major review confirmed metadata/audit correctness within scope. E2 is mechanically ready. |
| E3 / E3-01 | RESOLVED. The user-terminal native Codex run recorded exactly one model-selected `ast_search`, the expected unique fixture result, and a fresh successful audit event. Independent retained-evidence validation passed; preservation attestations and owned-process cleanup provenance are distinguished below. Final major E reviewer PASS accepted E with no findings. |
| DE4 | Prior final integration full suite: 203 passed, 0 failed, 5586 expectations, 47.90 seconds; no skips. Explicit native CODE_INTEL_TEST_CODEX enabled the real isolated Codex configuration/returned-launch-argv integration, which passed. Typecheck exited 0 with no diagnostics at 17:15:09.552–17:15:11.455Z. The initial major D/E review at 17:20Z returned BLOCK for C-NET-01 and E3-01, with no concrete source defects. Subsequent C and E follow-up PASS results resolved both blocks and accepted C/D/E. These integration checks were not rerun for either follow-up. The final major E reviewer explicitly permitted this bounded documentation-only factual cleanup without another review. |
| F | Not executed. |

Final validation evidence: `round2-cde-20261019/final-after-dfix02-20261018T1712Z/`
contains `target-result.json`, `full-result.json`, `typecheck-result.json`, and
their `*-output-head.txt` / `*-output-tail.txt` logs. These supplied results
supersede earlier pending-fixture and unstarted-regression records. All 54
selected repository paths compared by the tester were unchanged; that prior
check did not complete the interrupted E3 comparison. The initial major
D/E reviewer was Einstein; its
C follow-up PASS supersedes the earlier inherited C block and accepts C/D.

**C follow-up evidence:** User-supplied screenshot evidence records the exact
manual fresh empty-cache normal-registry frozen-lockfile installation: 22
packages, 5.71 seconds, exit 0, in
`manual-install-b14cd730553848c2b87032db4b80cbdb`.
The ordinary Bun frozen-install/integrity checks were performed by the user;
the agent did not repeat or independently observe that registry download.

Hume's independent post-install report is
`c-followup-20261019/C-followup-result.md`
(`focused-tests-result.json`, `module-resolution-output.txt`, and
`stable-entry-checks.json` provide bounded supporting evidence). Its result is
VALIDATION_PASS: 38 passed, 0 failed, 342 assertions, no skips. All 22 installed
versions match the lockfile and actual resolutions remain inside the fresh
dependencies. Stable CLI MCP exposed exactly five tools and served a successful
AST read; isolated real Codex configuration integration passed. Selected
source/config/provider preservation and fixture/process cleanup passed.
Dependency metadata was preserved; binary contents were not independently
byte-compared. No model-selected adoption was established by that C check.
Einstein's follow-up
PASS resolved C-NET-01 and accepted C/D, confirming 51 relevant paths match the
prior reviewed state. At that point E1/E2 were ready and E remained blocked
solely on E3-01; the E follow-up below supersedes that status.

Implemented E1 interface: `doctor --host codex [--config path]`, with read-only
selected configuration and safe structured stages. Built-in preflight precedes
dependency-backed imports and preserves C-01's no-install contract. Separate
disposable cwd/workspace fixtures check explicit-root AST results; request and
initialize limits are 10 seconds within a 30-second probe deadline, followed
by two-second graceful cleanup before owned-child termination. Sandbox/approval
remains `unknown` without trustworthy evidence.

Implemented E2 opt-in: `CODE_INTEL_AUDIT=stderr`, or `file` plus
`CODE_INTEL_AUDIT_FILE` selecting a new file under an existing parent (`wx`).
Default is off; ordinary installer entries remain unchanged. Events contain
only `timestamp`, `tool`, and `resultCategory`, with the sealed 512-byte
newline-inclusive/event, 256-event, and 128-KiB/process limits. Search is
read-only/idempotent; previews are read-only/non-idempotent; apply is
destructive/non-read-only/non-idempotent. All declare `openWorldHint: false`.

**Historical E3 failed-step record (superseded for acceptance):** The first PowerShell runner encountered a
case-insensitive `WS_PROXY` name collision, corrected only in that runner.
The Bun retry was blocked under the local/private-address execution policy
for `ab.chatgpt.com`; DNS resolution was not established. No native PID, native exit status, host tool-call
record, or audit capture was obtained in that attempt. Its process cleanup remains
unverified because
CIM inspection was denied. Fixture bytes were unchanged and the fixture was
deleted at 16:58:22Z; the full repository/live-config byte comparison was
interrupted and remains unverified for that attempt. Validation did not read or copy authentication
files and did not request live configuration writes. Bounded peer records are in
`round2-cde-20261019/`
(`E1-result.md`, `E2-result.md`, `E3-result.md`, `C-network-result.md`).

**E3 follow-up and final E acceptance:** Evidence source: `launched-native-cli`.
The user-terminal native Codex run
ran on 2026-10-19 from 02:11:40.352Z to 02:11:55.692Z (15.340 seconds),
with host exit 0 and no timeout. Its invocation-only entry launched absolute
Bun through a transparent owned wrapper to
`scripts/code-intel.mjs serve`.
Exactly one actual model-selected `ast_search` used public arguments
`pattern: console.log($ARG)`, `path: sample.ts`, and an explicit fresh fixture
`workspaceRoot`, distinct from the host cwd and installation. It returned the
expected unique sentinel match. The fresh run-specific `audit.jsonl` records
`ast_search` / `success` at 2026-10-19T02:11:50.148Z.

The evidence directory is the run subdirectory under
`e3-followup-20261019/` (private run identifier omitted).
`E3-terminal-result.md`, `run.json`, `host-records.jsonl`, `audit.jsonl`, and
`invocation.json` retain the receipt, native call/result, audit, and exact argv.
The wrapper's child command uses user-relative `.bun/bin/bun.exe` with
repository-relative `scripts/code-intel.mjs serve`.

The runner reports in-run direct-byte preservation of the selected config,
all 69 tracked repository files, both fixture trees/sources, and unchanged
HEAD/status. Its exact-owned-PID check records that the host, wrapper, and
server all exited at 02:11:55.518Z, before the 02:12:00.505Z cleanup
deadline; both fixtures were then removed. Original before-snapshot bytes were
not retained. Independent tester Mencius
returned `VALIDATION_PASS` after inspecting retained host/invocation/audit and
cleanup evidence and the runner's comparison logic. The tester independently
observed the clean repository at HEAD `f622e1dda107f59e818718a9ac782f2fa0bd0507`
and fixture removal; it did not read live configuration or repeat the historical
byte comparisons. Preservation booleans remain runner attestations supported by
inspected logic, not independent after-run byte re-comparisons. The independent
packet is `E3-evidence-verification.md` in the evidence directory's parent.

Final major E reviewer Russell
returned PASS: E `PHASE_ACCEPTED`, E3-01 resolved, no findings, and explicitly
permitted this bounded factual documentation cleanup without another review.
C/D acceptance is unchanged; A–E are accepted. The prior 203-pass suite and
exit-0 typecheck were not rerun for this follow-up. F remains unexecuted;
P4 completion is not claimed.

## Objective and phase sequence

Complete P4-D and P4-E while preserving accepted A–C installation, workspace-routing, and AST safety contracts:

- Retire implicit provider bootstrap from global and legacy startup.
- Implement a read-only, staged Codex doctor.
- Add concise tool metadata and explicitly bounded, opt-in auditing.
- Capture an actual Codex-selected AST call against the fresh implementation.

Preserve the master sequence **A → B → C → D → E → F**. The C and E follow-ups have been reconciled and A–E are accepted as recorded above. F’s broader restrictive-sandbox and adoption matrix remains outstanding.

## Evidence, decisions, and assumptions

### Supplied evidence at sealing

This table preserves the plan's supplied evidence at sealing; it does not claim fresh repository inspection or validation. Current acceptance and superseding follow-up evidence are recorded above.

| Evidence | Planning consequence |
| --- | --- |
| `README.md:153` and `docs/plans/05a-p4-abc-execution-plan.md:539` recorded A–C acceptance and 186 passing tests. At sealing, fresh registry/tarball identity was unverified; `05a:550` records earlier provenance. | Preserve historical results; C-NET-01 is now resolved by the separately recorded user receipt, independent post-install checks, and reviewer PASS. |
| `05a:7` excludes D/E/F; `05a:114` preserves bootstrap only until D. | Bootstrap retirement belongs in this phase. |
| `index.ts:31` invokes bootstrap through legacy `startServer`; global startup at line 63 does not. `scripts/mcp-launch.mjs:9` uses legacy startup. | Both entry paths require verification. |
| `src/bootstrap/resolver.ts:16` and `providers.ts:606` contain provider probing/registration. | Retire their runtime facility and exclusive tests. |
| `src/cli/main.ts:5` has no doctor; `tests/cli.test.ts:59` expects rejection. | Add doctor and replace the obsolete expectation. |
| `src/cli/host-entry.ts:3` owns absolute launch arguments; `codex-config.ts:89` reads/validates configuration. | Reuse existing contracts while avoiding installer mutation paths. |
| `src/server.ts:77` registers the five tools without the proposed annotations/auditing. | Extend metadata and observability without expanding the tool surface. |
| Existing routing/CLI tests provide fixtures; `cli-codex-integration.test.ts:19` reuses repository dependencies and an SDK handshake. | Reuse deterministic fixtures, but obtain separate fresh-package and real-agent evidence. |

### Decisions and explicit assumptions

- No downstream requirement for optional provider synchronization has been evidenced. **Retire bootstrap; do not build a replacement integration facility.**
- Preserve legacy explicit-root AST behavior and its fallback launcher while removing provider side effects.
- Reuse the installed MCP SDK, TOML parser, and existing configuration helpers. Exact helper signatures and installed Codex CLI capabilities require targeted implementation-time inspection.
- The supplied deadline does not relax acceptance gates. Missing evidence remains missing.
- Existing dirty paths and concurrent peer work remain under their owners. Do not overwrite, reset, stage, or commit unrelated changes.

## Scope and invariant contracts

Keep `@oh-my-pi/pi-natives` pinned exactly to `18.0.3`. Add no dependencies, OMP agent glue, MCP tools, provider registration, indexing, live host-config writes, or automatic package installation.

Preserve:

- Exactly `ast_search`, `ast_edit_preview`, `ast_transform_preview`, `ast_transform_plan_preview`, and `ast_edit_apply`.
- Required absolute `workspaceRoot` for global search/preview requests.
- Apply input containing only `previewId`, with immutable canonical workspace/target authority from the reviewed preview.
- Preview source nonmutation, confinement, expiration, replay protection, stale-state rejection, postconditions, and terminal uncertainty semantics.
- Accepted installer ownership, dry-run, reconciliation, uninstall, and configuration-preservation contracts.

Doctor’s fixtures and explicitly opted-in audit artifacts are permitted local writes. Inspected configuration, provider state, installation contents, and fixture source files must remain unchanged.

## Work order and ownership

| Unit | Dependency | Bounded outcome |
| --- | --- | --- |
| Entry checkpoint | Parallel C peer result | Record fresh-package evidence or its precise unresolved limitation |
| D1 | Entry checkpoint reconciliation | Retire bootstrap and verify both startup paths |
| E1 | D1 | Read-only staged doctor |
| E2 | D1 | Metadata and bounded audit implementation |
| E3 | E1 and E2 | Actual model-selected AST call with trustworthy audit capture |
| DE4 | Implementation and available evidence | Normative documentation, integration validation, independent review |

E1 and E2 are functionally independent; sequence them if needed to avoid shared-file conflicts. The supervisor owns coordination and acceptance. The designated documentation implementer materializes this plan; implementation workers own their assigned changes; an independent reviewer seals the result.

An unresolved C gate prevents an unqualified sequential-completion claim. Do not substitute earlier cached provenance for the peer’s fresh verification.

## D1 — Retire provider bootstrap

**Files:** `index.ts`, `scripts/mcp-launch.mjs`, `src/bootstrap/`, and existing bootstrap launcher, startup-stdio, resolver, and report tests. Inspect only direct references necessary for retirement.

**Implementation:**

1. Remove bootstrap invocation from legacy startup and remaining runtime imports/exports.
2. Delete provider bootstrap source and tests whose sole contract is probing, registration, or bootstrap reporting.
3. Retain or adapt startup/stdio and fixed-root tests covering behavior that survives retirement.
4. Preserve global and legacy explicit-root startup. Neither may require providers, Git, provider configuration, registration, or indexing.
5. Record the migration in current documentation without rewriting historical P3 evidence.

**Acceptance and validation:**

- Launch global and legacy modes in non-Git fixtures with provider CLIs and Git unavailable and `GPT_REPO_CONFIG`/`REPO_READER_CONFIG` unset.
- Complete initialization, exact catalog discovery, and a successful AST read through both modes.
- Separately use fixture marker executables/stores to detect provider invocation or writes. Compare fixture contents and directory entries before/after; no hashes are needed.
- Verify source fixtures remain unchanged and stdout contains only MCP protocol output.
- Confirm no surviving runtime reference invokes retired bootstrap.

**Exit:** Both startup modes serve AST requests without provider dependencies or provider-owned state changes.

## E1 — Implement read-only doctor

**Files:** `src/cli/main.ts`, `src/cli/host-entry.ts`, `src/cli/codex-config.ts`, proposed `src/cli/doctor.ts`, `tests/cli.test.ts`, and focused doctor tests.

### Entry and preflight

Implement `code-intel doctor --host codex`.

Reuse the existing selected-config path mechanism. If none exists, add one explicit doctor config-path selector for operator-selected configuration and fixtures; do not inspect or modify unrelated hosts.

Preserve C-01:

- Run local runtime/dependency preflight **before dynamically importing dependency-backed doctor modules**.
- Keep the preflight path free of imports that would fail before it can report missing dependencies.
- Return a structured missing-dependency result.
- Never invoke installation, package download, or a package-manager fallback.

Missing configuration remains absent. Malformed configuration remains unchanged. Neither case creates configuration files or parent directories.

### Structured stages

Each stage returns an identifier, `pass`/`fail`/`skipped`/`unknown`, a stable reason category, and concise safe detail. Dependent stages are skipped after failure.

| Stage | Required distinctions |
| --- | --- |
| Local prerequisites | Available dependencies versus missing runtime/dependency |
| Selected configuration | Missing file, malformed configuration, missing/disabled owned entry, usable entry |
| Executable | Absolute executable and valid launch arguments versus missing configured runtime or invalid launch specification |
| Spawn | Started child versus spawn failure |
| Initialize | Successful MCP handshake versus error or timeout |
| Catalog | Exact five expected names versus missing, extra, or duplicate names |
| Fixture read | Expected AST result versus tool error, incorrect result, or timeout |
| Root binding | Explicit fixture root honored versus fixed/install-directory/cwd binding or unresolved ambiguity |
| Sandbox/approval | Trustworthy host evidence where available; otherwise `unknown` |

Do not print raw configuration or environment contents. Use read-only configuration helpers, never the mutating installer.

### Probe and lifecycle

- Spawn the selected entry using its absolute executable and argument array, without shell reconstruction.
- Use the existing MCP SDK for initialization, discovery, and `ast_search`.
- Create distinct disposable child-cwd and workspace fixtures, separate from the installation directory, with distinguishable structural content.
- Supply the explicit absolute fixture workspace and assert its expected result.
- Diagnose fixed-root launch arguments and observed wrong-root results; do not infer correct root binding from handshake success.
- Use a 10-second initialization/request limit and a 30-second overall probe limit.
- In `finally`, close transport and child resources. Allow a two-second graceful shutdown, then terminate the owned child and report any cleanup failure.
- Remove disposable fixtures after process cleanup.

### Validation and exit

Cover missing dependencies before import failure; no auto-install; absent/malformed config without writes; missing/disabled entry; missing configured runtime; spawn failure; failed/timed-out handshake; catalog mismatch; healthy and failed reads; incorrect-root response; and cleanup/timeouts.

Assert byte-for-byte selected-config preservation and unchanged fixture sources. Report sandbox/approval as `unknown` unless actual evidence supports a narrower statement.

**Exit:** Doctor distinguishes installation, process, protocol, and read-call health while making no adoption or unsupported sandbox claim.

## E2 — Tool metadata and bounded opt-in audit

**Files:** `src/server.ts`, a small audit helper if needed, and focused registration/audit tests.

### Metadata

Use supported MCP annotations accurately:

- Search explains its structural matching use and explicit workspace requirement.
- Preview descriptions explain source nonmutation and preview-before-apply.
- Apply describes reviewed-ID-only guarded mutation and is not marked safely repeatable.
- Preserve schemas, structured results, and the exact five-tool catalog.

### Audit contract

Audit is disabled by default. Caller environment or invocation-specific overrides enable it. **Do not add audit environment settings to ordinary installer-generated entries.**

Define bounded audit as:

- One JSON event for each completed tool request until the budget is exhausted.
- Maximum **512 UTF-8 bytes per event, including its newline**.
- Maximum **256 events and 128 KiB total audit output per server process**.
- Fields limited to timestamp, tool name, and fixed result category: `success`, `tool_error`, or `internal_error`.
- Returned tool errors count as errors even when the handler does not throw.
- No arguments, roots, source, prompts, previews, IDs, raw exceptions, stack traces, or result payloads.
- Stop emission at the cap without affecting tool execution. No rotation, buffering framework, hashes, or additional overflow events. Missing events after exhaustion do not prove absence of use.

Support stderr as the normal destination. Also support an explicitly selected local audit path for isolated acceptance:

- Use existing runtime filesystem facilities.
- Require an existing parent directory and exclusively create a new file.
- Never overwrite an existing artifact.
- Apply the same event/byte caps.
- Surface destination failure safely; it cannot count as successful capture or change AST execution semantics.

Never emit audit records on MCP stdout.

### Validation and exit

Test default-off behavior, success/returned-error/thrown-error classification, exactly one event per eligible request, event and aggregate caps, and local-file creation/failure behavior.

Use sentinel source, preview, argument, and exception content to verify exclusion. Confirm protocol stdout remains valid with auditing enabled and ordinary installer output contains no added audit settings.

**Exit:** Requests can be observed through bounded, content-free events without changing tool contracts or stdio behavior.

## E3 — Actual Codex-selected AST call

**Scope:** One bounded real-host smoke task against the fresh implementation. An SDK call or `tools/list` cannot satisfy this gate.

### Invocation strategy

1. Inspect only installed native Codex version and relevant CLI help to establish supported noninteractive execution and invocation-specific configuration overrides.
2. Use legitimate native-host authentication. Do not read or copy authentication files, tokens, or credentials.
3. Launch the actual native Codex client in a disposable non-Git fixture workspace. Point its invocation-specific MCP entry at the fresh absolute runtime/launcher and enable audit only for that invocation.
4. Where supported, disable unrelated MCP entries for the invocation. Persist no host configuration and do not bypass approval or sandbox policy.
5. Establish one trustworthy capture route:
   - Verified host stderr capture or a disposable transparent launcher preserving protocol stdin/stdout; or
   - A fresh explicit local audit file selected through invocation-only environment overrides.
6. Ask the model to use this server’s `ast_search` to find a specified structural pattern under the explicit fixture root.
7. Capture the host record showing model tool selection and expected result, plus the successful fresh audit event.
8. Verify fixture sources and selected configuration remain unchanged, close owned processes, and remove disposable fixtures.

Bound the host task to three minutes and cleanup to a short explicit deadline. Timeout does not establish adoption.

### Evidence requirements

Record:

- Evidence source: `launched-native-cli` or `current-native-host`.
- Fresh implementation executable/arguments and run window.
- Dedicated audit destination and successful `ast_search` event.
- Host execution evidence identifying the selected tool and expected fixture result.
- Nonmutation and cleanup outcomes.

Do not retain credentials or unnecessary transcript content. An audit event alone does not identify the initiating client; pair it with the host run.

The current native host is acceptable only when it demonstrably uses the fresh implementation and newly captures its actual model-selected call. A stale session/server does not qualify.

**Exit:** An actual Codex model selected `ast_search`, received the expected fixture result, and produced trustworthy fresh audit evidence without source leakage.

If authentication, reload, capture, approval, CLI capability, or another external constraint prevents this, record the exact failed step and evidence. **E remains acceptance-blocked; do not downgrade the gate to SDK success.**

## DE4 — Documentation, validation, and review

**Files:** `README.md`, `docs/architecture.md`, `docs/plans/05-global-mcp-installation-and-workspace-routing.md`, this plan, and necessary P3 cross-references.

Update documentation by responsibility:

- **README:** actual doctor usage, audit opt-in/caps, provider-independent startup, and retained explicit-root fallback.
- **Architecture:** retired bootstrap boundary, read-only doctor, audit data limits, and preserved AST authority.
- **Master plan:** replace stale blanket “planning only” status with actual per-phase status; retain C’s evidence limitation until resolved; link this plan; record D retirement, E’s mandatory host-call gate, and incomplete F.
- **P3 history:** add a concise retirement/migration reference without changing historical implementation or test results.

Keep temporary debugging commands and transcripts out of normative documentation. Record bounded acceptance evidence and limitations in the phase record.

Run focused checks during implementation. At integration, run existing relevant type/build checks and the full test suite once using repository scripts and installed dependencies. Report actual commands/results; “186 passing” remains historical unless independently reproduced.

The independent reviewer checks scope, bootstrap retirement, preserved AST/installer contracts, diagnostic classifications, audit bounds, evidence provenance, and documentation accuracy.

## Final acceptance

**D accepted only when:**

- Global and legacy startup/read checks pass without providers, Git, provider configuration, or registration.
- Retired bootstrap cannot execute.
- No provider state or fixture source changes occur.

**E accepted only when:**

- Preflight preserves C-01 and missing/malformed configuration causes no creation or mutation.
- Doctor’s stage/failure distinctions, root-binding checks, timeouts, and cleanup pass.
- Metadata and bounded audit checks pass; protocol stdout stays clean.
- A real Codex-selected AST call has fresh, trustworthy audit evidence.
- Relevant regression checks and independent review pass.

Record C’s fresh-package result separately. Leave F incomplete. No outcome of this plan alone permits a “P4 complete” claim.

## Material risks

| Risk | Required response |
| --- | --- |
| Bootstrap retirement breaks legacy launch | Preserve explicit-root startup and AST regression coverage. |
| Dependency import fails before doctor can diagnose it | Keep preflight ahead of dependency-backed imports. |
| Doctor mutates selected configuration | Use read-only helpers and test absent/malformed inputs for nonmutation. |
| Healthy handshake hides incorrect workspace binding | Assert results from distinct cwd/workspace fixtures. |
| Audit leaks content or grows without bound | Fixed fields, byte/event caps, sentinel tests, and protocol validation. |
| Stale runtime or ambiguous capture produces false adoption evidence | Tie host execution and fresh audit artifact to the actual implementation. |
| External host limitation prevents E acceptance | Record the blocker and completed work separately; retain the mandatory gate. |
