import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client, type CallToolResult } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterEach, describe, expect, test } from "bun:test";

const roots: string[] = [];
const clients: Client[] = [];
const source = "const value = compute(1);\n";
const changed = "const value = compute(1).memo();\n";
const edit = {
  path: "sample.ts",
  operations: [{ pattern: "compute($$$ARGS)", replacement: "compute($$$ARGS).memo()" }],
};
const transformation = { ...edit, rationale: "Memoize the reviewed call.", symbolRefs: ["opaque:compute"] };
const requests = [
  { name: "ast_search", arguments: { pattern: "compute($$$ARGS)", path: "sample.ts" } },
  { name: "ast_edit_preview", arguments: edit },
  { name: "ast_transform_preview", arguments: transformation },
  { name: "ast_transform_plan_preview", arguments: { steps: [transformation] } },
];

afterEach(async () => {
  await Promise.allSettled(clients.splice(0).map((client) => client.close()));
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
  ));
});

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), "code-intel-routing-"));
  roots.push(base);
  const a = join(base, "工作 A");
  const b = join(base, "workspace B");
  const cwd = join(base, "unrelated-cwd");
  const providers = join(base, "providers");
  await Promise.all([a, b, cwd, providers].map((directory) => mkdir(directory)));
  await Promise.all([a, b, cwd].map((root) => writeFile(join(root, "sample.ts"), source)));
  // If bootstrap is accidentally invoked, these isolated shims leave evidence.
  const marker = join(base, "provider-invoked");
  const windows = process.platform === "win32";
  const shim = windows
    ? `@echo off\r\necho invoked>>"${marker}"\r\necho {}\r\n`
    : `#!/bin/sh\nprintf invoked >> '${marker}'\nprintf '{}\\n'\n`;
  for (const name of ["codebase-memory-mcp", "gpt-repo-local"]) {
    await writeFile(join(providers, `${name}${windows ? ".cmd" : ""}`), shim, { mode: 0o755 });
  }
  return { base, a, b, cwd, providers, marker };
}

async function connect(context: Awaited<ReturnType<typeof fixture>>, fixedRoot?: string) {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ["run", fileURLToPath(new URL("../index.ts", import.meta.url)), ...(fixedRoot === undefined ? ["serve"] : ["--workspace-root", fixedRoot])],
    cwd: context.cwd,
    // Fixed-root tests use an empty PATH: no real provider is reachable.
    env: { ...process.env, PATH: fixedRoot === undefined ? context.providers : context.cwd },
    stderr: "pipe",
  });
  let stderr = "";
  transport.stderr?.on("data", (chunk) => { stderr += String(chunk); });
  const client = new Client({ name: "workspace-routing-test", version: "0.1.0" });
  clients.push(client);
  await client.connect(transport);
  return { client, stderr: () => stderr };
}

function content(result: CallToolResult): Record<string, unknown> {
  expect(result.isError).not.toBe(true);
  return result.structuredContent as Record<string, unknown>;
}

function identity(result: CallToolResult): string {
  const previewId = content(result).previewId;
  expect(previewId).toBeString();
  if (typeof previewId !== "string") throw new Error("missing preview identity");
  return previewId;
}

function apply(client: Client, previewId: string) {
  return client.callTool({ name: "ast_edit_apply", arguments: { previewId } });
}

