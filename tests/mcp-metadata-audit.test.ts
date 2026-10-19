import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterEach, describe, expect, test } from "bun:test";

const repository = resolve(import.meta.dir, "..");
const roots: string[] = [];
const sentinel = "MCP_AUDIT_PRIVATE_SENTINEL";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) =>
    rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
  ));
});

describe("MCP metadata and audit protocol boundary", () => {
  for (const mode of ["stderr", "file", "failed-file"] as const) {
    test(`${mode} preserves the catalog, structured tool results and valid protocol stdout`, async () => {
      const root = await mkdtemp(join(tmpdir(), `${sentinel}-`));
      roots.push(root);
      const fixture = join(root, "sample.ts");
      const source = `console.log("${sentinel}");\nconst value = f(f(1));\n`;
      await writeFile(fixture, source);
      const destination = join(root, "audit.jsonl");
      if (mode === "failed-file") await writeFile(destination, sentinel);
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: ["run", join(repository, "index.ts"), "serve"],
        cwd: root,
        env: { ...process.env, PATH: dirname(process.execPath),
          CODE_INTEL_AUDIT: mode === "stderr" ? "stderr" : "file", CODE_INTEL_AUDIT_FILE: destination },
        stderr: "pipe",
      });
      let diagnostics = "";
      transport.stderr?.on("data", (chunk) => { diagnostics += String(chunk); });
      const client = new Client({ name: "metadata-audit-test", version: "0.1.0" });
      const protocolErrors: Error[] = [];
      client.onerror = (error) => { protocolErrors.push(error); };
      try {
        await client.connect(transport);
        const listed = await client.listTools();
        expect(listed.tools.map((tool) => tool.name).sort()).toEqual([
          "ast_edit_apply", "ast_edit_preview", "ast_search", "ast_transform_plan_preview", "ast_transform_preview",
        ]);
        for (const tool of listed.tools) {
          expect(tool.description).toBeString();
          expect(tool.annotations?.openWorldHint).toBe(false);
          expect(tool.inputSchema.additionalProperties).toBe(false);
          if (tool.name === "ast_edit_apply") {
            expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: true, idempotentHint: false });
            expect(Object.keys(tool.inputSchema.properties ?? {})).toEqual(["previewId"]);
            expect(tool.inputSchema.required).toEqual(["previewId"]);
            expect(tool.description).toContain("reviewed previewId");
          } else {
            expect(tool.annotations?.readOnlyHint).toBe(true);
            expect(tool.inputSchema.required).toContain("workspaceRoot");
            if (tool.name === "ast_search") {
              expect(tool.annotations?.idempotentHint).toBe(true);
              expect(tool.description).toContain("structural");
              expect(tool.description).toContain("workspaceRoot");
            } else {
              expect(tool.annotations?.idempotentHint).toBe(false);
              expect(tool.description).toContain("without changing source");
              expect(tool.description).toContain("review");
            }
          }
        }

        const search = await client.callTool({ name: "ast_search", arguments: {
          workspaceRoot: root, path: "sample.ts", pattern: "console.log($$$ARGS)",
        } });
        expect(search.isError).not.toBe(true);
        expect(search.structuredContent).toMatchObject({ totalMatches: 1 });

        const preview = await client.callTool({ name: "ast_edit_preview", arguments: {
          workspaceRoot: root, path: "sample.ts",
          operations: [{ pattern: "console.log($$$ARGS)", replacement: "logger.info($$$ARGS)" }],
        } });
        expect(preview.isError).not.toBe(true);
        expect(preview.structuredContent).toMatchObject({ applied: false });
        const previewId = (preview.structuredContent as { previewId: string }).previewId;
        expect(previewId).toBeString();

        const transformation = await client.callTool({ name: "ast_transform_preview", arguments: {
          workspaceRoot: root, path: "sample.ts", rationale: sentinel, symbolRefs: [sentinel],
          operations: [{ pattern: "console.log($$$ARGS)", replacement: "logger.info($$$ARGS)" }],
        } });
        expect(transformation.isError).not.toBe(true);
        expect(transformation.structuredContent).toMatchObject({
          applied: false, transformation: { rationale: sentinel, symbolRefs: [sentinel] },
        });
        const transformationId = (transformation.structuredContent as { previewId: string }).previewId;
        expect(transformationId).toBeString();

        // The handler returns isError with structured partial-plan details.
        const returnedError = await client.callTool({ name: "ast_transform_plan_preview", arguments: {
          workspaceRoot: root,
          steps: [{ path: "sample.ts", rationale: sentinel, symbolRefs: [sentinel],
            operations: [{ pattern: "f($$$A)", replacement: "g($$$A)" }] }],
        } });
        expect(returnedError.isError).toBe(true);
        expect(returnedError.structuredContent).toMatchObject({
          stepIndex: 0, error: { code: "AMBIGUOUS_MUTATION_PLAN" }, completedResults: [],
        });

        // The handler throws; the SDK still returns its normal error response.
        const thrownError = await client.callTool({ name: "ast_edit_apply", arguments: { previewId: sentinel } });
        expect(thrownError.isError).toBe(true);
        expect(JSON.stringify(thrownError)).toContain("UNKNOWN_OR_EXPIRED_PREVIEW");

        // SDK input-schema rejection completes the request without invoking the handler.
        const rejected = await client.callTool({ name: "ast_search", arguments: { pattern: sentinel } });
        expect(rejected.isError).toBe(true);
        expect(await readFile(fixture, "utf8")).toBe(source);
        await client.close();
        expect(protocolErrors).toEqual([]);

        if (mode === "failed-file") {
          expect(await readFile(destination, "utf8")).toBe(sentinel);
          expect(diagnostics).toBe("CODE_INTEL_AUDIT_UNAVAILABLE: capture disabled; destination unavailable or configuration invalid.\n");
        } else {
          const capture = mode === "stderr" ? diagnostics : await readFile(destination, "utf8");
          const lines = capture.trimEnd().split("\n");
          expect(lines).toHaveLength(6);
          const audit = lines.map((line) => {
            expect(Buffer.byteLength(line + "\n", "utf8")).toBeLessThanOrEqual(512);
            const event = JSON.parse(line);
            expect(Object.keys(event).sort()).toEqual(["resultCategory", "timestamp", "tool"]);
            return { tool: event.tool, resultCategory: event.resultCategory };
          });
          expect(audit).toEqual([
            { tool: "ast_search", resultCategory: "success" },
            { tool: "ast_edit_preview", resultCategory: "success" },
            { tool: "ast_transform_preview", resultCategory: "success" },
            { tool: "ast_transform_plan_preview", resultCategory: "tool_error" },
            { tool: "ast_edit_apply", resultCategory: "internal_error" },
            { tool: "ast_search", resultCategory: "tool_error" },
          ]);
          expect(capture).not.toContain(sentinel);
          expect(capture).not.toContain(previewId);
          expect(capture).not.toContain(transformationId);
          expect(capture).not.toContain(root);
          if (mode === "file") expect(diagnostics).toBe("");
        }
      } finally {
        await client.close();
      }
    }, 30_000);
  }
});
