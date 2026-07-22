import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { promoteModelEvidence } from "../tools/playtest/harness/promote.js";
import { LlmModelCatalog } from "../src/llm-model-catalog.js";
import { ModelAssessmentCatalog } from "../src/model-assessment-catalog.js";
import { ModelExecutionProfileStore } from "../src/model-execution-profile-store.js";
import {
  MODEL_EXECUTION_ADAPTER_REVISION,
  freezeModelExecutionProfile,
  type FrozenModelExecutionProfile,
} from "../src/model-execution-profile.js";
import { CERTIFICATION_PACKAGE_VERSION } from "../src/certification-version.js";
import { PROVIDER_COMPATIBILITY_FINGERPRINT } from "../src/connection-probe.js";

// A synthetic model id under a real provider. LlmModelCatalog, ModelExecutionProfileStore,
// and ModelAssessmentCatalog each merge in "shipped" release defaults from the real,
// checked-out repo's defaults/ files (module-level constants, not project-root-relative),
// so a real curated model id here would pick up real shipped evidence and defeat test
// isolation. A synthetic id has no shipped entry anywhere, so only what each test seeds
// into the temp root's local config/ is in play.
const TARGET = { provider: "deepseek", model: "deepseek-v4-flash-promote-test", route: "direct" } as const;
const HASH_A = "a".repeat(64);
const HASH_B = "b".repeat(64);

function draft(outputBudgetsOverrides: Partial<Record<"setup" | "decision" | "lockedResolution" | "repair", number>> = {}) {
  return {
    schemaVersion: 1 as const,
    key: TARGET,
    structuredOutput: { mode: "json_object_local_schema" as const, projection: "identity_v1" as const, reinforceSchema: true as const },
    temperature: { policy: "omitted" as const },
    reasoning: { policy: "deepseek_thinking_for_repairs" as const },
    outputTokenField: "max_tokens" as const,
    outputBudgets: { setup: 8_000, decision: 4_000, lockedResolution: 4_000, repair: 8_000, ...outputBudgetsOverrides },
    timeout: { setupMs: 180_000, decisionMs: 120_000, lockedResolutionMs: 120_000, repairMs: 120_000 },
    adapterRevision: MODEL_EXECUTION_ADAPTER_REVISION,
  };
}

const roots: string[] = [];
async function tempProjectRoot(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "promote-"));
  roots.push(root);
  const defaultsDir = path.join(root, "defaults");
  await mkdir(defaultsDir, { recursive: true });
  await writeFile(
    path.join(defaultsDir, "model-execution-profiles.json"),
    `${JSON.stringify({ version: 1, profiles: [] }, null, 2)}\n`,
  );
  await writeFile(
    path.join(defaultsDir, "model-assessments.json"),
    `${JSON.stringify({ version: 1, models: [] }, null, 2)}\n`,
  );
  await writeFile(
    path.join(defaultsDir, "llm-models.json"),
    `${JSON.stringify({
      version: 1,
      recommended: { provider: "gemini", model: "gemini-3.5-flash" },
      providers: [],
      retiredModels: [],
      shippedTests: [],
    }, null, 2)}\n`,
  );
  return root;
}

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function seedCalibrated(root: string, outputBudgetsOverrides = {}): Promise<FrozenModelExecutionProfile> {
  const profile = freezeModelExecutionProfile({
    ...draft(outputBudgetsOverrides),
    calibratedAt: "2026-07-20T00:00:00.000Z",
    evidenceRef: "playtests/calibration/test-run",
  });
  await new ModelExecutionProfileStore(root).put(profile);
  await new ModelAssessmentCatalog(root).recordCalibration({
    ...TARGET,
    status: "calibrated",
    adapterRevision: MODEL_EXECUTION_ADAPTER_REVISION,
    profileFingerprint: profile.fingerprint,
    evidence: { source: "calibration", reference: "playtests/calibration/test-run" },
  });
  return profile;
}

async function seedCertification(
  root: string,
  language: "en" | "ru",
  profileFingerprint: string,
  packageVersion = String(CERTIFICATION_PACKAGE_VERSION),
): Promise<void> {
  await new ModelAssessmentCatalog(root).recordCertification({
    ...TARGET,
    language,
    packageId: "certification-v1",
    packageVersion,
    profileFingerprint,
    technicalStatus: "clean",
    recoveryCount: 0,
    qualityStatus: "high",
    candidateMetricsHash: language === "en" ? HASH_A : HASH_B,
    evidence: {
      source: "certification",
      reference: `playtests/jobs/test-${language}`,
      recordedAt: "2026-07-20T00:00:01.000Z",
    },
  });
}

