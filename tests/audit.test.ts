import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, test } from "bun:test";

const repository = resolve(import.meta.dir, "..");
const auditModule = pathToFileURL(join(repository, "src/audit.ts")).href;
const serverModule = pathToFileURL(join(repository, "src/server.ts")).href;
const roots: string[] = [];
const sentinel = "AUDIT_PRIVATE_SENTINEL_秘密";

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "code-intel-audit-"));
  roots.push(root);
  return root;
}

// Each process owns its audit initialization and budget; no production reset hook.
function evaluate(body: string, environment: NodeJS.ProcessEnv = {}) {
  const child = spawnSync(process.execPath, ["--eval", `
    import { auditTool, auditTransport, initializeAudit } from ${JSON.stringify(auditModule)};
    ${body}
  `], {
    cwd: repository,
    env: { ...process.env, CODE_INTEL_AUDIT: undefined, CODE_INTEL_AUDIT_FILE: undefined, ...environment },
    encoding: "utf8",
    timeout: 15_000,
    windowsHide: true,
  });
  expect(child.error).toBeUndefined();
  expect(child.status).toBe(0);
  return { stdout: child.stdout, stderr: child.stderr };
}

function events(text: string) {
  const lines = text.trimEnd().split("\n").filter(Boolean);
  expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(128 * 1024);
  expect(lines.length).toBeLessThanOrEqual(256);
  return lines.map((line) => {
    expect(Buffer.byteLength(line + "\n", "utf8")).toBeLessThanOrEqual(512);
    const event = JSON.parse(line);
    expect(Object.keys(event).sort()).toEqual(["resultCategory", "timestamp", "tool"]);
    expect(new Date(event.timestamp).toISOString()).toBe(event.timestamp);
    expect(["success", "tool_error", "internal_error"]).toContain(event.resultCategory);
    return event;
  });
}

const classifications = `
  const privateValue = ${JSON.stringify(sentinel)};
  const success = { content: [{ text: privateValue.repeat(1000) }], structuredContent: {
    workspaceRoot: privateValue, source: privateValue, prompt: privateValue, previewId: privateValue,
  } };
  const returnedError = { isError: true, content: [{ text: privateValue }] };
  const thrownError = new Error(privateValue);
  const first = await auditTool("ast_search", async () => success);
  const second = await auditTool("ast_transform_plan_preview", async () => returnedError);
  let sameError = false;
  try { await auditTool("ast_edit_apply", async () => { throw thrownError; }); }
  catch (error) { sameError = error === thrownError; }
  console.log(JSON.stringify({ sameSuccess: first === success, sameReturnedError: second === returnedError, sameError }));
`;

