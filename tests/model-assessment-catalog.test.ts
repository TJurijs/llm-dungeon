import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { ModelAssessmentCatalog } from "../src/model-assessment-catalog.js";
import { MODEL_EXECUTION_ADAPTER_REVISION } from "../src/model-execution-profile.js";

const fingerprintA = "a".repeat(64);
const fingerprintB = "b".repeat(64);
const target = { provider: "openai" as const, model: "gpt-5.6-terra", route: "direct" };

/**
 * The catalog holds calibration evidence and nothing else.
 *
 * It used to hold certification too — a per-language technical and quality
 * verdict — and most of this file tested that. Certification was removed as a
 * feature, so those tests went with it rather than being kept alive against a
 * verdict nothing can produce.
 */
describe("model assessment catalog", () => {
  it("reports an uncalibrated route on a fresh installation", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "llm-dungeon-assessment-shipped-"));
    const catalog = new ModelAssessmentCatalog(root);
    await expect(
      catalog.effective({ provider: "gemini", model: "gemini-3.5-flash", route: "direct" }),
    ).resolves.toMatchObject({ adapterStatus: "uncalibrated" });
    await expect(
      catalog.effective({ provider: "deepseek", model: "deepseek-v4-flash", route: "direct" }),
    ).resolves.toMatchObject({ adapterStatus: "uncalibrated" });
  });

  it("records calibration and keeps recommendation a separate question", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "llm-dungeon-assessment-"));
    const catalog = new ModelAssessmentCatalog(root, () => new Date("2026-07-19T00:00:00.000Z"));
    expect(await catalog.effective(target)).toMatchObject({
      adapterStatus: "uncalibrated",
      recommendation: { eligible: false, reasons: ["adapter_not_calibrated"] },
    });

    await catalog.recordCalibration({
      ...target,
      status: "calibrated",
      adapterRevision: MODEL_EXECUTION_ADAPTER_REVISION,
      profileFingerprint: fingerprintA,
      evidence: { source: "calibration", reference: "calibrations/openai-terra" },
    });

    expect(await catalog.effective(target)).toMatchObject({
      adapterStatus: "calibrated",
      profileFingerprint: fingerprintA,
      recommendation: { eligible: true, reasons: [] },
      evidence: [{ source: "calibration", reference: "calibrations/openai-terra" }],
    });
  });

  it("refuses calibrated status without a frozen profile fingerprint", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "llm-dungeon-assessment-unfrozen-"));
    const catalog = new ModelAssessmentCatalog(root);
    await expect(
      catalog.recordCalibration({
        ...target,
        status: "calibrated",
        evidence: { source: "calibration", reference: "calibrations/unfrozen" },
      }),
    ).rejects.toThrow("frozen profile fingerprint");
  });

  it("retires calibration recorded against a superseded adapter revision", async () => {
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
            },
          ],
        },
        null,
        2,
      )}\n`,
    );

    // Shipped profiles were calibrated against the retired adapter revision, so
    // neither the local nor the shipped record is current.
    await expect(catalog.effective(shippedTarget)).resolves.toMatchObject({
      adapterStatus: "uncalibrated",
      profileFingerprint: shipped!.adapter!.profileFingerprint,
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
    // Writing an unrelated route must not rewrite the stale local history.
    expect(
      persisted.models.find((model) => model.model === shippedTarget.model)?.adapter,
    ).toMatchObject({
      adapterRevision: MODEL_EXECUTION_ADAPTER_REVISION - 1,
      profileFingerprint: fingerprintA,
    });
  });

  it("still loads a record written while certification existed", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "llm-dungeon-assessment-legacy-"));
    const catalog = new ModelAssessmentCatalog(root);
    await mkdir(path.dirname(catalog.filePath), { recursive: true });
    // A user's config file predates the removal. Every route in one carries a
    // certifications array, so it must be discarded rather than rejected:
    // refusing the file strands the calibration sitting beside it and blocks
    // model settings, playtest preflight, and provider construction.
    await writeFile(
      catalog.filePath,
      `${JSON.stringify({
        version: 1,
        models: [
          {
            ...target,
            adapter: {
              status: "calibrated",
              adapterRevision: MODEL_EXECUTION_ADAPTER_REVISION,
              profileFingerprint: fingerprintA,
              evidence: { source: "calibration", reference: "calibrations/legacy" },
              updatedAt: "2026-07-18T00:00:00.000Z",
            },
            certifications: [
              {
                language: "en",
                packageId: "certification-v1",
                packageVersion: "3",
                protocolVersion: 2,
                profileFingerprint: fingerprintA,
                technicalStatus: "clean",
                recoveryCount: 0,
                qualityStatus: "high",
                candidateMetricsHash: "d".repeat(64),
                evidence: { source: "certification", reference: "playtests/legacy" },
                certifiedAt: "2026-07-18T00:00:00.000Z",
              },
            ],
          },
        ],
      })}\n`,
    );
    await expect(catalog.effective(target)).resolves.toMatchObject({
      adapterStatus: "calibrated",
      profileFingerprint: fingerprintA,
    });
    // Dropped on the next write rather than carried forward.
    await catalog.recordCalibration({
      ...target,
      status: "calibrated",
      adapterRevision: MODEL_EXECUTION_ADAPTER_REVISION,
      profileFingerprint: fingerprintB,
      evidence: { source: "calibration", reference: "calibrations/rewrite" },
    });
    expect(await readFile(catalog.filePath, "utf8")).not.toContain("certifications");
  });

  it("keeps Gemini 3.6 Flash product-recommended without any run evidence", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "llm-dungeon-assessment-gemini-"));
    const catalog = new ModelAssessmentCatalog(root);
    // Recommendation is a product decision. It used to require a current
    // certification, which would have made every route permanently ineligible
    // once certification was removed.
    await expect(
      catalog.effective({ provider: "gemini", model: "gemini-3.6-flash", route: "direct" }),
    ).resolves.toMatchObject({
      recommendation: { eligible: true, reasons: ["product_recommended_default"] },
    });
  });

  it("serializes concurrent in-process writes without losing either route", async () => {
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
    await expect(first.effective(target)).resolves.toMatchObject({
      adapterStatus: "calibrated",
    });
    await expect(second.effective(gemini)).resolves.toMatchObject({
      adapterStatus: "calibrated",
    });
  });
});
