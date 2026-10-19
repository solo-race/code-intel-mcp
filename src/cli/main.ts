import { access } from "node:fs/promises";

import { runtimeEntry } from "./host-entry.ts";
import { doctorPreflight, setDoctorStage } from "./doctor-preflight.ts";

const HELP = `Usage (Bun runtime required):
  code-intel serve
  code-intel install --host codex --scope user [--dry-run]
  code-intel uninstall --host codex --scope user [--dry-run]
  code-intel print-config --host generic-stdio
  code-intel doctor --host codex [--config <path>]
  code-intel --help

Use an absolute Bun executable and absolute scripts/code-intel.mjs path.
Installation changes only Codex user configuration (CODEX_HOME/config.toml).
`;

export type CliCommand =
  | { readonly command: "help" }
  | { readonly command: "serve" }
  | { readonly command: "print-config" }
  | { readonly command: "doctor"; readonly configPath?: string }
  | { readonly command: "install" | "uninstall"; readonly dryRun: boolean };

export function parseCommand(args: readonly string[]): CliCommand {
  if (args.length === 0 || (args.length === 1 && ["help", "--help", "-h"].includes(args[0]!))) {
    return { command: "help" };
  }
  if (args.length === 1 && args[0] === "serve") return { command: "serve" };
  const command = args[0];
  if (command !== "install" && command !== "uninstall" && command !== "print-config" && command !== "doctor") {
    throw new Error("INVALID_ARGUMENTS: unsupported command or serve arguments; use --help");
  }
  const flags = new Map<string, string | true>();
  for (let index = 1; index < args.length; index += 1) {
    const flag = args[index]!;
    if (flags.has(flag)) throw new Error(`INVALID_ARGUMENTS: duplicate ${flag}`);
    if (flag === "--dry-run" && (command === "install" || command === "uninstall")) {
      flags.set(flag, true);
    } else if (flag === "--host" || (flag === "--scope" && (command === "install" || command === "uninstall")) || (flag === "--config" && command === "doctor")) {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new Error(`INVALID_ARGUMENTS: ${flag} requires a value`);
      flags.set(flag, value);
    } else {
      throw new Error(`INVALID_ARGUMENTS: unsupported option ${flag}`);
    }
  }
  if (command === "print-config") {
    if (flags.get("--host") !== "generic-stdio") throw new Error("UNSUPPORTED_HOST: print-config requires --host generic-stdio");
    return { command };
  }
  if (command === "doctor") {
    if (flags.get("--host") !== "codex") throw new Error("UNSUPPORTED_HOST: doctor requires --host codex");
    return { command, ...(flags.has("--config") ? { configPath: flags.get("--config") as string } : {}) };
  }
  if (flags.get("--host") !== "codex" || flags.get("--scope") !== "user") {
    throw new Error("UNSUPPORTED_HOST_OR_SCOPE: require --host codex --scope user");
  }
  return { command, dryRun: flags.has("--dry-run") };
}

/** Check local files before evaluating any module that imports package dependencies. */
async function requireLocalDependencies(entryUrl: string, names: readonly string[]): Promise<void> {
  for (const name of names) {
    try {
      await access(new URL(`../node_modules/${name}/package.json`, entryUrl));
    } catch {
      throw new Error(`MISSING_RUNTIME_DEPENDENCY: ${name}; use a complete installation with installed dependencies`);
    }
  }
}

export async function runCli(args: readonly string[], entryUrl: string): Promise<void> {
  const parsed = parseCommand(args);
  if (parsed.command === "help") {
    process.stdout.write(HELP);
  } else if (parsed.command === "serve") {
    // A complete source installation owns its local dependencies. Check before
    // importing runtime packages so Bun cannot auto-install an absent tree.
    await requireLocalDependencies(entryUrl, ["@modelcontextprotocol/server", "@oh-my-pi/pi-natives", "zod"]);
    const { startGlobalServer } = await import("../../index.ts");
    startGlobalServer();
  } else if (parsed.command === "print-config") {
    process.stdout.write(`${JSON.stringify(runtimeEntry(entryUrl), null, 2)}\n`);
  } else if (parsed.command === "doctor") {
    let report = await doctorPreflight(entryUrl);
    if (report.stages[0]!.status === "pass") {
      try {
        const { runDoctor } = await import("./doctor.ts");
        report = await runDoctor({ configPath: parsed.configPath, report });
      } catch {
        setDoctorStage(report, "prerequisites", "fail", "DEPENDENCY_LOAD_FAILED", "Local diagnostic modules could not be loaded; no installation was attempted.");
      }
    }
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (!report.ok) process.exitCode = 1;
  } else {
    await requireLocalDependencies(entryUrl, ["@ltd/j-toml"]);
    const { editCodexConfig } = await import("./codex-config.ts");
    const result = await editCodexConfig(parsed.command, runtimeEntry(entryUrl), { dryRun: parsed.dryRun });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  }
}
