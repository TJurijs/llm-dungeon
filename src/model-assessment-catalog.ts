import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  ModelAdapterStatusSchema,
  ModelEvidenceReferenceSchema,
  ModelRecommendationEligibilitySchema,
  type ModelRecommendationEligibility,
} from "./model-status.js";
import { RECOMMENDED_MODEL_SELECTION, ModelSelectionSchema } from "./llm-model-catalog.js";
import { MODEL_EXECUTION_ADAPTER_REVISION } from "./model-execution-profile.js";
import { atomicWriteJson } from "./persistence/files.js";
import { withSerializedFileLock } from "./persistence/lock.js";

/**
 * Durable calibration evidence for one provider/model/route.
 *
 * This catalog once also held certification: a per-language technical and
 * quality verdict produced by a paid `certification-v1` run. Certification was
 * removed as a feature, so nothing produces those verdicts and the catalog no
 * longer pretends to hold them. What remains is the evidence gameplay actually
 * reads — which execution profile was calibrated, against which adapter
 * revision — plus whether a route is the product-recommended default.
 */
export const MODEL_ASSESSMENT_CATALOG_VERSION = 1 as const;

const RouteKeySchema = ModelSelectionSchema.extend({
  route: z.string().trim().min(1).max(100),
}).strict();

const AdapterAssessmentSchema = z
  .object({
    status: ModelAdapterStatusSchema,
    adapterRevision: z.number().int().positive().optional(),
    profileFingerprint: z
      .string()
      .regex(/^[a-f0-9]{64}$/)
      .optional(),
    evidence: ModelEvidenceReferenceSchema.optional(),
    updatedAt: z.string().datetime({ offset: true }),
  })
  .strict()
  .superRefine((assessment, context) => {
    if (assessment.status === "calibrated" && assessment.profileFingerprint === undefined) {
      context.addIssue({
        code: "custom",
        path: ["profileFingerprint"],
        message: "calibrated status requires a frozen profile fingerprint",
      });
    }
  });

const ModelAssessmentSchema = RouteKeySchema.extend({
  adapter: AdapterAssessmentSchema.optional(),
  /**
   * Per-language certification verdicts, written while that feature existed.
   *
   * Accepted and discarded rather than rejected. Every route in an existing
   * `config/model-assessments.json` carries this key, and a strict schema would
   * refuse to load the file at all — stranding the calibration sitting beside
   * it and blocking model settings, playtest preflight, and provider
   * construction. It is dropped on the next write.
   */
  certifications: z.unknown().optional(),
})
  .strict()
  .transform(({ certifications: _discarded, ...model }) => model);
export type ModelAssessment = z.infer<typeof ModelAssessmentSchema>;

function assessmentKey(value: z.infer<typeof RouteKeySchema>): string {
  return `${value.provider}\u0000${value.model}\u0000${value.route}`;
}

const PersistedAssessmentCatalogSchema = z
  .object({
    version: z.literal(MODEL_ASSESSMENT_CATALOG_VERSION),
    models: z.array(ModelAssessmentSchema),
  })
  .strict()
  .superRefine((catalog, context) => {
    const keys = new Set<string>();
    for (const [index, model] of catalog.models.entries()) {
      const key = assessmentKey(model);
      if (keys.has(key))
        context.addIssue({
          code: "custom",
          path: ["models", index],
          message: "duplicate model route",
        });
      keys.add(key);
    }
  });

type PersistedAssessmentCatalog = z.infer<typeof PersistedAssessmentCatalogSchema>;
export type AdapterAssessment = z.infer<typeof AdapterAssessmentSchema>;

const LEGACY_SHIPPED_ADAPTER_REVISION = 7;

/**
 * The compact authoring shape for `defaults/model-assessments.json`.
 *
 * It retains the exact adapter revision that produced the evidence so an
 * adapter change cannot silently revalidate it. Records written while
 * certification existed also carry a `certifications` array; it is accepted and
 * discarded rather than rejected, so an existing defaults file and an existing
 * user `config/model-assessments.json` both keep loading.
 */
export const ShippedModelAssessmentSchema = RouteKeySchema.extend({
  adapterRevision: z.number().int().positive().default(LEGACY_SHIPPED_ADAPTER_REVISION),
  profileFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  calibrationReference: z.string().min(1),
  calibratedAt: z.string().datetime({ offset: true }),
  certifications: z.unknown().optional(),
}).strict();
export type ShippedModelAssessment = z.infer<typeof ShippedModelAssessmentSchema>;

