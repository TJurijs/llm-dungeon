import {
  campaignApiPath,
  chooseCampaignId,
  mergeAuthoritativeTerminalEntries,
  normalizeTerminalEntry,
  sortCampaigns,
} from "./terminal-history.js";
import { actionPrefillValue, BrowserChatHistory, createChatEntry, createThinkingEntry } from "./chat-ui.js";
import { renderInspectionView, inspectionMessage } from "./inspection-ui.js";
import { createSetupSettingsController } from "./setup-settings.js";
import { UI_COPY, localeCopy } from "./ui-copy.js";
import {
  campaignCostText,
  confirmationTitleValue,
  formatTemplate as fillTemplate,
  hasConfiguredProviderKey,
  llmModelEntries,
  modelChoice,
  modelValue,
  requestJson as api,
  submitShortcut,
} from "./ui-utils.js";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];

const SELECTED_CAMPAIGN_KEY = "llm-dungeon:selected-campaign";
const SIDEBAR_WIDTH_KEY = "llm-dungeon:sidebar-width";
const SIDEBAR_COLLAPSED_KEY = "llm-dungeon:sidebar-collapsed";
const INSPECTION_WIDTH_KEY = "llm-dungeon:inspection-width";
let locale = "";
let status = { language: "en", languages: [], config: null, llm: { defaultModel: null, providers: [] }, campaigns: [] };
let campaigns = [];
let selectedCampaignId = null;
let currentView = "chat";
let currentInspectionView = "character";
let statusPollPromise = null;
let statusRefreshQueued = false;
let sidebarReturnFocus = null;
let pendingArchiveCampaignId = null;
let pendingDeleteCampaignId = null;
let inspectionSequence = 0;
let campaignSetupSequence = 0;
let toastTimer;
const chatHistory = new BrowserChatHistory();
const inFlightCampaigns = new Set();
const savingCampaignConfigs = new Set();
const reconciledCampaignStates = new Map();
const actionDrafts = new Map();
const characterNames = new Map();

function t(key) {
  return UI_COPY[locale]?.[key] ?? UI_COPY.en[key] ?? key;
}

function campaignTranslator(campaignId, language) {
  const targetLanguage = language ?? campaignById(campaignId)?.language ?? "en";
  return (key) => localeCopy(targetLanguage, key);
}

function campaignById(campaignId) {
  return campaigns.find((campaign) => campaign.campaignId === campaignId) ?? null;
}

function selectedCampaign() {
  return campaignById(selectedCampaignId);
}

function saveActionDraft(campaignId = selectedCampaignId) {
  if (!campaignId) return;
  const value = $("#action").value;
  if (value) actionDrafts.set(campaignId, value);
  else actionDrafts.delete(campaignId);
}

function restoreActionDraft(campaignId = selectedCampaignId) {
  $("#action").value = campaignId ? actionDrafts.get(campaignId) ?? "" : "";
  resizeComposer();
}

function formatTemplate(key, values = {}) {
  return fillTemplate(t(key), values);
}

function applyLocale(language) {
  const nextLocale = UI_COPY[language] ? language : "en";
  if (nextLocale === locale) return false;
  locale = nextLocale;
  document.documentElement.lang = locale;
  $$('[data-i18n]').forEach((element) => { element.textContent = t(element.dataset.i18n); });
  $$('[data-i18n-aria-label]').forEach((element) => { element.setAttribute("aria-label", t(element.dataset.i18nAriaLabel)); });
  $("#action").placeholder = t("actionPlaceholder");
  $("#action").setAttribute("aria-label", t("whatDo"));
  $("#send-action").setAttribute("aria-label", t("sendAction"));
  $("#composer-hint").textContent = formatTemplate("submitHint", { shortcut: submitShortcut() });
  $("#campaign-sidebar").setAttribute("aria-label", t("campaigns"));
  $(".campaign-navigation").setAttribute("aria-label", t("campaigns"));
  $$(".sidebar-opener").forEach((button) => {
    button.setAttribute("aria-label", t("openCampaigns"));
    button.title = t("openCampaigns");
  });
  $("#close-sidebar").setAttribute("aria-label", t("closeCampaigns"));
  $("#close-sidebar").title = t("closeCampaigns");
  $("#sidebar-backdrop").setAttribute("aria-label", t("closeCampaigns"));
  $("#campaign-model").setAttribute("aria-label", t("model"));
  $("#open-campaign-setup").setAttribute("aria-label", t("campaignSetup"));
  $("#open-campaign-setup").title = t("campaignSetup");
  $("#edit-campaign-title").setAttribute("aria-label", t("editCampaignName"));
  $("#edit-campaign-title").title = t("editCampaignName");
  $("#close-campaign-setup").setAttribute("aria-label", t("closeCampaignSetup"));
  $("#cancel-archive-campaign-x").setAttribute("aria-label", t("cancelArchiving"));
  $("#open-inspection").setAttribute("aria-label", t("campaignState"));
  $("#open-inspection").title = t("campaignState");
  $("#campaign-menu > summary").setAttribute("aria-label", t("campaignActions"));
  $("#chat-log").setAttribute("aria-label", t("transcript"));
  $("#inspection-tabs").setAttribute("aria-label", t("stateViews"));
  $("#close-inspection").setAttribute("aria-label", t("closeState"));
  $("#close-inspection").title = t("closeState");
  $("#sidebar-resizer").setAttribute("aria-label", t("resizeCampaigns"));
  $("#inspection-resizer").setAttribute("aria-label", t("resizeCampaignState"));
  $("#cancel-delete-campaign-x").setAttribute("aria-label", t("cancelDeletion"));
  setPrefillButtonCopy($("#ask-generic"), "ask");
  setPrefillButtonCopy($("#appeal-generic"), "appeal");
  syncProviderOnboarding();
  setupSettings?.refreshSetupPlaceholders();
  setupSettings?.syncLlm(true);
  renderSidebar();
  return true;
}

