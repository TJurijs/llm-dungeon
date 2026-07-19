import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { LanguageCodeSchema, type LanguageCode } from "./language.js";
import {
  ModelAdapterStatusSchema,
  ModelEvidenceReferenceSchema,
  ModelQualityStatusSchema,
  ModelRecommendationEligibilitySchema,
  ModelTechnicalGameplayStatusSchema,
  type ModelRecommendationEligibility,
} from "./model-status.js";
import { RECOMMENDED_MODEL_SELECTION, ModelSelectionSchema } from "./llm-model-catalog.js";
import { MODEL_EXECUTION_ADAPTER_REVISION } from "./model-execution-profile.js";
import { atomicWriteJson } from "./persistence/files.js";
import { acquireFileLock } from "./persistence/lock.js";
import { CERTIFICATION_PACKAGE_VERSION } from "./playtest/packages.js";

export const MODEL_ASSESSMENT_CATALOG_VERSION = 1 as const;
const MODEL_ASSESSMENT_LOCK_WAIT_MS = 5_000;
const MODEL_ASSESSMENT_LOCK_RETRY_MS = 25;
const modelAssessmentProcessQueues = new Map<string, Promise<void>>();

async function queueModelAssessmentOperation<T>(
  lockPath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previous = modelAssessmentProcessQueues.get(lockPath) ?? Promise.resolve();
  let releaseQueue!: () => void;
  const current = new Promise<void>((resolve) => { releaseQueue = resolve; });
  const tail = previous.then(() => current, () => current);
  modelAssessmentProcessQueues.set(lockPath, tail);
  await previous.catch(() => undefined);
  try {
    return await operation();
  } finally {
    releaseQueue();
    if (modelAssessmentProcessQueues.get(lockPath) === tail) {
      modelAssessmentProcessQueues.delete(lockPath);
    }
  }
}

async function acquireModelAssessmentLock(lockPath: string): Promise<() => Promise<void>> {
  const deadline = Date.now() + MODEL_ASSESSMENT_LOCK_WAIT_MS;
  for (;;) {
    try {
      return await acquireFileLock(lockPath, "model assessment catalog");
    } catch (error) {
      if (!/locked by another running process/i.test(String((error as Error).message))
        || Date.now() >= deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, MODEL_ASSESSMENT_LOCK_RETRY_MS));
    }
  }
}

const RouteKeySchema = ModelSelectionSchema.extend({
  route: z.string().trim().min(1).max(100),
}).strict();

const AdapterAssessmentSchema = z.object({
  status: ModelAdapterStatusSchema,
  adapterRevision: z.number().int().positive().optional(),
  profileFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
  evidence: ModelEvidenceReferenceSchema.optional(),
  updatedAt: z.string().datetime({ offset: true }),
}).strict().superRefine((assessment, context) => {
  if (assessment.status === "calibrated" && assessment.profileFingerprint === undefined) {
    context.addIssue({ code: "custom", path: ["profileFingerprint"], message: "calibrated status requires a frozen profile fingerprint" });
  }
});

const CertificationAssessmentSchema = z.object({
  language: LanguageCodeSchema,
  packageId: z.literal("certification-v1"),
  packageVersion: z.string().min(1).max(100),
  profileFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  technicalStatus: ModelTechnicalGameplayStatusSchema,
  recoveryCount: z.number().int().nonnegative().optional(),
  qualityStatus: ModelQualityStatusSchema,
  candidateMetricsHash: z.string().regex(/^[a-f0-9]{64}$/),
  evidence: ModelEvidenceReferenceSchema,
  certifiedAt: z.string().datetime({ offset: true }),
}).strict();

const ModelAssessmentSchema = RouteKeySchema.extend({
  adapter: AdapterAssessmentSchema.optional(),
  certifications: z.array(CertificationAssessmentSchema)
    .superRefine((items, context) => {
      const languages = new Set<string>();
      for (const [index, item] of items.entries()) {
        if (languages.has(item.language)) {
          context.addIssue({ code: "custom", path: [index, "language"], message: "duplicate certification language" });
        }
        languages.add(item.language);
      }
    }),
}).strict();

