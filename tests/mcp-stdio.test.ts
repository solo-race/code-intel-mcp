import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterEach, describe, expect, it } from "bun:test";

/**
 * The runtime's own bin directory: the spawned server still resolves `bun`, while
 * AST serving requires no providers and performs no registry probe or write. These
 * tests are not about provider state, so they must not depend on the developer's
 * provider installs.
 */
const PROVIDER_FREE_PATH = dirname(process.execPath);

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("stdio MCP facade", () => {
  it("discovers and invokes the five exposed tools with structured results", async () => {
    const root = await mkdtemp(join(tmpdir(), "code-intel-mcp-"));
    temporaryRoots.push(root);
    const fixture = join(root, "sample.ts");
    const source = 'function demo() {\n  console.log("hello");\n  console.log("world");\n}\n';
    await writeFile(fixture, source, "utf8");

    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["run", resolve("index.ts"), "--workspace-root", root],
      env: { ...process.env, PATH: PROVIDER_FREE_PATH },
    });
    const client = new Client({ name: "code-intel-mcp-test", version: "0.1.0" });

    try {
      await client.connect(transport);

      const listed = await client.listTools();
      expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
        "ast_edit_apply",
        "ast_edit_preview",
        "ast_search",
        "ast_transform_plan_preview",
        "ast_transform_preview",
      ]);

      const search = await client.callTool({
        name: "ast_search",
        arguments: { pattern: "console.log($$$ARGS)" },
      });
      expect(search.isError).not.toBe(true);
      const searchResult = search.structuredContent as {
        matches?: Array<{ metaVariables?: Record<string, string> }>;
        totalMatches?: number;
      };
      expect(searchResult.totalMatches).toBe(2);
      expect(searchResult.matches?.[0]?.metaVariables).toBeDefined();

      const before = await readFile(fixture);
      const preview = await client.callTool({
        name: "ast_edit_preview",
        arguments: {
          operations: [
            {
              pattern: "console.log($$$ARGS)",
              replacement: "logger.info($$$ARGS)",
            },
          ],
          path: "sample.ts",
        },
      });
      expect(preview.isError).not.toBe(true);
      const previewResult = preview.structuredContent as {
        applied?: boolean;
        previewId?: string | null;
      };
      expect(previewResult.applied).toBe(false);
      expect(previewResult.previewId).toBeString();
      expect(previewResult.previewId?.length).toBeGreaterThan(0);
      expect(await readFile(fixture)).toEqual(before);

      const zeroChange = await client.callTool({
        name: "ast_edit_preview",
        arguments: {
          operations: [{ pattern: "missing($$$ARGS)", replacement: "noop($$$ARGS)" }],
          path: "sample.ts",
        },
      });
      expect(zeroChange.isError).not.toBe(true);
      expect(
        (zeroChange.structuredContent as { previewId?: string | null }).previewId,
      ).toBeNull();

      const failure = await client.callTool({
        name: "ast_search",
        arguments: { pattern: "console.log($$$ARGS)", path: "../outside.ts" },
      });
      expect(failure.isError).toBe(true);
      expect(JSON.stringify(failure)).toContain("WORKSPACE_ESCAPE");

      const duplicate = await client.callTool({
        name: "ast_edit_preview",
        arguments: {
          path: "sample.ts",
          operations: [
            { pattern: "console.log($$$ARGS)", replacement: "a($$$ARGS)" },
            { pattern: "console.log($$$ARGS)", replacement: "b($$$ARGS)" },
          ],
        },
      });
      expect(duplicate.isError).toBe(true);
      expect(JSON.stringify(duplicate)).toContain("DUPLICATE_PATTERN");

      const callerDryRun = await client.callTool({
        name: "ast_edit_preview",
        arguments: {
          path: "sample.ts",
          operations: [
            { pattern: "console.log($$$ARGS)", replacement: "logger.info($$$ARGS)" },
          ],
          dryRun: false,
        },
      });
      expect(callerDryRun.isError).toBe(true);

      const transformationInput = {
        path: "sample.ts",
        operations: [{ pattern: "console.log($$$ARGS)", replacement: "logger.info($$$ARGS)" }],
        rationale: "  Use the structured logger.  ",
        symbolRefs: [" understanding:demo "],
      };
      const secondFixture = join(root, "second.ts");
      await writeFile(secondFixture, source);
      const planInput = {
        steps: [
          { ...transformationInput, path: "second.ts" },
          transformationInput,
        ],
      };
      for (const invalidArguments of [
        { ...planInput, dryRun: false },
        { steps: [] },
        { steps: [transformationInput, { ...transformationInput, path: "./sample.ts" }] },
        { steps: [transformationInput, { ...transformationInput, path: "second.ts", script: "run()" }] },
      ]) {
        const invalid = await client.callTool({ name: "ast_transform_plan_preview", arguments: invalidArguments });
        expect(invalid.isError).toBe(true);
      }
      const planPreview = await client.callTool({ name: "ast_transform_plan_preview", arguments: planInput });
      expect(planPreview.isError).not.toBe(true);
      const plan = planPreview.structuredContent as {
        steps: Array<{ path: string }>;
        results: Array<{ stepIndex: number; previewId: string; result: { applied: boolean } }>;
      };
      expect(plan.steps.map((step) => step.path)).toEqual(["second.ts", "sample.ts"]);
      expect(plan.results.map((step) => step.stepIndex)).toEqual([0, 1]);
      expect(plan.results.every((step) => typeof step.previewId === "string" && step.result.applied === false)).toBe(true);
      expect(plan.results[0]!.previewId).not.toBe(plan.results[1]!.previewId);
      expect(await readFile(fixture)).toEqual(before);
      expect(await readFile(secondFixture, "utf8")).toBe(source);
      const planApplied = await client.callTool({ name: "ast_edit_apply", arguments: { previewId: plan.results[0]!.previewId } });
      expect(planApplied.isError).not.toBe(true);
      expect(await readFile(secondFixture, "utf8")).toBe(source.replaceAll("console.log", "logger.info"));

      const ambiguousFixture = join(root, "ambiguous.ts");
      const nestedSource = "const value = f(f(1));\n";
      await writeFile(ambiguousFixture, nestedSource);
      const partialPreview = await client.callTool({
        name: "ast_transform_plan_preview",
        arguments: {
          steps: [transformationInput, {
            ...transformationInput,
            path: "ambiguous.ts",
            operations: [{ pattern: "f($$$A)", replacement: "g($$$A)" }],
          }, { ...transformationInput, path: "second.ts" }],
        },
      });
      expect(partialPreview.isError).toBe(true);
      expect(partialPreview.structuredContent).toMatchObject({
        stepIndex: 1,
        error: { code: "AMBIGUOUS_MUTATION_PLAN" },
        notAttemptedStepIndexes: [2],
      });
      const partial = partialPreview.structuredContent as { completedResults: Array<{ previewId: string }> };
      expect(partial.completedResults).toHaveLength(1);
      expect(partial.completedResults[0]!.previewId).toBeString();
      expect(await readFile(ambiguousFixture, "utf8")).toBe(nestedSource);
      for (const extra of [{ glob: "**/*.ts" }, { maxFiles: 1 }, { dryRun: false }]) {
        const invalid = await client.callTool({
          name: "ast_transform_preview",
          arguments: { ...transformationInput, ...extra },
        });
        expect(invalid.isError).toBe(true);
      }
      const transformation = await client.callTool({
        name: "ast_transform_preview",
        arguments: transformationInput,
      });
      expect(transformation.isError).not.toBe(true);
      const transformed = transformation.structuredContent as {
        applied: boolean;
        previewId: string;
        transformation: { rationale: string; symbolRefs: string[] };
      };
      expect(transformed.applied).toBe(false);
      expect(transformed.previewId).toBeString();
      expect(transformed.transformation).toEqual({
        rationale: "Use the structured logger.",
        symbolRefs: ["understanding:demo"],
      });
      expect(await readFile(fixture)).toEqual(before);
      const applied = await client.callTool({
        name: "ast_edit_apply",
        arguments: { previewId: transformed.previewId },
      });
      expect(applied.isError).not.toBe(true);
      expect(applied.structuredContent).toMatchObject({
        applied: true,
        previewId: transformed.previewId,
        transformation: transformed.transformation,
      });
      expect(await readFile(fixture, "utf8")).toBe(source.replaceAll("console.log", "logger.info"));
    } finally {
      await client.close();
    }
  });
});