function syncProviderOnboarding() {
  const configured = hasConfiguredProviderKey(status.llm, status.keyStatus);
  $("#campaign-welcome").hidden = !configured;
  $("#provider-onboarding").hidden = configured;
  $("#empty-new-campaign").hidden = !configured;
  $("#empty-open-settings").hidden = configured;
  $("#new-campaign-icon").textContent = configured ? "＋" : "⚙";
  const label = t(configured ? "newCampaign" : "configureLlmProvider");
  $("#new-campaign-label").textContent = label;
  $("#empty-new-campaign").textContent = t("newCampaign");
  $("#empty-open-settings").textContent = t("openSettings");
}

function setPrefillButtonCopy(button, kind) {
  if (!button) return;
  button.setAttribute("aria-label", t(`${kind}GenericLabel`));
  button.title = t(`${kind}GenericTitle`);
}

function showToast(message, mode = "normal") {
  const toast = $("#toast");
  clearTimeout(toastTimer);
  toast.textContent = message;
  toast.className = `toast ${mode}`;
  toast.setAttribute("role", mode === "error" ? "alert" : "status");
  toast.hidden = false;
  toastTimer = setTimeout(() => { toast.hidden = true; }, mode === "error" ? 7000 : 3500);
}

function withButtonBusy(button, busyCopy, operation) {
  const original = button.textContent;
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  if (busyCopy) button.textContent = busyCopy;
  return Promise.resolve().then(operation).finally(() => {
    button.disabled = false;
    button.removeAttribute("aria-busy");
    button.textContent = original;
    renderCampaignChrome();
  });
}

function appendHistory(campaignId, value, { render = true } = {}) {
  if (!chatHistory.append(campaignId, value)) return;
  if (render && selectedCampaignId === campaignId && currentView === "chat") renderChat({ scroll: true });
}

function appendCommittedResponse(campaignId, result, { render = true } = {}) {
  const campaignT = campaignTranslator(campaignId, result.state?.language);
  if (result.checkText) appendHistory(campaignId, { title: campaignT("check"), text: result.checkText, mode: "normal" }, { render: false });
  if (result.kind === "appeal") {
    const target = Number.isSafeInteger(result.appealTargetTurn) ? ` · ${campaignT("turn")} ${result.appealTargetTurn}` : "";
    appendHistory(campaignId, {
      title: `${campaignT("appealHeading")}${target}`,
      text: result.narration,
      mode: "success",
      kind: "appeal",
      turn: result.turn,
      ...(result.generation ? { generation: result.generation } : {}),
      ...(result.appealTargetTurn === undefined ? {} : { appealTargetTurn: result.appealTargetTurn }),
    }, { render: false });
  } else {
    appendHistory(campaignId, {
      title: `${campaignT("dm")} · ${campaignT("turn")} ${result.turn}`,
      text: result.narration,
      mode: "success",
      kind: "gameplay",
      turn: result.turn,
      ...(result.generation ? { generation: result.generation } : {}),
    }, { render: false });
  }
  if (result.state) updateCampaignFromState(result.state);
  if (render && selectedCampaignId === campaignId && currentView === "chat") renderChat({ scroll: true });
}

function updateCampaignFromState(state, config) {
  const index = campaigns.findIndex((campaign) => campaign.campaignId === state.campaignId);
  const existing = index >= 0 ? campaigns[index] : {};
  const next = { ...existing, ...state, ...(config ? { config } : {}) };
  if (index >= 0) campaigns[index] = next;
  else campaigns.unshift(next);
  campaigns = sortCampaigns(campaigns);
  renderSidebar();
  renderCampaignChrome();
}

function renderChat({ scroll = false } = {}) {
  const campaign = selectedCampaign();
  const empty = $("#chat-empty");
  const log = $("#chat-log");
  const composer = $("#composer-wrap");
  if (!campaign) {
    delete log.dataset.campaignId;
    empty.hidden = false;
    log.hidden = true;
    composer.hidden = true;
    return;
  }
  empty.hidden = true;
  log.hidden = false;
  composer.hidden = false;
  log.dataset.campaignId = campaign.campaignId;
  const playerName = characterNames.get(campaign.campaignId) ?? campaignTranslator(campaign.campaignId, campaign.language)("you");
  log.replaceChildren(...chatHistory.entries(campaign.campaignId).map((entry) => createChatEntry(entry, playerName)));
  if (inFlightCampaigns.has(campaign.campaignId)) log.append(createThinkingEntry({ dm: t("dm"), working: t("working") }));
  updateComposer(campaign);
  if (scroll) requestAnimationFrame(() => { $("#chat-scroll").scrollTop = $("#chat-scroll").scrollHeight; });
}

function campaignBusy(campaign) {
  return Boolean(campaign?.busy || inFlightCampaigns.has(campaign?.campaignId));
}

function campaignCanPlay(campaign) {
  return Boolean(campaign && !campaign.archived && campaign.status === "active" && !campaign.pending && !campaignBusy(campaign));
}

function campaignCanRecover(campaign) {
  return Boolean(campaign && !campaign.archived && campaign.status === "active" && campaign.pending && !campaignBusy(campaign));
}

function updateComposer(campaign) {
  const canPlay = campaignCanPlay(campaign);
  const canRecover = campaignCanRecover(campaign);
  const action = $("#action");
  action.disabled = !canPlay && !canRecover;
  $("#send-action").disabled = !canPlay && !canRecover;
  $("#ask-generic").disabled = !canPlay;
  $("#appeal-generic").disabled = !canPlay;
  const banner = $("#pending-banner");
  if (campaignBusy(campaign)) {
    banner.textContent = t("workingHint");
    banner.hidden = false;
  } else if (campaign.pending) {
    banner.textContent = t("pendingHint");
    banner.hidden = false;
  } else if (campaign.archived || campaign.status !== "active") {
    banner.textContent = t("campaignFinished");
    banner.hidden = false;
  } else {
    banner.hidden = true;
  }
}

function statusLabel(campaign) {
  return campaign.archived ? t("archivedStatus") : t(campaign.status);
}

