import { describe, expect, it } from "vitest";
import { sanitizeTerminalText, terminalHeading } from "../src/terminal-style.js";

describe("terminal presentation safety", () => {
  it("removes provider-controlled terminal sequences while preserving readable whitespace", () => {
    const unsafe = "First\r\nSecond\t\u001b]52;c;clipboard\u0007\u001b[31mred\u001b[0m\rrewritten";

    expect(sanitizeTerminalText(unsafe)).toBe("First\nSecond\t]52;c;clipboard[31mred[0mrewritten");
    expect(terminalHeading("\u001b]0;spoofed\u0007Campaign")).not.toContain("\u001b]0;");
  });
});