const PersistedAssessmentCatalogSchema = z.object({
  version: z.literal(MODEL_ASSESSMENT_CATALOG_VERSION),
  models: z.array(ModelAssessmentSchema),
}).strict().superRefine((catalog, context) => {
  const keys = new Set<string>();
  for (const [index, model] of catalog.models.entries()) {
    const key = assessmentKey(model);
    if (keys.has(key)) context.addIssue({ code: "custom", path: ["models", index], message: "duplicate model route" });
    keys.add(key);
  }
});

type PersistedAssessmentCatalog = z.infer<typeof PersistedAssessmentCatalogSchema>;
export type AdapterAssessment = z.infer<typeof AdapterAssessmentSchema>;
export type CertificationAssessment = z.infer<typeof CertificationAssessmentSchema>;

interface ShippedCertification {
  language: LanguageCode;
  technicalStatus: CertificationAssessment["technicalStatus"];
  recoveryCount: number;
  qualityStatus: CertificationAssessment["qualityStatus"];
  candidateMetricsHash: string;
  reference: string;
  recordedAt: string;
}

function shippedAssessment(input: z.infer<typeof RouteKeySchema> & {
  profileFingerprint: string;
  calibrationReference: string;
  calibratedAt: string;
  certifications: readonly ShippedCertification[];
}): z.infer<typeof ModelAssessmentSchema> {
  return ModelAssessmentSchema.parse({
    provider: input.provider,
    model: input.model,
    route: input.route,
    adapter: {
      status: "calibrated",
      adapterRevision: MODEL_EXECUTION_ADAPTER_REVISION,
      profileFingerprint: input.profileFingerprint,
      evidence: {
        source: "calibration",
        reference: input.calibrationReference,
        executionProfileFingerprint: input.profileFingerprint,
        recordedAt: input.calibratedAt,
      },
      updatedAt: input.calibratedAt,
    },
    certifications: input.certifications.map(({ reference, recordedAt, ...certification }) => ({
      ...certification,
      packageId: "certification-v1",
      packageVersion: String(CERTIFICATION_PACKAGE_VERSION),
      profileFingerprint: input.profileFingerprint,
      evidence: {
        source: "certification",
        reference,
        packageId: "certification-v1",
        packageVersion: String(CERTIFICATION_PACKAGE_VERSION),
        executionProfileFingerprint: input.profileFingerprint,
        recordedAt,
      },
      certifiedAt: recordedAt,
    })),
  });
}