function renderCampaignItem(campaign) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "campaign-item";
  button.dataset.campaignId = campaign.campaignId;
  if (campaign.campaignId === selectedCampaignId) button.setAttribute("aria-current", "page");
  const dot = document.createElement("span");
  dot.className = `campaign-dot ${campaignBusy(campaign) ? "busy" : campaign.archived ? "archived" : campaign.status}`;
  dot.setAttribute("aria-hidden", "true");
  const copy = document.createElement("span");
  copy.className = "campaign-item-copy";
  const title = document.createElement("span");
  title.className = "campaign-item-title";
  title.textContent = campaign.title;
  const meta = document.createElement("span");
  meta.className = "campaign-item-meta";
  meta.textContent = `${t("turn")} ${campaign.turn} · ${campaignBusy(campaign) ? t("working") : statusLabel(campaign)}`;
  copy.append(title, meta);
  button.append(dot, copy);
  button.setAttribute("aria-label", `${campaign.title}, ${meta.textContent}`);
  if (!campaign.archived) return button;
  const row = document.createElement("div");
  row.className = "campaign-item-row";
  const deleteButton = document.createElement("button");
  deleteButton.type = "button";
  deleteButton.className = "delete-campaign-button";
  deleteButton.dataset.deleteCampaignId = campaign.campaignId;
  deleteButton.disabled = campaignBusy(campaign);
  const deleteLabel = formatTemplate("deleteCampaignLabel", { title: campaign.title });
  deleteButton.setAttribute("aria-label", deleteLabel);
  deleteButton.title = deleteLabel;
  deleteButton.innerHTML = '<svg aria-hidden="true" focusable="false" viewBox="0 0 24 24"><path d="M4 7h16"></path><path d="M9 3h6l1 4H8l1-4Z"></path><path d="m7 7 1 14h8l1-14"></path><path d="M10 11v6M14 11v6"></path></svg>';
  row.append(button, deleteButton);
  return row;
}

function renderSidebar() {
  const focusedCampaignId = document.activeElement?.closest?.("[data-campaign-id]")?.dataset.campaignId;
  const active = campaigns.filter((campaign) => !campaign.archived);
  const archived = campaigns.filter((campaign) => campaign.archived);
  const activeList = $("#campaign-list");
  if (active.length) activeList.replaceChildren(...active.map(renderCampaignItem));
  else {
    const empty = document.createElement("p");
    empty.className = "campaign-list-empty";
    empty.textContent = t("noCampaigns");
    activeList.replaceChildren(empty);
  }
  $("#archived-campaign-list").replaceChildren(...archived.map(renderCampaignItem));
  $("#archived-count").textContent = String(archived.length);
  $("#archived-campaigns").hidden = archived.length === 0;
  if (focusedCampaignId) {
    [...document.querySelectorAll("[data-campaign-id]")]
      .find((button) => button.dataset.campaignId === focusedCampaignId)
      ?.focus({ preventScroll: true });
  }
}

function syncCampaignModel(campaign) {
  const select = $("#campaign-model");
  const config = campaign?.config ?? status.llm?.defaultModel ?? status.config;
  if (!campaign || !config) {
    select.replaceChildren();
    select.disabled = true;
    return;
  }
  const currentValue = modelValue(config.provider, config.model);
  const allEntries = llmModelEntries(status.llm, { includeHidden: true });
  const options = llmModelEntries(status.llm, { availableOnly: true, requireKey: true, language: campaign.language });
  if (!options.some((option) => modelValue(option.provider, option.model) === currentValue)) {
    const known = allEntries.find((option) => modelValue(option.provider, option.model) === currentValue);
    options.unshift(known ?? {
      provider: config.provider,
      providerLabel: config.provider,
      model: config.model,
      label: config.model,
      available: false,
      enabled: false,
      keyPresent: false,
      hidden: true,
    });
  }
  const signature = options.map((option) => [modelValue(option.provider, option.model), option.providerLabel, option.label, option.available, option.enabled, option.keyPresent].join(":")).join("|");
  if (select.dataset.options !== signature) {
    const groups = new Map();
    for (const option of options) {
      if (!groups.has(option.provider)) {
        const group = document.createElement("optgroup");
        group.label = option.providerLabel;
        groups.set(option.provider, group);
      }
      const element = document.createElement("option");
      element.value = modelValue(option.provider, option.model);
      const isCurrentUnavailable = element.value === currentValue && !(option.available && option.enabled && option.keyPresent);
      const unavailableLabel = option.hidden ? t("legacyModel") : t("needsTest");
      element.textContent = `${option.label}${option.recommended ? ` · ${t("recommended")}` : ""}${isCurrentUnavailable ? ` · ${unavailableLabel}` : ""}`;
      groups.get(option.provider).append(element);
    }
    select.replaceChildren(...groups.values());
    select.dataset.options = signature;
  }
  select.value = currentValue;
  select.disabled = campaign.archived || campaign.status !== "active" || campaignBusy(campaign) || Boolean(campaign.pending) || savingCampaignConfigs.has(campaign.campaignId);
}

function renderCampaignChrome() {
  const campaign = selectedCampaign();
  if ($("#campaign-title-form").hidden) $("#campaign-title").textContent = campaign?.title ?? "llm-dungeon";
  $("#campaign-meta").textContent = campaign
    ? [`${t("turn")} ${campaign.turn}`, campaign.timeLabel, statusLabel(campaign), campaignCostText(campaign.campaignCost, t("campaignCost"))].filter(Boolean).join(" · ")
    : "";
  syncCampaignModel(campaign);
  const unavailable = !campaign || campaignBusy(campaign);
  $("#open-campaign-setup").disabled = unavailable;
  $("#open-inspection").disabled = unavailable;
  $("#export-campaign").disabled = unavailable;
  $("#archive-campaign").disabled = unavailable || campaign.archived;
  $("#edit-campaign-title").disabled = unavailable || campaign.archived;
  if (campaign) updateComposer(campaign);
}

function beginCampaignTitleEdit() {
  const campaign = selectedCampaign();
  if (!campaign || campaign.archived || campaignBusy(campaign)) return;
  $("#campaign-title-input").value = campaign.title;
  $("#campaign-title").hidden = true;
  $("#edit-campaign-title").hidden = true;
  $("#campaign-title-form").hidden = false;
  $("#campaign-title-input").focus();
  $("#campaign-title-input").select();
}

