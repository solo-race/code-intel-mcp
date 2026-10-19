import { closeSync, openSync, writeSync } from "node:fs";
import { AsyncLocalStorage } from "node:async_hooks";

import { isJSONRPCRequest, isJSONRPCResponse, type RequestId, type Transport } from "@modelcontextprotocol/server";

type AuditedTool = "ast_search" | "ast_edit_preview" | "ast_transform_preview"
  | "ast_transform_plan_preview" | "ast_edit_apply";
type ResultCategory = "success" | "tool_error" | "internal_error";
const completion = new AsyncLocalStorage<{
  tool: AuditedTool;
  requestId: RequestId;
  category?: ResultCategory;
  recorded: boolean;
}>();

function isAuditedTool(name: unknown): name is AuditedTool {
  return name === "ast_search" || name === "ast_edit_preview" || name === "ast_transform_preview"
    || name === "ast_transform_plan_preview" || name === "ast_edit_apply";
}

const MAX_EVENTS = 256;
const MAX_BYTES = 128 * 1024;
const MAX_EVENT_BYTES = 512;

// One destination and budget for all server instances in this process.
let initialized = false;
let destination: number | undefined;
let events = 0;
let bytes = 0;

function diagnostic(): void {
  try {
    writeSync(2, "CODE_INTEL_AUDIT_UNAVAILABLE: capture disabled; destination unavailable or configuration invalid.\n");
  } catch {
    // Reporting failure must not change tool execution either.
  }
}

function stop(): void {
  const fd = destination;
  destination = undefined;
  if (fd !== undefined && fd !== 2) {
    try { closeSync(fd); } catch { diagnostic(); }
  }
}

/** Read caller opt-in once, without exposing configuration values in diagnostics. */
export function initializeAudit(): void {
  if (initialized) return;
  initialized = true;
  const mode = process.env.CODE_INTEL_AUDIT;
  if (mode === undefined || mode === "" || mode === "off") return;
  if (mode === "stderr") {
    destination = 2;
    return;
  }
  if (mode === "file" && process.env.CODE_INTEL_AUDIT_FILE) {
    try {
      // Existing parent only; exclusive creation refuses an earlier artifact.
      destination = openSync(process.env.CODE_INTEL_AUDIT_FILE, "wx", 0o600);
      return;
    } catch {
      diagnostic();
      return;
    }
  }
  diagnostic();
}

function record(tool: AuditedTool, resultCategory: ResultCategory): void {
  if (destination === undefined) return;
  const line = JSON.stringify({ timestamp: new Date().toISOString(), tool, resultCategory }) + "\n";
  const size = Buffer.byteLength(line, "utf8");
  if (events >= MAX_EVENTS || size > MAX_EVENT_BYTES || bytes + size > MAX_BYTES) {
    stop();
    return;
  }
  try {
    const written = writeSync(destination, line);
    if (written !== size) throw new Error("incomplete audit write");
    events += 1;
    bytes += size;
    if (events === MAX_EVENTS || bytes === MAX_BYTES) stop();
  } catch {
    stop();
    diagnostic();
  }
}

/** Observe SDK completion through its public transport contract, without validating inputs. */
export function auditTransport(transport: Transport): Transport {
  const observed: Transport = {
    get sessionId() { return transport.sessionId; },
    get hasPerRequestStream() { return transport.hasPerRequestStream; },
    ...(transport.setProtocolVersion ? {
      setProtocolVersion: (version: string) => transport.setProtocolVersion!(version),
    } : {}),
    ...(transport.setSupportedProtocolVersions ? {
      setSupportedProtocolVersions: (versions: string[]) => transport.setSupportedProtocolVersions!(versions),
    } : {}),
    async start() {
      transport.onclose = () => observed.onclose?.();
      transport.onerror = (error) => observed.onerror?.(error);
      transport.onmessage = (message, extra) => {
        if (isJSONRPCRequest(message) && message.method === "tools/call"
          && isAuditedTool(message.params?.name)) {
          completion.run({ tool: message.params.name, requestId: message.id, recorded: false },
            () => observed.onmessage?.(message, extra));
        } else {
          observed.onmessage?.(message, extra);
        }
      };
      await transport.start();
    },
    async send(message, options) {
      await transport.send(message, options);
      const state = completion.getStore();
      if (state && !state.recorded && isJSONRPCResponse(message) && message.id === state.requestId) {
        state.recorded = true;
        const failed = "error" in message || message.result.isError === true;
        record(state.tool, state.category === "internal_error" ? "internal_error"
          : failed ? "tool_error" : "success");
      }
    },
    close: () => transport.close(),
  };
  return observed;
}

/** Preserve thrown-handler classification until the SDK sends its normal error response. */
export async function auditTool<T>(tool: AuditedTool, operation: () => Promise<T>): Promise<T> {
  initializeAudit();
  let result: T;
  try {
    result = await operation();
  } catch (error) {
    const state = completion.getStore();
    if (state) state.category = "internal_error";
    else record(tool, "internal_error");
    throw error;
  }
  if (!completion.getStore()) {
    record(tool, typeof result === "object" && result !== null && "isError" in result
      && result.isError === true ? "tool_error" : "success");
  }
  return result;
}
