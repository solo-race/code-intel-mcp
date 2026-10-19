# P3-A — Provider Registry and Interface Investigation

Status: **Complete (investigation only).** Read-only. No registry entry, index,
permission, host config, or repository file was modified. Observed on 2026-09-15
on this workstation; version-scoped and not normative for other versions.

Scope: `docs/plans/04-p3-project-registration-resolver.md` unit P3-A, questions
1–9. Two provider records, the host launch-path finding, the adapter mechanics
decision, and the residual blockers.

Paths below are relative to the repository root unless marked as relative to
the user home or Windows installation directory. Observed absolute roots and
their identifying slug prefixes are omitted from this public record.

## Provider A — `codebase-memory-mcp` (observed 0.10.8)

**Registration source of truth.** There is no registry file. The store is one
SQLite database per project, `<cache>/<slug>.db`, and the single-row `projects`
table *is* the registration record:

```text
CREATE TABLE projects ( name TEXT PRIMARY KEY, indexed_at TEXT NOT NULL, root_path TEXT NOT NULL )
observed row (sanitized): [derived slug omitted] | 2026-09-14T16:48:38Z | .
```

Cache directory resolves as `CBM_CACHE_DIR`, else user-home-relative
`.cache/codebase-memory-mcp` (observed with `_config.db` and `logs/` beside the
per-project databases). Readers are the MCP server process, the
coordination daemon, and each one-shot `cli` invocation.