const SHIPPED_MODEL_ASSESSMENTS = [
  shippedAssessment({ provider: "gemini", model: "gemini-3.5-flash", route: "direct", profileFingerprint: "957a28d5a3284d58a23032d92e2ed3e68c69c506c33722f14d722527f85a412e", calibrationReference: "playtests/calibration/gemini-3.5-flash-initial", calibratedAt: "2026-07-19T14:58:25.697Z", certifications: [
    { language: "en", technicalStatus: "clean", recoveryCount: 0, qualityStatus: "high", candidateMetricsHash: "2ec783316ec4e78e7e905aae0cc8e1246078583a2b652120820a5a0a64b5ac83", reference: "playtests/jobs/gemini-3.5-flash-en", recordedAt: "2026-07-19T22:33:20.118Z" },
    { language: "ru", technicalStatus: "playable_with_recovery", recoveryCount: 1, qualityStatus: "high", candidateMetricsHash: "8237edb3768ae375412c6bd68ccbd7f2161a3bf3666164ca1afa15b31d3f3a67", reference: "playtests/jobs/gemini-3.5-flash-ru", recordedAt: "2026-07-19T22:33:20.150Z" },
  ] }),
  shippedAssessment({ provider: "gemini", model: "gemini-3.1-flash-lite", route: "direct", profileFingerprint: "af8ddfd75ce068f9aca9573ca43bf38a4915f3b91f1f47040aa5a38dcbee4caa", calibrationReference: "playtests/calibration/gemini-3.1-flash-lite-initial", calibratedAt: "2026-07-19T20:01:51.243Z", certifications: [
    { language: "en", technicalStatus: "clean", recoveryCount: 0, qualityStatus: "high", candidateMetricsHash: "a282d1debe76104dba496bc63d4369b378b25da05be805325a6719b155f8726e", reference: "playtests/jobs/gemini-3.1-flash-lite-en", recordedAt: "2026-07-19T22:33:19.686Z" },
    { language: "ru", technicalStatus: "clean", recoveryCount: 0, qualityStatus: "high", candidateMetricsHash: "4890b9429d438cd64a870f191b2d4bccc5486824c4c5e0a8f9d0949feef68ef9", reference: "playtests/jobs/gemini-3.1-flash-lite-ru", recordedAt: "2026-07-19T22:33:19.717Z" },
  ] }),
  shippedAssessment({ provider: "openrouter", model: "qwen/qwen3.7-plus", route: "openrouter", profileFingerprint: "cde93c7e308b9ff9a0f250490bd0bc106d9c9230de7c186a1babeeafa2abbcac", calibrationReference: "playtests/calibration/qwen-qwen3.7-plus-initial", calibratedAt: "2026-07-19T20:43:30.760Z", certifications: [
    { language: "en", technicalStatus: "playable_with_recovery", recoveryCount: 1, qualityStatus: "high", candidateMetricsHash: "5aec5000977e69deedfb4033215880259c63f80bef5a528409f0d516dc424573", reference: "playtests/jobs/qwen-qwen3.7-plus-en", recordedAt: "2026-07-19T20:46:53.798Z" },
    { language: "ru", technicalStatus: "unstable", recoveryCount: 1, qualityStatus: "awaiting_judgment", candidateMetricsHash: "92b78cb3a2156d441bde83808a6c942e220aea4017b3f4094c3f5530d8b19add", reference: "playtests/jobs/qwen-qwen3.7-plus-ru", recordedAt: "2026-07-19T20:44:36.448Z" },
  ] }),
  shippedAssessment({ provider: "xai", model: "grok-4.5", route: "direct", profileFingerprint: "c9840a035b832ebe260978af336b369447c259ab87d6e2d1b5c8bcebfd2e3360", calibrationReference: "playtests/calibration/grok-4.5-initial", calibratedAt: "2026-07-19T20:34:44.395Z", certifications: [
    { language: "en", technicalStatus: "clean", recoveryCount: 0, qualityStatus: "high", candidateMetricsHash: "4890b9429d438cd64a870f191b2d4bccc5486824c4c5e0a8f9d0949feef68ef9", reference: "playtests/jobs/grok-4.5-en", recordedAt: "2026-07-19T22:33:20.952Z" },
    { language: "ru", technicalStatus: "clean", recoveryCount: 0, qualityStatus: "high", candidateMetricsHash: "4890b9429d438cd64a870f191b2d4bccc5486824c4c5e0a8f9d0949feef68ef9", reference: "playtests/jobs/grok-4.5-ru", recordedAt: "2026-07-19T22:33:20.984Z" },
  ] }),
  shippedAssessment({ provider: "openai", model: "gpt-5.4", route: "direct", profileFingerprint: "e078d694d7e7bfec060ae40411031802e04faf8f6733f52ab299f65f7de04c83", calibrationReference: "playtests/calibration/gpt-5.4-initial", calibratedAt: "2026-07-19T21:04:16.063Z", certifications: [
    { language: "en", technicalStatus: "playable_with_recovery", recoveryCount: 1, qualityStatus: "high", candidateMetricsHash: "1f9e98fc70fdbc02169b734969a94b0a28eddf78abb3bd727bf89309ebbb13b0", reference: "playtests/jobs/gpt-5.4-en", recordedAt: "2026-07-19T22:33:20.539Z" },
    { language: "ru", technicalStatus: "playable_with_recovery", recoveryCount: 1, qualityStatus: "medium", candidateMetricsHash: "bcbb22c8daca0e354272c1f44ebfb178c80a6b2493bdc881932fb72838e897aa", reference: "playtests/jobs/gpt-5.4-ru", recordedAt: "2026-07-19T22:33:20.570Z" },
  ] }),
  shippedAssessment({ provider: "deepseek", model: "deepseek-v4-flash", route: "direct", profileFingerprint: "11e6d104df6bfddf818aac35ab0727784ef1f636761bddfc39033e973ea6102e", calibrationReference: "playtests/calibration/deepseek-v4-flash-repair-thinking-final", calibratedAt: "2026-07-19T22:15:29.409Z", certifications: [
    { language: "en", technicalStatus: "playable_with_recovery", recoveryCount: 3, qualityStatus: "high", candidateMetricsHash: "72ec11d1123e2d8d48506085091fe99a469dc4cabddb91e4112263e8d10c6966", reference: "playtests/jobs/deepseek-v4-flash-en", recordedAt: "2026-07-19T22:31:21.677Z" },
    { language: "ru", technicalStatus: "playable_with_recovery", recoveryCount: 2, qualityStatus: "high", candidateMetricsHash: "87f577cf705e5b6883de69a8a91e3cdb1fbac7fd6a487effe6ca2030a2d5d0d7", reference: "playtests/jobs/deepseek-v4-flash-ru", recordedAt: "2026-07-19T22:31:21.706Z" },
  ] }),
  shippedAssessment({ provider: "deepseek", model: "deepseek-v4-pro", route: "direct", profileFingerprint: "9947b705d9ad3bdad4d86084782f952896bf991b9516f7b239111d30ccc64da7", calibrationReference: "playtests/calibration/deepseek-v4-pro-initial", calibratedAt: "2026-07-19T22:41:54.139Z", certifications: [
    { language: "en", technicalStatus: "playable_with_recovery", recoveryCount: 2, qualityStatus: "high", candidateMetricsHash: "a858ac4b4165001d22473a2d2d4e2e1d8d80815a554d376538cb2e79314a58c6", reference: "playtests/jobs/deepseek-v4-pro-en", recordedAt: "2026-07-19T22:46:47.960Z" },
    { language: "ru", technicalStatus: "playable_with_recovery", recoveryCount: 1, qualityStatus: "high", candidateMetricsHash: "62665b44206708b766abd01c281ec3eccaa98c41ce641d9a247493b9bcab88bf", reference: "playtests/jobs/deepseek-v4-pro-ru", recordedAt: "2026-07-19T22:46:47.355Z" },
  ] }),
] as const;

