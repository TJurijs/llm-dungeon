import { mkdtemp, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_MODEL_EXECUTION_PROFILE_DRAFTS,
  MODEL_EXECUTION_ADAPTER_REVISION,
  freezeModelExecutionProfile,
  SHIPPED_MODEL_EXECUTION_PROFILES,
} from "../src/model-execution-profile.js";
import { ModelExecutionProfileStore } from "../src/model-execution-profile-store.js";

describe("ModelExecutionProfileStore", () => {
  it("provides calibrated release profiles on a fresh installation", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "llm-dungeon-profiles-shipped-"));
    const store = new ModelExecutionProfileStore(root);
    for (const profile of SHIPPED_MODEL_EXECUTION_PROFILES) {
      await expect(store.require(profile.key)).resolves.toEqual(profile);
    }
  });

  it("persists one frozen authority per provider/model/route", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "llm-dungeon-profiles-"));
    const store = new ModelExecutionProfileStore(root);
    const draft = DEFAULT_MODEL_EXECUTION_PROFILE_DRAFTS[0]!;
    const profile = freezeModelExecutionProfile({
      ...draft,
      calibratedAt: "2026-07-19T10:00:00.000Z",
      evidenceRef: "playtests/calibration/evidence-1",
    });

    await store.put(profile);

    await expect(store.require(profile.key)).resolves.toEqual(profile);
    await expect(store.get({ ...profile.key, route: "different" })).resolves.toBeUndefined();
  });

  it("atomically replaces the same route authority and rejects stale fingerprints", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "llm-dungeon-profiles-replace-"));
    const store = new ModelExecutionProfileStore(root);
    const draft = DEFAULT_MODEL_EXECUTION_PROFILE_DRAFTS[0]!;
    const original = freezeModelExecutionProfile({
      ...draft,
      calibratedAt: "2026-07-19T10:00:00.000Z",
      evidenceRef: "playtests/calibration/evidence-original",
    });
    const replacement = freezeModelExecutionProfile({
      ...draft,
      outputBudgets: { ...draft.outputBudgets, decision: 8_000 },
      calibratedAt: "2026-07-19T11:00:00.000Z",
      evidenceRef: "playtests/calibration/evidence-replacement",
    });

    await store.put(original);
    await store.put(replacement);

    const restored = await store.require(replacement.key);
    expect(restored).toEqual(replacement);
    expect(Object.isFrozen(restored)).toBe(true);
    expect(Object.isFrozen(restored.key)).toBe(true);
    expect(Object.isFrozen(restored.structuredOutput)).toBe(true);
    expect(Object.isFrozen(restored.outputBudgets)).toBe(true);
    expect(Object.isFrozen(restored.timeout)).toBe(true);
    expect(Reflect.set(restored.outputBudgets, "decision", 16_000)).toBe(false);
    await expect(store.require(replacement.key)).resolves.toEqual(replacement);
    const persisted = JSON.parse(await readFile(store.filePath, "utf8")) as {
      profiles: Array<{ fingerprint: string }>;
    };
    expect(persisted.profiles.find((profile) => profile.fingerprint === replacement.fingerprint))
      .toEqual({ ...replacement });
    await expect(store.put({
      ...replacement,
      fingerprint: "0".repeat(64),
    })).rejects.toThrow("stale fingerprint");
    const staleRevision = freezeModelExecutionProfile({
      ...draft,
      adapterRevision: MODEL_EXECUTION_ADAPTER_REVISION - 1,
      calibratedAt: "2026-07-19T12:00:00.000Z",
      evidenceRef: "playtests/calibration/stale-adapter",
    });
    await expect(store.put(staleRevision)).rejects.toThrow("current revision");
    await expect(store.require({ ...replacement.key, model: "missing-model" }))
      .rejects.toThrow("run playtest calibrate first");
  });

  it("preserves concurrent profiles for independent model routes", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "llm-dungeon-profiles-concurrent-"));
    const first = new ModelExecutionProfileStore(root);
    const second = new ModelExecutionProfileStore(root);
    const profileA = freezeModelExecutionProfile({
      ...DEFAULT_MODEL_EXECUTION_PROFILE_DRAFTS[0]!,
      calibratedAt: "2026-07-19T10:00:00.000Z",
      evidenceRef: "playtests/calibration/a",
    });
    const profileB = freezeModelExecutionProfile({
      ...DEFAULT_MODEL_EXECUTION_PROFILE_DRAFTS[1]!,
      calibratedAt: "2026-07-19T10:00:00.000Z",
      evidenceRef: "playtests/calibration/b",
    });
    await Promise.all([first.put(profileA), second.put(profileB)]);
    await expect(first.require(profileA.key)).resolves.toEqual(profileA);
    await expect(second.require(profileB.key)).resolves.toEqual(profileB);
  });
});
