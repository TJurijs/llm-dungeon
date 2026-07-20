import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import {
  FrozenModelExecutionProfileSchema,
  MODEL_EXECUTION_ADAPTER_REVISION,
  modelExecutionProfileFingerprint,
  SHIPPED_MODEL_EXECUTION_PROFILES,
  type FrozenModelExecutionProfile,
} from "./model-execution-profile.js";
import { atomicWriteJson } from "./persistence/files.js";
import { withSerializedFileLock } from "./persistence/lock.js";
import { ProviderConfigSchema } from "./schemas.js";

export const MODEL_EXECUTION_PROFILE_STORE_VERSION = 1 as const;
export const ModelExecutionProfileKeySchema = z.object({
  provider: ProviderConfigSchema.shape.provider,
  model: z.string().trim().min(1).max(300),
  route: z.string().trim().min(1).max(100),
}).strict();
export type ModelExecutionProfileKey = z.infer<typeof ModelExecutionProfileKeySchema>;

const PersistedModelExecutionProfilesSchema = z.object({
  version: z.literal(MODEL_EXECUTION_PROFILE_STORE_VERSION),
  profiles: z.array(FrozenModelExecutionProfileSchema),
}).strict().superRefine((value, context) => {
  const keys = new Set<string>();
  for (const [index, profile] of value.profiles.entries()) {
    const key = profileKey(profile.key);
    if (keys.has(key)) {
      context.addIssue({ code: "custom", path: ["profiles", index], message: "duplicate provider/model/route profile" });
    }
    keys.add(key);
    if (profile.fingerprint !== modelExecutionProfileFingerprint(profile)) {
      context.addIssue({ code: "custom", path: ["profiles", index, "fingerprint"], message: "profile fingerprint does not match execution settings" });
    }
  }
});

type PersistedModelExecutionProfiles = z.infer<typeof PersistedModelExecutionProfilesSchema>;

function profileKey(key: ModelExecutionProfileKey): string {
  return `${key.provider}\u0000${key.model}\u0000${key.route}`;
}

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  }
  return value;
}

function mergeShippedProfiles(saved: PersistedModelExecutionProfiles): PersistedModelExecutionProfiles {
  const profiles = new Map(SHIPPED_MODEL_EXECUTION_PROFILES.map((profile) => [profileKey(profile.key), profile]));
  for (const profile of saved.profiles) profiles.set(profileKey(profile.key), profile);
  return PersistedModelExecutionProfilesSchema.parse({
    version: MODEL_EXECUTION_PROFILE_STORE_VERSION,
    profiles: [...profiles.values()].sort((left, right) => profileKey(left.key).localeCompare(profileKey(right.key))),
  });
}

/** Durable authority for the frozen execution profile used by certification. */
export class ModelExecutionProfileStore {
  readonly filePath: string;
  readonly lockPath: string;

  constructor(readonly root: string) {
    this.filePath = path.join(root, "config", "model-execution-profiles.json");
    this.lockPath = path.join(root, "config", ".model-execution-profiles.lock");
  }

  async get(key: ModelExecutionProfileKey): Promise<FrozenModelExecutionProfile | undefined> {
    const parsedKey = ModelExecutionProfileKeySchema.parse(key);
    const saved = await this.load();
    const found = saved.profiles.find((profile) => profileKey(profile.key) === profileKey(parsedKey));
    return found ? deepFreeze(structuredClone(found)) : undefined;
  }

  async require(key: ModelExecutionProfileKey): Promise<FrozenModelExecutionProfile> {
    const profile = await this.get(key);
    if (!profile) {
      throw new Error(`No calibrated execution profile for ${key.provider}/${key.model} via ${key.route}; run playtest calibrate first`);
    }
    if (profile.adapterRevision !== MODEL_EXECUTION_ADAPTER_REVISION) {
      throw new Error(
        `Execution profile for ${key.provider}/${key.model} via ${key.route} uses stale adapter revision ${profile.adapterRevision}; run playtest calibrate again`,
      );
    }
    return profile;
  }

  async put(profile: FrozenModelExecutionProfile): Promise<void> {
    const parsed = FrozenModelExecutionProfileSchema.parse(profile);
    if (parsed.adapterRevision !== MODEL_EXECUTION_ADAPTER_REVISION) {
      throw new Error(
        `Cannot persist adapter revision ${parsed.adapterRevision}; current revision is ${MODEL_EXECUTION_ADAPTER_REVISION}`,
      );
    }
    if (parsed.fingerprint !== modelExecutionProfileFingerprint(parsed)) {
      throw new Error("Cannot persist a frozen execution profile with a stale fingerprint");
    }
    await withSerializedFileLock(this.lockPath, "model execution profile store", async () => {
      const saved = await this.load();
      saved.profiles = [
        ...saved.profiles.filter((candidate) => profileKey(candidate.key) !== profileKey(parsed.key)),
        parsed,
      ].sort((left, right) => profileKey(left.key).localeCompare(profileKey(right.key)));
      await atomicWriteJson(this.filePath, PersistedModelExecutionProfilesSchema.parse(saved));
    });
  }

  private async load(): Promise<PersistedModelExecutionProfiles> {
    try {
      return mergeShippedProfiles(PersistedModelExecutionProfilesSchema.parse(JSON.parse(await readFile(this.filePath, "utf8"))));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return mergeShippedProfiles({ version: MODEL_EXECUTION_PROFILE_STORE_VERSION, profiles: [] });
      }
      throw error;
    }
  }
}