function mergeShippedAssessments(saved: PersistedAssessmentCatalog): PersistedAssessmentCatalog {
  const models = new Map<string, z.infer<typeof ModelAssessmentSchema>>();
  for (const shipped of SHIPPED_MODEL_ASSESSMENTS) models.set(assessmentKey(shipped), structuredClone(shipped));
  for (const local of saved.models) {
    const shipped = models.get(assessmentKey(local));
    if (!shipped) {
      models.set(assessmentKey(local), local);
      continue;
    }
    const certifications = new Map(shipped.certifications.map((item) => [item.language, item]));
    for (const certification of local.certifications) certifications.set(certification.language, certification);
    models.set(assessmentKey(local), {
      ...local,
      adapter: local.adapter ?? shipped.adapter,
      certifications: [...certifications.values()].sort((left, right) => left.language.localeCompare(right.language)),
    });
  }
  return PersistedAssessmentCatalogSchema.parse({
    version: MODEL_ASSESSMENT_CATALOG_VERSION,
    models: [...models.values()].sort((left, right) => assessmentKey(left).localeCompare(assessmentKey(right))),
  });
}

export interface EffectiveModelAssessment {
  adapterStatus: z.infer<typeof ModelAdapterStatusSchema>;
  profileFingerprint?: string;
  technicalStatus: z.infer<typeof ModelTechnicalGameplayStatusSchema>;
  recoveryCount: number;
  qualityStatus: z.infer<typeof ModelQualityStatusSchema>;
  evidence: z.infer<typeof ModelEvidenceReferenceSchema>[];
  certificationCurrent: boolean;
  recommendation: ModelRecommendationEligibility;
}

export interface RecordCalibrationInput extends z.infer<typeof RouteKeySchema> {
  status: z.infer<typeof ModelAdapterStatusSchema>;
  adapterRevision?: number | undefined;
  profileFingerprint?: string | undefined;
  evidence: z.infer<typeof ModelEvidenceReferenceSchema>;
}

export interface RecordCertificationInput extends z.infer<typeof RouteKeySchema> {
  language: LanguageCode;
  packageId: string;
  packageVersion: string;
  profileFingerprint: string;
  technicalStatus: z.infer<typeof ModelTechnicalGameplayStatusSchema>;
  recoveryCount?: number;
  qualityStatus: z.infer<typeof ModelQualityStatusSchema>;
  candidateMetricsHash: string;
  evidence: z.infer<typeof ModelEvidenceReferenceSchema>;
}

