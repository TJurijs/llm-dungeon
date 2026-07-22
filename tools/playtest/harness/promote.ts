import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  LlmModelCatalog,
  ModelSelectionSchema,
  type LlmProviderId,
} from "../../../src/llm-model-catalog.js";
import {
  ModelAssessmentCatalog,
  ShippedModelAssessmentSchema,
  type ShippedModelAssessment,
} from "../../../src/model-assessment-catalog.js";
import { ModelExecutionProfileStore } from "../../../src/model-execution-profile-store.js";
import {
  MODEL_EXECUTION_ADAPTER_REVISION,
  PhaseBudgetsSchema,
  TimeoutPolicySchema,
  type ShippedProfileEvidence,
} from "../../../src/model-execution-profile.js";
import { CERTIFICATION_PACKAGE_VERSION } from "../../../src/certification-version.js";
import { PROVIDER_COMPATIBILITY_FINGERPRINT } from "../../../src/connection-probe.js";
import { atomicWriteJson } from "../../../src/persistence/files.js";
import { withSerializedFileLock } from "../../../src/persistence/lock.js";
import { ProviderConfigSchema, type ProviderConfig } from "../../../src/schemas.js";
import { defaultDraftFor } from "./default-drafts.js";

const TargetSchema = z.object({
  provider: ProviderConfigSchema.shape.provider,
  model: z.string().trim().min(1).max(300),
  route: z.string().trim().min(1).max(100),
});

export interface PromoteModelEvidenceOptions {
  projectRoot: string;
  provider: ProviderConfig["provider"];
  model: string;
  route: string;
  /** Human-readable provenance stored alongside the shipped compatibility test; never read by the app. */
  note?: string | undefined;
}

export interface PromoteModelEvidenceResult {
  provider: LlmProviderId;
  model: string;
  route: string;
  profileFingerprint: string;
  promotedLanguages: string[];
  skippedLanguages: Array<{ language: string; reason: string }>;
  filesWritten: string[];
}

const ExecutionProfilesFileSchema = z.object({
  version: z.literal(1),
  profiles: z.array(z.object({
    provider: ProviderConfigSchema.shape.provider,
    model: z.string(),
    route: z.string(),
    calibratedAt: z.string(),
    evidenceRef: z.string(),
    outputBudgets: PhaseBudgetsSchema.optional(),
    timeout: TimeoutPolicySchema.optional(),
  }).strict()),
}).strict();

const AssessmentsFileSchema = z.object({
  version: z.literal(1),
  models: z.array(ShippedModelAssessmentSchema),
}).strict();

const LlmModelsFileSchema = z.object({
  version: z.number(),
  recommended: ModelSelectionSchema,
  providers: z.array(z.unknown()),
  retiredModels: z.array(z.unknown()),
  shippedTests: z.array(z.object({
    provider: ProviderConfigSchema.shape.provider,
    model: z.string(),
    testedAt: z.string(),
    protocolVersion: z.number(),
    testFingerprint: z.string(),
    testedLanguages: z.array(z.string()),
    note: z.string().optional(),
  }).strict()),
}).passthrough();

async function readJson<T>(target: string, schema: z.ZodType<T>): Promise<T> {
  return schema.parse(JSON.parse(await readFile(target, "utf8")));
}

/**
 * Reads a model's local calibrated profile, adapter status, current
 * certifications, and compatibility-probe record, validates they are all
 * mutually current (same profile fingerprint, current adapter/package
 * versions, current probe fingerprint), and writes the matching entries into
 * defaults/model-execution-profiles.json, defaults/model-assessments.json,
 * and defaults/llm-models.json's shippedTests — the three committed files a
 * fresh checkout reads. This is the only supported way to update those
 * files; hand-editing them risks exactly the fingerprint drift this
 * function guards against.
 *
 * Does not touch candidateModels — offering a model publicly remains a
 * separate, deliberate decision.
 */
