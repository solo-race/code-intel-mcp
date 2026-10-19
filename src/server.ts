import { McpServer, type Transport } from "@modelcontextprotocol/server";
import { z } from "zod";

import { auditTool, auditTransport, initializeAudit } from "./audit.ts";
import { runAstEditPreview } from "./ast/edit-preview.ts";
import { guardedAstEditApply } from "./ast/guarded-apply.ts";
import { capturePreviewState } from "./ast/preview-state.ts";
import { ApplyStateUncertainError, PreviewRegistry } from "./ast/preview-registry.ts";
import { astSearch } from "./ast/search.ts";
import {
  astTransformationPlanInputSchema,
  astTransformationPreviewInputSchema,
  AstTransformationPlanPreviewError,
  runAstTransformationPlanPreview,
  runAstTransformationPreview,
} from "./ast/transformation-plan.ts";
import { isAbsoluteWorkspaceRoot, Workspace, WorkspaceError } from "./workspace.ts";

const astSearchInputSchema = z
  .object({
    pattern: z.string().min(1),
    path: z.string().min(1).optional(),
    glob: z.string().min(1).optional(),
    offset: z.number().int().min(0).optional(),
    limit: z.number().int().positive().optional(),
  })
  .strict();

const astEditPreviewInputSchema = z
  .object({
    operations: astTransformationPreviewInputSchema.shape.operations,
    path: z.string().min(1),
    glob: z.string().min(1).optional(),
    maxFiles: z.number().int().positive().optional(),
    failOnParseError: z.boolean().optional(),
  })
  .strict();

const astEditApplyInputSchema = z
  .object({
    previewId: z.string().min(1),
  })
  .strict();

function successResult(value: object, text: string) {
  return {
    content: [{ type: "text" as const, text }],
    structuredContent: value,
  };
}

class AuditedMcpServer extends McpServer {
  override connect(transport: Transport): Promise<void> {
    return super.connect(auditTransport(transport));
  }
}

/** Omit the fixed workspace for request-routed global serving. */
export function createMcpServer(fixedWorkspace?: Workspace): McpServer {
  initializeAudit();
  const server = new AuditedMcpServer({
    name: "code-intel-mcp",
    version: "0.1.0",
  });
  const previewRegistry = new PreviewRegistry();
  const absoluteRoot = z.string().min(1).refine(isAbsoluteWorkspaceRoot, {
    message: "workspaceRoot must be an absolute directory path",
  });
  const routing = {
    workspaceRoot: fixedWorkspace === undefined ? absoluteRoot : absoluteRoot.optional(),
  };

  async function resolveWorkspace(rootInput: string | undefined): Promise<Workspace> {
    if (rootInput === undefined && fixedWorkspace !== undefined) return fixedWorkspace;
    const workspace = await Workspace.createAbsolute(rootInput);
    if (fixedWorkspace !== undefined && workspace.root !== fixedWorkspace.root) {
      throw new WorkspaceError(
        "WORKSPACE_ROOT_MISMATCH",
        "request workspaceRoot differs from the fixed startup workspace",
      );
    }
    return workspace;
  }

  server.registerTool(
    "ast_search",
    {
      description: "Find structural AST matches in source; supply an absolute workspaceRoot in global mode.",
      annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
      inputSchema: astSearchInputSchema.extend(routing),
    },
    async (input) => auditTool("ast_search", async () => {
      const { workspaceRoot, ...request } = input;
      const workspace = await resolveWorkspace(workspaceRoot);
      const result = await astSearch(workspace, request);
      return successResult(result, "ast_search completed");
    }),
  );

  server.registerTool(
    "ast_edit_preview",
    {
      description: "Preview structural AST rewrites without changing source; review the preview before applying its previewId.",
      annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false },
      inputSchema: astEditPreviewInputSchema.extend(routing),
    },
    async (input) => auditTool("ast_edit_preview", async () => {
      const { workspaceRoot, ...request } = input;
      const workspace = await resolveWorkspace(workspaceRoot);
      const execution = await runAstEditPreview(workspace, request);
      const previewId = await capturePreviewState(previewRegistry, execution);
      return successResult(
        { ...execution.result, previewId },
        "ast_edit_preview completed",
      );
    }),
  );

  server.registerTool(
    "ast_transform_preview",
    {
      description:
        "Preview a single-file AST transformation with rationale and symbol references without changing source; review before applying its previewId.",
      annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false },
      inputSchema: astTransformationPreviewInputSchema.extend(routing),
    },
    async (input) => auditTool("ast_transform_preview", async () => {
      const { workspaceRoot, ...request } = input;
      const workspace = await resolveWorkspace(workspaceRoot);
      const execution = await runAstTransformationPreview(workspace, request);
      const previewId = await capturePreviewState(previewRegistry, execution);
      return successResult(
        {
          ...execution.result,
          transformation: execution.contract.transformation,
          ...(execution.contract.verification === undefined ? {} : {
            verification: execution.contract.verification,
          }),
          previewId,
        },
        "ast_transform_preview completed",
      );
    }),
  );

  server.registerTool(
    "ast_transform_plan_preview",
    {
      description:
        "Preview an ordered multi-file AST plan without changing source; review each step before applying its independent previewId.",
      annotations: { readOnlyHint: true, idempotentHint: false, openWorldHint: false },
      inputSchema: astTransformationPlanInputSchema.extend(routing),
    },
    async (input) => auditTool("ast_transform_plan_preview", async () => {
      const { workspaceRoot, ...request } = input;
      const workspace = await resolveWorkspace(workspaceRoot);
      try {
        const result = await runAstTransformationPlanPreview(workspace, previewRegistry, request);
        return successResult(result, "ast_transform_plan_preview completed");
      } catch (error) {
        if (!(error instanceof AstTransformationPlanPreviewError)) throw error;
        return {
          isError: true,
          content: [{ type: "text" as const, text: error.message }],
          structuredContent: {
            steps: error.steps,
            stepIndex: error.stepIndex,
            completedResults: error.completedResults,
            notAttemptedStepIndexes: error.notAttemptedStepIndexes,
            error: error.failure,
          },
        };
      }
    }),
  );

  server.registerTool(
    "ast_edit_apply",
    {
      description:
        "Apply only a reviewed previewId through guarded source mutation; revalidates reviewed file state and rejects replay.",
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: false },
      inputSchema: astEditApplyInputSchema,
    },
    async (input) => auditTool("ast_edit_apply", async () => {
      try {
        const applied = await guardedAstEditApply(previewRegistry, input.previewId);
        return successResult(
          {
            ...applied.result,
            previewId: applied.previewId,
            workspaceRoot: applied.workspaceRoot,
            ...(applied.transformation === undefined ? {} : {
              transformation: applied.transformation,
            }),
            ...(applied.verification === undefined ? {} : {
              verification: applied.verification,
            }),
          },
          "ast_edit_apply completed",
        );
      } catch (error) {
        if (!(error instanceof ApplyStateUncertainError) || error.verification === undefined) throw error;
        return {
          isError: true,
          content: [{ type: "text" as const, text: error.message }],
          structuredContent: {
            previewId: input.previewId,
            error: { code: error.code, message: error.message },
            verification: error.verification,
          },
        };
      }
    }),
  );

  return server;
}