function assessmentKey(value: z.infer<typeof RouteKeySchema>): string {
  return `${value.provider}\u0000${value.model}\u0000${value.route}`;
}

function sameRoute(
  left: z.infer<typeof RouteKeySchema>,
  right: z.infer<typeof RouteKeySchema>,
): boolean {
  return assessmentKey(left) === assessmentKey(right);
}

function isProductRecommendation(value: z.infer<typeof RouteKeySchema>): boolean {
  return value.provider === RECOMMENDED_MODEL_SELECTION.provider
    && value.model === RECOMMENDED_MODEL_SELECTION.model
    && value.route === "direct";
}

function recommendationFor(
  key: z.infer<typeof RouteKeySchema>,
  adapter: AdapterAssessment | undefined,
  certification: CertificationAssessment | undefined,
  current: boolean,
): ModelRecommendationEligibility {
  if (isProductRecommendation(key)) {
    return ModelRecommendationEligibilitySchema.parse({
      eligible: true,
      reasons: ["product_recommended_default"],
      ...(certification?.evidence ? { evidence: certification.evidence } : {}),
    });
  }
  const reasons: string[] = [];
  if (adapter?.status !== "calibrated") reasons.push("adapter_not_calibrated");
  if (!certification) reasons.push("not_certified");
  else if (!current) reasons.push("certification_profile_stale");
  else {
    if (!(["clean", "playable_with_recovery"] as const).includes(
      certification.technicalStatus as "clean" | "playable_with_recovery",
    )) reasons.push("technical_status_not_eligible");
    if (!(["high", "medium"] as const).includes(
      certification.qualityStatus as "high" | "medium",
    )) reasons.push("quality_status_not_eligible");
  }
  return ModelRecommendationEligibilitySchema.parse({
    eligible: reasons.length === 0,
    reasons,
    ...(certification?.evidence ? { evidence: certification.evidence } : {}),
  });
}

export class ModelAssessmentCatalog {
  readonly filePath: string;
  readonly lockPath: string;

  constructor(
    readonly root: string,
    private readonly now: () => Date = () => new Date(),
  ) {
    this.filePath = path.join(root, "config", "model-assessments.json");
    this.lockPath = path.join(root, "config", ".model-assessments.lock");
  }

  async effective(
    target: z.infer<typeof RouteKeySchema>,
    language: LanguageCode,
  ): Promise<EffectiveModelAssessment> {
    const key = RouteKeySchema.parse(target);
    const parsedLanguage = LanguageCodeSchema.parse(language);
    const catalog = await this.load();
    const model = catalog.models.find((entry) => sameRoute(entry, key));
    const certification = model?.certifications.find((entry) => entry.language === parsedLanguage);
    const adapterCurrent = model?.adapter?.status === "calibrated"
      && model.adapter.adapterRevision === MODEL_EXECUTION_ADAPTER_REVISION;
    const current = certification !== undefined
      && adapterCurrent
      && certification.packageVersion === String(CERTIFICATION_PACKAGE_VERSION)
      && model?.adapter?.profileFingerprint === certification.profileFingerprint;
    const technicalStatus = certification === undefined
      ? "inconclusive" as const
      : current ? certification.technicalStatus : "inconclusive" as const;
    const qualityStatus = certification === undefined
      ? "unrated" as const
      : current ? certification.qualityStatus : "unrated" as const;
    const evidence = [model?.adapter?.evidence, certification?.evidence]
      .filter((item): item is z.infer<typeof ModelEvidenceReferenceSchema> => item !== undefined);
    return {
      adapterStatus: adapterCurrent
        ? "calibrated"
        : model?.adapter?.status === "calibrated" ? "uncalibrated" : model?.adapter?.status ?? "uncalibrated",
      ...(model?.adapter?.profileFingerprint ? { profileFingerprint: model.adapter.profileFingerprint } : {}),
      technicalStatus,
      recoveryCount: current ? certification.recoveryCount ?? 0 : 0,
      qualityStatus,
      evidence,
      certificationCurrent: current,
      recommendation: recommendationFor(
        key,
        adapterCurrent ? model?.adapter : undefined,
        certification,
        current,
      ),
    };
  }

