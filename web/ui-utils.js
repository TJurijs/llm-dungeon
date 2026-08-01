/** @typedef {import("../src/web/contracts.js").BrowserLlmModelEntry} BrowserLlmModelEntry */
/** @typedef {import("../src/web/contracts.js").BrowserLlmPresentation} BrowserLlmPresentation */
/** @typedef {import("../src/web/contracts.js").BrowserModelSelection} BrowserModelSelection */
/** @typedef {import("../src/web/contracts.js").BrowserProviderId} BrowserProviderId */
/** @typedef {import("../src/web/contracts.js").BrowserCampaignBudgetSnapshot} BrowserCampaignBudgetSnapshot */

/** @param {Navigator & { userAgentData?: { platform?: string } }} [navigatorValue] */
export function submitShortcut(navigatorValue = navigator) {
  const platform = navigatorValue.userAgentData?.platform || navigatorValue.platform || "";
  return /mac/i.test(platform) ? "⌘ + Enter" : "Ctrl + Enter";
}

export function formatTemplate(copy, values = {}) {
  return Object.entries(values).reduce(
    (value, [name, replacement]) => value.replaceAll(`{${name}}`, String(replacement)),
    copy,
  );
}

export function confirmationTitleValue(title) {
  return String(title).replace(/\r\n?/g, "\n");
}

/** @param {unknown} error */
export function isAbortError(error) {
  return Boolean(
    error && typeof error === "object" && "name" in error && error.name === "AbortError",
  );
}

export function modelValue(provider, model) {
  return `${provider}\u0000${model}`;
}

/** @param {string} value @returns {value is BrowserProviderId} */
function isBrowserProviderId(value) {
  return ["gemini", "openrouter", "xai", "openai", "anthropic", "deepseek"].includes(value);
}

/** @returns {BrowserModelSelection | null} */
export function modelChoice(value) {
  const [provider, model] = String(value).split("\u0000");
  return provider && model && isBrowserProviderId(provider) ? { provider, model } : null;
}

/**
 * @param {BrowserLlmPresentation} llm
 * @param {Record<string, boolean>} keyStatus
 */
export function hasConfiguredProviderKey(llm, keyStatus) {
  if (keyStatus && Object.values(keyStatus).some(Boolean)) return true;
  return (Array.isArray(llm?.providers) ? llm.providers : []).some((provider) =>
    Boolean(provider.keyPresent),
  );
}

/**
 * @param {BrowserLlmPresentation} llm
 * @param {{ availableOnly?: boolean, requireKey?: boolean, language?: string, includeHidden?: boolean }} [options]
 * @returns {BrowserLlmModelEntry[]}
 */
export function llmModelEntries(
  llm,
  { availableOnly = false, requireKey = false, language, includeHidden = false } = {},
) {
  return llm.providers
    .flatMap((provider) => {
      return provider.models
        .map((model) => {
          return {
            provider: provider.id,
            providerLabel: provider.label,
            envKey: provider.envKey,
            keyPresent: provider.keyPresent,
            keySource: provider.keySource,
            model: model.id,
            label: model.label,
            status: model.status,
            compatibilityStatus: model.compatibilityStatus,
            adapterStatus: model.adapterStatus,
            enabled: model.enabled,
            available: model.available,
            known: model.known,
            testedLanguages: model.testedLanguages,
            failedLanguages: model.failedLanguages,
            pricing: model.pricing,
            speed: model.speed,
            speedEstimate: model.speedEstimate,
            cost: model.cost,
            recommended: model.recommended,
            recommendationEligibility: model.recommendationEligibility,
            reasoningDescription: model.reasoningDescription,
            evidence: model.evidence,
            keyAccess: model.keyAccess,
            hidden: model.hidden,
            error: model.error,
          };
        })
        .filter((entry) => entry.model && (includeHidden || !entry.hidden));
    })
    .filter(
      (entry) =>
        !availableOnly ||
        (entry.available &&
          entry.enabled &&
          (!requireKey || entry.keyPresent) &&
          (!language ||
            entry.testedLanguages.length === 0 ||
            entry.testedLanguages.some((candidate) => candidate === language))),
    );
}

export function campaignCostText(cost, label) {
  if (!cost || typeof cost.totalUsd !== "number" || Number(cost.pricedTurns) < 1) return "";
  const exact = cost.basis === "exact" && Number(cost.unpricedTurns) === 0;
  return `${label} ${exact ? "" : "≈"}$${cost.totalUsd.toFixed(4)}`;
}

/** @param {number | null | undefined} value @param {boolean} [approximate] */
export function budgetUsdText(value, approximate = false) {
  if (!Number.isFinite(value) || Number(value) < 0) return "";
  const amount = Number(value);
  return `${approximate ? "≈" : ""}$${amount.toFixed(amount < 1 ? 4 : 2)}`;
}

/** @param {BrowserCampaignBudgetSnapshot | null | undefined} budget @param {string} label */
export function campaignBudgetText(budget, label) {
  if (!budget || !Number.isFinite(budget.spentUsd)) return "";
  return `${label} ${budgetUsdText(budget.spentUsd, budget.basis !== "exact")}`;
}
