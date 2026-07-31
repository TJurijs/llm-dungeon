import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ModelAssessmentCatalog } from "../src/model-assessment-catalog.js";
import { MODEL_EXECUTION_ADAPTER_REVISION } from "../src/model-execution-profile.js";
import { CERTIFICATION_PACKAGE_VERSION } from "../tools/playtest/harness/packages.js";

const fingerprintA = "a".repeat(64);
const fingerprintB = "b".repeat(64);
const metricsHash = "c".repeat(64);
const target = { provider: "openai" as const, model: "gpt-5.6-terra", route: "direct" };

describe("model assessment catalog", () => {
  it("provides language-specific release assessments on a fresh installation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "llm-dungeon-assessment-shipped-"));
    const catalog = new ModelAssessmentCatalog(root);
    await expect(
      catalog.effective({ provider: "gemini", model: "gemini-3.5-flash", route: "direct" }, "en"),
    ).resolves.toMatchObject({
      adapterStatus: "uncalibrated",
      technicalStatus: "inconclusive",
      recoveryCount: 0,
      qualityStatus: "unrated",
      certificationCurrent: false,
    });
    await expect(
      catalog.effective(
        { provider: "deepseek", model: "deepseek-v4-flash", route: "direct" },
        "ru",
      ),
    ).resolves.toMatchObject({
      adapterStatus: "uncalibrated",
      technicalStatus: "inconclusive",
      recoveryCount: 0,
      qualityStatus: "unrated",
      certificationCurrent: false,
    });
  });

  it("keeps calibration, technical, quality, and recommendation results separate", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "llm-dungeon-assessment-"));
    const catalog = new ModelAssessmentCatalog(root, () => new Date("2026-07-19T00:00:00.000Z"));
    expect(await catalog.effective(target, "en")).toMatchObject({
      adapterStatus: "uncalibrated",
      technicalStatus: "inconclusive",
      qualityStatus: "unrated",
      recommendation: { eligible: false },
    });
    await catalog.recordCalibration({
      ...target,
      status: "calibrated",
      adapterRevision: MODEL_EXECUTION_ADAPTER_REVISION,
      profileFingerprint: fingerprintA,
      evidence: { source: "calibration", reference: "calibrations/run-a" },
    });
    await catalog.recordCertification({
      ...target,
      language: "en",
      packageId: "certification-v1",
      packageVersion: String(CERTIFICATION_PACKAGE_VERSION),
      profileFingerprint: fingerprintA,
      technicalStatus: "playable_with_recovery",
      recoveryCount: 3,
      qualityStatus: "high",
      candidateMetricsHash: metricsHash,
      evidence: {
        source: "certification",
        reference: "playtests/runs/cert-a",
        packageId: "certification-v1",
        packageVersion: String(CERTIFICATION_PACKAGE_VERSION),
      },
    });
    expect(await catalog.effective(target, "en")).toMatchObject({
      adapterStatus: "calibrated",
      technicalStatus: "playable_with_recovery",
      recoveryCount: 3,
      qualityStatus: "high",
      certificationCurrent: true,
      recommendation: { eligible: true, reasons: [] },
    });
  });

  it("invalidates certification when the frozen profile fingerprint changes", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "llm-dungeon-assessment-stale-"));
    const catalog = new ModelAssessmentCatalog(root, () => new Date("2026-07-19T00:00:00.000Z"));
    await catalog.recordCalibration({
      ...target,
      status: "calibrated",
      adapterRevision: MODEL_EXECUTION_ADAPTER_REVISION,
      profileFingerprint: fingerprintA,
      evidence: { source: "calibration", reference: "calibrations/a" },
    });
    await catalog.recordCertification({
      ...target,
      language: "en",
      packageId: "certification-v1",
      packageVersion: String(CERTIFICATION_PACKAGE_VERSION),
      profileFingerprint: fingerprintA,
      technicalStatus: "clean",
      qualityStatus: "high",
      candidateMetricsHash: metricsHash,
      evidence: { source: "certification", reference: "playtests/a" },
    });
    await catalog.recordCalibration({
      ...target,
      status: "calibrated",
      adapterRevision: MODEL_EXECUTION_ADAPTER_REVISION,
      profileFingerprint: fingerprintB,
      evidence: { source: "calibration", reference: "calibrations/b" },
    });
    expect(await catalog.effective(target, "en")).toMatchObject({
      certificationCurrent: false,
      technicalStatus: "inconclusive",
      qualityStatus: "unrated",
      recommendation: { eligible: false, reasons: ["certification_profile_stale"] },
    });
  });

  it("falls back to current shipped evidence while preserving stale local upgrade history", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "llm-dungeon-assessment-upgrade-"));
    const catalog = new ModelAssessmentCatalog(root);
    const shippedTarget = {
      provider: "gemini" as const,
      model: "gemini-3.5-flash",
      route: "direct",
    };
    const shipped = await catalog.get(shippedTarget);
    expect(shipped?.adapter?.profileFingerprint).toBeDefined();
    await mkdir(path.dirname(catalog.filePath), { recursive: true });
    await writeFile(
      catalog.filePath,
      `${JSON.stringify(
        {
          version: 1,
          models: [
            {
              ...shippedTarget,
              adapter: {
                status: "calibrated",
                adapterRevision: MODEL_EXECUTION_ADAPTER_REVISION - 1,
                profileFingerprint: fingerprintA,
                evidence: {
                  source: "calibration",
                  reference: "calibrations/pre-upgrade-local",
                },
                updatedAt: "2026-07-18T00:00:00.000Z",
              },
              certifications: [
                {
                  language: "en",
                  packageId: "certification-v1",
                  packageVersion: String(CERTIFICATION_PACKAGE_VERSION),
                  profileFingerprint: fingerprintA,
                  technicalStatus: "unstable",
                  recoveryCount: 9,
                  qualityStatus: "low",
                  candidateMetricsHash: metricsHash,
                  evidence: {
                    source: "certification",
                    reference: "playtests/pre-upgrade-local",
                  },
                  certifiedAt: "2026-07-18T00:00:00.000Z",
                },
              ],
            },
          ],
        },
        null,
        2,
      )}\n`,
    );

    await expect(catalog.effective(shippedTarget, "en")).resolves.toMatchObject({
      // Shipped profiles were calibrated against the retired adapter revision.
      adapterStatus: "uncalibrated",
      profileFingerprint: shipped!.adapter!.profileFingerprint,
      technicalStatus: "inconclusive",
      recoveryCount: 0,
      qualityStatus: "unrated",
      certificationCurrent: false,
    });

    await catalog.recordCalibration({
      ...target,
      status: "calibrated",
      adapterRevision: MODEL_EXECUTION_ADAPTER_REVISION,
      profileFingerprint: fingerprintB,
      evidence: { source: "calibration", reference: "calibrations/unrelated-current" },
    });
    const persisted = JSON.parse(await readFile(catalog.filePath, "utf8")) as {
      models: Array<{
        model: string;
        adapter?: { adapterRevision?: number; profileFingerprint?: string };
      }>;
    };
    expect(
      persisted.models.find((model) => model.model === shippedTarget.model)?.adapter,
    ).toMatchObject({
      adapterRevision: MODEL_EXECUTION_ADAPTER_REVISION - 1,
      profileFingerprint: fingerprintA,
    });
  });

  it("prefers current local calibration and certification over shipped evidence", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "llm-dungeon-assessment-local-current-"));
    const catalog = new ModelAssessmentCatalog(root);
    const shippedTarget = {
      provider: "gemini" as const,
      model: "gemini-3.5-flash",
      route: "direct",
    };
    await catalog.recordCalibration({
      ...shippedTarget,
      status: "calibrated",
      adapterRevision: MODEL_EXECUTION_ADAPTER_REVISION,
      profileFingerprint: fingerprintB,
      evidence: { source: "calibration", reference: "calibrations/current-local" },
    });
    await catalog.recordCertification({
      ...shippedTarget,
      language: "en",
      packageId: "certification-v1",
      packageVersion: String(CERTIFICATION_PACKAGE_VERSION),
      profileFingerprint: fingerprintB,
      technicalStatus: "playable_with_recovery",
      recoveryCount: 1,
      qualityStatus: "medium",
      candidateMetricsHash: metricsHash,
      evidence: { source: "certification", reference: "playtests/current-local" },
    });

    await expect(catalog.effective(shippedTarget, "en")).resolves.toMatchObject({
      adapterStatus: "calibrated",
      profileFingerprint: fingerprintB,
      technicalStatus: "playable_with_recovery",
      recoveryCount: 1,
      qualityStatus: "medium",
      certificationCurrent: true,
    });
  });

  it("rejects diagnostic packages as authoritative certification evidence", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "llm-dungeon-assessment-package-"));
    const catalog = new ModelAssessmentCatalog(root);
    await catalog.recordCalibration({
      ...target,
      status: "calibrated",
      adapterRevision: MODEL_EXECUTION_ADAPTER_REVISION,
      profileFingerprint: fingerprintA,
      evidence: { source: "calibration", reference: "calibrations/a" },
    });
    await expect(
      catalog.recordCertification({
        ...target,
        language: "en",
        packageId: "mechanics-v1",
        packageVersion: "1",
        profileFingerprint: fingerprintA,
        technicalStatus: "clean",
        qualityStatus: "high",
        candidateMetricsHash: metricsHash,
        evidence: { source: "certification", reference: "playtests/mechanics" },
      }),
    ).rejects.toThrow("Only certification-v1");
  });

  it("keeps Gemini 3.6 Flash product-recommended with shipped certification evidence", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "llm-dungeon-assessment-gemini-"));
    const catalog = new ModelAssessmentCatalog(root);
    const effective = await catalog.effective(
      { provider: "gemini", model: "gemini-3.6-flash", route: "direct" },
      "ru",
    );
    // The product-recommended default survives a lapsed certification; only
    // the evidence-backed quality rating falls back until a fresh run.
    expect(effective.recommendation).toMatchObject({
      eligible: true,
      reasons: ["product_recommended_default"],
    });
    expect(effective.qualityStatus).toBe("unrated");
    expect(effective.certificationCurrent).toBe(false);
  });

  it("serializes concurrent in-process assessment writes without losing either route", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "llm-dungeon-assessment-concurrent-"));
    const first = new ModelAssessmentCatalog(root);
    const second = new ModelAssessmentCatalog(root);
    const gemini = { provider: "gemini" as const, model: "gemini-3.5-flash", route: "direct" };
    await Promise.all([
      first.recordCalibration({
        ...target,
        status: "calibrated",
        adapterRevision: MODEL_EXECUTION_ADAPTER_REVISION,
        profileFingerprint: fingerprintA,
        evidence: { source: "calibration", reference: "calibrations/openai" },
      }),
      second.recordCalibration({
        ...gemini,
        status: "calibrated",
        adapterRevision: MODEL_EXECUTION_ADAPTER_REVISION,
        profileFingerprint: fingerprintB,
        evidence: { source: "calibration", reference: "calibrations/gemini" },
      }),
    ]);
    await expect(first.effective(target, "en")).resolves.toMatchObject({
      adapterStatus: "calibrated",
    });
    await expect(second.effective(gemini, "ru")).resolves.toMatchObject({
      adapterStatus: "calibrated",
    });
  });
});
