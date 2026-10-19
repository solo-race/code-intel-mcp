import { serveStdio } from "@modelcontextprotocol/server/stdio";

import { createMcpServer } from "./src/server.ts";
import { Workspace } from "./src/workspace.ts";

function workspaceRootArgument(args: string[]): string {
  if (args.length !== 2 || args[0] !== "--workspace-root") {
    throw new Error(
      "WORKSPACE_ROOT_REQUIRED: start the server with --workspace-root <path>",
    );
  }
  const root = args[1];
  if (root === undefined || root.length === 0) {
    throw new Error(
      "WORKSPACE_ROOT_REQUIRED: --workspace-root must be followed by a path",
    );
  }
  return root;
}

export async function startServer(rootInput: string): Promise<void> {
  const workspace = await Workspace.create(rootInput);

  serveStdio(() => createMcpServer(workspace), {
    onerror: (error) => {
      console.error(`MCP_TRANSPORT_ERROR: ${error.message}`);
    },
  });
}

/** Global serving selects its workspace only from explicit requests. */
export function startGlobalServer(): void {
  serveStdio(() => createMcpServer(), {
    onerror: (error) => {
      console.error(`MCP_TRANSPORT_ERROR: ${error.message}`);
    },
  });
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "serve") {
    startGlobalServer();
    return;
  }
  await startServer(workspaceRootArgument(args));
}

if (import.meta.main) {
  try {
    await main();
  } catch (error) {
    const message = error instanceof Error ? error.message : "server startup failed";
    console.error(message);
    process.exitCode = 1;
  }
}
