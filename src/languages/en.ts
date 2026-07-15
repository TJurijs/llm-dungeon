import type { LanguageDefinition } from "./definition.js";

export const ENGLISH: LanguageDefinition = {
  nativeName: "English",
  instruction: "Write all narration, dialogue, summaries, names, descriptions, and player-facing text in English.",
  setupDefaults: {
    premise: "A classical opening in a tavern, with immediate but optional possibilities.",
    characterConcept: "Create a grounded adventurer with two useful traits and one complicating trait.",
  },
  mechanics: {
    noModifiers: "No modifiers",
    total: "Total",
    difficulty: "difficulty",
    comparisonConnector: " vs ",
    outcomes: {
      exceptional_success: "EXCEPTIONAL SUCCESS",
      success: "SUCCESS",
      failure: "FAILURE",
      severe_failure: "SEVERE FAILURE",
    },
  },
  campaignLifecycle: {
    openingAction: "Campaign begins.",
    openingSummary: "The campaign began.",
  },
  inspection: {
    character: "Character",
    location: "Location",
    storyThreads: "Story threads",
    status: "Status",
    traits: "Traits",
    conditions: "Conditions",
    inventory: "Inventory",
    establishedFacts: "Established facts",
    knowledge: "Knowledge",
    history: "History",
    relationships: "Relationships",
    features: "Features",
    active: "Active",
    resolved: "Resolved",
    failed: "Failed",
    none: "None.",
    emptyInventory: "Empty.",
    noThreads: "No story threads.",
  },
  worldProfileFile: "en.md",
};
