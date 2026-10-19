# P3-B — Canonical Identity and Provider Path Contract

Status: **Specification.** No conversion or comparison code exists. This document
is the contract P3-C's adapters and P3-D's resolver must implement; it depends on
the evidence in
[`04a-p3-a-provider-interface-investigation.md`](04a-p3-a-provider-interface-investigation.md).

## 1. Canonical identity

```text
identity = (await Workspace.create(rootInput)).root
```

The existing startup canonicalization is the identity source: lexical acceptance
of the supplied root, `realpath`, and an existing-directory check, with the
current fail-fast error codes unchanged. Confinement stays where it is today —
in per-target resolution, not in identity. Identity is computed once per process
start and is never re-derived later in the process.

Not identity sources, for either provider: git remote or discovered repository
root, directory basename, `package.json` name, provider-derived slug,
provider `repo_id`, host project key or trust entry, branch, or working-tree
state. A provider key may be *reported* by an adapter but never used as another
provider's identity or as the resolver's identity.

## 2. Projection: argument passing plus comparison, never a stored key

Projection is defined as the *transformations the resolver applies to the
canonical identity when calling a provider and when comparing a provider-reported
root*. It is deliberately not "compute the string the provider would store".

| Provider | Probe input | Registration input | Comparison basis | Rule |
| --- | --- | --- | --- | --- |
| `codebase-memory-mcp` | none — enumerate provider-reported projects | canonical identity passed as `--repo-path` | provider-reported `root_path` | The resolver never computes the provider slug and never pre-writes registry state. The provider canonicalizes and derives its own `name`; its derived rule is unconfirmed, so it must not be reproduced. |
| `gpt-repo-stdio` | none — enumerate provider-reported roots | canonical identity passed as the `add` path argument | provider-reported `root` | The provider realpaths the target itself at `add` time and persists its own spelling (observed Windows backslash form). The resolver must not write its own spelling. |

Rationale: both providers project paths internally — one via realpath before slug
derivation, the other via realpath at add time and at registry load. Duplicating
that projection in the resolver would create a second, unverified implementation
of a provider rule and a second source of truth for identity.

## 3. Comparison rule

For "is this project registered with provider P", the resolver compares each
provider-reported root with the canonical identity:

1. Reject empties and values that are not absolute in either the POSIX or the
   drive/UNC sense → that entry cannot be compared.
