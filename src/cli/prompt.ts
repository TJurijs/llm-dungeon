import * as p from "@clack/prompts";

export class CliCancelledError extends Error {
  constructor() {
    super("CLI interaction cancelled");
    this.name = "CliCancelledError";
  }
}

export function takePrompt<T>(value: T | symbol): T {
  if (p.isCancel(value)) {
    p.cancel("Cancelled.");
    throw new CliCancelledError();
  }
  return value as T;
}
