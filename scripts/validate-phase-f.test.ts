import { expect, test } from "bun:test";
import { denialEvidence } from "./validate-phase-f.ts";

const target = String.raw`C:\fixture cache\工作 space\outside grant\sentinel.txt`;
const marker = "WRITE_F_fixture_unique";
const command = `Set-Content -LiteralPath '${target}' -Value '${marker}' -NoNewline -ErrorAction Stop`;
const completed = { type: "turn.completed" };
const narrative = [{ type: "item.completed", item: { type: "agent_message", text: `${command} rejected: blocked by policy` } }, completed];

// Sanitized retained native grammar: router frame, Rust debug message string,
// Rejected(string), then the wrapped command and policy outcome. No host run.
function router(write = command, tool = "exec_command", reason = "blocked by policy") {
  const detail = `\`"C:\\Program Files\\PowerShell\\7\\pwsh.exe" -Command "${write}"\` rejected: ${reason}`;
  const message = `Rejected(${JSON.stringify(detail)})`;
  return `2026-01-01T00:00:00.000000Z ERROR codex_core::tools::router: error=${tool} failed: CreateProcess { message: ${JSON.stringify(message)} }\r\n`;
}
function execution(exit_code: number, aggregated_output = "Access to the path is denied") {
  return { type: "item.completed", item: { type: "command_execution", command, exit_code, aggregated_output } };
}

test("retained native router rejection is attributable pre-spawn HOST_POLICY evidence", () => {
  const evidence = denialEvidence(narrative, target, marker, router(command.replaceAll("\\", "\\\\")));
  expect(evidence).toMatchObject({ status: "PASS", attempts: 1, denied: 1, routerAttempts: 1,
    commandExecutionAttempts: 0, successfulCommands: 0, completed: true, enforcementLayers: ["HOST_POLICY"] });
  // Command attribution is parsed separately from the native error envelope.
  expect(denialEvidence(narrative, target, marker, router(command.replaceAll("'", '"'))).status).toBe("PASS");
});

test("existing completed command denial retains its distinct OS/filesystem layer", () => {
  for (const output of ["Access to the path is denied", `Access to the path '${target}' is denied`, "Access is denied", "Permission denied"]) {
    expect(denialEvidence([execution(1, output), completed], target, marker)).toMatchObject({ status: "PASS",
      attempts: 1, denied: 1, commandExecutionAttempts: 1, routerAttempts: 0, enforcementLayers: ["OS_FILESYSTEM"] });
  }
});

test("model prose, unrelated target/marker/frame, and malformed router text stay BLOCK", () => {
  for (const stderr of [
    "", `${command} rejected: blocked by policy`,
    router(command.replace(target, `${target}.other`)), router(command.replace(marker, `${marker}_other`)),
    router(command, "ast_search"), router().replace("codex_core::tools::router:", "unrelated::router:"),
    router().replace(" ERROR ", " WARN "), router().replace("CreateProcess", "AgentMessage"),
    router(command, "exec_command", "an unrelated warning"), router().replace("message: \"", "message: broken\""),
    router(`Write-Output '${target} ${marker} Set-Content'`),
    router(`Write-Output "${command}"`),
  ]) {
    expect(denialEvidence(narrative, target, marker, stderr)).toMatchObject({ status: "BLOCK", attempts: 0, denied: 0 });
  }
  expect(denialEvidence([execution(1, "Model refused without an enforcement error"), completed], target, marker).status).toBe("BLOCK");
});

test("successful command overrides router denial; incomplete or repeated evidence stays BLOCK", () => {
  expect(denialEvidence([execution(0, ""), completed], target, marker, router())).toMatchObject({ status: "FAIL", successfulCommands: 1 });
  expect(denialEvidence([], target, marker, router()).status).toBe("BLOCK");
  expect(denialEvidence(narrative, target, marker, router() + router()).status).toBe("BLOCK");
});