describe("bounded opt-in tool audit", () => {
  test("unset, empty and off modes produce no artifact or audit output", async () => {
    const root = await fixture();
    for (const mode of [undefined, "", "off"]) {
      const result = evaluate(classifications, {
        CODE_INTEL_AUDIT: mode, CODE_INTEL_AUDIT_FILE: join(root, "must-not-exist.jsonl"),
      });
      expect(result.stderr).toBe("");
      expect(JSON.parse(result.stdout)).toEqual({ sameSuccess: true, sameReturnedError: true, sameError: true });
    }
    expect(await readdir(root)).toEqual([]);
  });

  test("records exactly one fixed classification and preserves return/error identity without content", () => {
    const result = evaluate(classifications, { CODE_INTEL_AUDIT: "stderr" });
    expect(JSON.parse(result.stdout)).toEqual({ sameSuccess: true, sameReturnedError: true, sameError: true });
    expect(events(result.stderr).map(({ tool, resultCategory }) => ({ tool, resultCategory }))).toEqual([
      { tool: "ast_search", resultCategory: "success" },
      { tool: "ast_transform_plan_preview", resultCategory: "tool_error" },
      { tool: "ast_edit_apply", resultCategory: "internal_error" },
    ]);
    expect(result.stderr).not.toContain(sentinel);
  });

  test("transport completion keeps concurrent request classifications separate and emits once", () => {
    const result = evaluate(`
      initializeAudit();
      const sent = [];
      const pending = [];
      const raw = { async start() {}, async close() {}, async send(message) { sent.push(message); } };
      const observed = auditTransport(raw);
      let release;
      const held = new Promise((resolve) => { release = resolve; });
      observed.onmessage = (request) => {
        pending.push((async () => {
          let response;
          if (request.id === 1) {
            try {
              await auditTool("ast_edit_apply", async () => { await held; throw new Error(${JSON.stringify(sentinel)}); });
            } catch {
              response = { isError: true, content: [] };
            }
          } else {
            // Models a rejection by SDK validation, before any handler invocation.
            response = { isError: true, content: [] };
          }
          const message = { jsonrpc: "2.0", id: request.id, result: response };
          await observed.send(message);
          await observed.send(message); // A second send must not duplicate the audit event.
        })());
      };
      await observed.start();
      raw.onmessage({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "ast_edit_apply" } });
      raw.onmessage({ jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "ast_search" } });
      release();
      await Promise.all(pending);
      console.log(JSON.stringify(sent.map((message) => message.id)));
    `, { CODE_INTEL_AUDIT: "stderr" });
    expect(JSON.parse(result.stdout).sort()).toEqual([1, 1, 2, 2]);
    expect(events(result.stderr).map(({ tool, resultCategory }) => ({ tool, resultCategory }))).toEqual([
      { tool: "ast_search", resultCategory: "tool_error" },
      { tool: "ast_edit_apply", resultCategory: "internal_error" },
    ]);
    expect(result.stderr).not.toContain(sentinel);
  });

  for (const mode of ["stderr", "file"]) {
    test(`${mode} caps are shared across server instances and do not stop execution`, async () => {
      const root = await fixture();
      const destination = join(root, "bounded.jsonl");
      const result = evaluate(`
        import { createMcpServer } from ${JSON.stringify(serverModule)};
        const first = createMcpServer();
        let completed = 0;
        for (let index = 0; index < 130; index++) await auditTool("ast_search", async () => ++completed);
        const second = createMcpServer();
        for (let index = 0; index < 170; index++) await auditTool("ast_edit_apply", async () => ++completed);
        console.log(completed);
      `, { CODE_INTEL_AUDIT: mode, CODE_INTEL_AUDIT_FILE: destination });
      expect(result.stdout.trim()).toBe("300");
      const captured = mode === "stderr" ? result.stderr : await readFile(destination, "utf8");
      expect(events(captured)).toHaveLength(256);
      if (mode === "file") expect(result.stderr).toBe("");
    });
  }

  test("exclusively creates a fresh file and refuses overwrite without leaking its path", async () => {
    const root = await fixture();
    const destination = join(root, `${sentinel}.jsonl`);
    const environment = { CODE_INTEL_AUDIT: "file", CODE_INTEL_AUDIT_FILE: destination };
    const first = evaluate(classifications, environment);
    expect(first.stderr).toBe("");
    const original = await readFile(destination, "utf8");
    expect(events(original).map((event) => event.resultCategory)).toEqual(["success", "tool_error", "internal_error"]);
    expect(original).not.toContain(sentinel);
    const second = evaluate(classifications, environment);
    expect(JSON.parse(second.stdout).sameError).toBe(true);
    expect(second.stderr).toBe("CODE_INTEL_AUDIT_UNAVAILABLE: capture disabled; destination unavailable or configuration invalid.\n");
    expect(second.stderr).not.toContain(sentinel);
    expect(await readFile(destination, "utf8")).toBe(original);
  });

  test("missing parents, missing paths and invalid modes disable capture safely", async () => {
    const root = await fixture();
    for (const environment of [
      { CODE_INTEL_AUDIT: "file", CODE_INTEL_AUDIT_FILE: join(root, sentinel, "capture.jsonl") },
      { CODE_INTEL_AUDIT: "file" },
      { CODE_INTEL_AUDIT: sentinel },
    ]) {
      const result = evaluate(classifications, environment);
      expect(JSON.parse(result.stdout)).toEqual({ sameSuccess: true, sameReturnedError: true, sameError: true });
      expect(result.stderr).toBe("CODE_INTEL_AUDIT_UNAVAILABLE: capture disabled; destination unavailable or configuration invalid.\n");
      expect(result.stderr).not.toContain(sentinel);
    }
    expect(await readdir(root)).toEqual([]);
  });

  test("print-config output stays identical and contains no audit settings", async () => {
    const root = await fixture();
    const invoke = (enabled: boolean) => spawnSync(process.execPath, [
      join(repository, "scripts/code-intel.mjs"), "print-config", "--host", "generic-stdio",
    ], {
      cwd: repository,
      env: { ...process.env, CODE_INTEL_AUDIT: enabled ? "file" : undefined,
        CODE_INTEL_AUDIT_FILE: join(root, "must-not-exist.jsonl") },
      encoding: "utf8", timeout: 15_000, windowsHide: true,
    });
    const off = invoke(false);
    const on = invoke(true);
    expect(off.status).toBe(0);
    expect(on.status).toBe(0);
    expect(on.stdout).toBe(off.stdout);
    expect(on.stderr).toBe("");
    expect(on.stdout).not.toContain("CODE_INTEL_AUDIT");
    expect(await readdir(root)).toEqual([]);
  });
});