const ShippedAssessmentFileSchema = z
  .object({
    version: z.literal(MODEL_ASSESSMENT_CATALOG_VERSION),
    models: z.array(ShippedModelAssessmentSchema),
  })
  .strict();

function shippedAssessment(
  input: z.infer<typeof ShippedModelAssessmentSchema>,
): z.infer<typeof ModelAssessmentSchema> {
  return ModelAssessmentSchema.parse({
    provider: input.provider,
    model: input.model,
    route: input.route,
    adapter: {
      status: "calibrated",
      adapterRevision: input.adapterRevision,
      profileFingerprint: input.profileFingerprint,
      evidence: {
        source: "calibration",
        reference: input.calibrationReference,
        executionProfileFingerprint: input.profileFingerprint,
        recordedAt: input.calibratedAt,
      },
      updatedAt: input.calibratedAt,
    },
  });
}

const SHIPPED_MODEL_ASSESSMENTS_URL = new URL("../defaults/model-assessments.json", import.meta.url);
let shippedAssessmentsCache: readonly z.infer<typeof ModelAssessmentSchema>[] | undefined;

async function shippedModelAssessments(): Promise<
  readonly z.infer<typeof ModelAssessmentSchema>[]
> {
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
    // A local record wins only while it matches the current adapter revision;
    // otherwise the shipped evidence is the more current of the two.
    const localAdapterCurrent = local.adapter?.adapterRevision === MODEL_EXECUTION_ADAPTER_REVISION;
    const adapter = localAdapterCurrent ? local.adapter : (shipped.adapter ?? local.adapter);
    models.set(assessmentKey(local), { ...local, ...(adapter ? { adapter } : {}) });
  }
  return PersistedAssessmentCatalogSchema.parse({
    version: MODEL_ASSESSMENT_CATALOG_VERSION,
    models: [...models.values()].sort((left, right) =>
      assessmentKey(left).localeCompare(assessmentKey(right)),
    ),
  });
}

export interface EffectiveModelAssessment {
  adapterStatus: z.infer<typeof ModelAdapterStatusSchema>;
  profileFingerprint?: string;
  evidence: z.infer<typeof ModelEvidenceReferenceSchema>[];
  recommendation: ModelRecommendationEligibility;
}

export interface RecordCalibrationInput extends z.infer<typeof RouteKeySchema> {
  status: z.infer<typeof ModelAdapterStatusSchema>;
  adapterRevision?: number | undefined;
  profileFingerprint?: string | undefined;
  evidence: z.infer<typeof ModelEvidenceReferenceSchema>;
}

function sameRoute(
  left: z.infer<typeof RouteKeySchema>,
  right: z.infer<typeof RouteKeySchema>,
): boolean {
  return assessmentKey(left) === assessmentKey(right);
}

function isProductRecommendation(value: z.infer<typeof RouteKeySchema>): boolean {
  return (
    value.provider === RECOMMENDED_MODEL_SELECTION.provider &&
    value.model === RECOMMENDED_MODEL_SELECTION.model &&
    value.route === "direct"
  );
}

/**
 * Recommendation is a product decision, not a measurement.
 *
 * It previously required a current certification, which is why removing
 * certification would otherwise have made every route permanently ineligible.
 * The one recommended default is declared in the model catalog; any other route
 * becomes eligible once its adapter is calibrated, because calibration is the
 * only route evidence the application still produces.
 */
