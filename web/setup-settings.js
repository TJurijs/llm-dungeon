import {
  formatTemplate,
  llmModelEntries,
} from "./ui-utils.js";

const $ = (selector) => document.querySelector(selector);

function syncLanguageSelect(select, languages, value) {
  if (!select) return;
  const available = languages.length ? languages : [{ code: "en", name: "English" }, { code: "ru", name: "Русский" }];
  const signature = available.map((language) => `${language.code}:${language.name}`).join("|");
  if (select.dataset.languages !== signature) {
    select.replaceChildren(...available.map((language) => {
      const option = document.createElement("option");
      option.value = language.code;
      option.textContent = language.name;
      return option;
    }));
    select.dataset.languages = signature;
  }
  if (available.some((language) => language.code === value)) select.value = value;
}

function createElement(tagName, className, text) {
  const element = document.createElement(tagName);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function createOverflowIcon() {
  const namespace = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(namespace, "svg");
  svg.setAttribute("viewBox", "0 0 20 20");
  svg.setAttribute("aria-hidden", "true");
  for (const cx of [4, 10, 16]) {
    const circle = document.createElementNS(namespace, "circle");
    circle.setAttribute("cx", String(cx));
    circle.setAttribute("cy", "10");
    circle.setAttribute("r", "1.35");
    svg.append(circle);
  }
  return svg;
}

function createRemoveIcon() {
  const namespace = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(namespace, "svg");
  svg.setAttribute("viewBox", "0 0 20 20");
  svg.setAttribute("aria-hidden", "true");
  for (const pathData of ["M4 5h12", "M7 5V3h6v2", "M6 5l.7 12h6.6L14 5", "M9 8v6", "M11 8v6"]) {
    const path = document.createElementNS(namespace, "path");
    path.setAttribute("d", pathData);
    svg.append(path);
  }
  return svg;
}

const MODEL_SIGNAL_PATHS = {
  protocol: ["M10 2.5 16 5v4.5c0 3.6-2.2 6.2-6 8-3.8-1.8-6-4.4-6-8V5l6-2.5Z", "m7.3 9.8 1.8 1.8 3.8-4"],
  technical: ["M2.5 10h3l2.2-4.2 4.2 8.4 2.1-4.2h3.5"],
  quality: ["m10 2.7 2.15 4.36 4.81.7-3.48 3.39.82 4.79L10 13.52l-4.3 2.27.82-4.79-3.48-3.39 4.81-.7L10 2.7Z"],
  speed: ["M11.3 2.5 4.8 11h4.4l-.5 6.5 6.5-8.5h-4.4l.5-6.5Z"],
  cost: ["M10 17.5a7.5 7.5 0 1 0 0-15 7.5 7.5 0 0 0 15Z", "M12.7 6.4c-.7-.6-1.6-.9-2.7-.9-1.5 0-2.6.7-2.6 1.8 0 2.8 5.4 1.2 5.4 4.2 0 1.2-1.1 2-2.8 2-1.2 0-2.3-.4-3-1.1", "M10 4v12"],
};

function createModelSignalIcon(kind) {
  const namespace = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(namespace, "svg");
  svg.setAttribute("viewBox", "0 0 20 20");
  svg.setAttribute("aria-hidden", "true");
  for (const pathData of MODEL_SIGNAL_PATHS[kind] || MODEL_SIGNAL_PATHS.protocol) {
    const path = document.createElementNS(namespace, "path");
    path.setAttribute("d", pathData);
    svg.append(path);
  }
  return svg;
}

export function createSetupSettingsController(dependencies) {
  const {
    api,
    applyLocale,
    getStatus,
    onCampaignCreated,
    refreshStatus,
    setDefaults,
    showToast,
    t,
    withButtonBusy,
  } = dependencies;
  let currentDraft = null;
  let setupWorldSequence = 0;
  let setupGenerationSequence = 0;
  let setupBusy = false;
  let llmRenderSignature = "";
  const testingModels = new Set();

  function modelTestKey(provider, model, language) {
    return `${provider}\u0000${model}\u0000${language || ""}`;
  }

  function invalidateDraft() {
    currentDraft = null;
    setupGenerationSequence += 1;
  }

  function setSetupBusy(busy) {
    for (const element of [$("#campaign-setup-form"), $("#campaign-preview")]) {
      element.inert = busy;
      if (busy) element.setAttribute("aria-busy", "true");
      else element.removeAttribute("aria-busy");
    }
  }

  async function runSetupOperation(button, busyCopy, operation) {
    if (setupBusy) return;
    setupBusy = true;
    setSetupBusy(true);
    try {
      return await withButtonBusy(button, busyCopy, operation);
    } finally {
      setupBusy = false;
      setSetupBusy(false);
    }
  }

  function languages() {
    return Array.isArray(getStatus().languages) ? getStatus().languages : [];
  }

  function syncLanguages() {
    const status = getStatus();
    syncLanguageSelect($("#setup-language"), languages(), $("#setup-language").value || status.language);
    syncLanguageSelect($("#settings-language"), languages(), $("#settings-language").value || status.language);
  }

  function refreshSetupPlaceholders() {
    const language = $("#setup-language").value || getStatus().language || "en";
    const defaults = languages().find((item) => item.code === language)?.setupDefaults;
    $("#premise").placeholder = defaults?.premise || (language === "ru"
      ? "Классическое начало в таверне с несколькими возможностями."
      : "A classic opening in a tavern with several immediate possibilities.");
    $("#character").placeholder = defaults?.characterConcept || (language === "ru"
      ? "Приземлённый искатель приключений с сильными и слабыми сторонами."
      : "A grounded adventurer with useful strengths and a complication.");
  }

  function selectableModels() {
    return llmModelEntries(getStatus().llm, {
      availableOnly: true,
      requireKey: true,
      language: $("#setup-language").value || getStatus().language,
    });
  }

  function defaultModel() {
    const status = getStatus();
    return status.llm?.defaultModel ?? null;
  }

  function syncSetupModels(provider, selectedModel) {
    const models = selectableModels().filter((entry) => entry.provider === provider);
    const select = $("#setup-model");
    select.replaceChildren(...models.map((entry) => {
      const option = document.createElement("option");
      option.value = entry.model;
      option.textContent = `${entry.label}${entry.recommended ? ` · ${t("recommended")}` : ""}`;
      return option;
    }));
    if (models.some((entry) => entry.model === selectedModel)) select.value = selectedModel;
    select.disabled = models.length === 0;
  }

  function syncSetupModelControls({ resetToDefault = false } = {}) {
    const models = selectableModels();
    const providers = [...new Map(models.map((entry) => [entry.provider, entry])).values()];
    const providerSelect = $("#setup-provider");
    const previousProvider = providerSelect.value;
    const previousModel = $("#setup-model").value;
    const preferred = resetToDefault ? defaultModel() : { provider: previousProvider, model: previousModel };
    const preferredAvailable = providers.some((entry) => entry.provider === preferred?.provider);
    const options = providers.map((entry) => {
      const option = document.createElement("option");
      option.value = entry.provider;
      option.textContent = entry.providerLabel;
      return option;
    });
    if (!preferredAvailable) {
      const placeholder = document.createElement("option");
      placeholder.value = "";
      placeholder.textContent = t("chooseProvider");
      placeholder.disabled = true;
      placeholder.selected = true;
      options.unshift(placeholder);
    }
    providerSelect.replaceChildren(...options);
    const provider = preferredAvailable ? preferred.provider : "";
    if (provider) providerSelect.value = provider;
    providerSelect.disabled = providers.length === 0;
    syncSetupModels(provider, preferred?.provider === provider ? preferred.model : undefined);
    updateSetupModelWarning();
  }

  function setupModelChoice() {
    const provider = $("#setup-provider").value;
    const model = $("#setup-model").value;
    return provider && model ? { provider, model } : null;
  }

  function updateSetupModelWarning() {
    const choice = setupModelChoice();
    const usable = choice && selectableModels().some((entry) => entry.provider === choice.provider && entry.model === choice.model);
    const warning = $("#setup-key-warning");
    warning.textContent = t("noAvailableModels");
    warning.hidden = Boolean(usable);
  }

  async function loadSetupWorld(language) {
    const requestId = ++setupWorldSequence;
    const body = await api(`/api/config/world?language=${encodeURIComponent(language)}`);
    if (requestId === setupWorldSequence && $("#setup-language").value === language) {
      $("#setup-world").value = body.markdown;
    }
  }

  async function initializeSetup() {
    const status = getStatus();
    syncLanguageSelect($("#setup-language"), languages(), status.language || "en");
    refreshSetupPlaceholders();
    syncSetupModelControls({ resetToDefault: true });
    await loadSetupWorld($("#setup-language").value);
  }

  function begin() {
    invalidateDraft();
    $("#campaign-setup-form").hidden = false;
    $("#campaign-preview").hidden = true;
    $("#premise").value = "";
    $("#character").value = "";
    $("#setup-model-settings").open = false;
    $("#setup-world-settings").open = false;
    applyLocale(getStatus().language || "en");
    if (setupBusy) return;
    runSetupOperation($("#generate-campaign"), t("working"), initializeSetup)
      .catch((error) => showToast(error.message, "error"));
  }

  function renderPreview(setup) {
    $("#preview-title").textContent = setup.campaignTitle;
    $("#preview-player").textContent = setup.player.name;
    $("#preview-description").textContent = setup.player.description;
    $("#preview-opening").textContent = setup.openingNarration;
    $("#preview-scenario").textContent = setup.scenarioMarkdown;
    $("#preview-traits").replaceChildren(...(setup.player.traits || []).map((trait) => createElement("span", "trait-chip", trait)));
    $("#campaign-setup-form").hidden = true;
    $("#campaign-preview").hidden = false;
    $("#preview-title").focus({ preventScroll: true });
    $("#setup-view .form-scroll").scrollTop = 0;
  }

  async function generate(button = $("#generate-campaign")) {
    const config = setupModelChoice();
    if (!config) {
      showToast(t("noAvailableModels"), "error");
      return;
    }
    const requestId = ++setupGenerationSequence;
    currentDraft = null;
    await runSetupOperation(button, t("generating"), async () => {
      const worldRules = $("#setup-world").value;
      const payload = {
        premise: $("#premise").value,
        character: $("#character").value,
        language: $("#setup-language").value,
        config,
        ...(worldRules.trim() ? { worldRules } : {}),
      };
      const draft = await api("/api/campaigns/draft", { method: "POST", body: JSON.stringify(payload) });
      if (requestId !== setupGenerationSequence) return;
      currentDraft = draft;
      renderPreview(draft.setup);
    }).catch((error) => showToast(error.message, "error"));
  }

  async function accept() {
    if (!currentDraft?.draftId) return;
    await runSetupOperation($("#accept-campaign"), t("creating"), async () => {
      const draftId = currentDraft.draftId;
      const body = await api("/api/campaigns/confirm", { method: "POST", body: JSON.stringify({ draftId }) });
      currentDraft = null;
      await onCampaignCreated(body);
    }).catch((error) => showToast(error.message, "error"));
  }

  function modelStatusCopy(model) {
    const compatible = model.available || ["available", "passed", "compatible"].includes(model.status);
    if (compatible && model.enabled) return t("modelAvailable");
    if (compatible && !model.enabled) return t("modelDisabled");
    const key = {
      testing: "modelTesting",
      failed: "modelFailed",
      stale: "modelStale",
      available: "modelAvailable",
      passed: "modelAvailable",
      compatible: "modelAvailable",
    }[model.status] ?? "modelUntested";
    return t(key);
  }

  function modelCostCopy(model) {
    const key = {
      cheap: "costCheap",
      moderate: "costModerate",
      expensive: "costExpensive",
      "very-expensive": "costVeryExpensive",
    }[model.cost];
    return t(key || "costUnknown");
  }

  function modelQualityCopy(model, language) {
    const rating = model.quality?.[language];
    const key = {
      low: "qualityLow",
      medium: "qualityMedium",
      high: "qualityHigh",
      awaiting_judgment: "qualityAwaiting",
    }[rating];
    return t(key || "qualityUnrated");
  }

  function modelTechnicalCopy(model, language) {
    const key = {
      clean: "technicalClean",
      playable_with_recovery: "technicalRecovery",
      unstable: "technicalUnstable",
      unsupported: "technicalUnsupported",
    }[model.technicalStatus?.[language]];
    return t(key || "technicalInconclusive");
  }

  function createTechnicalSignal(model, language) {
    const technical = model.technicalStatus?.[language] || "inconclusive";
    const recoveries = model.technicalRecoveries?.[language] || 0;
    const recoveryBand = technical === "playable_with_recovery"
      ? recoveries >= 5 ? "recovery-high" : recoveries >= 2 ? "recovery-medium" : "recovery-low"
      : "";
    const tone = technical === "clean" || recoveryBand === "recovery-low"
      ? "positive"
      : recoveryBand === "recovery-medium" ? "mixed"
        : recoveryBand === "recovery-high" ? "warning"
          : ["unstable", "unsupported"].includes(technical) ? "negative" : "neutral";
    return createModelSignal(
      "technical",
      `model-technical technical-${technical} ${recoveryBand} signal-${tone}`,
      modelTechnicalCopy(model, language),
      language,
    );
  }

  function createQualitySignal(model, language) {
    const rating = model.quality?.[language] || "unrated";
    const supported = model.testedLanguages.includes(language);
    const tone = rating === "high"
      ? "positive"
      : rating === "medium" ? "mixed"
        : rating === "low" ? "warning" : "neutral";
    return createModelSignal(
      "quality",
      `model-quality quality-${rating} signal-${tone} ${supported ? "is-supported" : "is-unsupported"}`,
      modelQualityCopy(model, language),
      language,
    );
  }

  function modelSpeedCopy(model) {
    const key = { fast: "speedFast", average: "speedAverage", slow: "speedSlow", "very-slow": "speedVerySlow" }[model.speed];
    return t(key || "speedUnrated");
  }

  function createModelSignal(kind, className, label, language) {
    const signal = createElement("span", `model-signal ${className}`);
    signal.title = label;
    signal.setAttribute("aria-label", label);
    signal.append(createModelSignalIcon(kind));
    if (language) signal.append(createElement("span", "model-signal-language", language.toUpperCase()));
    return signal;
  }

  function renderModelStatusLegend() {
    const legend = $("#llm-status-legend");
    legend.setAttribute("aria-label", t("modelStatusLegend"));
    const categories = createElement("div", "model-status-legend-categories");
    for (const [kind, key] of [
      ["protocol", "compatibilityLabel"],
      ["technical", "legendTechnical"],
      ["quality", "legendQuality"],
      ["speed", "legendSpeed"],
      ["cost", "legendCost"],
    ]) {
      const item = createElement("span", "model-status-legend-item");
      item.append(createModelSignal(kind, "signal-neutral", t(key)), createElement("span", "", t(key)));
      categories.append(item);
    }
    const colors = createElement("div", "model-status-legend-colors");
    for (const [tone, key] of [
      ["positive", "legendGood"],
      ["mixed", "legendTowardBad"],
      ["warning", "legendTowardBad"],
      ["negative", "legendBad"],
      ["neutral", "legendUnknown"],
    ]) {
      const item = createElement("span", "model-status-legend-color", t(key));
      item.prepend(createElement("i", `signal-${tone}`));
      colors.append(item);
    }
    legend.replaceChildren(categories, colors);
  }

  function renderModelRow(provider, model, isDefault) {
    const isTesting = testingModels.has(modelTestKey(provider.id, model.model));
    const presentedModel = isTesting ? { ...model, status: "testing", available: false } : model;
    const row = createElement("div", "llm-model-row");
    if (isDefault) row.classList.add("is-default");
    if (!model.known) row.classList.add("is-custom");
    const copy = createElement("div", "llm-model-copy");
    const heading = createElement("div", "llm-model-heading");
    heading.title = model.model;
    heading.append(createElement("strong", "", model.label || model.model));
    if (model.label && model.label !== model.model) heading.append(createElement("code", "", model.model));
    if (model.recommended) heading.append(createElement("span", "model-recommended", t("recommended")));
    if (provider.id === "openai" && model.keyAccess === "not_allowed") {
      const marker = createElement("span", "model-key-restriction", "(!)");
      marker.title = t("modelNotAllowedByKey");
      marker.setAttribute("aria-label", t("modelNotAllowedByKey"));
      heading.append(marker);
    }
    const metadata = createElement("div", "llm-model-meta");
    const protocolTone = presentedModel.available && presentedModel.enabled
      ? "positive"
      : presentedModel.status === "failed" ? "negative"
        : ["testing", "stale"].includes(presentedModel.status) ? "warning" : "neutral";
    const protocolLabel = modelStatusCopy(presentedModel);
    const statusBadge = isTesting
      ? createElement("span", `model-signal model-status model-protocol-testing signal-${protocolTone}`)
      : presentedModel.status === "stale"
        ? createElement("button", `model-signal model-status model-protocol-retest signal-${protocolTone}`)
        : createModelSignal("protocol", `model-status signal-${protocolTone}`, protocolLabel);
    if (isTesting) {
      statusBadge.title = protocolLabel;
      statusBadge.setAttribute("aria-label", `${protocolLabel}: ${provider.label}, ${model.label || model.model}`);
      statusBadge.setAttribute("aria-live", "polite");
      statusBadge.append(createElement("span", "model-protocol-spinner"));
    } else if (presentedModel.status === "stale") {
      statusBadge.type = "button";
      statusBadge.dataset.llmAction = "test";
      statusBadge.dataset.provider = provider.id;
      statusBadge.dataset.model = model.model;
      statusBadge.disabled = !provider.keyPresent || isTesting;
      statusBadge.title = `${protocolLabel} · ${t("retestModel")}`;
      statusBadge.setAttribute(
        "aria-label",
        `${protocolLabel}: ${t("retestModel")} ${provider.label}, ${model.label || model.model}`,
      );
      statusBadge.append(createModelSignalIcon("protocol"));
    } else if (model.error) {
      statusBadge.title = model.error;
    }
    metadata.append(statusBadge);
    const primaryLanguage = "en";
    const technicalGroup = createElement("span", "model-technical-group");
    technicalGroup.append(createTechnicalSignal(model, primaryLanguage));
    const qualityGroup = createElement("span", "model-quality-group");
    qualityGroup.append(createQualitySignal(model, primaryLanguage));
    const additionalLanguages = languages()
      .map((language) => language.code)
      .filter((language) => language !== primaryLanguage);
    if (additionalLanguages.length > 0) {
      const details = createElement("details", "model-language-details");
      const summary = createElement("summary", "model-language-summary");
      summary.title = t("otherLanguages");
      summary.setAttribute("aria-label", `${primaryLanguage.toUpperCase()} · ${t("otherLanguages")}`);
      summary.append(technicalGroup, qualityGroup);
      const menu = createElement("div", "model-language-menu");
      for (const language of additionalLanguages) {
        const languageRow = createElement("div", "model-language-row");
        languageRow.append(
          createTechnicalSignal(model, language),
          createQualitySignal(model, language),
        );
        menu.append(languageRow);
      }
      details.append(summary, menu);
      metadata.append(details);
    } else {
      metadata.append(technicalGroup, qualityGroup);
    }
    const speedTone = model.speed === "fast"
      ? "positive"
      : model.speed === "average" ? "mixed" : model.speed === "slow" ? "warning"
        : model.speed === "very-slow" ? "negative" : "neutral";
    const speed = createModelSignal("speed", `model-speed speed-${model.speed || "unrated"} signal-${speedTone}`, modelSpeedCopy(model));
    metadata.append(speed);
    const costTone = model.cost === "cheap"
      ? "positive"
      : model.cost === "moderate" ? "mixed" : model.cost === "expensive" ? "warning"
        : model.cost === "very-expensive" ? "negative" : "neutral";
    const price = createModelSignal("cost", `model-price cost-${model.cost || "unknown"} signal-${costTone}`, modelCostCopy(model));
    metadata.append(price);
    copy.append(heading, metadata);
    if (model.error) copy.append(createElement("p", "llm-model-error", model.error));

    const actions = createElement("div", "llm-model-actions");
    if (!model.known) {
      actions.classList.add("has-remove");
      const testButton = createElement("button", "quiet", t(model.status === "untested" ? "testModel" : "retestModel"));
      testButton.type = "button";
      testButton.dataset.llmAction = "test";
      testButton.dataset.provider = provider.id;
      testButton.dataset.model = model.model;
      testButton.disabled = !provider.keyPresent || isTesting;
      testButton.setAttribute("aria-label", `${testButton.textContent}: ${provider.label}, ${model.label || model.model}`);
      if (isTesting) testButton.setAttribute("aria-busy", "true");
      actions.append(testButton);
    }

    const compatible = model.available || ["available", "passed", "compatible"].includes(model.status);
    const toggleButton = createElement("button", "quiet", model.enabled ? t("disableModel") : t("enableModel"));
    toggleButton.type = "button";
    toggleButton.dataset.llmAction = "toggle";
    toggleButton.dataset.provider = provider.id;
    toggleButton.dataset.model = model.model;
    toggleButton.dataset.enabled = String(!model.enabled);
    toggleButton.disabled = !compatible;
    toggleButton.setAttribute("aria-label", `${toggleButton.textContent}: ${provider.label}, ${model.label || model.model}`);
    actions.append(toggleButton);

    const defaultButton = createElement("button", isDefault ? "quiet" : "", t("activeDefault"));
    defaultButton.type = "button";
    defaultButton.dataset.llmAction = "default";
    defaultButton.dataset.provider = provider.id;
    defaultButton.dataset.model = model.model;
    defaultButton.disabled = isDefault || !provider.keyPresent || !model.available || !model.enabled;
    defaultButton.setAttribute("aria-label", `${t("setDefault")}: ${provider.label}, ${model.label || model.model}`);
    actions.append(defaultButton);
    if (!model.known) {
      const removeButton = createElement("button", "quiet model-remove-button");
      removeButton.type = "button";
      removeButton.dataset.llmAction = "remove";
      removeButton.dataset.provider = provider.id;
      removeButton.dataset.model = model.model;
      removeButton.setAttribute("aria-label", `${t("removeModel")}: ${provider.label}, ${model.label || model.model}`);
      removeButton.title = t("removeModel");
      removeButton.append(createRemoveIcon());
      actions.append(removeButton);
    }
    row.append(copy, actions);
    return row;
  }

  function renderLlmConfiguration(force = false) {
    const llm = getStatus().llm ?? { defaultModel: null, providers: [] };
    const signature = JSON.stringify(llm);
    if (!force && signature === llmRenderSignature) return false;
    llmRenderSignature = signature;
    renderModelStatusLegend();
    const defaultEntry = llmModelEntries(llm).find((entry) => llm.defaultModel
      && entry.provider === llm.defaultModel.provider && entry.model === llm.defaultModel.model);
    $("#llm-default-summary").textContent = defaultEntry
      ? `${t("defaultModel")}: ${defaultEntry.providerLabel} · ${defaultEntry.label}`
      : t("noDefaultModel");
    const providers = Array.isArray(llm.providers) ? llm.providers : [];
    const openProviders = new Set([...$("#llm-providers").querySelectorAll("details[open][data-provider-details]")]
      .map((card) => card.dataset.providerDetails));
    $("#llm-providers").replaceChildren(...providers.map((provider) => {
      const card = createElement("details", "llm-provider-card");
      card.dataset.providerDetails = provider.id;
      card.open = openProviders.has(provider.id);
      const header = createElement("summary", "llm-provider-header");
      const heading = createElement("div", "");
      const title = createElement("div", "llm-provider-title");
      title.append(createElement("h3", "", provider.label || provider.id));
      if (provider.recommended) title.append(createElement("span", "provider-recommended", t("recommended")));
      heading.append(title);
      heading.append(createElement("p", "llm-env-key", `${t("environmentVariable")}: ${provider.envKey}`));
      const keyCopy = provider.keySource === "session"
        ? t("sessionKeyDetected")
        : provider.keyPresent ? t("environmentKeyDetected") : t("keyMissing");
      const keyTone = provider.keyConnectionStatus === "connected"
        ? "success"
        : provider.keyConnectionStatus === "failed" ? "error" : "warning";
      const keyBadge = createElement("span", `llm-key-status ${keyTone}`, keyCopy);
      header.append(heading, keyBadge);
      const tools = createElement("details", "llm-provider-tools");
      const toolsTrigger = createElement("summary", "llm-provider-tools-trigger");
      toolsTrigger.setAttribute("aria-label", `${t("providerOptions")}: ${provider.label || provider.id}`);
      toolsTrigger.title = t("providerOptions");
      toolsTrigger.append(createOverflowIcon());
      const toolsPanel = createElement("div", "llm-provider-tools-panel");
      const keyForm = createElement("form", "llm-provider-key-form");
      keyForm.dataset.providerKeyForm = provider.id;
      const keyInputId = `provider-key-${provider.id}`;
      const keyLabel = createElement("label", "sr-only", `${t("sessionApiKey")}: ${provider.label || provider.id}`);
      keyLabel.htmlFor = keyInputId;
      const keyInput = createElement("input", "");
      keyInput.id = keyInputId;
      keyInput.name = "key";
      keyInput.type = "password";
      keyInput.maxLength = 10_000;
      keyInput.autocomplete = "new-password";
      keyInput.placeholder = t("sessionApiKey");
      const saveKey = createElement("button", "quiet", t("useSessionKey"));
      saveKey.type = "submit";
      const clearKey = createElement("button", "quiet", t("clearSessionKey"));
      clearKey.type = "button";
      clearKey.dataset.clearSessionKey = provider.id;
      clearKey.disabled = provider.keySource !== "session";
      const keyHint = createElement("p", "field-hint llm-key-hint", t("sessionKeyHint"));
      keyForm.append(keyLabel, keyInput, saveKey, clearKey, keyHint);
      const providerModels = llmModelEntries(llm).filter((model) => model.provider === provider.id);
      const models = createElement("div", "llm-model-list");
      models.replaceChildren(...providerModels.map((model) => renderModelRow(
        provider,
        model,
        llm.defaultModel?.provider === provider.id && llm.defaultModel?.model === model.model,
      )));
      if (!providerModels.length) models.append(createElement("p", "field-hint", t("noProviderModels")));
      const customForm = createElement("form", "llm-custom-model-form");
      customForm.dataset.customModelProvider = provider.id;
      const inputId = `custom-model-${provider.id}`;
      const label = createElement("label", "sr-only", `${t("anotherModelId")}: ${provider.label || provider.id}`);
      label.htmlFor = inputId;
      const input = createElement("input", "");
      input.id = inputId;
      input.name = "model";
      input.type = "text";
      input.maxLength = 300;
      input.autocomplete = "off";
      input.placeholder = t("modelIdPlaceholder");
      const addButton = createElement("button", "quiet", t("addModel"));
      addButton.type = "submit";
      customForm.append(label, input, addButton);
      toolsPanel.append(keyForm, customForm);
      tools.append(toolsTrigger, toolsPanel);
      card.append(header, tools, models);
      return card;
    }));
    return true;
  }

  async function mutateLlm(button, endpoint, method, payload, successCopy, { inspectOk = false } = {}) {
    let succeeded = false;
    const testKey = endpoint === "/api/llm/models/test"
      ? modelTestKey(payload.provider, payload.model, payload.language)
      : null;
    const focusAction = endpoint === "/api/llm/models/test"
      ? "test"
      : endpoint === "/api/llm/models" ? "toggle" : "default";
    if (testKey) {
      testingModels.add(testKey);
      renderLlmConfiguration(true);
    }
    const restoreActionFocus = () => {
      const matchingActions = [...$("#llm-providers").querySelectorAll("[data-llm-action]")]
        .filter((candidate) => candidate.dataset.provider === payload.provider
          && candidate.dataset.model === payload.model
          && (!payload.language || candidate.dataset.language === payload.language));
      const focusTarget = matchingActions.find((candidate) => candidate.dataset.llmAction === focusAction && !candidate.disabled)
        ?? matchingActions.find((candidate) => !candidate.disabled);
      focusTarget?.focus({ preventScroll: true });
    };
    await withButtonBusy(button, t("working"), async () => {
      const result = await api(endpoint, { method, body: JSON.stringify(payload) });
      await refreshStatus({ ensureFresh: true });
      renderLlmConfiguration();
      if (!testKey) restoreActionFocus();
      if (inspectOk && result.ok === false) {
        const error = result.error || t("modelTestFailed");
        showToast(error, "error");
        return;
      }
      if (inspectOk && Array.isArray(result.failures) && result.failures.length) {
        showToast(formatTemplate(t("modelTestPartial"), {
          passed: (result.testedLanguages || []).map((language) => language.toUpperCase()).join(", ") || "—",
          failed: result.failures.map((failure) => failure.language.toUpperCase()).join(", "),
        }), "success");
        return;
      }
      showToast(t(successCopy), "success");
    }).then(() => { succeeded = true; }).catch((error) => showToast(error.message, "error")).finally(() => {
      if (!testKey) return;
      testingModels.delete(testKey);
      renderLlmConfiguration(true);
      restoreActionFocus();
    });
    return succeeded;
  }

  function handleLlmAction(event) {
    const button = event.target.closest("[data-llm-action]");
    if (!button) return;
    const payload = {
      provider: button.dataset.provider,
      model: button.dataset.model,
      ...(button.dataset.language ? { language: button.dataset.language } : {}),
    };
    if (button.dataset.llmAction === "test") {
      mutateLlm(button, "/api/llm/models/test", "POST", payload, "modelTestPassed", { inspectOk: true });
    } else if (button.dataset.llmAction === "toggle") {
      mutateLlm(button, "/api/llm/models", "PUT", { ...payload, enabled: button.dataset.enabled === "true" }, "modelAvailabilitySaved");
    } else if (button.dataset.llmAction === "default") {
      mutateLlm(button, "/api/llm/default", "PUT", payload, "defaultModelSaved");
    } else if (button.dataset.llmAction === "remove") {
      mutateLlm(button, "/api/llm/models", "DELETE", payload, "modelRemoved");
    }
  }

  async function handleCustomModel(event) {
    const form = event.target.closest("[data-custom-model-provider]");
    if (!form) return;
    event.preventDefault();
    const input = form.elements.model;
    const model = input.value.trim();
    if (!model) {
      showToast(t("modelIdRequired"), "error");
      input.focus();
      return;
    }
    const button = form.querySelector("button[type=submit]");
    const added = await mutateLlm(button, "/api/llm/models", "POST", {
      provider: form.dataset.customModelProvider,
      model,
    }, "modelAdded");
    if (added) input.value = "";
  }

  async function saveSessionKey(form, key) {
    const button = form.querySelector("button[type=submit]");
    await withButtonBusy(button, t("working"), async () => {
      await api("/api/llm/keys", {
        method: "PUT",
        body: JSON.stringify({ provider: form.dataset.providerKeyForm, key }),
      });
      form.elements.key.value = "";
      await refreshStatus({ ensureFresh: true });
      renderLlmConfiguration();
      showToast(t(key ? "sessionKeySaved" : "sessionKeyCleared"), "success");
    }).catch((error) => showToast(error.message, "error"));
  }

  function handleProviderKeySubmit(event) {
    const form = event.target.closest("[data-provider-key-form]");
    if (!form) return;
    event.preventDefault();
    const key = form.elements.key.value.trim();
    if (!key) {
      showToast(t("sessionKeyRequired"), "error");
      form.elements.key.focus();
      return;
    }
    saveSessionKey(form, key);
  }

  function handleProviderKeyClear(event) {
    const button = event.target.closest("[data-clear-session-key]");
    if (!button) return;
    const form = button.closest("[data-provider-key-form]");
    saveSessionKey(form, "");
  }

  async function reloadProjectEnv() {
    const button = $("#reload-project-env");
    await withIconButtonBusy(button, async () => {
      await api("/api/llm/environment/reload", { method: "POST", body: JSON.stringify({}) });
      await refreshStatus({ ensureFresh: true });
      renderLlmConfiguration();
      showToast(t("envReloaded"), "success");
    }).catch((error) => showToast(error.message, "error"));
  }

  async function testProviderConnections() {
    const button = $("#test-provider-connections");
    await withIconButtonBusy(button, async () => {
      const result = await api("/api/llm/connections/test", { method: "POST", body: JSON.stringify({}) });
      await refreshStatus({ ensureFresh: true });
      renderLlmConfiguration();
      const connected = result.results.filter((entry) => entry.status === "connected").map((entry) => entry.provider);
      const failed = result.results.filter((entry) => entry.status !== "connected")
        .map((entry) => `${entry.provider} (${t(entry.status === "unauthorized" ? "connectionUnauthorized" : "connectionUnavailable")})`);
      showToast(
        failed.length
          ? formatTemplate(t("connectionsPartial"), { connected: connected.join(", ") || "—", failed: failed.join(", ") })
          : formatTemplate(t("connectionsPassed"), { providers: connected.join(", ") }),
        failed.length ? "error" : "success",
      );
    }).catch((error) => showToast(error.message, "error"));
  }

  async function withIconButtonBusy(button, operation) {
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    try {
      return await operation();
    } finally {
      button.disabled = false;
      button.removeAttribute("aria-busy");
    }
  }

  async function loadSettingsWorld(language) {
    const body = await api(`/api/config/world?language=${encodeURIComponent(language)}`);
    if ($("#settings-language").value !== language) return;
    $("#settings-world").value = body.markdown;
    const sourceCopy = { default: "defaultSource", localized_override: "localizedSource", legacy_override: "legacySource" };
    $("#world-source").textContent = `${body.language} · ${t(sourceCopy[body.source] || body.source)}`;
  }

  async function loadSettings() {
    const status = getStatus();
    syncLanguageSelect($("#settings-language"), languages(), status.language || "en");
    renderLlmConfiguration();
    await loadSettingsWorld($("#settings-language").value);
  }

  function selectSettingsSection(section) {
    for (const button of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll("[data-settings-section]"))) {
      if (button.dataset.settingsSection === section) button.setAttribute("aria-current", "page");
      else button.removeAttribute("aria-current");
    }
    for (const panel of /** @type {NodeListOf<HTMLElement>} */ (document.querySelectorAll("[data-settings-panel]"))) {
      panel.hidden = panel.dataset.settingsPanel !== section;
    }
  }

  async function saveWorld() {
    await withButtonBusy($("#save-world"), t("working"), async () => {
      const language = $("#settings-language").value;
      await api("/api/config/world", { method: "PUT", body: JSON.stringify({ language, markdown: $("#settings-world").value }) });
      await api("/api/config/language", { method: "PUT", body: JSON.stringify({ language }) });
      setDefaults({ language });
      applyLocale(language);
      await loadSettingsWorld(language);
      showToast(t("worldSaved"), "success");
    }).catch((error) => showToast(error.message, "error"));
  }

  function bind() {
    $("#campaign-setup-form").addEventListener("submit", (event) => { event.preventDefault(); generate(); });
    $("#campaign-setup-form").addEventListener("input", invalidateDraft);
    $("#campaign-setup-form").addEventListener("change", invalidateDraft);
    $("#setup-provider").addEventListener("change", () => {
      syncSetupModels($("#setup-provider").value);
      updateSetupModelWarning();
    });
    $("#setup-model").addEventListener("change", updateSetupModelWarning);
    $("#setup-language").addEventListener("change", () => {
      $("#campaign-preview").hidden = true;
      refreshSetupPlaceholders();
      syncSetupModelControls();
      loadSetupWorld($("#setup-language").value).catch((error) => showToast(error.message, "error"));
    });
    $("#accept-campaign").addEventListener("click", accept);
    $("#regenerate-campaign").addEventListener("click", () => {
      $("#campaign-setup-form").hidden = false;
      $("#campaign-preview").hidden = true;
      generate($("#regenerate-campaign"));
    });
    $("#edit-campaign").addEventListener("click", () => {
      invalidateDraft();
      $("#campaign-preview").hidden = true;
      $("#campaign-setup-form").hidden = false;
      $("#premise").focus();
    });
    $("#llm-providers").addEventListener("click", handleLlmAction);
    $("#llm-providers").addEventListener("click", handleProviderKeyClear);
    $("#llm-providers").addEventListener("submit", handleCustomModel);
    $("#llm-providers").addEventListener("submit", handleProviderKeySubmit);
    $("#reload-project-env").addEventListener("click", reloadProjectEnv);
    $("#test-provider-connections").addEventListener("click", testProviderConnections);
    $(".settings-navigation").addEventListener("click", (event) => {
      const button = event.target.closest("[data-settings-section]");
      if (button) selectSettingsSection(button.dataset.settingsSection);
    });
    $("#settings-language").addEventListener("change", () => loadSettingsWorld($("#settings-language").value).catch((error) => showToast(error.message, "error")));
    $("#save-world").addEventListener("click", saveWorld);
  }

  function syncLlm(force = false) {
    if (!renderLlmConfiguration(force)) return;
    syncSetupModelControls();
  }

  return { begin, bind, loadSettings, refreshSetupPlaceholders, selectSettingsSection, syncLanguages, syncLlm };
}