**Inspection interface (transport-free).** `codebase-memory-mcp cli --json
list_projects` exits 0 without an MCP handshake, without starting a standing
process, and returns the same project set as the MCP `list_projects` tool
(verified against this session's MCP mount). It emits the MCP tool-result
envelope `{content, structuredContent, isError}`. The positional raw-JSON form is
already deprecated in favour of flags, `--args-file <path>`, or stdin; the flags
form is documented by `cli list_projects --help`. Direct read of
`<cache>/<slug>.db:projects` is also available with no provider process at all.

**Recording interface.** `index_repository` only — `cli index_repository
--repo-path <string> [required] [--mode] [--target-projects] [--name]
[--persistence]`, or the MCP tool with `repo_path`. No register-only tool exists
in the 15-tool surface, no config key holds projects, and no `config` subcommand
touches them. The write is an upsert executed inside the index run:

```text
INSERT INTO projects (name, indexed_at, root_path) VALUES (?1, ?2, ?3)
  ON CONFLICT(name) DO UPDATE SET indexed_at=?2, root_path=?3;   -- label: upsert_project
```

**Registration is inseparable from indexing.** The minimum write path is a full
`index_repository` invocation. An already-indexed project takes an incremental
fast path (`incremental.noop`, `semantic_manifest_equal`) but still reports
`Project indexed.`; there is no call that records identity without the index
machinery. Provider-managed session behaviour includes `auto_index` and
`auto_watch`; these settings are stored in `_config.db`.

**Identity keying.** Key = derived slug (`name`, PRIMARY KEY) from the *full
absolute path*: drive colon removed, `/` and `\` → `-`, existing `-`/`_` and case
preserved (five observed pairs). For a fictional relative-path illustration,
the suffix `examples/Sample_Project` contributes `examples-Sample_Project` to
the derived slug; the absolute prefix and its slug prefix are omitted here.
`root_path` is a non-unique column stored in forward-slash form. `--name`
overrides the slug but is validated
(`invalid project name`). The exact rule for spaces, other punctuation,
non-ASCII encoding, and trailing separators was **not** confirmed; a bootstrap
that reproduces the slug inherits that unverified rule, so the safe probe is to
read `list_projects` and compare `root_path` rather than to compute a key.

**Permission model.** None. The schema has no permission/mode column and no
sidecar metadata. Read-only versus mutating exists only as MCP tool annotations,
`--tool-profile`, and `CBM_ALLOWED_ROOT`/`allow-root` indexing confinement — none
of which is per-project registration state. A "read-only registration" therefore
has no provider-side representation here.

**Idempotence and concurrency.** Re-registering an existing slug overwrites
`indexed_at`/`root_path` (upsert, never a duplicate and never an error). Mutations
are serialized per project by OS-backed locks in the rendezvous directory
(`%LOCALAPPDATA%\cbm-daemon-<key>`, `BEGIN IMMEDIATE`), reads are not. Publication
is WAL plus temp-file+rename behind an integrity gate; corruption is quarantined
(`<db>.corrupt.<gen>`) rather than silently replaced. All active processes must
run the same version, build, coordination ABI, and cache root, so conflicts fail
hard rather than degrade.

**Failure surface.** Exit 0 on success, 1 on failure. `--json` failures keep the
envelope shape with `isError: true` and `structuredContent.error` (observed:
`{"error":"unknown tool: nosuch_tool"}`). Not-found responses carry `hint` and
`available_projects`. No CLI-level timeout flag was observed; index-worker
timeouts exist but were not exercised. The read path makes no network request,
but the npm shim `bin.js` can trigger `install.js` — a GitHub Releases download —
if the native executable is missing or fails its `--version` probe, so invoking
through the `.cmd` shim inherits a network path.

**Version stability.** `cli` is documented first-class in the installed README,
but the interface is churning: the raw-JSON positional form is already
deprecated, and the installed 0.10.8 differs from upstream `main` docs
(`watcher_enabled` absent from the binary; tool counts differ). No schema-version
string is exposed for the `projects` table.

## Provider B — `gpt-repo-stdio` (gpt-repo-mcp, observed 0.2.0)

**Registration source of truth.** One JSON document, but the resolution differs
per process and this distinction decides which file a registration must land in:

| Process | Resolution order | When read | When nothing is bound |
| --- | --- | --- | --- |
| `connect-gpt` (the write path and `list\|check\|doctor`) | `--config` → `GPT_REPO_CONFIG` → `REPO_READER_CONFIG` → cwd-relative `./config.local.json` | per invocation | cwd-relative file |
| stdio MCP server (what the host launches) and `gpt-repo-local` | `GPT_REPO_CONFIG` → `REPO_READER_CONFIG` (env values resolved against cwd) → installed package-root `config.local.json` | once at startup / per invocation | package-root `config.local.json` |
| HTTP/streamable server | `GPT_REPO_CONFIG` → `REPO_READER_CONFIG` only | once at module load | **empty registry** |

The empty-registry path therefore belongs to the HTTP server alone, not to the
stdio server the host runs. The stdio server resolves its path once before
connecting and has no watcher or reload path, so a running stdio session never
observes a later registration — the resolver must register into the same file the
deployment's server resolves, or the write is invisible to it.

**Inspection interface (transport-free).** `gpt-repo-local invoke repo_list_roots`
with one JSON object (`{}`) written to stdin and stdin closed — an empty stdin is
a `VALIDATION_ERROR` exit 2, a piped-but-open stdin blocks — and
`connect-gpt list|check|doctor [--config <path>]`.
`repo_list_roots` is also exposed over MCP at the `default` tier. No MCP tool
records registration: `writeConfigAtomic` is reachable only from the
`connect-gpt add|remove` CLI.

**Recording interface.** `node dist/cli/connect-gpt.js add <abs-path>
[--mode read|write|ship] [--id <repo_id>] [--name <display_name>]
[--allow-non-git] [--config <path>]`. Non-interactive invocation defaults to
`read`; explicit `--mode read` is deterministic. Read mode writes exactly:

```json
{ "repo_id": "<slug>", "display_name": "<name|basename>", "root": "<realpath, Windows backslashes>",
  "writes": { "enabled": false }, "operations": { "enabled": false } }
```

**Registration-only, free of side effects.** Yes: `add` performs argument
validation, realpath, directory and `.git` checks, duplicate checks, and one
atomic config write. No indexing, watching, validation, or child process. The
repository's own index feature is a separate opt-in tool and configuration block.

**Identity keying.** `repo_id` = lowercased display name with `[^a-z0-9]+` → `-`,
edges trimmed (or an explicit `--id`); display name comes from the target's
`package.json` name, else the directory basename. Duplicate `repo_id` and
duplicate canonical root are both hard failures (exit 1, file untouched) — there
is **no idempotent "already registered" success**, so a caller must probe before
adding. Runtime lookup is exact, case-sensitive `repo_id` matching against
realpath-normalized roots; no tool resolves a repository by path.

**Write mechanics.** Whole-document rewrite: parse with a strict zod schema,
re-emit in schema key order with 2-space JSON and a trailing newline, temp file +
rename in the same directory, no lock, no backup, no compare-and-swap. Because
every object is strict, unknown keys abort the command instead of being dropped;
because the document is re-serialized from the parse output, pre-existing entries
gain materialized defaults and any non-canonical formatting is normalized. The
live `config.local.json` already matches that canonical form and round-trips
unchanged, but byte-exact preservation is **not** guaranteed in general.

**Failure surface.** Recording interface: success is exit 0 with five stdout
lines (`Added repo_id=…`, `mode=…`, `root=…`); failure is exit 1 with
`Error: <message>` on stderr, and the file is untouched because the write happens
after all checks. Missing config is not an error (defaults are used and the file
is created); malformed JSON or an unwritable target aborts without writing.
Probe interface `gpt-repo-local invoke <tool>`: exit 0 on success, exit 1 on a
tool error, exit 2 on a CLI/input error (for example empty stdin), with failures
emitted as an envelope on stdout
(`{"isError":true,"structuredContent":{"ok":false,"error":{"code":"VALIDATION_ERROR",…}}, "content":[…]}`)
— note `structuredContent.ok=false`, not a top-level `error` field, so an adapter
cannot read provider B and provider A envelopes the same way. Neither interface
implements a CLI-level timeout; the caller owns that boundary. `connect-gpt
list|check|doctor` exit 1 only when a check reports FAIL, and that exit code is
not exclusive to a config problem (doctor also fails on unrelated checks such as
a missing `package.json` in its cwd), so a config verdict must be read from the
specific `FAIL <name> missing` / `FAIL config unreadable: <message>` lines rather
than from the exit code; that check is also the read-only way to validate a
resolved config path before registering.

**Version stability.** 0.2.0, no config schema-version field; unknown fields are
rejected and schema changes are handled by migration, so the adapter must tolerate
strictness and cannot rely on forward-compatible documents.

## Host launch path for `code-intel-mcp`

**Finding: there is currently no launcher at all.** No MCP server, plugin, or
launcher entry outside the repository references this project. It appears nowhere
as an MCP server — not in user-home-relative `.codex/config.toml`, not as a
plugin-provided server, not in any project-scope MCP
file (`.omp/mcp.json`, `mcp.json`, `.mcp.json` — none exist in the repository or
its parents), and not as an npm bin shim. The name does occur elsewhere by
design: as a *repository* entry in gpt-repo-mcp's registry
(`repo_id: code-intel-mcp`, which routes `repo_*` tool calls), as a project row in
the `codebase-memory-mcp` store, and in OMP session state — none of which is a
launcher. The only observed starts are the documented manual command
`bun run index.ts --workspace-root <path>` and the test harness spawning
`index.ts`.

One surface could not be checked in this environment and is therefore unverified
rather than excluded: Windows scheduled tasks (`schtasks`, PowerShell
`Get-ScheduledTask`, and a read of Windows-installation-relative
`System32/Tasks` each fail with EPERM in this sandbox). Nothing else observed
points at such a task, and no
launcher artifact exists in the repository to register one.

Host surfaces that exist for registering a server, all install-time rather than
pre-start hooks: OMP-native config (project `.omp/mcp.json`, user-home-relative
`.omp/agent/mcp.json`, root `mcp.json`/`.mcp.json`), imports of Codex
user-home-relative `.codex/config.toml` `[mcp_servers.*]`, plugin packaging
(a Codex plugin's `plugin.json` may point at `./.mcp.json`), and repository-owned launcher wrappers
(gpt-repo-mcp's PowerShell + Scheduled Task autostart). No generic
"before MCP servers start" hook exists; the closest per-server mechanism is OMP's
`!command` env/header resolution, which runs immediately before one server is
launched and is limited to env/header values.

## Adapter mechanics decision

| Provider | Probe | Register | Rationale |
| --- | --- | --- | --- |
| `codebase-memory-mcp` | `cli --json list_projects --limit 100` with `--offset` pages until `has_more` is false (flags/`--args-file`/stdin form), match `root_path` against the canonical root; never compute the slug, never answer from a truncated page | `cli index_repository --repo-path <canonical-root>` — **subject to blocker B1** | Provider-owned enumeration avoids the unconfirmed slug rule; both calls are transport-free and leave no standing process |
| `gpt-repo-stdio` | `gpt-repo-local invoke repo_list_roots`, match `root` against the canonical root, tolerating the provider's own comparison | `connect-gpt add <canonical-root> --mode read --config <path resolved the way the deployed server resolves it>` | Documented CLI, deterministic non-interactive read mode, atomic single write, no side effects beyond the entry; the explicit `--config` keeps registration and the server's own resolution pointing at one file |

Both interfaces are process-local CLI invocations: no sibling MCP transport, no
startup cycle, no dependency on another server being up. Probes rely on the
providers' own path comparison and never reproduce provider key derivation.
`register` is invoked only after a probe answered "not registered", because
neither provider offers an idempotent already-registered success path. The
`gpt-repo-stdio` registration path must resolve the config file the same way the
deployed server does (env bindings first, then the package-root fallback), or the
entry lands in a document the running server never reads.

Mutation timing relative to the host: registering with `gpt-repo-stdio` is worth
little to a session whose stdio server is already running (it reads the config
once), and the `codebase-memory-mcp` store is re-read per call, so ordering
constraints differ per provider. This is an input to P3-E/F, not a P3-A decision.

## Startup dependency review (gate item 2)

- No sibling MCP server needs to be running: both probe and register paths are
  local CLI invocations over provider-owned on-disk state.
- No startup cycle: `code-intel-mcp` neither waits for nor is waited on by
  either provider.
- Residual coupling to record for P3-E: the `codebase-memory-mcp` npm shim can
  attempt a network download when its native binary is missing, and all active
  codebase-memory processes must share one version/build/cache root, so a
  conflicting process fails these calls hard. Both are provider-side conditions
  the resolver must map to `failed`/`unavailable` under the non-blocking policy.

## Blockers requiring an upstream decision

**B1 — `codebase-memory-mcp` has no registration-only path; registration ⇒ indexing.**
**Decided (2026-09-15): probe-only.** Bootstrap never calls `index_repository`.
The provider A adapter exposes a probe and no register operation, the report
records the provider's actual state (`registered` / `not-registered` with
`permission: "not-applicable"`), and an unregistered project is left to the
operator, the agent, or the provider's own `auto_index` behaviour. This keeps
`code-intel-mcp` free of index triggering, matches the architecture non-goal that
bootstrap never indexes, and avoids an unbounded startup action. The `unsupported`
taxonomy entry is therefore not reachable for provider A in v1; it stays reserved.

**B2 — no host launch path exists for `code-intel-mcp`.**
**Decided (2026-09-15): a global host MCP entry plus a cwd-injecting wrapper.**
The wrapper resolves the session workspace root and passes it as
`--workspace-root`, so no per-project config file is needed and the existing
single-argument startup contract is unchanged. The wrapper's own contract (stdout
is protocol-only, stdio is passed through, the resolved root is the session
workspace) belongs to P3-E.

## Unknowns explicitly not guessed

- The exact slug rule of `codebase-memory-mcp` for spaces, punctuation, non-ASCII,
  and trailing separators (probe-by-enumeration avoids it).
- Same-slug/different-root collision behaviour for `codebase-memory-mcp`
  (deduced from SQL only, not triggered).
- Whether a running `codebase-memory-mcp` session observes a project file created
  after it started (deduced from per-call directory enumeration).
- CLI exit codes and timing for a failed `index_repository`, and any CLI-level
  timeout.
- Whether the deployed `dist/cli/connect-gpt.js` bundle matches current
  `gpt-repo-mcp` source (bundle inspected only at its head; no build run).
- Windows realpath case canonicalization for `gpt-repo-stdio`'s duplicate-root
  comparison (read from code, not executed).
- Provenance of individual entries in the live `config.local.json`.

## Gate status

| Entry-gate item | Status |
| --- | --- |
| 1. Source of truth + deterministic non-MCP interface per provider | Met for inspection on both providers; registration interface confirmed for `gpt-repo-stdio`, and confirmed to be index-coupled for `codebase-memory-mcp` (B1) |
| 2. Startup dependency review passed | Passed — no sibling MCP transport, no cycle, no start-order assumption |
| 3. P3-B and P3-C written and reviewed | Met — `04b` and `04c`, reviewed with all findings resolved |
| 4. Host launch path identified | Met — decision B2: `scripts/mcp-launch.mjs` plus the `code_intel_mcp` host entry |