2. Unify separators (`\` → `/`).
3. Strip a trailing separator, except at a volume root.
4. Compare case-insensitively on Windows; case-sensitively elsewhere. Both
   providers canonicalize with `realpath`, but Windows `realpath` does not
   reliably fold case, so the resolver folds it for comparison only.
5. **Step 4 equal → `registered`.**
6. **Step 4 unequal, and both sides resolve with `realpath` to the same target →
   `registered`.** This is the only filesystem use this contract permits, and it
   is the same read-only resolution the workspace layer already performs. It is a
   positive signal only and never forces a negative answer: Windows `realpath`
   resolves junctions, but it does not expand 8.3 short names (a short name stays
   short), so an unequal realpath result proves nothing on its own.
7. **Otherwise evaluate the syntactic predicates**, independently of whether the
   sides resolve — exactly one side is a UNC path (`//host/share/...`); one side
   is POSIX-absolute while the other is drive-absolute; either side contains
   `//wsl.localhost/` or `//wsl$/`; or a segment on exactly one side matches the
   8.3 shape `NAME~n` while the corresponding segment on the other side does not
   **and every other segment is already equal after steps 2–4**, so the predicate
   fires only when the entry differs from the identity at that one position.
   A `NAME~n`-shaped segment in a non-candidate entry (other segments differ)
   matches nothing and falls to step 8. Any predicate match → `indeterminate`.
8. **Otherwise → `not-registered`**, whether or not the sides resolve. An
   unresolved pair that matches no predicate is still two different absolute paths
   in the same namespace with no remaining equivalence candidate, and answering
   `indeterminate` for every unreadable path would hide genuine differences.

Steps 5–8 are total, and their order matters: an unequal result can never reach
`not-registered` before both the realpath signal and the equivalence predicates
have been excluded. No step requires a write.

The comparison is read-only: it never rewrites a provider entry, never respells a
stored root, and never "repairs" a spelling difference. An entry that differs
only by a comparison-equivalent spelling **is** registered, and the resolver then
performs no write at all.

### 3.1 Aggregating per-entry comparisons into one provider state

A probe compares every provider-reported entry against the identity with the
pairwise rule above, then aggregates in this precedence:

1. **Any entry compares `registered` → provider state `registered`.** A match
   wins outright; remaining entries are not consulted for the decision.
2. **Else, any entry compares `indeterminate` for a candidate entry** — an entry
   whose other segments are equal after steps 2–4, so the ambiguity is confined
   to a single position, which in this contract means an 8.3 short name against
   its long form → provider state `indeterminate`. This is the case where the
   entry plausibly *is* this project and writing would risk a duplicate.
3. **Else, entries compared `indeterminate` only through a cross-form predicate**
   (UNC, WSL, or drive-relative value against a differently-formed identity) are
   recorded in the probe detail as `alias-candidates`, and the provider state
   falls through to `not-registered`. Namespace-level alias relationships —
   a mapped drive standing for a UNC share, a WSL mount standing for a Windows
   path — are outside this contract's decidable set, and treating them as
   `indeterminate` would make the provider permanently unresolvable for every
   project in any registry that holds one such entry.
4. **Else → provider state `not-registered`.** Entries that cannot be compared at
   all (empty or relative provider values) are recorded in the detail as
   uncomparable and do not by themselves make the provider indeterminate.

Accepted residual risk of rule 3: if a project is genuinely already registered
under an alias spelling, the probe answers `not-registered` and a second entry can
be created; the `alias-candidates` detail makes that visible in the bootstrap
report. The alternative — blocking registration for every project whenever any
alias-form entry exists — was rejected because it silently disables the capability
in exactly the mixed registries that exist in practice. Resolving alias forms is
an explicit non-goal (section 5), not an oversight.

Consequently a WSL-UNC entry in a Windows registry, or a UNC entry beside drive
roots, leaves unrelated probes decidable, while an ambiguity confined to one
segment of a candidate entry still blocks the write.

## 4. Decided and undecided cases

Two levels are distinguished: the **pairwise** result of comparing one provider
entry with the identity (section 3), and the **provider state** the probe reports
after aggregation (section 3.1). The provider column assumes no other entry
matched.

| Case | Pairwise result | Provider state | Detected by |
| --- | --- | --- | --- |
| Same path, same spelling | registered | registered | step 4 |
| Same path, alternate separators (`D:\x` vs `D:/x`) | registered | registered | steps 2–4 |
| Same path, case-only difference | registered | registered | step 4 |
| Same path with a trailing separator | registered | registered | step 3 |
| Root reached through a symlink or junction, same target | registered | registered | step 6 |
| Root reached through a symlink or junction, different target | not-registered | not-registered | step 8 (no predicate covers symlink targets, and no symlink rewriting is implemented) |
| 8.3 short name versus long name, other segments equal | indeterminate (candidate) | indeterminate | step 7 |
| `NAME~n`-shaped segment in a non-candidate entry | not-registered | not-registered | step 7 (predicate requires other segments to match), step 8 |
| Nested project inside a registered project's root | not-registered for the parent comparison; the nested root is probed on its own | registered only if the nested root itself matches | steps 4–8 |
| UNC path versus a mapped drive for the same share | indeterminate (cross-form) | not-registered, listed as `alias-candidate` | step 7, aggregation rule 3 |
| WSL `\\wsl.localhost\<distro>\...` versus the in-distro path | indeterminate (cross-form) | not-registered, listed as `alias-candidate` | step 7, aggregation rule 3 |
| POSIX-absolute value versus a drive-absolute identity (or vice versa) | indeterminate (cross-form) | not-registered, listed as `alias-candidate` | step 7, aggregation rule 3 |
| Drive-relative value (`C:repo`) | uncomparable | not-registered, listed as uncomparable in the detail | step 1 (not absolute in either sense), aggregation rule 4 |
| Two different absolute paths on the same drive | not-registered | not-registered | step 8 |
| A provider root that is empty or relative | uncomparable | not-registered, listed as uncomparable in the detail | step 1, aggregation rule 4 |

`indeterminate` is first-class only where the pairwise ambiguity is confined to a
candidate entry's single segment: it means no write, a structured warning, and the
provider staying unresolved for that process (see P3-D and P3-F). Cross-form and
uncomparable entries never make the provider indeterminate; they are reported in
the probe detail so an operator can see the alias relationship, and the resolver's
decision proceeds without writing to the provider.

## 5. Boundaries

- Projection and comparison live in the adapters (P3-C); the resolver (P3-D)
  consumes only their results and never touches a provider root string.
- No path conversion is implemented: no Windows/WSL mapping, no
  symlink-to-target rewriting, no 8.3 expansion, no Unicode folding, and no
  cross-provider path unification. The single permitted filesystem interaction is
  the read-only `realpath` in step 6; anything it cannot decide falls to step 7 or
  step 8 as specified.
- Identity is per-process and per-workspace. Multi-workspace sessions, project
  discovery from a parent directory, and inferring a repository root from git
  metadata are out of scope.

## 6. Invariants

- Deterministic and side-effect free: identical inputs produce identical identity
  and identical comparison results, with no filesystem mutation (step 6 reads
  only) and no provider mutation.
- Independent of git state (branch, dirty tree, submodules), of the process's
  current working directory, and of environment variables other than the explicit
  configuration the host already uses to start the server.
- No provider key derivation is reproduced anywhere in the resolver.

## 7. Failure semantics

A comparison that cannot be decided yields `indeterminate`, which is reported and
never resolved by writing. Only a candidate entry with a single-segment ambiguity
(section 3.1 rule 2) makes the *provider* indeterminate; an uncomparable provider
value (empty or relative) is recorded in the probe detail and the provider state
follows aggregation rule 4. A provider that cannot be queried at all is
`unavailable` and mapped by P3-C.

## 8. Acceptance criteria

Met for this unit when: the identity source is stated unambiguously; each provider
has a projection rule that requires no provider key derivation; the comparison
rule is total with a detection predicate for every `indeterminate` case; every
case in section 4 has a decision and a detection mechanism; and the specification
introduces no conversion code, no write path, and no cross-provider unification.
