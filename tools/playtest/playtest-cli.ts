#!/usr/bin/env node
import { unsupportedNodeMessage } from "../../src/node-version.js";

async function main(): Promise<void> {
  const versionError = unsupportedNodeMessage(process.versions.node);
  if (versionError !== undefined) throw new Error(versionError);
  const [{ createPlaytestCliProgram }, { createPlaytestProjectContext }] = await Promise.all([
    import("./cli/playtest-program.js"),
    import("./cli/playtest-project-context.js"),
  ]);
  await createPlaytestCliProgram(createPlaytestProjectContext(process.cwd())).parseAsync();
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