function cancelCampaignTitleEdit() {
  $("#campaign-title-form").hidden = true;
  $("#campaign-title").hidden = false;
  $("#edit-campaign-title").hidden = false;
  renderCampaignChrome();
  $("#edit-campaign-title").focus();
}

async function saveCampaignTitle() {
  const campaign = selectedCampaign();
  const title = $("#campaign-title-input").value.trim();
  if (!campaign || campaign.archived || campaignBusy(campaign) || !title) return;
  try {
    const body = await api(campaignApiPath(campaign.campaignId, "title"), {
      method: "PUT",
      body: JSON.stringify({ title }),
    });
    updateCampaignFromState(body.campaign);
    cancelCampaignTitleEdit();
    showToast(t("campaignRenamed"), "success");
  } catch (error) {
    showToast(error.message, "error");
    $("#campaign-title-input").focus();
  }
}

function closeSidebar({ restoreFocus = false } = {}) {
  document.body.classList.remove("sidebar-open");
  $("#sidebar-backdrop").hidden = true;
  syncSidebarAccessibility();
  if (restoreFocus && window.matchMedia("(max-width: 760px)").matches) {
    const target = sidebarReturnFocus?.isConnected ? sidebarReturnFocus : $("#open-sidebar");
    target.focus({ preventScroll: true });
  }
  sidebarReturnFocus = null;
}

function setDesktopSidebarCollapsed(collapsed) {
  document.body.classList.toggle("sidebar-collapsed", collapsed);
  try { localStorage.setItem(SIDEBAR_COLLAPSED_KEY, String(collapsed)); } catch { /* Storage can be disabled. */ }
  syncSidebarAccessibility();
}

function collapseSidebar({ restoreFocus = false } = {}) {
  if (window.matchMedia("(max-width: 760px)").matches) {
    closeSidebar({ restoreFocus });
    return;
  }
  setDesktopSidebarCollapsed(true);
  if (restoreFocus) $("#open-sidebar").focus({ preventScroll: true });
}

function openSidebar(opener) {
  sidebarReturnFocus = opener instanceof HTMLElement ? opener : document.activeElement;
  if (!window.matchMedia("(max-width: 760px)").matches) {
    setDesktopSidebarCollapsed(false);
    $("#close-sidebar").focus({ preventScroll: true });
    return;
  }
  document.body.classList.add("sidebar-open");
  $("#sidebar-backdrop").hidden = false;
  syncSidebarAccessibility();
  $("#close-sidebar").focus();
}

function syncSidebarAccessibility() {
  const mobile = window.matchMedia("(max-width: 760px)").matches;
  const open = document.body.classList.contains("sidebar-open");
  const inspectionOpen = document.body.classList.contains("inspection-open");
  const collapsed = !mobile && document.body.classList.contains("sidebar-collapsed");
  const sidebarHidden = mobile ? !open || inspectionOpen : collapsed;
  $("#campaign-sidebar").inert = sidebarHidden;
  $("#campaign-sidebar").setAttribute("aria-hidden", String(sidebarHidden));
  $$(".sidebar-opener").forEach((button) => button.setAttribute("aria-expanded", String(mobile ? open : !collapsed)));
  $("#close-sidebar").setAttribute("aria-expanded", String(mobile ? open : !collapsed));
  $("#sidebar-resizer").tabIndex = collapsed ? -1 : 0;
  $(".main-pane").inert = mobile && (open || inspectionOpen);
  if (!mobile) {
    $("#sidebar-backdrop").hidden = true;
    $(".main-pane").inert = false;
  }
}

function initializeSidebarState() {
  try {
    document.body.classList.toggle("sidebar-collapsed", localStorage.getItem(SIDEBAR_COLLAPSED_KEY) === "true");
  } catch { /* Storage can be disabled. */ }
}

function clampPanelWidth(value, minimum, maximum) {
  return Math.round(Math.min(Math.max(Number(value) || minimum, minimum), maximum));
}

function panelWidth(variable, fallback) {
  return Number.parseFloat(getComputedStyle(document.documentElement).getPropertyValue(variable)) || fallback;
}

function setPanelWidth(variable, handle, value, minimum, maximum) {
  const width = clampPanelWidth(value, minimum, maximum);
  document.documentElement.style.setProperty(variable, `${width}px`);
  handle.setAttribute("aria-valuemin", String(minimum));
  handle.setAttribute("aria-valuemax", String(maximum));
  handle.setAttribute("aria-valuenow", String(width));
  return width;
}