describe("request-routed stdio MCP", () => {
  test("alternates A/B/A with coexisting previews and applies only each frozen workspace", async () => {
    const context = await fixture();
    const { client, stderr } = await connect(context);
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
      "ast_edit_apply", "ast_edit_preview", "ast_search", "ast_transform_plan_preview", "ast_transform_preview",
    ]);
    for (const request of requests) {
      const schema = listed.tools.find((tool) => tool.name === request.name)!.inputSchema;
      expect(schema.required).toContain("workspaceRoot");
    }
    const applySchema = listed.tools.find((tool) => tool.name === "ast_edit_apply")!.inputSchema;
    expect(Object.keys(applySchema.properties ?? {})).toEqual(["previewId"]);
    expect(applySchema.additionalProperties).toBe(false);

    const aPreview = await client.callTool({ name: "ast_edit_preview", arguments: { ...edit, workspaceRoot: context.a } });
    const aId = identity(aPreview);
    const bPreview = await client.callTool({ name: "ast_edit_preview", arguments: { ...edit, workspaceRoot: context.b } });
    const bId = identity(bPreview);
    expect(aId).not.toBe(bId);
    for (const workspaceRoot of [context.a, context.b, context.a]) {
      // All four routed surfaces work, including the strict internal plan parser.
      for (const request of requests) {
        const result = await client.callTool({ ...request, arguments: { ...request.arguments, workspaceRoot } });
        const value = content(result);
        if (request.name === "ast_search") expect(value.totalMatches).toBe(1);
        else if (request.name === "ast_transform_plan_preview") {
          const steps = value.results as Array<{ previewId: string; result: { applied: boolean } }>;
          expect(steps).toHaveLength(1);
          expect(steps[0]!.previewId).toBeString();
          expect(steps[0]!.result.applied).toBe(false);
        } else expect(value.applied).toBe(false);
      }
    }
    for (const root of [context.a, context.b, context.cwd]) {
      expect(await readFile(join(root, "sample.ts"), "utf8")).toBe(source);
    }
    const appliedB = content(await apply(client, bId));
    expect(appliedB).toMatchObject({ applied: true, previewId: bId, workspaceRoot: await realpath(context.b) });
    expect(await readFile(join(context.a, "sample.ts"), "utf8")).toBe(source);
    expect(await readFile(join(context.b, "sample.ts"), "utf8")).toBe(changed);

    const replay = await apply(client, bId);
    expect(replay.isError).toBe(true);
    expect(JSON.stringify(replay)).toContain("PREVIEW_ALREADY_USED");
    const appliedA = content(await apply(client, aId));
    expect(appliedA).toMatchObject({ applied: true, workspaceRoot: await realpath(context.a) });
    expect(await readFile(join(context.a, "sample.ts"), "utf8")).toBe(changed);
    expect(await readFile(join(context.cwd, "sample.ts"), "utf8")).toBe(source);
    await client.close();
    expect(stderr()).not.toContain('"version":1');
    await expect(readFile(context.marker)).rejects.toMatchObject({ code: "ENOENT" });
  }, 30_000);

  test("requires valid absolute roots on every routed surface and rejects apply overrides", async () => {
    const context = await fixture();
    const { client } = await connect(context);
    for (const request of requests) {
      for (const root of [undefined, "", ".", "relative/root", ...(process.platform === "win32" ? ["/", "\\", "C:relative"] : []), join(context.base, "missing"), join(context.a, "sample.ts")]) {
        const result = await client.callTool({
          ...request,
          arguments: { ...request.arguments, ...(root === undefined ? {} : { workspaceRoot: root }) },
        });
        expect(result.isError).toBe(true);
      }
    }
    const previewId = identity(await client.callTool({ name: "ast_edit_preview", arguments: { ...edit, workspaceRoot: context.a } }));
    for (const extra of [{ workspaceRoot: context.b }, { path: "sample.ts" }, { operations: edit.operations }, { dryRun: false }]) {
      const result = await client.callTool({ name: "ast_edit_apply", arguments: { previewId, ...extra } });
      expect(result.isError).toBe(true);
    }
    const nestedRoot = await client.callTool({
      name: "ast_transform_plan_preview",
      arguments: { workspaceRoot: context.a, steps: [{ ...transformation, workspaceRoot: context.b }] },
    });
    expect(nestedRoot.isError).toBe(true);
    for (const root of [context.a, context.b, context.cwd]) expect(await readFile(join(root, "sample.ts"), "utf8")).toBe(source);
    expect(content(await apply(client, previewId)).applied).toBe(true);
  }, 30_000);

  test("preserves confinement and duplicate-pattern rejection across request roots", async () => {
    const context = await fixture();
    const { client } = await connect(context);
    const sibling = `${context.a}-sibling`;
    await mkdir(sibling);
    await writeFile(join(sibling, "sample.ts"), source);
    for (const target of ["../workspace B/sample.ts", join(context.b, "sample.ts"), join(sibling, "sample.ts")]) {
      for (const request of requests.slice(0, 3)) {
        const result = await client.callTool({ ...request, arguments: { ...request.arguments, path: target, workspaceRoot: context.a } });
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result)).toContain(request.name === "ast_transform_preview" ? "INVALID_WORKSPACE_TARGET" : "WORKSPACE_ESCAPE");
      }
      const plan = await client.callTool({ name: "ast_transform_plan_preview", arguments: { workspaceRoot: context.a, steps: [{ ...transformation, path: target }] } });
      expect(plan.isError).toBe(true);
      expect(JSON.stringify(plan)).toContain("INVALID_WORKSPACE_TARGET");
    }
    const duplicate = await client.callTool({ name: "ast_edit_preview", arguments: {
      ...edit, workspaceRoot: context.a, operations: [edit.operations[0]!, { ...edit.operations[0]!, replacement: "other($$$ARGS)" }],
    } });
    expect(duplicate.isError).toBe(true);
    expect(JSON.stringify(duplicate)).toContain("DUPLICATE_PATTERN");
    for (const root of [context.a, context.b, sibling]) expect(await readFile(join(root, "sample.ts"), "utf8")).toBe(source);
  }, 30_000);

  test("rejects stale state after changing request workspace without consuming unrelated previews", async () => {
    const context = await fixture();
    const { client } = await connect(context);
    const aId = identity(await client.callTool({ name: "ast_edit_preview", arguments: { ...edit, workspaceRoot: context.a } }));
    const bId = identity(await client.callTool({ name: "ast_transform_preview", arguments: { ...transformation, workspaceRoot: context.b } }));
    const drifted = `${source}// external edit\n`;
    await writeFile(join(context.a, "sample.ts"), drifted);
    const rejected = await apply(client, aId);
    expect(rejected.isError).toBe(true);
    expect(JSON.stringify(rejected)).toContain("STALE_PREVIEW");
    expect(await readFile(join(context.a, "sample.ts"), "utf8")).toBe(drifted);
    expect(content(await apply(client, bId)).applied).toBe(true);
    expect(await readFile(join(context.b, "sample.ts"), "utf8")).toBe(changed);
  }, 30_000);

  test("isolates parallel A/B searches and previews through interleaved ID-only applies", async () => {
    const context = await fixture();
    const { client } = await connect(context);
    const bSource = "const value = compute(2);\n";
    const bChanged = "const value = compute(2).memo();\n";
    await writeFile(join(context.b, "sample.ts"), bSource);
    const aPostcondition = { kind: "ast_match_count", pattern: "compute(1).memo()", expectedCount: 1 };
    const bPostcondition = { kind: "ast_match_count", pattern: "compute(2).memo()", expectedCount: 1 };
    const [aSearch, bSearch, aPreview, bPreview, staleBPreview] = await Promise.all([
      client.callTool({ name: "ast_search", arguments: { workspaceRoot: context.a, path: "sample.ts", pattern: "compute(1)" } }),
      client.callTool({ name: "ast_search", arguments: { workspaceRoot: context.b, path: "sample.ts", pattern: "compute(2)" } }),
      client.callTool({ name: "ast_transform_preview", arguments: {
        ...transformation, workspaceRoot: context.a, verification: { postconditions: [aPostcondition] },
      } }),
      client.callTool({ name: "ast_transform_preview", arguments: {
        ...transformation, workspaceRoot: context.b, verification: { postconditions: [bPostcondition] },
      } }),
      client.callTool({ name: "ast_edit_preview", arguments: { ...edit, workspaceRoot: context.b } }),
    ]);
    expect(content(aSearch).totalMatches).toBe(1);
    expect(content(bSearch).totalMatches).toBe(1);
    const aId = identity(aPreview);
    const bId = identity(bPreview);
    const staleBId = identity(staleBPreview);
    expect(new Set([aId, bId, staleBId]).size).toBe(3);
    const frozenA = { ...aPostcondition, path: await realpath(join(context.a, "sample.ts")) };
    const frozenB = { ...bPostcondition, path: await realpath(join(context.b, "sample.ts")) };
    expect(content(aPreview)).toMatchObject({ applied: false, verification: { postconditions: [frozenA] } });
    expect(content(bPreview)).toMatchObject({ applied: false, verification: { postconditions: [frozenB] } });
    expect(content(staleBPreview).applied).toBe(false);
    expect(await readFile(join(context.a, "sample.ts"))).toEqual(Buffer.from(source));
    expect(await readFile(join(context.b, "sample.ts"))).toEqual(Buffer.from(bSource));

    // Select the opposite root immediately before each ID-only apply.
    expect(content(await client.callTool({ name: "ast_search", arguments: {
      workspaceRoot: context.a, path: "sample.ts", pattern: "compute(1)",
    } })).totalMatches).toBe(1);
    expect(content(await apply(client, bId))).toMatchObject({
      applied: true, previewId: bId, workspaceRoot: await realpath(context.b),
      verification: { status: "passed", results: [{ ...frozenB, actualCount: 1 }] },
    });
    expect(await readFile(join(context.a, "sample.ts"))).toEqual(Buffer.from(source));
    expect(await readFile(join(context.b, "sample.ts"))).toEqual(Buffer.from(bChanged));

    const replayB = await apply(client, bId);
    expect(replayB.isError).toBe(true);
    expect(JSON.stringify(replayB)).toContain("PREVIEW_ALREADY_USED");
    const staleB = await apply(client, staleBId);
    expect(staleB.isError).toBe(true);
    expect(JSON.stringify(staleB)).toContain("STALE_PREVIEW");
    expect(await readFile(join(context.a, "sample.ts"))).toEqual(Buffer.from(source));
    expect(await readFile(join(context.b, "sample.ts"))).toEqual(Buffer.from(bChanged));

    expect(content(await client.callTool({ name: "ast_search", arguments: {
      workspaceRoot: context.b, path: "sample.ts", pattern: "compute(2).memo()",
    } })).totalMatches).toBe(1);
    // Neither consuming B nor rejecting B's other identities consumes A.
    expect(content(await apply(client, aId))).toMatchObject({
      applied: true, previewId: aId, workspaceRoot: await realpath(context.a),
      verification: { status: "passed", results: [{ ...frozenA, actualCount: 1 }] },
    });
    const replayA = await apply(client, aId);
    expect(replayA.isError).toBe(true);
    expect(JSON.stringify(replayA)).toContain("PREVIEW_ALREADY_USED");
    expect(await readFile(join(context.a, "sample.ts"))).toEqual(Buffer.from(changed));
    expect(await readFile(join(context.b, "sample.ts"))).toEqual(Buffer.from(bChanged));
    expect(await readFile(join(context.cwd, "sample.ts"))).toEqual(Buffer.from(source));
  }, 30_000);

  test("rejects an invalid late plan step before issuing usable identities or applying the valid early step", async () => {
    const context = await fixture();
    const { client } = await connect(context);
    const lateTarget = join(context.a, "late.ts");
    await writeFile(lateTarget, source);
    const rejected = await client.callTool({ name: "ast_transform_plan_preview", arguments: {
      workspaceRoot: context.a,
      steps: [transformation, {
        ...transformation, path: "late.ts", operations: [edit.operations[0]!, edit.operations[0]!],
      }],
    } });
    expect(rejected.isError).toBe(true);
    expect(JSON.stringify(rejected)).toContain("DUPLICATE_PATTERN");
    const failure = rejected.structuredContent as {
      previewId?: unknown; results?: unknown[]; completedResults?: unknown[];
    } | undefined;
    expect(failure?.previewId).toBeUndefined();
    expect(failure?.results ?? []).toEqual([]);
    expect(failure?.completedResults ?? []).toEqual([]);
    for (const root of [context.a, context.b, context.cwd]) {
      expect(await readFile(join(root, "sample.ts"))).toEqual(Buffer.from(source));
    }
    expect(await readFile(lateTarget)).toEqual(Buffer.from(source));

    // The early step is independently valid; the rejected plan exposed no such ID.
    const early = await client.callTool({ name: "ast_transform_preview", arguments: {
      ...transformation, workspaceRoot: context.a,
    } });
    identity(early);
    expect(content(early)).toMatchObject({ applied: false, totalReplacements: 1 });
    expect(await readFile(join(context.a, "sample.ts"))).toEqual(Buffer.from(source));
    expect(await readFile(join(context.b, "sample.ts"))).toEqual(Buffer.from(source));
    expect(await readFile(lateTarget)).toEqual(Buffer.from(source));
  }, 30_000);

  test("routes a whole plan to one root and preserves independent partial-preview identities", async () => {
    const context = await fixture();
    const { client } = await connect(context);
    const nested = "const value = f(f(1));\n";
    await writeFile(join(context.b, "ambiguous.ts"), nested);
    await writeFile(join(context.b, "not-attempted.ts"), source);
    const partial = await client.callTool({ name: "ast_transform_plan_preview", arguments: {
      workspaceRoot: context.b,
      steps: [transformation, {
        ...transformation, path: "ambiguous.ts", operations: [{ pattern: "f($$$A)", replacement: "g($$$A)" }],
      }, { ...transformation, path: "not-attempted.ts" }],
    } });
    expect(partial.isError).toBe(true);
    expect(partial.structuredContent).toMatchObject({ stepIndex: 1, error: { code: "AMBIGUOUS_MUTATION_PLAN" }, notAttemptedStepIndexes: [2] });
    const state = partial.structuredContent as { completedResults: Array<{ previewId: string }> };
    expect(state.completedResults).toHaveLength(1);
    expect(await readFile(join(context.b, "sample.ts"), "utf8")).toBe(source);
    content(await client.callTool({ name: "ast_search", arguments: { pattern: "compute($$$ARGS)", workspaceRoot: context.a } }));
    expect(content(await apply(client, state.completedResults[0]!.previewId)).workspaceRoot).toBe(await realpath(context.b));
    expect(await readFile(join(context.b, "sample.ts"), "utf8")).toBe(changed);
    expect(await readFile(join(context.b, "ambiguous.ts"), "utf8")).toBe(nested);
    expect(await readFile(join(context.b, "not-attempted.ts"), "utf8")).toBe(source);
    expect(await readFile(join(context.a, "sample.ts"), "utf8")).toBe(source);
  }, 30_000);

  test("keeps distinct authority for the same file previewed through parent and child roots", async () => {
    const context = await fixture();
    const { client } = await connect(context);
    const parentId = identity(await client.callTool({ name: "ast_edit_preview", arguments: { ...edit, path: join(context.a, "sample.ts"), workspaceRoot: context.base } }));
    const childId = identity(await client.callTool({ name: "ast_edit_preview", arguments: { ...edit, workspaceRoot: context.a } }));
    expect(parentId).not.toBe(childId);
    expect(await readFile(join(context.a, "sample.ts"), "utf8")).toBe(source);
    const childApplied = content(await apply(client, childId));
    expect(childApplied.workspaceRoot).toBe(await realpath(context.a));
    const parentStale = await apply(client, parentId);
    expect(parentStale.isError).toBe(true);
    expect(JSON.stringify(parentStale)).toContain("STALE_PREVIEW");
    expect(await readFile(join(context.a, "sample.ts"), "utf8")).toBe(changed);
  }, 30_000);

  test("preserves fixed-root payloads and accepts only canonical-equivalent explicit roots", async () => {
    const context = await fixture();
    const { client } = await connect(context, context.a);
    const listed = await client.listTools();
    for (const request of requests) {
      expect(listed.tools.find((tool) => tool.name === request.name)!.inputSchema.required ?? []).not.toContain("workspaceRoot");
      content(await client.callTool(request));
      content(await client.callTool({ ...request, arguments: { ...request.arguments, workspaceRoot: `${context.a}/.` } }));
      const mismatch = await client.callTool({ ...request, arguments: { ...request.arguments, workspaceRoot: context.b } });
      expect(mismatch.isError).toBe(true);
      expect(JSON.stringify(mismatch)).toContain("WORKSPACE_ROOT_MISMATCH");
    }
    const previewId = identity(await client.callTool({ name: "ast_edit_preview", arguments: edit }));
    expect(content(await apply(client, previewId)).workspaceRoot).toBe(await realpath(context.a));
    expect(await readFile(join(context.a, "sample.ts"), "utf8")).toBe(changed);
    expect(await readFile(join(context.b, "sample.ts"), "utf8")).toBe(source);
  }, 30_000);

  test("rejects canonical symlink escape when directory links are supported", async () => {
    const context = await fixture();
    const link = join(context.a, "outside");
    try {
      await symlink(context.b, link, process.platform === "win32" ? "junction" : "dir");
    } catch (error) {
      if (["EPERM", "EACCES", "ENOSYS", "ENOTSUP"].includes((error as NodeJS.ErrnoException).code ?? "")) return;
      throw error;
    }
    const { client } = await connect(context);
    const rejected = await client.callTool({ name: "ast_edit_preview", arguments: { ...edit, path: "outside/sample.ts", workspaceRoot: context.a } });
    expect(rejected.isError).toBe(true);
    expect(JSON.stringify(rejected)).toContain("WORKSPACE_ESCAPE");
    expect(await readFile(join(context.b, "sample.ts"), "utf8")).toBe(source);
  }, 30_000);
});
