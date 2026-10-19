import { randomUUID } from "node:crypto";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { Client, type CallToolResult } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterEach, describe, expect, it } from "bun:test";

/**
 * The runtime's own bin directory: the spawned server still resolves `bun`, while
 * AST serving requires no providers and performs no registry probe or write. These
 * tests are about the apply path, so they must not depend on the developer's
 * provider installs.
 */
const PROVIDER_FREE_PATH = dirname(process.execPath);

const temporaryRoots: string[] = [];
const connectedClients: Client[] = [];

afterEach(async () => {
  await Promise.allSettled(connectedClients.splice(0).map((client) => client.close()));
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

/** Deliberately non-idempotent: a second application would append `.memo()` twice. */
const memoOperation = {
  pattern: "compute($$$ARGS)",
  replacement: "compute($$$ARGS).memo()",
};

const source = "const value = compute(1);\n";
const memoized = "const value = compute(1).memo();\n";

function previewIdOf(result: CallToolResult): unknown {
  const content: unknown = result.structuredContent;
  if (typeof content !== "object" || content === null || !("previewId" in content)) {
    return undefined;
  }
  return content.previewId;
}

function appliedOf(result: CallToolResult): unknown {
  const content: unknown = result.structuredContent;
  if (typeof content !== "object" || content === null || !("applied" in content)) {
    return undefined;
  }
  return content.applied;
}

function verificationOf(result: CallToolResult): unknown {
  const content: unknown = result.structuredContent;
  if (typeof content !== "object" || content === null || !("verification" in content)) {
    return undefined;
  }
  return content.verification;
}

function postconditionOf(result: CallToolResult): Record<string, unknown> {
  const verification = verificationOf(result);
  if (typeof verification !== "object" || verification === null || !("postconditions" in verification)) {
    throw new Error("result carried no verification descriptor");
  }
  const { postconditions } = verification as { postconditions: unknown };
  if (!Array.isArray(postconditions) || postconditions.length !== 1) {
    throw new Error("result did not carry exactly one postcondition");
  }
  return postconditions[0] as Record<string, unknown>;
}

async function workspaceRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "code-intel-mcp-apply-"));
  temporaryRoots.push(root);
  return root;
}

/** Spawn the real stdio server and prove the spawn stays protocol-clean. */
async function startServer(root: string): Promise<Client> {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["run", resolve("index.ts"), "--workspace-root", root],
    env: { ...process.env, PATH: PROVIDER_FREE_PATH },
  });
  const client = new Client({ name: "code-intel-mcp-apply-test", version: "0.1.0" });
  connectedClients.push(client);
  await client.connect(transport);

  const listed = await client.listTools();
  expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
    "ast_edit_apply",
    "ast_edit_preview",
    "ast_search",
    "ast_transform_plan_preview",
    "ast_transform_preview",
  ]);
  return client;
}

async function previewIdentity(
  client: Client,
  args: Record<string, unknown>,
): Promise<string> {
  const preview = await client.callTool({ name: "ast_edit_preview", arguments: args });
  expect(preview.isError).not.toBe(true);
  const previewId = previewIdOf(preview);
  expect(previewId).toBeString();
  if (typeof previewId !== "string") {
    throw new Error("preview did not return a preview identity");
  }
  return previewId;
}

function applyPreview(client: Client, previewId: unknown): Promise<CallToolResult> {
  return client.callTool({ name: "ast_edit_apply", arguments: { previewId } });
}

/** Preview one reviewed transformation with its verification descriptor. */
async function transformationPreview(
  client: Client,
  args: Record<string, unknown>,
): Promise<CallToolResult> {
  const preview = await client.callTool({ name: "ast_transform_preview", arguments: args });
  expect(preview.isError).not.toBe(true);
  return preview;
}

/** One root holding `sample.ts`, one server, and one preview over that file. */
async function previewedSample(): Promise<{
  fixture: string;
  client: Client;
  previewId: string;
}> {
  const root = await workspaceRoot();
  const fixture = join(root, "sample.ts");
  await writeFile(fixture, source, "utf8");
  const client = await startServer(root);
  const previewId = await previewIdentity(client, {
    operations: [memoOperation],
    path: "sample.ts",
  });
  return { fixture, client, previewId };
}

