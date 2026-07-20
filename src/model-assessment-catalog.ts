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
import { withSerializedFileLock } from "./persistence/lock.js";
import { CERTIFICATION_PACKAGE_VERSION } from "./certification-version.js";

export const MODEL_ASSESSMENT_CATALOG_VERSION = 1 as const;
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

const ShippedCertificationSchema = z.object({
  language: LanguageCodeSchema,
  technicalStatus: ModelTechnicalGameplayStatusSchema,
  recoveryCount: z.number().int().nonnegative(),
  qualityStatus: ModelQualityStatusSchema,
  candidateMetricsHash: z.string().regex(/^[a-f0-9]{64}$/),
  reference: z.string().min(1),
  recordedAt: z.string().datetime({ offset: true }),
}).strict();

const ShippedModelAssessmentSchema = RouteKeySchema.extend({
  profileFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  calibrationReference: z.string().min(1),
  calibratedAt: z.string().datetime({ offset: true }),
  certifications: z.array(ShippedCertificationSchema).min(1),
}).strict();

const ShippedAssessmentFileSchema = z.object({
  version: z.literal(MODEL_ASSESSMENT_CATALOG_VERSION),
  models: z.array(ShippedModelAssessmentSchema),
}).strict();

function shippedAssessment(
  input: z.infer<typeof ShippedModelAssessmentSchema>,
): z.infer<typeof ModelAssessmentSchema> {
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

/**
 * Shipped assessments are certification output produced by the playtest
 * harness (tools/playtest) and reviewed into defaults/model-assessments.json.
 * The compact authoring shape is expanded here so packageVersion and adapter
 * revision always reflect the current application constants.
 */
const SHIPPED_MODEL_ASSESSMENTS_URL = new URL("../defaults/model-assessments.json", import.meta.url);
let shippedAssessmentsCache: readonly z.infer<typeof ModelAssessmentSchema>[] | undefined;

async function shippedModelAssessments(): Promise<readonly z.infer<typeof ModelAssessmentSchema>[]> {
  if (!shippedAssessmentsCache) {
    const file = ShippedAssessmentFileSchema.parse(
      JSON.parse(await readFile(SHIPPED_MODEL_ASSESSMENTS_URL, "utf8")),
    );
    shippedAssessmentsCache = file.models.map(shippedAssessment);
  }
  return shippedAssessmentsCache;
}

function mergeShippedAssessments(
  saved: PersistedAssessmentCatalog,
  shippedModels: readonly z.infer<typeof ModelAssessmentSchema>[],
): PersistedAssessmentCatalog {
  const models = new Map<string, z.infer<typeof ModelAssessmentSchema>>();
  for (const shipped of shippedModels) models.set(assessmentKey(shipped), structuredClone(shipped));
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
    const shipped = await shippedModelAssessments();
    try {
      return mergeShippedAssessments(PersistedAssessmentCatalogSchema.parse(JSON.parse(await readFile(this.filePath, "utf8"))), shipped);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return mergeShippedAssessments({ version: MODEL_ASSESSMENT_CATALOG_VERSION, models: [] }, shipped);
      }
      throw error;
    }
  }

  private async mutate(change: (catalog: PersistedAssessmentCatalog) => void): Promise<void> {
    await withSerializedFileLock(this.lockPath, "model assessment catalog", async () => {
      const catalog = await this.load();
      change(catalog);
      catalog.models.sort((left, right) => assessmentKey(left).localeCompare(assessmentKey(right)));
      await atomicWriteJson(this.filePath, PersistedAssessmentCatalogSchema.parse(catalog));
    });
  }
}
