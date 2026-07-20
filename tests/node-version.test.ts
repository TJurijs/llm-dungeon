import { describe, expect, it } from "vitest";
import { MINIMUM_NODE_MAJOR, unsupportedNodeMessage } from "../src/node-version.js";

describe("Node.js startup version", () => {
  it("accepts the supported major version and newer releases", () => {
    expect(MINIMUM_NODE_MAJOR).toBe(22);
    expect(unsupportedNodeMessage("22.0.0")).toBeUndefined();
    expect(unsupportedNodeMessage("24.1.2")).toBeUndefined();
  });

  it("returns a direct diagnostic for old or malformed versions", () => {
    expect(unsupportedNodeMessage("18.20.5"))
      .toBe("llm-dungeon requires Node.js 22 or newer. Current version: 18.20.5.");
    expect(unsupportedNodeMessage("unknown")).toContain("Current version: unknown");
  });
});
