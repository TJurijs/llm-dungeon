import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

const REPOSITORY_ROOT = path.resolve(import.meta.dirname, "..");
const ENGINE_ENTRY = path.join(REPOSITORY_ROOT, "src", "engine.ts");

/** Relative import specifiers, including re-exports, in one module. */
function relativeSpecifiers(source: string): string[] {
  return [...source.matchAll(/\bfrom\s+"(\.[^"]+)"/gu)].map((match) => match[1]!);
}

/**
 * Every module the engine reaches, directly or transitively.
 *
 * The seam this asserts is otherwise conventional: the lint rule covers only the
 * one-way dependency on `tools/`, and nothing stopped an operational concern
 * from being imported into the gameplay path. `spending` did exactly that, which
 * is why the boundary is pinned here rather than described and trusted.
 */
async function engineClosure(): Promise<Set<string>> {
  const seen = new Set<string>();
  const pending = [ENGINE_ENTRY];
  while (pending.length > 0) {
    const current = pending.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);
    const source = await readFile(current, "utf8");
    for (const specifier of relativeSpecifiers(source)) {
      const resolved = path.resolve(path.dirname(current), specifier);
      // Source is TypeScript; NodeNext specifiers name the emitted .js.
      const target = resolved.endsWith(".js") ? `${resolved.slice(0, -3)}.ts` : `${resolved}.ts`;
      if (!seen.has(target)) pending.push(target);
    }
  }
  return seen;
}

function repoRelative(files: Iterable<string>): string[] {
  return [...files].map((file) => path.relative(REPOSITORY_ROOT, file).replaceAll(path.sep, "/"));
}

/**
 * Modules the engine must never reach.
 *
 * Presentation, provider construction, and the catalogs are all downstream of
 * the engine: they may depend on it, never the reverse. The playtest harness is
 * a developer tool outside the shipped app entirely.
 */
const FORBIDDEN_PREFIXES = [
  "src/cli.ts",
  "src/cli/",
  "src/web-server.ts",
  "src/web/",
  "src/providers.ts",
  "src/providers/",
  "src/campaign-catalog.ts",
  "src/llm-model-catalog.ts",
  "src/model-assessment-catalog.ts",
  "src/model-execution-profile-store.ts",
  "src/connection-probe.ts",
  "src/world-profile.ts",
  "tools/",
];

/**
 * Non-gameplay modules the engine currently reaches, pinned deliberately.
 *
 * Two are vocabulary only: `model-execution-profile` supplies three type
 * aliases through `types.ts`, and `scenario-contracts` supplies one Zod schema.
 * `input-budget` guards the model call itself and is treated as core.
 *
 * `spending` is the one real crosscut. A logical turn's USD envelope is held
 * across adjudication and locked resolution and its retries share one durable
 * operation ID, so the state is turn-scoped and currently lives where the turn
 * lives. Inverting it means the provider wrapper learns the turn boundary.
 *
 * A fifth entry appearing here is a design decision, not a detail. Make it
 * deliberately and update this list, or inject the dependency instead.
 */
const PINNED_OPERATIONAL_DEPENDENCIES = [
  "src/input-budget.ts",
  "src/persistence/campaign-catalog.ts",
  "src/model-execution-profile.ts",
  "src/scenario-contracts.ts",
  "src/spending.ts",
];

describe("engine boundary", () => {
  it("never reaches presentation, provider construction, the catalogs, or the harness", async () => {
    const closure = repoRelative(await engineClosure());
    const violations = closure
      .filter((file) => FORBIDDEN_PREFIXES.some((prefix) => file.startsWith(prefix)))
      .sort();

    expect(violations).toEqual([]);
  });

  it("pins the non-gameplay modules the engine still depends on", async () => {
    const closure = new Set(repoRelative(await engineClosure()));
    const reached = PINNED_OPERATIONAL_DEPENDENCIES.filter((file) => closure.has(file));

    // Exact equality in both directions: a new operational dependency fails, and
    // so does a stale pin left behind after one is removed.
    expect(reached).toEqual(PINNED_OPERATIONAL_DEPENDENCIES);
  });

  it("takes only the archived-status check from the catalog's on-disk format", async () => {
    // The catalog manager stays outside the engine and the test above proves it.
    // The on-disk metadata format is shared, because a catalog-owned store must
    // refuse to mutate an archived campaign or one whose identity no longer
    // matches. That is a documented invariant and a read-only check.
    //
    // Pinned to one symbol in one module so the crossing cannot quietly widen
    // into the engine depending on catalog management.
    const store = await readFile(path.join(REPOSITORY_ROOT, "src", "store.ts"), "utf8");
    const imported = [
      ...store.matchAll(/import\s+\{([^}]*)\}\s+from\s+"\.\/persistence\/campaign-catalog\.js"/gu),
    ].flatMap((match) =>
      match[1]!
        .split(",")
        .map((name) => name.trim())
        .filter(Boolean),
    );

    expect(imported).toEqual(["readCampaignMetadata"]);

    const closure = repoRelative(await engineClosure());
    const importers = closure.filter((file) => file === "src/maintenance.ts");
    expect(importers, "maintenance is an operator tool, not part of the engine").toEqual([]);
  });

  it("keeps one campaign's durable state inside the engine", async () => {
    const closure = new Set(repoRelative(await engineClosure()));

    // The project's central bet is that code owns truth, which means the store
    // owns truth. Commit, locking, and pending-turn recovery are the mechanics
    // substrate, not a peer of it: a turn cannot be tested without the thing
    // that commits it. Multi-campaign management is separate and stays separate.
    for (const file of [
      "src/store.ts",
      "src/persistence/markdown.ts",
      "src/persistence/commit.ts",
      "src/persistence/lock.ts",
      "src/persistence/pending.ts",
      "src/mechanics.ts",
      "src/schemas.ts",
      "src/domain/transaction.ts",
      "src/llm/gameplay-protocol.ts",
    ]) {
      expect(closure.has(file), `${file} must stay inside the engine`).toBe(true);
    }
  });
});
