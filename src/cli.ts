#!/usr/bin/env node
import { unsupportedNodeMessage } from "./node-version.js";

async function main(): Promise<void> {
  const versionError = unsupportedNodeMessage(process.versions.node);
  if (versionError !== undefined) {
    console.error(versionError);
    process.exitCode = 1;
    return;
  }

  const [p, { CliCancelledError }, { createCliProgram }, { createCliProjectContext }] = await Promise.all([
    import("@clack/prompts"),
    import("./cli/prompt.js"),
    import("./cli/program.js"),
    import("./cli/project-context.js"),
  ]);
  const project = createCliProjectContext(process.cwd());
  try {
    await createCliProgram(project).parseAsync();
  } catch (error) {
    if (error instanceof CliCancelledError) return;
    p.log.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

void main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
