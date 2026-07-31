import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  DOMAIN_RULES,
  domainRulePromptFragments,
  type DomainViolationCode,
} from "../src/domain/rules/registry.js";
import { adjudicationPromptDocument } from "../src/prompts.js";
import { DomainViolationCollector } from "../src/domain/violations.js";

const SOURCE_ROOT = fileURLToPath(new URL("../src", import.meta.url));
const REGISTRY_PATH = path.join(SOURCE_ROOT, "domain", "rules", "registry.ts");

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(
    entries.map(async (entry) => {
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(target);
      return entry.isFile() && target.endsWith(".ts") ? [target] : [];
    }),
  );
  return files.flat();
}

async function sourceOutsideRegistry(): Promise<string> {
  const files = (await sourceFiles(SOURCE_ROOT)).filter((file) => file !== REGISTRY_PATH);
  const contents = await Promise.all(files.map((file) => readFile(file, "utf8")));
  return contents.join("\n");
}

describe("domain rule registry", () => {
  it("declares a usable redaction for every rule", () => {
    for (const [code, rule] of Object.entries(DOMAIN_RULES)) {
      expect(code, `${code} must be lowercase snake_case`).toMatch(/^[a-z][a-z0-9_]*$/u);
      expect(rule.redacted.length, `${code} needs redacted text`).toBeGreaterThan(0);
      expect(rule.phases.length, `${code} needs at least one phase`).toBeGreaterThan(0);
    }
  });

  it("keeps redacted text free of campaign identifiers", () => {
    for (const [code, rule] of Object.entries(DOMAIN_RULES)) {
      // Redacted text reaches telemetry, so it must describe the rule only.
      expect(rule.redacted, `${code} leaks a namespaced ID`).not.toMatch(/[a-z]+:[a-z0-9-]+/u);
      expect(rule.redacted, `${code} leaks a quoted value`).not.toContain('"');
    }
  });

  it("has no rule that no check can ever report", async () => {
    const source = await sourceOutsideRegistry();
    const orphans = (Object.keys(DOMAIN_RULES) as DomainViolationCode[]).filter(
      (code) =>
        // A fully normalized rule is unreachable on purpose: deterministic
        // rewriting removes the operation before any check could report it. The
        // declaration survives to name what was normalized and why.
        DOMAIN_RULES[code].disposition !== "normalize" && !source.includes(`"${code}"`),
    );

    // A declaration nothing reports is dead weight that still renders prompt
    // prose and pollutes the repair ranking.
    expect(orphans).toEqual([]);
  });

  it("keeps a normalize rule fail-closed if normalization ever misses a case", () => {
    const collector = new DomainViolationCollector();
    const normalizeCode = (Object.keys(DOMAIN_RULES) as DomainViolationCode[]).find(
      (code) => DOMAIN_RULES[code].disposition === "normalize",
    );
    expect(normalizeCode).toBeDefined();

    collector.add(normalizeCode!, "Normalization did not remove this.");

    // `normalize` is a claim that a rewrite handles the case, not permission to
    // commit it unrewritten. If the claim is ever wrong the turn must still stop,
    // because the alternative is silently persisting what the rule forbids.
    expect(collector.signals()).toEqual([]);
    expect(collector.list().map((entry) => entry.code)).toEqual([normalizeCode]);
    expect(() => collector.assertNone()).toThrow();
  });

  it("lets the declared disposition decide whether a rule blocks a turn", () => {
    const collector = new DomainViolationCollector();
    const signalCode = (Object.keys(DOMAIN_RULES) as DomainViolationCode[]).find(
      (code) => DOMAIN_RULES[code].disposition === "signal",
    );
    const rejectCode = (Object.keys(DOMAIN_RULES) as DomainViolationCode[]).find(
      (code) => DOMAIN_RULES[code].disposition === "reject",
    );
    expect(signalCode).toBeDefined();
    expect(rejectCode).toBeDefined();

    collector.add(signalCode!, "Observed only.", { subjects: ["npc:someone"] });

    // A review-only rule neither blocks nor poisons dependent operations.
    expect(collector.list()).toEqual([]);
    expect(collector.signals().map((entry) => entry.code)).toEqual([signalCode]);
    expect(collector.isFailedSubject("npc:someone")).toBe(false);
    expect(() => collector.assertNone()).not.toThrow();

    collector.add(rejectCode!, "Blocks the turn.");
    expect(collector.list().map((entry) => entry.code)).toEqual([rejectCode]);
    expect(() => collector.assertNone()).toThrow();
  });

  it("states each enforced rule exactly once in the delivered prompt", () => {
    const delivered = adjudicationPromptDocument("CONTEXT", "I act.").text;
    const enforced = Object.values(DOMAIN_RULES).filter(
      (value) => value.prompt !== undefined && value.phases.includes("adjudication"),
    );

    expect(enforced.length).toBeGreaterThan(0);
    for (const value of enforced) {
      const occurrences = delivered.split(value.prompt!).length - 1;
      // A prose copy alongside the generated statement is how restatements
      // accumulated. One occurrence keeps the declaration the only source.
      expect(occurrences, `"${value.prompt!.slice(0, 50)}..." appears ${occurrences} times`).toBe(
        1,
      );
    }
  });

  it("renders deterministic prompt fragments per phase", () => {
    const first = domainRulePromptFragments("resolution");
    const second = domainRulePromptFragments("resolution");

    expect(first).toEqual(second);
    expect(first.length).toBeGreaterThan(0);
    expect(first.every((line) => line.startsWith("- "))).toBe(true);
    // A setup-only rule must not leak into gameplay phases.
    expect(domainRulePromptFragments("setup")).not.toEqual(first);
  });
});
