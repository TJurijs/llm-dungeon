#!/usr/bin/env node
import * as p from "@clack/prompts";
import { CliCancelledError } from "./cli/prompt.js";
import { createCliProgram } from "./cli/program.js";
import { createCliProjectContext } from "./cli/project-context.js";

const project = createCliProjectContext(process.cwd());

createCliProgram(project).parseAsync().catch((error: unknown) => {
  if (error instanceof CliCancelledError) return;
  p.log.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
