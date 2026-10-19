import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Readable } from "node:stream";
import { pathToFileURL } from "node:url";

import { LATEST_PROTOCOL_VERSION } from "@modelcontextprotocol/client";
import { afterEach, describe, expect, test } from "bun:test";

/**
 * Process-level contract of `scripts/mcp-launch.mjs`: it resolves the session
 * working directory, starts the server with that root, keeps stdout
 * protocol-only, and rejects an unusable session working directory.
 */

const temporaryRoots: string[] = [];
const runningLaunchers: ChildProcess[] = [];

afterEach(async () => {
  await Promise.all(
    runningLaunchers.splice(0).map(async (child) => {
      const closed = new Promise<void>((release) => {
        if (child.exitCode !== null || child.signalCode !== null) {
          release();
          return;
        }
        child.once("close", () => release());
      });
      // Closing stdin ends the MCP session and releases the workspace directory
      // held as the launcher's cwd.
      child.stdin?.end();
      await closed;
      child.kill();
    }),
  );
  await Promise.all(
    temporaryRoots.splice(0).map((root) =>
      rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }),
    ),
  );
});

interface OutputTrack {
  read: () => string;
  /** Resolves on the event that produces the marker; closing the process releases it. */
  waitFor: (marker: string) => Promise<void>;
}

function trackOutput(stream: Readable | null, child: ChildProcess): OutputTrack {
  let text = "";
  const waiters: Array<{ marker: string; release: () => void }> = [];
  stream?.setEncoding("utf8");
  stream?.on("data", (chunk) => {
    text += String(chunk);
    for (const waiter of waiters.splice(0)) {
      if (text.includes(waiter.marker)) {
        waiter.release();
      } else {
        waiters.push(waiter);
      }
    }
  });
  child.on("close", () => {
    for (const waiter of waiters.splice(0)) {
      waiter.release();
    }
  });
  return {
    read: () => text,
    waitFor: (marker) =>
      text.includes(marker)
        ? Promise.resolve()
        : new Promise<void>((release) => {
            waiters.push({ marker, release });
          }),
  };
}

interface LauncherSession {
  child: ChildProcess;
  stdout: OutputTrack;
  stderr: OutputTrack;
}

/**
 * PATH restricted to the runtime's own bin directory so both provider CLIs stay
 * unreachable without touching a real provider registry.
 */
const LAUNCHER_PATH = dirname(process.execPath);

function spawnLauncher(cwd: string): LauncherSession {
  const child = spawn(process.execPath, [resolve("scripts/mcp-launch.mjs")], {
    cwd,
    env: { ...process.env, PATH: LAUNCHER_PATH },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  runningLaunchers.push(child);
  return {
    child,
    stdout: trackOutput(child.stdout, child),
    stderr: trackOutput(child.stderr, child),
  };
}

async function createWorkspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "code-intel-mcp-p3l-"));
  temporaryRoots.push(root);
  return root;
}

function initializeFrame(id: number, method: string, params: unknown = {}) {
  return `${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`;
}

describe("mcp-launch.mjs", () => {
  test(
    "passes the session cwd as the workspace root without provider reporting",
    async () => {
      const root = await createWorkspace();
      const session = spawnLauncher(root);

      session.child.stdin?.write(
        initializeFrame(1, "initialize", {
          protocolVersion: LATEST_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: "code-intel-mcp-launcher-test", version: "0.1.0" },
        }),
      );
      session.child.stdin?.write(
        `${JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" })}\n`,
      );
      session.child.stdin?.write(initializeFrame(2, "tools/list"));

      await session.stdout.waitFor('"id":2');

      const responses = session.stdout
        .read()
        .split(/\r?\n/u)
        .filter((line) => line.trim().length > 0)
        .map((frame) => {
          return JSON.parse(frame) as {
            jsonrpc?: string;
            id?: number;
            result?: { tools?: Array<{ name: string }> };
          };
        });
      expect(responses.length).toBeGreaterThanOrEqual(2);
      expect(responses.every((frame) => frame.jsonrpc === "2.0")).toBe(true);
      expect(
        responses
          .find((frame) => frame.id === 2)
          ?.result?.tools?.map((tool) => tool.name)
          .sort(),
      ).toEqual([
        "ast_edit_apply",
        "ast_edit_preview",
        "ast_search",
        "ast_transform_plan_preview",
        "ast_transform_preview",
      ]);

      expect(session.stderr.read()).not.toContain("BOOTSTRAP");
    },
    30_000,
  );

  test(
    "exits 1 without a report when the session cwd is not a directory",
    async () => {
      const root = await createWorkspace();
      const notADirectory = join(root, "note.txt");
      await writeFile(notADirectory, "not a directory\n", "utf8");
      // The OS cannot start a process with a file as its working directory, so the
      // file path is injected as the launcher's `process.cwd()`. The dynamic
      // import is deliberate: the launcher must run as a module inside a
      // separate process whose stdio this test owns — a static import would be
      // hoisted above the override and would hijack the test runner's own stdio.
      const child = spawn(
        process.execPath,
        [
          "-e",
          `process.cwd = () => ${JSON.stringify(notADirectory)};\n` +
            `await import(${JSON.stringify(pathToFileURL(resolve("scripts/mcp-launch.mjs")).href)});`,
        ],
        {
          cwd: root,
          env: { ...process.env, PATH: LAUNCHER_PATH },
          stdio: ["pipe", "pipe", "pipe"],
          windowsHide: true,
        },
      );
      runningLaunchers.push(child);
      const stdout = trackOutput(child.stdout, child);
      const stderr = trackOutput(child.stderr, child);

      const exitCode = await new Promise<number | null>((resolveExit) => {
        child.once("close", resolveExit);
      });

      expect(exitCode).toBe(1);
      expect(stdout.read()).toBe("");
      expect(stderr.read()).toContain("not a usable workspace root");
      expect(stderr.read()).not.toContain('"version":1');
    },
    30_000,
  );
});