export async function promoteModelEvidence(
  options: PromoteModelEvidenceOptions,
): Promise<PromoteModelEvidenceResult> {
  const target = TargetSchema.parse(options);
  const projectRoot = path.resolve(options.projectRoot);
  const defaultsRoot = path.join(projectRoot, "defaults");
  const EXECUTION_PROFILES_PATH = path.join(defaultsRoot, "model-execution-profiles.json");
  const ASSESSMENTS_PATH = path.join(defaultsRoot, "model-assessments.json");
  const LLM_MODELS_PATH = path.join(defaultsRoot, "llm-models.json");

  const profiles = new ModelExecutionProfileStore(projectRoot);
  const profile = await profiles.get(target);
  if (!profile) {
    throw new Error(
      `No frozen execution profile for ${target.provider}/${target.model} via ${target.route}; run playtest calibrate first`,
    );
  }

  const assessments = new ModelAssessmentCatalog(projectRoot);
  const assessment = await assessments.get(target);
  if (!assessment?.adapter) {
    throw new Error(`No calibration adapter record for ${target.provider}/${target.model}; run playtest calibrate first`);
  }
  if (assessment.adapter.status !== "calibrated") {
    throw new Error(`Adapter status is "${assessment.adapter.status}", not calibrated; nothing to promote`);
  }
  if (assessment.adapter.adapterRevision !== MODEL_EXECUTION_ADAPTER_REVISION) {
    throw new Error(
      `Adapter revision ${assessment.adapter.adapterRevision} is stale (current is ${MODEL_EXECUTION_ADAPTER_REVISION}); recalibrate before promoting`,
    );
  }
  if (assessment.adapter.profileFingerprint !== profile.fingerprint) {
    throw new Error(
      "Adapter's calibrated profile fingerprint does not match the frozen profile on disk; recalibrate before promoting",
    );
  }
  if (!assessment.adapter.evidence) {
    throw new Error("Calibration record has no evidence reference; recalibrate before promoting");
  }

  const currentCertifications = assessment.certifications.filter((certification) =>
    certification.packageVersion === String(CERTIFICATION_PACKAGE_VERSION)
    && certification.profileFingerprint === profile.fingerprint);
  const skippedLanguages = assessment.certifications
    .filter((certification) => !currentCertifications.includes(certification))
    .map((certification) => ({
      language: certification.language,
      reason: certification.packageVersion !== String(CERTIFICATION_PACKAGE_VERSION)
        ? `stale certification package version ${certification.packageVersion}`
        : "certification profile fingerprint does not match the current frozen profile",
    }));
  if (currentCertifications.length === 0) {
    throw new Error(`No current certification for ${target.provider}/${target.model}; run playtest certify first`);
  }

  const catalog = new LlmModelCatalog(projectRoot, { testFingerprint: PROVIDER_COMPATIBILITY_FINGERPRINT });
  const snapshot = await catalog.snapshot();
  const catalogModel = snapshot.providers
    .find((provider) => provider.id === target.provider)
    ?.models.find((candidate) => candidate.model === target.model);
  if (!catalogModel?.test || catalogModel.state !== "compatible") {
    throw new Error(
      `No current compatibility probe for ${target.provider}/${target.model}; run playtest probe first`,
    );
  }
  if (catalogModel.test.testFingerprint !== PROVIDER_COMPATIBILITY_FINGERPRINT) {
    throw new Error(
      `Compatibility probe fingerprint is stale for ${target.provider}/${target.model}; run playtest probe again before promoting`,
    );
  }

  const baseline = defaultDraftFor({ provider: target.provider, model: target.model } as ProviderConfig, target.route);
  const outputBudgetsOverride = JSON.stringify(profile.outputBudgets) !== JSON.stringify(baseline.outputBudgets)
    ? profile.outputBudgets
    : undefined;
  const timeoutOverride = JSON.stringify(profile.timeout) !== JSON.stringify(baseline.timeout)
    ? profile.timeout
    : undefined;

  const profileEntry: ShippedProfileEvidence = {
    provider: target.provider,
    model: target.model,
    route: target.route,
    calibratedAt: assessment.adapter.updatedAt,
    evidenceRef: assessment.adapter.evidence.reference,
    ...(outputBudgetsOverride ? { outputBudgets: outputBudgetsOverride } : {}),
    ...(timeoutOverride ? { timeout: timeoutOverride } : {}),
  };

  const assessmentEntry: ShippedModelAssessment = ShippedModelAssessmentSchema.parse({
    provider: target.provider,
    model: target.model,
    route: target.route,
    profileFingerprint: profile.fingerprint,
    calibrationReference: assessment.adapter.evidence.reference,
    calibratedAt: assessment.adapter.updatedAt,
    certifications: currentCertifications.map((certification) => ({
      language: certification.language,
      technicalStatus: certification.technicalStatus,
      recoveryCount: certification.recoveryCount ?? 0,
      qualityStatus: certification.qualityStatus,
      candidateMetricsHash: certification.candidateMetricsHash,
      reference: certification.evidence.reference,
      recordedAt: certification.evidence.recordedAt,
    })),
  });

  const testEntry = {
    provider: target.provider,
    model: target.model,
    testedAt: catalogModel.test.testedAt,
    protocolVersion: catalogModel.test.protocolVersion,
    testFingerprint: catalogModel.test.testFingerprint,
    testedLanguages: catalogModel.test.testedLanguages,
    ...(options.note ? { note: options.note } : {}),
  };

  const filesWritten: string[] = [];

  await withSerializedFileLock(`${EXECUTION_PROFILES_PATH}.lock`, "shipped execution profiles", async () => {
    const file = await readJson(EXECUTION_PROFILES_PATH, ExecutionProfilesFileSchema);
    const index = file.profiles.findIndex((entry) =>
      entry.provider === target.provider && entry.model === target.model && entry.route === target.route);
    if (index >= 0) file.profiles[index] = profileEntry;
    else file.profiles.push(profileEntry);
    await atomicWriteJson(EXECUTION_PROFILES_PATH, file);
  });
  filesWritten.push(path.relative(projectRoot, EXECUTION_PROFILES_PATH));

  await withSerializedFileLock(`${ASSESSMENTS_PATH}.lock`, "shipped assessments", async () => {
    const file = await readJson(ASSESSMENTS_PATH, AssessmentsFileSchema);
    const index = file.models.findIndex((entry) =>
      entry.provider === target.provider && entry.model === target.model && entry.route === target.route);
    if (index >= 0) file.models[index] = assessmentEntry;
    else file.models.push(assessmentEntry);
    await atomicWriteJson(ASSESSMENTS_PATH, file);
  });
  filesWritten.push(path.relative(projectRoot, ASSESSMENTS_PATH));

  await withSerializedFileLock(`${LLM_MODELS_PATH}.lock`, "curated model data", async () => {
    const file = await readJson(LLM_MODELS_PATH, LlmModelsFileSchema);
    const index = file.shippedTests.findIndex((entry) =>
      entry.provider === target.provider && entry.model === target.model);
    if (index >= 0) file.shippedTests[index] = testEntry;
    else file.shippedTests.push(testEntry);
    await atomicWriteJson(LLM_MODELS_PATH, file);
  });
  filesWritten.push(path.relative(projectRoot, LLM_MODELS_PATH));

  return {
    provider: target.provider,
    model: target.model,
    route: target.route,
    profileFingerprint: profile.fingerprint,
    promotedLanguages: currentCertifications.map((certification) => certification.language),
    skippedLanguages,
    filesWritten,
  };
}