function bindPanelResizer({ selector, variable, storageKey, fallback, minimum, maximum, direction }) {
  const handle = $(selector);
  const maximumWidth = () => Math.max(minimum, Math.min(maximum, window.innerWidth * .55));
  let initial = fallback;
  try { initial = Number(localStorage.getItem(storageKey)) || fallback; } catch { /* Storage can be disabled. */ }
  setPanelWidth(variable, handle, initial, minimum, maximumWidth());
  let startX = null;
  let startWidth = 0;

  const persist = () => {
    try { localStorage.setItem(storageKey, String(Math.round(panelWidth(variable, fallback)))); } catch { /* Storage can be disabled. */ }
  };
  const finish = (event) => {
    if (startX === null) return;
    startX = null;
    document.body.classList.remove("resizing-panels");
    if (handle.hasPointerCapture?.(event.pointerId)) handle.releasePointerCapture(event.pointerId);
    persist();
  };
  handle.addEventListener("pointerdown", (event) => {
    if (window.matchMedia("(max-width: 760px)").matches) return;
    startX = event.clientX;
    startWidth = panelWidth(variable, fallback);
    handle.setPointerCapture(event.pointerId);
    document.body.classList.add("resizing-panels");
    event.preventDefault();
  });
  handle.addEventListener("pointermove", (event) => {
    if (startX === null) return;
    setPanelWidth(variable, handle, startWidth + ((event.clientX - startX) * direction), minimum, maximumWidth());
  });
  handle.addEventListener("pointerup", finish);
  handle.addEventListener("pointercancel", finish);
  handle.addEventListener("keydown", (event) => {
    if (!['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    const screenDirection = event.key === "ArrowRight" ? 1 : -1;
    setPanelWidth(variable, handle, panelWidth(variable, fallback) + (screenDirection * direction * 16), minimum, maximumWidth());
    persist();
    event.preventDefault();
  });
  return () => setPanelWidth(variable, handle, panelWidth(variable, fallback), minimum, maximumWidth());
}

function initializePanelResizing() {
  const clampSidebar = bindPanelResizer({
    selector: "#sidebar-resizer", variable: "--sidebar-width", storageKey: SIDEBAR_WIDTH_KEY,
    fallback: 272, minimum: 220, maximum: 480, direction: 1,
  });
  const clampInspection = bindPanelResizer({
    selector: "#inspection-resizer", variable: "--inspection-width", storageKey: INSPECTION_WIDTH_KEY,
    fallback: 420, minimum: 320, maximum: 640, direction: -1,
  });
  window.addEventListener("resize", () => { clampSidebar(); clampInspection(); });
}

function showView(name, { focus = true } = {}) {
  if (name !== "chat") closeInspection();
  currentView = name;
  for (const view of $$(".app-view")) view.hidden = view.id !== `${name}-view`;
  closeSidebar();
  if (name === "chat") {
    const campaign = selectedCampaign();
    applyLocale(campaign?.language ?? status.language ?? "en");
    renderCampaignChrome();
    renderChat({ scroll: true });
    if (focus) $("#campaign-title").focus({ preventScroll: true });
  } else if (name === "setup") {
    if (focus) $("#setup-title").focus({ preventScroll: true });
  } else if (name === "settings") {
    setupSettings.loadSettings().catch((error) => showToast(error.message, "error"));
    if (focus) $("#settings-title").focus({ preventScroll: true });
  }
}

async function selectCampaign(campaignId) {
  if (!campaignById(campaignId)) return;
  if (selectedCampaignId !== campaignId) saveActionDraft(selectedCampaignId);
  selectedCampaignId = campaignId;
  restoreActionDraft(campaignId);
  try { localStorage.setItem(SELECTED_CAMPAIGN_KEY, campaignId); } catch { /* Storage can be disabled. */ }
  closeInspection();
  showView("chat");
  await reconcileTranscript(campaignId);
}

function beginNewCampaign() {
  setupSettings.begin();
  showView("setup");
}

function openProviderSettings() {
  showView("settings", { focus: false });
  setupSettings.selectSettingsSection("providers");
  const recommendedProvider = status.llm?.providers?.find((provider) => provider.recommended);
  const recommendedCard = [...document.querySelectorAll("[data-provider-details]")]
    .find((card) => card.dataset.providerDetails === recommendedProvider?.id);
  if (recommendedCard) recommendedCard.open = true;
  $("#llm-settings-title").focus({ preventScroll: true });
}

function handleCampaignCta() {
  if (!hasConfiguredProviderKey(status.llm, status.keyStatus)) {
    openProviderSettings();
    return;
  }
  beginNewCampaign();
}

async function reconcileTranscript(campaignId) {
  const campaign = campaignById(campaignId);
  if (!campaign) return;
  const campaignT = campaignTranslator(campaignId, campaign.language);
  if (selectedCampaignId === campaignId) $("#chat-log").setAttribute("aria-busy", "true");
  try {
    const body = await api(campaignApiPath(campaignId, "transcript"));
    if (typeof body.playerName === "string" && body.playerName.trim()) characterNames.set(campaignId, body.playerName.trim());
    const turns = Array.isArray(body.turns) ? body.turns : [];
    const entries = chatHistory.entries(campaignId);
    const authoritative = [];
    for (const turn of turns) {
      if (!Number.isSafeInteger(turn.turn)) continue;
      if (turn.turn === 0 || turn.kind === "opening") {
        authoritative.push(normalizeTerminalEntry({ title: `${campaignT("openingHeading")} · ${campaign.title}`, text: turn.narration, mode: "success", channel: "game", kind: "opening", turn: 0, generation: turn.generation }));
      } else {
        if (turn.action) authoritative.push(normalizeTerminalEntry({ title: campaignT("you"), text: turn.action, mode: "normal", channel: "game" }));
        if (turn.checkText) authoritative.push(normalizeTerminalEntry({ title: campaignT("check"), text: turn.checkText, mode: "normal", channel: "game" }));
        if (turn.kind === "appeal") {
          const target = Number.isSafeInteger(turn.appealTargetTurn) ? ` · ${campaignT("turn")} ${turn.appealTargetTurn}` : "";
          authoritative.push(normalizeTerminalEntry({ title: `${campaignT("appealHeading")}${target}`, text: turn.narration, mode: "success", channel: "game", kind: "appeal", turn: turn.turn, appealTargetTurn: turn.appealTargetTurn, generation: turn.generation }));
        } else {
          authoritative.push(normalizeTerminalEntry({ title: `${campaignT("dm")} · ${campaignT("turn")} ${turn.turn}`, text: turn.narration, mode: "success", channel: "game", kind: "gameplay", turn: turn.turn, generation: turn.generation }));
        }
      }
    }
    const merged = mergeAuthoritativeTerminalEntries(authoritative.filter(Boolean), entries);
    if (JSON.stringify(merged) !== JSON.stringify(entries)) chatHistory.replace(campaignId, merged);
    reconciledCampaignStates.set(campaignId, `${campaign.turn}:${campaign.updatedAt ?? ""}`);
    if (selectedCampaignId === campaignId && currentView === "chat") renderChat({ scroll: true });
  } catch (error) {
    if (selectedCampaignId === campaignId) showToast(error.message, "error");
  } finally {
    if (selectedCampaignId === campaignId) $("#chat-log").setAttribute("aria-busy", "false");
  }
}

async function performStatusRefresh() {
  const previousCampaigns = JSON.stringify(campaigns);
  const next = await api("/api/status");
  status = { ...status, ...next };
  syncProviderOnboarding();
  const nextCampaigns = sortCampaigns(next.campaigns);
  const campaignsChanged = previousCampaigns !== JSON.stringify(nextCampaigns);
  setupSettings.syncLanguages();
  setupSettings.syncLlm();
  let preferred = selectedCampaignId;
  if (!preferred) {
    try { preferred = localStorage.getItem(SELECTED_CAMPAIGN_KEY); } catch { /* Storage can be disabled. */ }
  }
  const nextSelected = chooseCampaignId(nextCampaigns, preferred);
  const selectionChanged = selectedCampaignId !== nextSelected;
  if (selectionChanged) saveActionDraft(selectedCampaignId);
  campaigns = nextCampaigns;
  selectedCampaignId = nextSelected;
  if (selectionChanged) restoreActionDraft(nextSelected);
  const localeChanged = currentView === "chat"
    ? applyLocale(selectedCampaign()?.language ?? next.language ?? "en")
    : false;
  if (campaignsChanged || selectionChanged || localeChanged) {
    renderSidebar();
    renderCampaignChrome();
    if (currentView === "chat") renderChat({ scroll: selectionChanged });
  }
  if (currentView === "chat") {
    const campaign = selectedCampaign();
    if (campaign) {
      const key = `${campaign.turn}:${campaign.updatedAt ?? ""}`;
      if (selectionChanged || reconciledCampaignStates.get(campaign.campaignId) !== key) {
        await reconcileTranscript(campaign.campaignId);
      }
    }
  }
}

function refreshStatus({ ensureFresh = false } = {}) {
  if (statusPollPromise) {
    if (ensureFresh) statusRefreshQueued = true;
    return statusPollPromise;
  }
  statusPollPromise = (async () => {
    do {
      statusRefreshQueued = false;
      await performStatusRefresh();
    } while (statusRefreshQueued);
  })().finally(() => { statusPollPromise = null; });
  return statusPollPromise;
}

function setActionPrefill(kind) {
  const input = $("#action");
  input.value = actionPrefillValue(input.value, kind);
  saveActionDraft();
  input.focus();
  input.setSelectionRange(input.value.length, input.value.length);
  resizeComposer();
}

function prefillAsk() {
  setActionPrefill("ask");
}

function prefillAppeal() {
  setActionPrefill("appeal");
}

function resizeComposer() {
  const action = $("#action");
  action.style.height = "auto";
  action.style.height = `${Math.min(action.scrollHeight, 210)}px`;
}

async function submitAction() {
  const campaign = selectedCampaign();
  const campaignId = campaign?.campaignId;
  const campaignT = campaignTranslator(campaignId, campaign?.language);
  const action = $("#action").value.trim();
  if (!campaignId || !action) return;
  if (campaign.pending && ![":retry", ":discard"].includes(action)) {
    showToast(campaignT("pendingRequired"), "error");
    return;
  }
  if (campaignBusy(campaign)) return;
  $("#action").value = "";
  actionDrafts.delete(campaignId);
  resizeComposer();
  inFlightCampaigns.add(campaignId);
  renderSidebar();
  renderCampaignChrome();
  if (action !== ":retry" && action !== ":discard") {
    appendHistory(campaignId, { title: campaignT("you"), text: action, mode: "normal" });
  }
  try {
    if (action === ":discard") {
      await api(campaignApiPath(campaignId, "discard"), { method: "POST", body: "{}" });
      if (selectedCampaignId === campaignId) showToast(campaignT("discarded"), "success");
    } else {
      const endpoint = action === ":retry" ? "retry" : "play";
      const result = await api(campaignApiPath(campaignId, endpoint), {
        method: "POST",
        body: action === ":retry" ? "{}" : JSON.stringify({ action }),
      });
      if (result.kind === "question") {
        appendHistory(campaignId, { title: campaignT("answerNoTurn"), text: result.answer, mode: "success", ...(result.generation ? { generation: result.generation } : {}) });
      } else {
        appendCommittedResponse(campaignId, result);
      }
    }
  } catch (error) {
    appendHistory(campaignId, { title: campaignT("error"), text: error.message, mode: "error" });
  } finally {
    inFlightCampaigns.delete(campaignId);
    await refreshStatus({ ensureFresh: true }).catch(() => {});
    if (selectedCampaignId === campaignId) renderChat({ scroll: true });
    renderSidebar();
    renderCampaignChrome();
  }
}

async function changeCampaignModel() {
  const campaignId = selectedCampaignId;
  const campaign = campaignById(campaignId);
  const choice = modelChoice($("#campaign-model").value);
  const currentConfig = campaign?.config ?? status.llm?.defaultModel ?? status.config;
  if (!campaign || !choice || !currentConfig) return;
  const selectable = llmModelEntries(status.llm, { availableOnly: true, requireKey: true, language: campaign.language })
    .some((entry) => entry.provider === choice.provider && entry.model === choice.model);
  if (!selectable) {
    syncCampaignModel(campaign);
    showToast(t("modelUnavailable"), "error");
    return;
  }
  const previous = { ...currentConfig };
  savingCampaignConfigs.add(campaignId);
  renderCampaignChrome();
  try {
    const body = await api(campaignApiPath(campaignId, "config"), { method: "PUT", body: JSON.stringify(choice) });
    const saved = body.config ?? body;
    const target = campaignById(campaignId);
    if (target) target.config = saved;
    if (selectedCampaignId === campaignId) showToast(t("modelSaved"), "success");
  } catch (error) {
    const target = campaignById(campaignId);
    if (target) target.config = previous;
    if (selectedCampaignId === campaignId) showToast(error.message, "error");
  } finally {
    savingCampaignConfigs.delete(campaignId);
    await refreshStatus({ ensureFresh: true }).catch(() => {});
    renderCampaignChrome();
  }
}

async function loadInspection(view) {
  const campaignId = selectedCampaignId;
  if (!campaignId) return;
  currentInspectionView = view;
  const requestId = ++inspectionSequence;
  $$("#inspection-tabs [role=tab]").forEach((button) => button.setAttribute("aria-selected", String(button.dataset.view === view)));
  $("#inspection-title").textContent = t(view === "threads" ? "storyThreads" : view);
  $("#inspection-output").replaceChildren(inspectionMessage(t("loadingState")));
  try {
    const body = await api(`${campaignApiPath(campaignId, "inspect")}?view=${encodeURIComponent(view)}`);
    if (requestId !== inspectionSequence || selectedCampaignId !== campaignId || currentInspectionView !== view) return;
    if (!body.inspection || body.inspection.view !== view) throw new Error(t("stateError"));
    $("#inspection-output").replaceChildren(renderInspectionView(body.inspection, t));
  } catch (error) {
    if (requestId !== inspectionSequence || selectedCampaignId !== campaignId) return;
    $("#inspection-output").replaceChildren(inspectionMessage(`${t("stateError")} ${error.message}`, "error"));
  }
}

function openInspection() {
  if (!selectedCampaignId) return;
  $("#inspection-panel").hidden = false;
  $("#inspection-resizer").hidden = false;
  document.body.classList.add("inspection-open");
  $("#open-inspection").setAttribute("aria-expanded", "true");
  $("#close-inspection").setAttribute("aria-expanded", "true");
  syncSidebarAccessibility();
  loadInspection(currentInspectionView);
}

function closeInspection({ restoreFocus = false } = {}) {
  if (!document.body.classList.contains("inspection-open")) return;
  document.body.classList.remove("inspection-open");
  $("#open-inspection").setAttribute("aria-expanded", "false");
  $("#close-inspection").setAttribute("aria-expanded", "false");
  $("#inspection-panel").hidden = true;
  $("#inspection-resizer").hidden = true;
  inspectionSequence += 1;
  syncSidebarAccessibility();
  if (restoreFocus) $("#open-inspection").focus({ preventScroll: true });
}

function exportCampaign() {
  const campaignId = selectedCampaignId;
  if (!campaignId) return;
  const link = document.createElement("a");
  link.href = `${campaignApiPath(campaignId, "export")}?format=markdown`;
  link.download = "";
  document.body.append(link);
  link.click();
  link.remove();
  $("#campaign-menu").open = false;
}

async function archiveCampaign() {
  const campaignId = pendingArchiveCampaignId;
  if (!campaignId) return;
  closeArchiveCampaignDialog();
  inFlightCampaigns.add(campaignId);
  renderSidebar();
  renderCampaignChrome();
  try {
    await api(campaignApiPath(campaignId, "archive"), { method: "POST", body: "{}" });
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    inFlightCampaigns.delete(campaignId);
    await refreshStatus({ ensureFresh: true }).catch(() => {});
  }
}

function requestArchiveCampaign() {
  const campaign = selectedCampaign();
  if (!campaign || campaign.archived || campaignBusy(campaign)) return;
  pendingArchiveCampaignId = campaign.campaignId;
  $("#campaign-menu").open = false;
  $("#archive-campaign-dialog").showModal();
  $("#confirm-archive-campaign").focus();
}

function closeArchiveCampaignDialog() {
  if ($("#archive-campaign-dialog").open) $("#archive-campaign-dialog").close();
  pendingArchiveCampaignId = null;
}

function campaignSetupSection(label, value, className = "") {
  const section = document.createElement("section");
  const heading = document.createElement("h3");
  heading.textContent = label;
  const content = document.createElement(className ? "pre" : "p");
  if (className) content.className = className;
  content.textContent = value;
  section.append(heading, content);
  return section;
}

async function openCampaignSetup() {
  const campaign = selectedCampaign();
  if (!campaign || campaignBusy(campaign)) return;
  const campaignId = campaign.campaignId;
  const requestId = ++campaignSetupSequence;
  const dialog = $("#campaign-setup-dialog");
  const content = $("#campaign-setup-content");
  content.replaceChildren(inspectionMessage(t("loadingState")));
  dialog.showModal();
  try {
    const body = await api(campaignApiPath(campaignId, "setup"));
    if (requestId !== campaignSetupSequence || !dialog.open) return;
    if (!body.setup) {
      content.replaceChildren(inspectionMessage(t("setupUnavailable")));
      return;
    }
    const language = status.languages.find((item) => item.code === body.setup.language)?.name ?? body.setup.language;
    content.replaceChildren(
      campaignSetupSection(t("premise"), body.setup.premise),
      campaignSetupSection(t("characterConcept"), body.setup.character),
      campaignSetupSection(t("language"), language),
      campaignSetupSection(t("worldStyle"), body.setup.worldRules, "campaign-setup-markdown"),
    );
  } catch (error) {
    if (requestId === campaignSetupSequence && dialog.open) {
      content.replaceChildren(inspectionMessage(error.message, "error"));
    }
  }
}

function closeCampaignSetup() {
  campaignSetupSequence += 1;
  if ($("#campaign-setup-dialog").open) $("#campaign-setup-dialog").close();
}

function requestDeleteArchivedCampaign(campaignId) {
  const campaign = campaignById(campaignId);
  if (!campaign?.archived) return;
  pendingDeleteCampaignId = campaignId;
  $("#delete-campaign-warning").textContent = formatTemplate("deleteCampaignConfirm", { title: campaign.title });
  $("#delete-campaign-confirmation").value = "";
  $("#confirm-delete-campaign").disabled = true;
  $("#delete-campaign-dialog").showModal();
  $("#delete-campaign-confirmation").focus();
}

function closeDeleteCampaignDialog() {
  $("#delete-campaign-dialog").close();
  pendingDeleteCampaignId = null;
}

async function deleteArchivedCampaign(campaignId) {
  const campaign = campaignById(campaignId);
  if (!campaign?.archived) return;
  inFlightCampaigns.add(campaignId);
  renderSidebar();
  try {
    await api(campaignApiPath(campaignId, "delete"), { method: "DELETE", body: JSON.stringify({ title: campaign.title }) });
    chatHistory.remove(campaignId);
    characterNames.delete(campaignId);
    actionDrafts.delete(campaignId);
    reconciledCampaignStates.delete(campaignId);
    if (selectedCampaignId === campaignId) {
      closeInspection();
      selectedCampaignId = null;
      try { localStorage.removeItem(SELECTED_CAMPAIGN_KEY); } catch { /* Storage can be disabled. */ }
    }
    showToast(t("campaignDeleted"), "success");
  } catch (error) {
    showToast(error.message, "error");
  } finally {
    inFlightCampaigns.delete(campaignId);
    await refreshStatus({ ensureFresh: true }).catch(() => {});
  }
}

function handleCampaignListClick(event) {
  const deleteButton = event.target.closest("[data-delete-campaign-id]");
  if (deleteButton) {
    requestDeleteArchivedCampaign(deleteButton.dataset.deleteCampaignId);
    return;
  }
  const button = event.target.closest("[data-campaign-id]");
  if (button) selectCampaign(button.dataset.campaignId);
}

const setupSettings = createSetupSettingsController({
  api,
  applyLocale,
  getStatus: () => status,
  onCampaignCreated: async (body) => {
    const campaignT = campaignTranslator(body.state.campaignId, body.state.language);
    updateCampaignFromState(body.state, body.config);
    if (typeof body.playerName === "string" && body.playerName.trim()) characterNames.set(body.state.campaignId, body.playerName.trim());
    appendHistory(body.state.campaignId, {
      title: `${campaignT("openingHeading")} · ${body.state.title}`,
      text: body.openingNarration,
      mode: "success",
      kind: "opening",
      turn: 0,
    }, { render: false });
    await refreshStatus({ ensureFresh: true });
    await selectCampaign(body.state.campaignId);
  },
  refreshStatus,
  setDefaults: (values) => { status = { ...status, ...values }; },
  showToast,
  t,
  withButtonBusy,
});

function bindEvents() {
  $("#new-campaign").addEventListener("click", handleCampaignCta);
  $("#empty-new-campaign").addEventListener("click", handleCampaignCta);
  $("#empty-open-settings").addEventListener("click", openProviderSettings);
  $("#open-settings").addEventListener("click", () => showView("settings"));
  $("#campaign-list").addEventListener("click", handleCampaignListClick);
  $("#archived-campaign-list").addEventListener("click", handleCampaignListClick);
  $$(".sidebar-opener").forEach((button) => button.addEventListener("click", (event) => openSidebar(event.currentTarget)));
  $("#close-sidebar").addEventListener("click", () => collapseSidebar({ restoreFocus: true }));
  $("#sidebar-backdrop").addEventListener("click", () => closeSidebar({ restoreFocus: true }));
  window.addEventListener("resize", syncSidebarAccessibility);

  $("#ask-generic").addEventListener("click", () => prefillAsk());
  $("#appeal-generic").addEventListener("click", () => prefillAppeal());
  $("#action").addEventListener("input", () => {
    saveActionDraft();
    resizeComposer();
  });
  $("#action").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      submitAction();
    }
  });
  $("#send-action").addEventListener("click", submitAction);
  $("#campaign-model").addEventListener("change", changeCampaignModel);
  $("#open-inspection").addEventListener("click", openInspection);
  $("#close-inspection").addEventListener("click", () => closeInspection({ restoreFocus: true }));
  $("#inspection-tabs").addEventListener("click", (event) => {
    const button = event.target.closest("[data-view]");
    if (button) loadInspection(button.dataset.view);
  });
  $("#export-campaign").addEventListener("click", exportCampaign);
  $("#open-campaign-setup").addEventListener("click", openCampaignSetup);
  $("#edit-campaign-title").addEventListener("click", beginCampaignTitleEdit);
  $("#campaign-title-form").addEventListener("submit", (event) => {
    event.preventDefault();
    saveCampaignTitle();
  });
  $("#cancel-campaign-title").addEventListener("click", cancelCampaignTitleEdit);
  $("#campaign-title-input").addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      cancelCampaignTitleEdit();
    }
  });
  $("#close-campaign-setup").addEventListener("click", closeCampaignSetup);
  $("#campaign-setup-dialog").addEventListener("close", () => { campaignSetupSequence += 1; });
  $("#archive-campaign").addEventListener("click", requestArchiveCampaign);
  $("#archive-campaign-form").addEventListener("submit", (event) => {
    event.preventDefault();
    archiveCampaign();
  });
  $("#cancel-archive-campaign").addEventListener("click", closeArchiveCampaignDialog);
  $("#cancel-archive-campaign-x").addEventListener("click", closeArchiveCampaignDialog);
  $("#archive-campaign-dialog").addEventListener("close", () => { pendingArchiveCampaignId = null; });
  $("#delete-campaign-confirmation").addEventListener("input", (event) => {
    const campaign = campaignById(pendingDeleteCampaignId);
    $("#confirm-delete-campaign").disabled = !campaign
      || event.target.value !== confirmationTitleValue(campaign.title);
  });
  $("#delete-campaign-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const campaignId = pendingDeleteCampaignId;
    const campaign = campaignById(campaignId);
    if (!campaign || $("#delete-campaign-confirmation").value !== confirmationTitleValue(campaign.title)) return;
    closeDeleteCampaignDialog();
    deleteArchivedCampaign(campaignId);
  });
  $("#cancel-delete-campaign").addEventListener("click", closeDeleteCampaignDialog);
  $("#cancel-delete-campaign-x").addEventListener("click", closeDeleteCampaignDialog);
  $("#delete-campaign-dialog").addEventListener("close", () => { pendingDeleteCampaignId = null; });

  document.addEventListener("click", (event) => {
    const menu = $("#campaign-menu");
    if (menu.open && !menu.contains(event.target)) menu.open = false;
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && document.body.classList.contains("inspection-open")) {
      event.preventDefault();
      closeInspection({ restoreFocus: true });
      return;
    }
    if (event.key === "Escape" && document.body.classList.contains("sidebar-open")) {
      event.preventDefault();
      closeSidebar({ restoreFocus: true });
    }
  });
}

setupSettings.bind();
initializePanelResizing();
initializeSidebarState();
bindEvents();
syncSidebarAccessibility();
applyLocale("en");
refreshStatus().catch((error) => showToast(error.message, "error"));
setInterval(() => refreshStatus().catch(() => {}), 2000);
