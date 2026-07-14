import { stdout } from "node:process";

const enabled = Boolean(stdout.isTTY) && !process.env.NO_COLOR;

function code(open: number, close = 0): (value: string) => string {
  return (value) => enabled ? `\u001b[${open}m${value}\u001b[${close}m` : value;
}

export const terminalStyle = {
  bold: code(1, 22),
  dim: code(2, 22),
  red: code(31, 39),
  green: code(32, 39),
  gold: code(33, 39),
  blue: code(36, 39),
  violet: code(35, 39),
};

export function terminalBanner(subtitle = "Persistent worlds. Unscripted adventures."): string {
  const line = terminalStyle.violet("━".repeat(58));
  return [
    "",
    line,
    `${terminalStyle.gold("◆")} ${terminalStyle.bold("LLM DUNGEON")}`,
    terminalStyle.dim(subtitle),
    line,
    "",
  ].join("\n");
}

export function terminalHeading(title: string, detail?: string): string {
  const heading = `${terminalStyle.gold("◆")} ${terminalStyle.bold(title)}`;
  return detail ? `${heading} ${terminalStyle.dim(`— ${detail}`)}` : heading;
}

export function terminalRule(): string {
  return terminalStyle.violet("─".repeat(58));
}

export function terminalPrompt(): string {
  return `${terminalStyle.gold("❯")} `;
}
