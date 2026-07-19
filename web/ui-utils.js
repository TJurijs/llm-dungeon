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

export function modelValue(provider, model) {
  return `${provider}\u0000${model}`;
}

export function modelChoice(value) {
  const [provider, model] = String(value).split("\u0000");
  return provider && model ? { provider, model } : null;
}

export function hasConfiguredProviderKey(llm, keyStatus) {
  if (keyStatus && Object.values(keyStatus).some(Boolean)) return true;
  return (Array.isArray(llm?.providers) ? llm.providers : [])
    .some((provider) => Boolean(provider.keyPresent));
}

export function llmModelEntries(llm, {
  availableOnly = false,
  requireKey = false,
  language,
  includeHidden = false,
} = {}) {
  const providers = Array.isArray(llm?.providers) ? llm.providers : [];
  return providers.flatMap((provider) => {
    const models = Array.isArray(provider.models) ? provider.models : [];
    return models.map((model) => {
      const modelId = model.id || model.model;
      const status = model.status || model.state || "untested";
      const testedLanguages = Array.isArray(model.testedLanguages)
        ? model.testedLanguages
        : Array.isArray(model.test?.testedLanguages) ? model.test.testedLanguages : [];
      const failedLanguages = Array.isArray(model.failedLanguages)
        ? model.failedLanguages
        : Array.isArray(model.test?.failedLanguages) ? model.test.failedLanguages : [];
      return {
        provider: provider.id,
        providerLabel: provider.label || provider.id,
        envKey: provider.envKey || "",
        keyPresent: Boolean(provider.keyPresent),
        keySource: provider.keySource || (provider.keyPresent ? "environment" : "missing"),
        model: modelId,
        label: model.label || model.candidate?.label || modelId,
        status,
        compatibilityStatus: model.compatibilityStatus || status,
        technicalStatus: model.technicalStatus || {},
        technicalRecoveries: model.technicalRecoveries || {},
        enabled: Boolean(model.enabled),
        available: model.available === undefined ? status === "compatible" : Boolean(model.available),
        known: Boolean(model.known ?? model.candidate),
        testedLanguages,
        failedLanguages,
        pricing: model.pricing,
        quality: model.quality,
        speed: model.speed,
        speedEstimate: model.speedEstimate,
        cost: model.cost,
        recommended: Boolean(model.recommended),
        evidence: model.evidence,
        keyAccess: model.keyAccess,
        hidden: Boolean(model.hidden),
        error: model.error || model.test?.error,
      };
    }).filter((entry) => entry.model && (includeHidden || !entry.hidden));
  }).filter((entry) => !availableOnly || (
    entry.available
    && entry.enabled
    && (!requireKey || entry.keyPresent)
    && (!language || entry.testedLanguages.length === 0 || entry.testedLanguages.includes(language))
  ));
}

export async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || `Request failed (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return body;
}

export function campaignCostText(cost, label) {
  if (!cost || typeof cost.totalUsd !== "number" || Number(cost.pricedTurns) < 1) return "";
  const exact = cost.basis === "exact" && Number(cost.unpricedTurns) === 0;
  return `${label} ${exact ? "" : "≈"}$${cost.totalUsd.toFixed(4)}`;
}