  async recordCalibration(input: RecordCalibrationInput): Promise<void> {
    const key = RouteKeySchema.parse({
      provider: input.provider,
      model: input.model,
      route: input.route,
    });
    const status = ModelAdapterStatusSchema.parse(input.status);
    const profileFingerprint = input.profileFingerprint === undefined
      ? undefined
      : z.string().regex(/^[a-f0-9]{64}$/).parse(input.profileFingerprint);
    if (status === "calibrated" && profileFingerprint === undefined) {
      throw new Error("A calibrated adapter requires a frozen profile fingerprint");
    }
    if (status === "calibrated" && input.adapterRevision !== MODEL_EXECUTION_ADAPTER_REVISION) {
      throw new Error(
        `A calibrated adapter requires current adapter revision ${MODEL_EXECUTION_ADAPTER_REVISION}`,
      );
    }
    await this.mutate((catalog) => {
      const model = this.ensure(catalog, key);
      model.adapter = AdapterAssessmentSchema.parse({
        status,
        ...(input.adapterRevision === undefined ? {} : { adapterRevision: input.adapterRevision }),
        ...(profileFingerprint ? { profileFingerprint } : {}),
        evidence: input.evidence,
        updatedAt: this.timestamp(),
      });
    });
  }

  async recordCertification(input: RecordCertificationInput): Promise<void> {
    if (input.packageId !== "certification-v1") {
      throw new Error("Only certification-v1 may update authoritative model certification metadata");
    }
    const key = RouteKeySchema.parse({
      provider: input.provider,
      model: input.model,
      route: input.route,
    });
    const language = LanguageCodeSchema.parse(input.language);
    await this.mutate((catalog) => {
      const model = this.ensure(catalog, key);
      const adapterFingerprint = model.adapter?.status === "calibrated"
        && model.adapter.adapterRevision === MODEL_EXECUTION_ADAPTER_REVISION
        ? model.adapter.profileFingerprint
        : undefined;
      if (adapterFingerprint !== input.profileFingerprint) {
        throw new Error("Certification requires the currently frozen calibrated execution profile");
      }
      const certification = CertificationAssessmentSchema.parse({
        language,
        packageId: input.packageId,
        packageVersion: input.packageVersion,
        profileFingerprint: input.profileFingerprint,
        technicalStatus: input.technicalStatus,
        recoveryCount: input.recoveryCount ?? 0,
        qualityStatus: input.qualityStatus,
        candidateMetricsHash: input.candidateMetricsHash,
        evidence: input.evidence,
        certifiedAt: this.timestamp(),
      });
      model.certifications = [
        ...model.certifications.filter((entry) => entry.language !== language),
        certification,
      ].sort((left, right) => left.language.localeCompare(right.language));
    });
  }

  private ensure(
    catalog: PersistedAssessmentCatalog,
    key: z.infer<typeof RouteKeySchema>,
  ): z.infer<typeof ModelAssessmentSchema> {
    let model = catalog.models.find((entry) => sameRoute(entry, key));
    if (!model) {
      model = { ...key, certifications: [] };
      catalog.models.push(model);
    }
    return model;
  }

  private timestamp(): string {
    const date = this.now();
    if (Number.isNaN(date.getTime())) throw new Error("Assessment catalog clock returned an invalid date");
    return date.toISOString();
  }

  private async load(): Promise<PersistedAssessmentCatalog> {
    try {
      return mergeShippedAssessments(PersistedAssessmentCatalogSchema.parse(JSON.parse(await readFile(this.filePath, "utf8"))));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return mergeShippedAssessments({ version: MODEL_ASSESSMENT_CATALOG_VERSION, models: [] });
      }
      throw error;
    }
  }

  private async mutate(change: (catalog: PersistedAssessmentCatalog) => void): Promise<void> {
    await queueModelAssessmentOperation(path.resolve(this.lockPath), async () => {
      const release = await acquireModelAssessmentLock(this.lockPath);
      try {
        const catalog = await this.load();
        change(catalog);
        catalog.models.sort((left, right) => assessmentKey(left).localeCompare(assessmentKey(right)));
        await atomicWriteJson(this.filePath, PersistedAssessmentCatalogSchema.parse(catalog));
      } finally {
        await release();
      }
    });
  }
}
