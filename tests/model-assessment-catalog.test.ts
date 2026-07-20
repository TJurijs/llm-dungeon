import { mkdtemp } from "node:fs/promises";
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
    await expect(catalog.effective(
      { provider: "gemini", model: "gemini-3.5-flash", route: "direct" },
      "en",
    )).resolves.toMatchObject({
      adapterStatus: "calibrated",
      technicalStatus: "clean",
      recoveryCount: 0,
      qualityStatus: "high",
      certificationCurrent: true,
    });
    await expect(catalog.effective(
      { provider: "deepseek", model: "deepseek-v4-flash", route: "direct" },
      "ru",
    )).resolves.toMatchObject({
      adapterStatus: "calibrated",
      technicalStatus: "playable_with_recovery",
      recoveryCount: 2,
      qualityStatus: "high",
      certificationCurrent: true,
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
    await expect(catalog.recordCertification({
      ...target,
      language: "en",
      packageId: "mechanics-v1",
      packageVersion: "1",
      profileFingerprint: fingerprintA,
      technicalStatus: "clean",
      qualityStatus: "high",
      candidateMetricsHash: metricsHash,
      evidence: { source: "certification", reference: "playtests/mechanics" },
    })).rejects.toThrow("Only certification-v1");
  });

  it("keeps Gemini 3.5 Flash product-recommended with shipped certification evidence", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "llm-dungeon-assessment-gemini-"));
    const catalog = new ModelAssessmentCatalog(root);
    const effective = await catalog.effective(
      { provider: "gemini", model: "gemini-3.5-flash", route: "direct" },
      "ru",
    );
    expect(effective.recommendation).toMatchObject({
      eligible: true,
      reasons: ["product_recommended_default"],
    });
    expect(effective.qualityStatus).toBe("high");
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
    await expect(first.effective(target, "en")).resolves.toMatchObject({ adapterStatus: "calibrated" });
    await expect(second.effective(gemini, "ru")).resolves.toMatchObject({ adapterStatus: "calibrated" });
  });
});
