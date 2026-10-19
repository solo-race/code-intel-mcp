import { access, readFile, readdir } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const DOCTOR_STAGES = ["prerequisites", "configuration", "executable", "spawn", "initialize", "catalog", "fixture-read", "root-binding", "sandbox-approval", "cleanup"] as const;
export type DoctorStageId = typeof DOCTOR_STAGES[number];
export interface DoctorStage {
  id: DoctorStageId;
  status: "pass" | "fail" | "skipped" | "unknown";
  reason: string;
  detail: string;
}
export interface DoctorReport { host: "codex"; ok: boolean; stages: DoctorStage[] }

export function newDoctorReport(): DoctorReport {
  return {
    host: "codex", ok: false,
    stages: DOCTOR_STAGES.map((id) => id === "sandbox-approval"
      ? { id, status: "unknown", reason: "HOST_EVIDENCE_UNAVAILABLE", detail: "A direct probe does not establish host sandbox or approval policy." }
      : { id, status: "skipped", reason: "DEPENDENCY_NOT_PASSED", detail: "A prerequisite stage has not passed." }),
  };
}

export function setDoctorStage(report: DoctorReport, id: DoctorStageId, status: DoctorStage["status"], reason: string, detail: string): void {
  Object.assign(report.stages.find((stage) => stage.id === id)!, { status, reason, detail });
}

/** Builtins only. Inspect installed manifests, including required transitive packages,
 * before Bun evaluates any dependency-backed module. Resolution never downloads. */
export async function doctorPreflight(entryUrl: string): Promise<DoctorReport> {
  const report = newDoctorReport();
  const install = fileURLToPath(new URL("../", entryUrl));
  const visited = new Set<string>();
  async function inspect(manifest: string): Promise<void> {
    if (visited.has(manifest)) return;
    visited.add(manifest);
    const data = JSON.parse(await readFile(manifest, "utf8")) as { dependencies?: Record<string, string> };
    const resolver = createRequire(manifest);
    for (const name of Object.keys(data.dependencies ?? {})) {
      let found: string | undefined;
      for (const directory of resolver.resolve.paths(name) ?? []) {
        const candidate = path.join(directory, name, "package.json");
        try { await access(candidate); found = candidate; break; } catch { /* try next installed location */ }
      }
      if (!found) throw new Error("missing dependency");
      await inspect(found);
    }
  }
  try {
    for (const name of ["@ltd/j-toml", "@modelcontextprotocol/client", "@modelcontextprotocol/server", "@oh-my-pi/pi-natives", "zod"]) {
      await inspect(path.join(install, "node_modules", name, "package.json"));
    }
    // The pinned native package has no required dependencies: its platform
    // addon is optional in npm metadata, but required by a source installation.
    const tag = `${process.platform}-${process.arch}`;
    const native = path.join(install, "node_modules", "@oh-my-pi", "pi-natives");
    const locations = [path.join(native, "native")];
    const resolver = createRequire(path.join(native, "package.json"));
    for (const directory of resolver.resolve.paths(`@oh-my-pi/pi-natives-${tag}`) ?? []) {
      locations.push(path.join(directory, `@oh-my-pi/pi-natives-${tag}`));
    }
    const filenames = [`pi_natives.${tag}.node`, `pi_natives.${tag}-baseline.node`, `pi_natives.${tag}-modern.node`];
    let addon = false;
    for (const directory of locations) {
      try { if ((await readdir(directory)).some((name) => filenames.includes(name))) { addon = true; break; } }
      catch { /* try the next local addon location */ }
    }
    if (!addon) throw new Error("missing native addon");
    setDoctorStage(report, "prerequisites", "pass", "LOCAL_DEPENDENCIES_AVAILABLE", "Local parser, SDK, dependency manifests, and platform native addon are available.");
  } catch {
    setDoctorStage(report, "prerequisites", "fail", "MISSING_RUNTIME_DEPENDENCY", "Local runtime dependencies are missing or unreadable; use a complete installation. No installation was attempted.");
  }
  return report;
}