function recommendationFor(
  key: z.infer<typeof RouteKeySchema>,
  adapter: AdapterAssessment | undefined,
): ModelRecommendationEligibility {
  if (isProductRecommendation(key)) {
    return ModelRecommendationEligibilitySchema.parse({
      eligible: true,
      reasons: ["product_recommended_default"],
      ...(adapter?.evidence ? { evidence: adapter.evidence } : {}),
    });
  }
  const reasons = adapter?.status === "calibrated" ? [] : ["adapter_not_calibrated"];
  return ModelRecommendationEligibilitySchema.parse({
    eligible: reasons.length === 0,
    reasons,
    ...(adapter?.evidence ? { evidence: adapter.evidence } : {}),
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

  /** Effective route record after current shipped and local evidence are reconciled. */
  async get(target: z.infer<typeof RouteKeySchema>): Promise<ModelAssessment | undefined> {
    const key = RouteKeySchema.parse(target);
    const catalog = await this.load();
    return catalog.models.find((entry) => sameRoute(entry, key));
  }

  async effective(target: z.infer<typeof RouteKeySchema>): Promise<EffectiveModelAssessment> {
    const key = RouteKeySchema.parse(target);
    const catalog = await this.load();
    const model = catalog.models.find((entry) => sameRoute(entry, key));
    const adapterCurrent =
      model?.adapter?.status === "calibrated" &&
      model.adapter.adapterRevision === MODEL_EXECUTION_ADAPTER_REVISION;
    const evidence = [model?.adapter?.evidence].filter(
      (item): item is z.infer<typeof ModelEvidenceReferenceSchema> => item !== undefined,
    );
    return {
      adapterStatus: adapterCurrent
        ? "calibrated"
        : model?.adapter?.status === "calibrated"
          ? "uncalibrated"
          : (model?.adapter?.status ?? "uncalibrated"),
      ...(model?.adapter?.profileFingerprint
        ? { profileFingerprint: model.adapter.profileFingerprint }
        : {}),
      evidence,
      recommendation: recommendationFor(key, adapterCurrent ? model?.adapter : undefined),
    };
  }

  async recordCalibration(input: RecordCalibrationInput): Promise<void> {
    const key = RouteKeySchema.parse({
      provider: input.provider,
      model: input.model,
      route: input.route,
    });
    const status = ModelAdapterStatusSchema.parse(input.status);
    const profileFingerprint =
      input.profileFingerprint === undefined
        ? undefined
        : z
            .string()
            .regex(/^[a-f0-9]{64}$/)
            .parse(input.profileFingerprint);
    if (status === "calibrated" && profileFingerprint === undefined) {
      throw new Error("A calibrated adapter requires a frozen profile fingerprint");
    }
    if (
      input.adapterRevision !== undefined &&
      input.adapterRevision !== MODEL_EXECUTION_ADAPTER_REVISION
    ) {
      throw new Error(
        `Calibration evidence requires current adapter revision ${MODEL_EXECUTION_ADAPTER_REVISION}`,
      );
    }
    await this.mutate((catalog) => {
      const model = this.ensure(catalog, key);
      model.adapter = AdapterAssessmentSchema.parse({
        status,
        adapterRevision: MODEL_EXECUTION_ADAPTER_REVISION,
        ...(profileFingerprint ? { profileFingerprint } : {}),
        evidence: input.evidence,
        updatedAt: this.timestamp(),
      });
    });
  }

  private ensure(
    catalog: PersistedAssessmentCatalog,
    key: z.infer<typeof RouteKeySchema>,
  ): z.infer<typeof ModelAssessmentSchema> {
    let model = catalog.models.find((entry) => sameRoute(entry, key));
    if (!model) {
      model = { ...key };
      catalog.models.push(model);
    }
    return model;
  }

  private timestamp(): string {
    const date = this.now();
    if (Number.isNaN(date.getTime()))
      throw new Error("Assessment catalog clock returned an invalid date");
    return date.toISOString();
  }

  private async load(): Promise<PersistedAssessmentCatalog> {
    const shipped = await shippedModelAssessments();
    return mergeShippedAssessments(await this.loadPersisted(), shipped);
  }

  private async loadPersisted(): Promise<PersistedAssessmentCatalog> {
    try {
      return PersistedAssessmentCatalogSchema.parse(
        JSON.parse(await readFile(this.filePath, "utf8")),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { version: MODEL_ASSESSMENT_CATALOG_VERSION, models: [] };
      }
      throw error;
    }
  }

  private async mutate(change: (catalog: PersistedAssessmentCatalog) => void): Promise<void> {
    await withSerializedFileLock(this.lockPath, "model assessment catalog", async () => {
      const catalog = await this.loadPersisted();
      change(catalog);
      catalog.models.sort((left, right) => assessmentKey(left).localeCompare(assessmentKey(right)));
      await atomicWriteJson(this.filePath, PersistedAssessmentCatalogSchema.parse(catalog));
    });
  }
}