async function seedCompatibilityProbe(root: string, languages: readonly ("en" | "ru")[] = ["en", "ru"]): Promise<void> {
  const catalog = new LlmModelCatalog(root, { testFingerprint: PROVIDER_COMPATIBILITY_FINGERPRINT, protocolVersion: 1 });
  await catalog.recordTestSuccess({ provider: TARGET.provider, model: TARGET.model }, { testedLanguages: languages });
}

async function seedFullyCurrent(root: string, outputBudgetsOverrides = {}): Promise<FrozenModelExecutionProfile> {
  const profile = await seedCalibrated(root, outputBudgetsOverrides);
  await seedCertification(root, "en", profile.fingerprint);
  await seedCertification(root, "ru", profile.fingerprint);
  await seedCompatibilityProbe(root);
  return profile;
}

describe("promoteModelEvidence", () => {
  it("refuses to promote a model with no frozen execution profile", async () => {
    const root = await tempProjectRoot();
    await expect(promoteModelEvidence({ projectRoot: root, ...TARGET }))
      .rejects.toThrow(/No frozen execution profile/);
  });

  it("refuses to promote an uncalibrated adapter", async () => {
    const root = await tempProjectRoot();
    const profile = freezeModelExecutionProfile({
      ...draft(),
      calibratedAt: "2026-07-20T00:00:00.000Z",
      evidenceRef: "playtests/calibration/test-run",
    });
    await new ModelExecutionProfileStore(root).put(profile);
    await expect(promoteModelEvidence({ projectRoot: root, ...TARGET }))
      .rejects.toThrow(/No calibration adapter record/);
  });

  it("refuses to promote when the assessment's profile fingerprint does not match the frozen profile on disk", async () => {
    const root = await tempProjectRoot();
    const profile = freezeModelExecutionProfile({
      ...draft(),
      calibratedAt: "2026-07-20T00:00:00.000Z",
      evidenceRef: "playtests/calibration/test-run",
    });
    await new ModelExecutionProfileStore(root).put(profile);
    // Freeze a second, differently-budgeted profile so its fingerprint genuinely
    // differs, then register the FIRST profile's frozen fingerprint as the
    // adapter's calibrated fingerprint via a direct catalog write below — simplest
    // is to just record calibration against a fingerprint that belongs to neither.
    await new ModelAssessmentCatalog(root).recordCalibration({
      ...TARGET,
      status: "calibrated",
      adapterRevision: MODEL_EXECUTION_ADAPTER_REVISION,
      profileFingerprint: freezeModelExecutionProfile({
        ...draft({ repair: 32_000 }),
        calibratedAt: "2026-07-20T00:00:00.000Z",
        evidenceRef: "playtests/calibration/other-run",
      }).fingerprint,
      evidence: { source: "calibration", reference: "playtests/calibration/test-run" },
    });
    await expect(promoteModelEvidence({ projectRoot: root, ...TARGET }))
      .rejects.toThrow(/does not match the frozen profile/);
  });

  it("refuses to promote when there is no current certification", async () => {
    const root = await tempProjectRoot();
    await seedCalibrated(root);
    await expect(promoteModelEvidence({ projectRoot: root, ...TARGET }))
      .rejects.toThrow(/No current certification/);
  });

  it("refuses to promote when the compatibility probe is missing", async () => {
    const root = await tempProjectRoot();
    const profile = await seedCalibrated(root);
    await seedCertification(root, "en", profile.fingerprint);
    await expect(promoteModelEvidence({ projectRoot: root, ...TARGET }))
      .rejects.toThrow(/No current compatibility probe/);
  });

  it("promotes only the still-current language and reports one made stale by a later recalibration as skipped", async () => {
    const root = await tempProjectRoot();
    // First calibration generation: RU gets certified against it.
    const first = await seedCalibrated(root);
    await seedCertification(root, "ru", first.fingerprint);
    // A recalibration moves the adapter to a new fingerprint (e.g. a budget fix);
    // EN gets certified against the new one, but RU's certification is now stale.
    const second = await seedCalibrated(root, { repair: 16_000 });
    await seedCertification(root, "en", second.fingerprint);
    await seedCompatibilityProbe(root);

    const result = await promoteModelEvidence({ projectRoot: root, ...TARGET });
    expect(result.promotedLanguages).toEqual(["en"]);
    expect(result.skippedLanguages).toEqual([
      { language: "ru", reason: "certification profile fingerprint does not match the current frozen profile" },
    ]);
    expect(result.profileFingerprint).toBe(second.fingerprint);
  });

  it("reports a stale certification package version as skipped", async () => {
    const root = await tempProjectRoot();
    const profile = await seedCalibrated(root);
    await seedCertification(root, "en", profile.fingerprint);
    await seedCertification(root, "ru", profile.fingerprint, "1"); // superseded package version
    await seedCompatibilityProbe(root);

    const result = await promoteModelEvidence({ projectRoot: root, ...TARGET });
    expect(result.promotedLanguages).toEqual(["en"]);
    expect(result.skippedLanguages).toEqual([
      { language: "ru", reason: "stale certification package version 1" },
    ]);
  });

  it("writes matching entries to all three defaults files and omits budget/timeout overrides that equal the default draft", async () => {
    const root = await tempProjectRoot();
    const profile = await seedFullyCurrent(root);

    const result = await promoteModelEvidence({ projectRoot: root, ...TARGET, note: "test provenance" });
    expect(result.promotedLanguages.slice().sort()).toEqual(["en", "ru"]);
    expect(result.skippedLanguages).toEqual([]);
    expect(result.filesWritten).toHaveLength(3);

    const profilesFile = JSON.parse(await readFile(path.join(root, "defaults", "model-execution-profiles.json"), "utf8"));
    const profileEntry = profilesFile.profiles.find((entry: { model: string }) => entry.model === TARGET.model);
    expect(profileEntry).toMatchObject({ provider: "deepseek", model: TARGET.model, route: "direct" });
    expect(profileEntry.outputBudgets).toBeUndefined();
    expect(profileEntry.timeout).toBeUndefined();

    const assessmentsFile = JSON.parse(await readFile(path.join(root, "defaults", "model-assessments.json"), "utf8"));
    const assessmentEntry = assessmentsFile.models.find((entry: { model: string }) => entry.model === TARGET.model);
    expect(assessmentEntry.profileFingerprint).toBe(profile.fingerprint);
    expect(assessmentEntry.certifications.map((c: { language: string }) => c.language).sort()).toEqual(["en", "ru"]);

    const llmModelsFile = JSON.parse(await readFile(path.join(root, "defaults", "llm-models.json"), "utf8"));
    const testEntry = llmModelsFile.shippedTests.find((entry: { model: string }) => entry.model === TARGET.model);
    expect(testEntry).toMatchObject({ testFingerprint: PROVIDER_COMPATIBILITY_FINGERPRINT, note: "test provenance" });
    expect(testEntry.testedLanguages.slice().sort()).toEqual(["en", "ru"]);
  });

  it("includes budget/timeout overrides when the profile diverges from the default draft", async () => {
    const root = await tempProjectRoot();
    await seedFullyCurrent(root, { repair: 16_000 });

    await promoteModelEvidence({ projectRoot: root, ...TARGET });
    const profilesFile = JSON.parse(await readFile(path.join(root, "defaults", "model-execution-profiles.json"), "utf8"));
    const entry = profilesFile.profiles.find((e: { model: string }) => e.model === TARGET.model);
    expect(entry.outputBudgets).toMatchObject({ repair: 16_000 });
  });

  it("is idempotent: re-running upserts in place instead of duplicating entries", async () => {
    const root = await tempProjectRoot();
    await seedFullyCurrent(root);

    await promoteModelEvidence({ projectRoot: root, ...TARGET });
    await promoteModelEvidence({ projectRoot: root, ...TARGET });

    const profilesFile = JSON.parse(await readFile(path.join(root, "defaults", "model-execution-profiles.json"), "utf8"));
    expect(profilesFile.profiles.filter((e: { model: string }) => e.model === TARGET.model)).toHaveLength(1);
    const assessmentsFile = JSON.parse(await readFile(path.join(root, "defaults", "model-assessments.json"), "utf8"));
    expect(assessmentsFile.models.filter((e: { model: string }) => e.model === TARGET.model)).toHaveLength(1);
    const llmModelsFile = JSON.parse(await readFile(path.join(root, "defaults", "llm-models.json"), "utf8"));
    expect(llmModelsFile.shippedTests.filter((e: { model: string }) => e.model === TARGET.model)).toHaveLength(1);
  });
});