describe("stdio ast_edit_apply facade", () => {
  it("applies one reviewed preview once and rejects replaying its identity", async () => {
    const { fixture, client, previewId } = await previewedSample();

    const applied = await applyPreview(client, previewId);
    expect(applied.isError).not.toBe(true);
    expect(appliedOf(applied)).toBe(true);
    expect(previewIdOf(applied)).toBe(previewId);
    expect(await readFile(fixture, "utf8")).toBe(memoized);

    const replay = await applyPreview(client, previewId);
    expect(replay.isError).toBe(true);
    expect(JSON.stringify(replay)).toContain("PREVIEW_ALREADY_USED");
    expect(await readFile(fixture, "utf8")).toBe(memoized);
  });

  it("cannot duplicate the mutation when one identity is applied concurrently", async () => {
    const { fixture, client, previewId } = await previewedSample();

    const results = await Promise.all([
      applyPreview(client, previewId),
      applyPreview(client, previewId),
    ]);
    const failures = results.filter((result) => result.isError === true);
    expect(failures).toHaveLength(1);
    expect(JSON.stringify(failures[0])).toMatch(
      /PREVIEW_IN_PROGRESS|PREVIEW_ALREADY_USED/,
    );
    const successes = results.filter((result) => result.isError !== true);
    expect(successes.map(appliedOf)).toEqual([true]);

    const content = await readFile(fixture, "utf8");
    expect(content).toBe(memoized);
    expect(content.split(".memo()").length - 1).toBe(1);
  });

  it("rejects byte drift after the preview and leaves external content in place", async () => {
    const { fixture, client, previewId } = await previewedSample();

    const drifted = `${source}// external edit\n`;
    await writeFile(fixture, drifted, "utf8");

    const applied = await applyPreview(client, previewId);
    expect(applied.isError).toBe(true);
    expect(JSON.stringify(applied)).toContain("STALE_PREVIEW");
    expect(await readFile(fixture, "utf8")).toBe(drifted);
  });

  it("rejects directory-scope expansion by a newly matching file", async () => {
    const root = await workspaceRoot();
    const fixture = join(root, "sample.ts");
    await writeFile(fixture, source, "utf8");
    const client = await startServer(root);
    const previewId = await previewIdentity(client, {
      operations: [memoOperation],
      path: ".",
      glob: "**/*.ts",
    });

    const addedFixture = join(root, "added.ts");
    const addedSource = "export const added = compute(2);\n";
    await writeFile(addedFixture, addedSource, "utf8");

    const applied = await applyPreview(client, previewId);
    expect(applied.isError).toBe(true);
    expect(JSON.stringify(applied)).toContain("STALE_PREVIEW");
    expect(await readFile(fixture, "utf8")).toBe(source);
    expect(await readFile(addedFixture, "utf8")).toBe(addedSource);
  });

  it("rejects fresh mutation fields instead of applying them", async () => {
    const { fixture, client, previewId } = await previewedSample();

    const rejected = await client.callTool({
      name: "ast_edit_apply",
      arguments: {
        previewId,
        operations: [memoOperation],
        path: "sample.ts",
        glob: "**/*.ts",
        dryRun: false,
      },
    });
    expect(rejected.isError).toBe(true);
    expect(await readFile(fixture, "utf8")).toBe(source);

    // The rejected call consumed nothing: the reviewed preview still applies.
    const applied = await applyPreview(client, previewId);
    expect(applied.isError).not.toBe(true);
    expect(await readFile(fixture, "utf8")).toBe(memoized);
  });

  it("rejects a fabricated or null preview identity", async () => {
    const root = await workspaceRoot();
    const fixture = join(root, "sample.ts");
    await writeFile(fixture, source, "utf8");
    const client = await startServer(root);

    const fabricated = await applyPreview(client, randomUUID());
    expect(fabricated.isError).toBe(true);
    expect(JSON.stringify(fabricated)).toContain("UNKNOWN_OR_EXPIRED_PREVIEW");

    const nullIdentity = await client.callTool({
      name: "ast_edit_apply",
      arguments: { previewId: null },
    });
    expect(nullIdentity.isError).toBe(true);

    const nestedFixture = join(root, "nested.ts");
    const nestedSource = "const v = f(f(1));\n";
    await writeFile(nestedFixture, nestedSource, "utf8");
    const ambiguous = await client.callTool({
      name: "ast_edit_preview",
      arguments: {
        operations: [{ pattern: "f($$$A)", replacement: "g($$$A)" }],
        path: "nested.ts",
      },
    });
    expect(ambiguous.isError).toBe(true);
    expect(JSON.stringify(ambiguous)).toContain("AMBIGUOUS_MUTATION_PLAN");
    expect(previewIdOf(ambiguous)).toBeUndefined();
    expect(await readFile(nestedFixture, "utf8")).toBe(nestedSource);

    expect(await readFile(fixture, "utf8")).toBe(source);
  });

  it("invalidates preview identities across a server restart", async () => {
    const root = await workspaceRoot();
    const fixture = join(root, "sample.ts");
    await writeFile(fixture, source, "utf8");
    const first = await startServer(root);
    const previewId = await previewIdentity(first, {
      operations: [memoOperation],
      path: "sample.ts",
    });
    await first.close();

    const second = await startServer(root);
    const applied = await applyPreview(second, previewId);
    expect(applied.isError).toBe(true);
    expect(JSON.stringify(applied)).toContain("UNKNOWN_OR_EXPIRED_PREVIEW");
    expect(await readFile(fixture, "utf8")).toBe(source);
  });

  it("returns structured postcondition evidence for an applied transformation", async () => {
    const root = await workspaceRoot();
    const fixture = join(root, "sample.ts");
    await writeFile(fixture, source, "utf8");
    const client = await startServer(root);

    const preview = await transformationPreview(client, {
      operations: [memoOperation],
      path: "sample.ts",
      rationale: "Memoize the reviewed call site.",
      symbolRefs: ["opaque:compute"],
      verification: {
        postconditions: [{
          kind: "ast_match_count",
          pattern: "$_.memo($$$ARGS)",
          expectedCount: 1,
          path: "sample.ts",
        }],
      },
    });
    expect(postconditionOf(preview)).toEqual({
      kind: "ast_match_count",
      pattern: "$_.memo($$$ARGS)",
      expectedCount: 1,
      path: await realpath(fixture),
    });
    expect(await readFile(fixture, "utf8")).toBe(source);

    const applied = await applyPreview(client, previewIdOf(preview));
    expect(applied.isError).not.toBe(true);
    expect(appliedOf(applied)).toBe(true);
    expect(verificationOf(applied)).toEqual({
      status: "passed",
      results: [{ ...postconditionOf(preview), actualCount: 1 }],
    });
    expect(await readFile(fixture, "utf8")).toBe(memoized);
  });

  it("returns structured postcondition evidence when an applied transformation mismatches", async () => {
    const root = await workspaceRoot();
    const fixture = join(root, "sample.ts");
    await writeFile(fixture, source, "utf8");
    const client = await startServer(root);

    const preview = await transformationPreview(client, {
      operations: [memoOperation],
      path: "sample.ts",
      rationale: "Memoize the reviewed call site.",
      symbolRefs: ["opaque:compute"],
      verification: {
        postconditions: [{
          kind: "ast_match_count",
          pattern: "$_.memo($$$ARGS)",
          expectedCount: 5,
        }],
      },
    });
    // An omitted assertion path defaults to the owning step's canonical target.
    expect(postconditionOf(preview).path).toBe(await realpath(fixture));

    const applied = await applyPreview(client, previewIdOf(preview));
    expect(applied.isError).toBe(true);
    expect(JSON.stringify(applied)).toContain("APPLY_STATE_UNCERTAIN");
    expect(verificationOf(applied)).toEqual({
      status: "failed",
      results: [{ ...postconditionOf(preview), actualCount: 1 }],
      failedIndex: 0,
      path: await realpath(fixture),
      cause: expect.any(String),
      notEvaluatedIndexes: [],
    });
    expect(await readFile(fixture, "utf8")).toBe(memoized);
  });
});
