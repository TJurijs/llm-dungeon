export interface CampaignSetupDefaults {
  readonly premise: string;
  readonly characterConcept: string;
}

export interface InspectionCopy {
  readonly character: string;
  readonly location: string;
  readonly storyThreads: string;
  readonly status: string;
  readonly traits: string;
  readonly conditions: string;
  readonly inventory: string;
  readonly establishedFacts: string;
  readonly knowledge: string;
  readonly history: string;
  readonly relationships: string;
  readonly features: string;
  readonly active: string;
  readonly resolved: string;
  readonly failed: string;
  readonly none: string;
  readonly emptyInventory: string;
  readonly noThreads: string;
}

export interface MechanicsCopy {
  readonly noModifiers: string;
  readonly total: string;
  readonly difficulty: string;
  readonly comparisonConnector: string;
  readonly outcomes: Readonly<Record<"exceptional_success" | "success" | "failure" | "severe_failure", string>>;
}

export interface CampaignLifecycleCopy {
  readonly openingAction: string;
  readonly openingSummary: string;
}

/**
 * Everything gameplay-facing that is specific to one output language.
 *
 * Adding a language means defining one of these records and registering it in
 * `language.ts`; schemas, setup defaults, world rules, and deterministic
 * structured inspection copy then follow the same code path automatically.
 */
export interface LanguageDefinition {
  readonly nativeName: string;
  readonly instruction: string;
  readonly setupDefaults: CampaignSetupDefaults;
  readonly mechanics: MechanicsCopy;
  readonly campaignLifecycle: CampaignLifecycleCopy;
  readonly inspection: InspectionCopy;
  /** Filename inside config/worlds. The language registry owns this mapping. */
  readonly worldProfileFile: string;
}
