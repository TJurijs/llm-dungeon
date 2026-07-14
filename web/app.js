const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const terminal = $("#terminal");
const busy = $("#busy");
const workspace = $(".workspace");
const workspaceResizer = $("#workspace-resizer");
let status = null;
let currentDraft = null;
let evaluationRuns = [];
let polling = false;
let preferredRunId = null;
let locale = "en";
let gameLanguage = "en";
let profileSelectionOrder = [];
let providerCompatibility = null;
const COMMAND_STORAGE_KEY = "llm-dungeon:web-cli-command-log";
const TERMINAL_STORAGE_PREFIX = "llm-dungeon:web-cli-terminal:";
const TERMINAL_MAX_ENTRIES = 300;
const TERMINAL_MAX_TEXT = 50_000;
const TERMINAL_MAX_STORAGE = 750_000;
const TERMINAL_CHANNELS = new Set(["game", "campaign", "provider", "evaluations", "world"]);
const LEGACY_JOURNAL_DUMP_TITLES = new Set([
  "RECENT JOURNAL — RESTORED",
  "НЕДАВНИЙ ЖУРНАЛ — ВОССТАНОВЛЕН",
]);
let commandLog = [];
let terminalCampaignId;
let terminalHistory = [];

const UI_COPY = {
  en: {
    controlRoom: "web-cli", output: "TERMINAL OUTPUT", clear: "clear", language: "Language", commands: "activity log", close: "close",
    commandTitle: "Activity log", commandHint: "A local audit trail of actions performed through this interface. API keys are always redacted.", activityCloseLabel: "Close activity log", copy: "Copy", clearLog: "Clear activity", noCommands: "No activity recorded yet.", copied: "Copied", online: "WEB-CLI ONLINE",
    campaignGroup: "Campaign", configurationGroup: "Configuration", testingGroup: "Testing",
    game: "Play", newCampaign: "New campaign", providerKey: "Provider & key", autoRuns: "Auto-runs", worldRules: "World rules",
    play: "Play", whatDo: "What do you do?", send: "Send action", retry: "Retry pending", discard: "Discard pending",
    sendHint: "Ctrl/⌘ + Enter sends the action. Rolls and modifiers appear in the output.",
    pendingHint: "Pending recovery: Retry resumes the same action and locked roll. Discard removes it with no world-state change.",
    inspect: "Inspect", character: "Character", inventory: "Inventory", location: "Location", threads: "Threads", journal: "Journal", archive: "Archive current campaign",
    premise: "Premise / scenario (optional)", characterConcept: "Character concept (optional)",
    generate: "Generate preview", archiveExisting: "Archive the current campaign if one exists", accept: "Accept & begin", regenerate: "Regenerate",
    provider: "Provider", googleRecommended: "Google — recommended", openrouter: "OpenRouter", model: "Model ID", recommended: "recommended", showModelOptions: "Show model options", noModelMatches: "No preset matches. Your entered model ID will be used.", temperature: "Temperature", maxTokens: "Max output tokens", endpoint: "Endpoint override (optional)", apiKey: "API key (leave blank to keep current key)", saveConfig: "Save config", test: "Test connection",
    recommendedDm: "Recommended DM model.", listedModel: "Listed model. Run Test connection before use with the selected provider.", unverifiedModel: "Manually entered model. It may reject schemas or behave differently; run Test connection before use.",
    keyNotice: "Browser-entered keys stay only in this server process and are never written to files or returned by the API.",
    schemaRequired: "Structured output required", schemaUntested: "The selected model must accept both campaign-setup and Gameplay Contract V1 schemas. Run Test connection after changing provider or model.", schemaRule: "Unsupported models fail closed; the game never falls back to unrestricted JSON.",
    schemaFullTitle: "Compatible · setup and gameplay schemas enforced", schemaFullDetail: "The provider accepted the campaign-setup schema and exact Gameplay Contract V1 wire schema; no degraded fallback is used.", schemaFailedTitle: "Incompatible · required schema rejected", schemaFailedDetail: "This provider/model cannot pass every schema required to create and play a campaign.", openrouterSchemaRequirement: "The selected model route supports strict response_format=json_schema.", geminiSchemaRequirement: "The selected Gemini model accepts both provider-enforced schemas.", playerSchemaHint: "A player-model override must also support schema-constrained JSON output.", connectionSchemaOk: "CONNECTION + REQUIRED SCHEMAS OK",
    selfPlay: "Self-play auto-runs", cost: "Cost ceiling ($)", sessions: "Sessions", turnsSession: "Turns / session", concurrency: "Parallel sessions", playerProfile: "Player profile pool", profileHint: "Select one or more. Sessions rotate through profiles in the order you select them.", playerModel: "Simulated-player model (optional override)", startRun: "Start bounded auto-run", artifacts: "Run artifacts", run: "Run", report: "Show report", resume: "Resume run", regenReport: "Regenerate report", session: "Session", transcript: "Transcript", aiEvaluation: "AI evaluation",
    worldNotice: "These Markdown rules affect future campaigns. Every campaign keeps its own snapshot when created.", saveWorld: "Save world.md", working: "Working…",
    noCampaign: "No current campaign. Create one in the New campaign panel.", pendingAvailable: "pending action available", none: "none",
    providerMissing: "provider: not configured", noKey: "no key", campaignNone: "campaign: none", evaluationIdle: "evaluation: idle",
    autoUses: "Auto-runs use the saved provider; completed sessions are judged by the same DM model", configureAuto: "Configure and save a provider before starting an auto-run.",
    ready: "llm-dungeon web-cli ready.\n\nConfigure a provider, create or resume a campaign, then enter any action.", emptyOutput: "No output for this tab yet.",
    changed: "LANGUAGE CHANGED", changedBody: "The selected language now applies to the interface where translated and to new campaign narration.",
    actionPlaceholder: "I approach the hooded traveler and ask why they have been watching the door.", premisePlaceholder: "Default: A classical opening in a tavern, with immediate but optional possibilities.", characterPlaceholder: "Default: A grounded adventurer with two useful traits and one complicating trait.", playerModelPlaceholder: "google/gemini-3.1-flash-lite — recommended",
    endpointPlaceholder: "Use provider default", keyPlaceholder: "Session-only key", present: "present", missing: "missing", you: "YOU", check: "D100 CHECK", dm: "DUNGEON MASTER", campaignEnded: "CAMPAIGN ENDED",
    splitLabel: "Resize terminal and controls", splitTitle: "Drag to resize · Double-click to reset",
  },
  ru: {
    controlRoom: "web-cli", output: "ВЫВОД ТЕРМИНАЛА", clear: "очистить", language: "Язык", commands: "журнал действий", close: "закрыть",
    commandTitle: "Журнал действий", commandHint: "Локальный журнал действий, выполненных через этот интерфейс. Ключи API всегда скрыты.", activityCloseLabel: "Закрыть журнал действий", copy: "Копировать", clearLog: "Очистить действия", noCommands: "Действий пока нет.", copied: "Скопировано", online: "WEB-CLI ГОТОВ",
    campaignGroup: "Кампания", configurationGroup: "Настройки", testingGroup: "Тестирование",
    game: "Играть", newCampaign: "Новая кампания", providerKey: "Провайдер и ключ", autoRuns: "Автопрогоны", worldRules: "Правила мира",
    play: "Играть", whatDo: "Что вы делаете?", send: "Отправить действие", retry: "Повторить ожидающее", discard: "Отменить ожидающее",
    sendHint: "Ctrl/⌘ + Enter отправляет действие. Броски и модификаторы появятся в выводе.",
    pendingHint: "Восстановление: повтор продолжает то же действие с сохранённым броском. Отмена удаляет его, не меняя мир.",
    inspect: "Просмотр", character: "Персонаж", inventory: "Инвентарь", location: "Локация", threads: "Сюжетные линии", journal: "Журнал", archive: "Архивировать текущую кампанию",
    premise: "Завязка / сценарий (необязательно)", characterConcept: "Концепция персонажа (необязательно)",
    generate: "Создать предпросмотр", archiveExisting: "Архивировать текущую кампанию, если она существует", accept: "Принять и начать", regenerate: "Создать заново",
    provider: "Провайдер", googleRecommended: "Google — рекомендуется", openrouter: "OpenRouter", model: "ID модели", recommended: "рекомендуется", showModelOptions: "Показать варианты моделей", noModelMatches: "Подходящих вариантов нет. Будет использован введённый ID модели.", temperature: "Температура", maxTokens: "Макс. токенов ответа", endpoint: "Адрес API (необязательно)", apiKey: "Ключ API (оставьте пустым, чтобы сохранить текущий)", saveConfig: "Сохранить", test: "Проверить соединение",
    recommendedDm: "Рекомендуемая модель мастера.", listedModel: "Модель из списка. Перед использованием с выбранным провайдером запустите проверку соединения.", unverifiedModel: "Модель введена вручную. Она может отклонить схему или вести себя иначе; сначала запустите проверку соединения.",
    keyNotice: "Введённые в браузере ключи хранятся только в процессе сервера, не записываются в файлы и не возвращаются API.",
    schemaRequired: "Требуется структурированный вывод", schemaUntested: "Выбранная модель должна принять схемы создания кампании и Gameplay Contract V1. После смены провайдера или модели запустите проверку.", schemaRule: "Неподдерживаемые модели отклоняются; игра никогда не переходит к JSON без ограничений.",
    schemaFullTitle: "Совместимо · схемы создания и игры применяются", schemaFullDetail: "Провайдер принял схему создания кампании и точную схему Gameplay Contract V1; ослабленный резервный режим не используется.", schemaFailedTitle: "Несовместимо · обязательная схема отклонена", schemaFailedDetail: "Эта комбинация провайдера и модели не прошла все проверки, необходимые для создания и игры кампании.", openrouterSchemaRequirement: "Выбранный маршрут модели поддерживает строгий response_format=json_schema.", geminiSchemaRequirement: "Выбранная модель Gemini принимает обе схемы, заданные провайдеру.", playerSchemaHint: "Переопределённая модель игрока также должна поддерживать JSON с ограничением схемой.", connectionSchemaOk: "СОЕДИНЕНИЕ И ОБЯЗАТЕЛЬНЫЕ СХЕМЫ В ПОРЯДКЕ",
    selfPlay: "Автоматические тестовые игры", cost: "Лимит стоимости ($)", sessions: "Сессии", turnsSession: "Ходов в сессии", concurrency: "Параллельные сессии", playerProfile: "Набор профилей игрока", profileHint: "Выберите один или несколько. Сессии чередуют профили в порядке выбора.", playerModel: "Модель игрока (необязательная замена)", startRun: "Запустить ограниченный автопрогон", artifacts: "Материалы прогонов", run: "Прогон", report: "Показать отчёт", resume: "Продолжить прогон", regenReport: "Обновить отчёт", session: "Сессия", transcript: "Транскрипт", aiEvaluation: "Оценка ИИ",
    worldNotice: "Эти Markdown-правила действуют на будущие кампании. При создании каждая кампания сохраняет свою копию.", saveWorld: "Сохранить world.md", working: "Работаю…",
    noCampaign: "Текущей кампании нет. Создайте её на вкладке «Новая кампания».", pendingAvailable: "есть ожидающее действие", none: "нет",
    providerMissing: "провайдер: не настроен", noKey: "нет ключа", campaignNone: "кампания: нет", evaluationIdle: "автопрогон: не запущен",
    autoUses: "Автопрогоны используют сохранённого провайдера; завершённые сессии оценивает та же модель мастера", configureAuto: "Настройте и сохраните провайдера перед запуском.",
    ready: "llm-dungeon web-cli готов.\n\nНастройте провайдера, создайте или продолжите кампанию, затем введите любое действие.", emptyOutput: "На этой вкладке пока нет вывода.",
    changed: "ЯЗЫК ИЗМЕНЁН", changedBody: "Язык интерфейса и текущей кампании обновлён. Новое повествование будет на русском.",
    actionPlaceholder: "Я подхожу к путнику в капюшоне и спрашиваю, почему он следит за дверью.", premisePlaceholder: "По умолчанию: классическое начало в таверне с немедленными, но необязательными возможностями.", characterPlaceholder: "По умолчанию: приземлённый искатель приключений с двумя полезными и одной осложняющей чертой.", playerModelPlaceholder: "google/gemini-3.1-flash-lite — рекомендуется",
    endpointPlaceholder: "Адрес провайдера по умолчанию", keyPlaceholder: "Ключ только для этой сессии", present: "есть", missing: "нет", you: "ВЫ", check: "ПРОВЕРКА D100", dm: "МАСТЕР ПОДЗЕМЕЛИЙ", campaignEnded: "КАМПАНИЯ ЗАВЕРШЕНА",
    splitLabel: "Изменить размер терминала и панели", splitTitle: "Перетащите для изменения · Двойной щелчок сбрасывает размер",
  },
};

const STATIC_TARGETS = {
  ".subtitle": "controlRoom", ".terminal-title > span": "output", "#clear-terminal": "clear", ".language-picker span": "language",
  "#command-log-label": "commands", "#command-log-close": "close", ".command-dialog h2": "commandTitle", ".command-dialog > .hint": "commandHint", "#copy-command-log": "copy", "#clear-command-log": "clearLog",
  "#tab-group-campaign-label": "campaignGroup", "#tab-group-configuration-label": "configurationGroup", "#tab-group-testing-label": "testingGroup",
  '[data-panel="game"]': "game", '[data-panel="campaign"]': "newCampaign", '[data-panel="provider"]': "providerKey", '[data-panel="evaluations"]': "autoRuns", '[data-panel="world"]': "worldRules",
  "#panel-game h1": "play", 'label[for="action"]': "whatDo", "#play": "send", "#retry": "retry", "#discard": "discard", "#panel-game .hint:not(#pending-help)": "sendHint", "#pending-help": "pendingHint", "#panel-game h2": "inspect",
  '[data-view="character"]': "character", '[data-view="inventory"]': "inventory", '[data-view="location"]': "location", '[data-view="threads"]': "threads", '[data-view="journal"]': "journal", "#archive": "archive",
  "#panel-campaign h1": "newCampaign", 'label[for="premise"]': "premise", 'label[for="character"]': "characterConcept", "#generate-campaign": "generate", ".check span": "archiveExisting", "#confirm-campaign": "accept", "#regenerate-campaign": "regenerate",
  "#panel-provider h1": "providerKey", "#panel-provider .notice": "keyNotice", 'label[for="provider"]': "provider", '#provider option[value="gemini"]': "googleRecommended", '#provider option[value="openrouter"]': "openrouter", 'label[for="model"]': "model", 'label[for="temperature"]': "temperature", 'label[for="max-tokens"]': "maxTokens", 'label[for="endpoint"]': "endpoint", 'label[for="api-key"]': "apiKey", "#save-provider": "saveConfig", "#test-provider": "test", "#player-model-schema-hint": "playerSchemaHint",
  "#panel-evaluations h1": "selfPlay", 'label[for="max-cost"]': "cost", 'label[for="sessions"]': "sessions", 'label[for="turns"]': "turnsSession", 'label[for="concurrency"]': "concurrency", "#profile-control legend": "playerProfile", "#profile-help": "profileHint", 'label[for="player-model"]': "playerModel", "#start-evaluation": "startRun", "#panel-evaluations h2": "artifacts", 'label[for="run-select"]': "run", "#show-report": "report", "#resume-run": "resume", "#regenerate-report": "regenReport", 'label[for="session-select"]': "session", "#show-transcript": "transcript", "#show-evaluation": "aiEvaluation",
  "#panel-world h1": "worldRules", "#panel-world .notice": "worldNotice", "#save-world": "saveWorld", "#busy b": "working",
};

function t(key) { return UI_COPY[locale]?.[key] ?? UI_COPY.en[key] ?? key; }

const MODEL_IDS = [
  "google/gemini-3.5-flash",
  "google/gemini-3.1-flash-lite",
  "google/gemini-3.1-pro-preview",
];
const LISTED_MODEL_IDS = new Set(MODEL_IDS);

function displayModelId(provider, model) {
  const trimmed = model.trim();
  return provider === "gemini" && trimmed.startsWith("gemini-") ? `google/${trimmed}` : trimmed;
}

function requestModelId(provider, model) {
  const trimmed = model.trim();
  return provider === "gemini" && trimmed.startsWith("google/gemini-")
    ? trimmed.slice("google/".length)
    : trimmed;
}

function providerLabel(provider) {
  return provider === "gemini" ? "Google" : provider === "openrouter" ? "OpenRouter" : provider;
}

function renderModelGuidance() {
  const provider = $("#provider").value;
  const model = displayModelId(provider, $("#model").value).toLowerCase();
  const guidance = $("#model-guidance");
  if (model === "google/gemini-3.5-flash") {
    guidance.className = "hint model-guidance recommended";
    guidance.textContent = t("recommendedDm");
  } else if (LISTED_MODEL_IDS.has(model)) {
    guidance.className = "hint model-guidance warn";
    guidance.textContent = t("listedModel");
  } else {
    guidance.className = "hint model-guidance warn";
    guidance.textContent = t("unverifiedModel");
  }
}

function setModelValue(model) {
  const displayed = displayModelId($("#provider").value, model);
  $("#model").value = displayed;
  renderModelGuidance();
}

function closeModelPicker(root) {
  const input = root.querySelector('[role="combobox"]');
  const menu = root.querySelector('[role="listbox"]');
  menu.hidden = true;
  input.setAttribute("aria-expanded", "false");
  input.removeAttribute("aria-activedescendant");
}

function renderModelPickerOptions(root, filter = "") {
  const input = root.querySelector('[role="combobox"]');
  const menu = root.querySelector('[role="listbox"]');
  const query = filter.trim().toLowerCase();
  const models = query ? MODEL_IDS.filter((model) => model.includes(query)) : MODEL_IDS;
  const recommended = root.dataset.recommended;

  menu.replaceChildren(...models.map((model, index) => {
    const option = document.createElement("button");
    option.type = "button";
    option.id = `${menu.id}-option-${index}`;
    option.className = "model-picker-option";
    option.dataset.value = model;
    option.setAttribute("role", "option");
    option.setAttribute("aria-selected", String(input.value.trim().toLowerCase() === model));

    const name = document.createElement("span");
    name.textContent = model;
    option.append(name);
    if (model === recommended) {
      const tag = document.createElement("small");
      tag.textContent = t("recommended");
      option.append(tag);
    }
    return option;
  }));

  if (!models.length) {
    const empty = document.createElement("p");
    empty.className = "model-picker-empty";
    empty.textContent = t("noModelMatches");
    menu.append(empty);
  }
}

function openModelPicker(root, filter = "") {
  const input = root.querySelector('[role="combobox"]');
  const menu = root.querySelector('[role="listbox"]');
  renderModelPickerOptions(root, filter);
  menu.hidden = false;
  input.setAttribute("aria-expanded", "true");
}

function chooseModelOption(root, option) {
  const input = root.querySelector('[role="combobox"]');
  input.value = option.dataset.value;
  input.dispatchEvent(new Event("input", { bubbles: true }));
  closeModelPicker(root);
  input.focus({ preventScroll: true });
}

function moveModelPickerSelection(root, direction) {
  const input = root.querySelector('[role="combobox"]');
  const options = [...root.querySelectorAll(".model-picker-option")];
  if (!options.length) return;
  const current = options.findIndex((option) => option.classList.contains("active"));
  const next = current < 0
    ? (direction > 0 ? 0 : options.length - 1)
    : (current + direction + options.length) % options.length;
  for (const option of options) option.classList.remove("active");
  options[next].classList.add("active");
  input.setAttribute("aria-activedescendant", options[next].id);
  options[next].scrollIntoView({ block: "nearest" });
}

function initializeModelPickers() {
  for (const root of $$('[data-model-picker]')) {
    const input = root.querySelector('[role="combobox"]');
    const menu = root.querySelector('[role="listbox"]');
    const toggle = root.querySelector(".model-picker-toggle");

    input.addEventListener("focus", () => openModelPicker(root));
    input.addEventListener("input", () => openModelPicker(root, input.value));
    input.addEventListener("keydown", (event) => {
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        if (menu.hidden) openModelPicker(root);
        moveModelPickerSelection(root, event.key === "ArrowDown" ? 1 : -1);
      } else if (event.key === "Enter" && !menu.hidden) {
        const active = menu.querySelector(".model-picker-option.active");
        if (active) {
          event.preventDefault();
          chooseModelOption(root, active);
        } else {
          closeModelPicker(root);
        }
      } else if (event.key === "Escape") {
        closeModelPicker(root);
      } else if (event.key === "Tab") {
        closeModelPicker(root);
      }
    });
    menu.addEventListener("pointerdown", (event) => {
      if (event.target.closest(".model-picker-option")) event.preventDefault();
    });
    menu.addEventListener("click", (event) => {
      const option = event.target.closest(".model-picker-option");
      if (option) chooseModelOption(root, option);
    });
    toggle.addEventListener("click", () => {
      if (menu.hidden) {
        openModelPicker(root);
        input.focus({ preventScroll: true });
      } else {
        closeModelPicker(root);
      }
    });
  }
}

function syncLanguageOptions(languages) {
  if (!Array.isArray(languages) || !languages.length) return;
  const select = $("#language-select");
  const current = gameLanguage;
  const expected = languages.map(({ code, name }) => `${code}\u0000${name}`).join("\u0001");
  const actual = [...select.options].map((option) => `${option.value}\u0000${option.textContent}`).join("\u0001");
  if (actual !== expected) {
    select.replaceChildren(...languages.map(({ code, name }) => {
      const option = document.createElement("option");
      option.value = code;
      option.textContent = name;
      return option;
    }));
  }
  select.value = current;
}

function applyUiLanguage(language, { resetTerminal = false } = {}) {
  gameLanguage = language;
  locale = UI_COPY[language] ? language : "en";
  document.documentElement.lang = locale;
  $("#language-select").value = gameLanguage;
  for (const [selector, key] of Object.entries(STATIC_TARGETS)) {
    const element = $(selector);
    if (element) element.textContent = t(key);
  }
  $("#action").placeholder = t("actionPlaceholder");
  $("#premise").placeholder = t("premisePlaceholder");
  $("#character").placeholder = t("characterPlaceholder");
  $("#player-model").placeholder = t("playerModelPlaceholder");
  for (const root of $$('[data-model-picker]')) {
    root.querySelector(".model-picker-toggle").setAttribute("aria-label", t("showModelOptions"));
    if (!root.querySelector('[role="listbox"]').hidden) renderModelPickerOptions(root);
  }
  $("#endpoint").placeholder = t("endpointPlaceholder");
  $("#api-key").placeholder = t("keyPlaceholder");
  renderModelGuidance();
  $(".tabs").setAttribute("aria-label", locale === "ru" ? "Панели управления" : "Control panels");
  $("#command-log-close").setAttribute("aria-label", t("activityCloseLabel"));
  $("#language-select").setAttribute("aria-label", locale === "ru" ? "Язык игры и интерфейса" : "Game and interface language");
  $("#profile-selection-summary").setAttribute("aria-label", locale === "ru" ? "Выбранные профили игрока" : "Selected player profiles");
  workspaceResizer.setAttribute("aria-label", t("splitLabel"));
  workspaceResizer.title = t("splitTitle");
  document.title = "llm-dungeon web-cli";
  syncProfilePool();
  renderCommandLog();
  renderProviderCompatibility();
  if (resetTerminal) setTerminalReady();
}

function setTerminalReady() {
  const welcome = document.createElement("section");
  welcome.className = "terminal-welcome";
  const title = document.createElement("div");
  title.className = "terminal-welcome-title";
  const sigil = document.createElement("span");
  sigil.textContent = "◆";
  const mode = document.createElement("small");
  mode.textContent = t("online");
  title.append(sigil, document.createTextNode(" LLM DUNGEON "), mode);
  const message = document.createElement("p");
  message.textContent = currentTerminalChannel() === "game"
    ? t("ready").split("\n\n").slice(1).join("\n\n")
    : t("emptyOutput");
  welcome.append(title, message);
  terminal.replaceChildren(welcome);
  terminal.dataset.pristine = "true";
}

function terminalStorageKey(campaignId) {
  return `${TERMINAL_STORAGE_PREFIX}${campaignId ?? "no-campaign"}`;
}

function normalizedTerminalEntry(value, fallbackChannel = "game") {
  if (!value || typeof value !== "object") return null;
  const mode = ["normal", "success", "error"].includes(value.mode) ? value.mode : "normal";
  const channel = TERMINAL_CHANNELS.has(value.channel) ? value.channel : fallbackChannel;
  return {
    title: String(value.title ?? "").slice(0, 500),
    text: String(value.text ?? "").slice(0, TERMINAL_MAX_TEXT),
    mode,
    channel,
  };
}

function isLegacyEvaluationTranscriptEntry(entry) {
  return entry.title.startsWith("TRANSCRIPT — ")
    && entry.text.trimStart().startsWith("# Self-Play Transcript:");
}

function migratedTerminalEntries(values) {
  let evaluationOpening = false;
  let evaluationTurn = false;
  return values.map((value) => {
    if (TERMINAL_CHANNELS.has(value?.channel)) return normalizedTerminalEntry(value);
    const entry = normalizedTerminalEntry(value);
    if (!entry) return null;
    const title = entry.title;
    let channel = "game";
    const autoRunHeader = title.startsWith("AUTO-RUN") || title.startsWith("АВТОПРОГОН");
    const evaluationArtifact = title.startsWith("REPORT — ")
      || title.startsWith("EVALUATION — ")
      || title.startsWith("TRANSCRIPT — ")
      || title.startsWith("TURN FAILED ")
      || title.startsWith("СБОЙ ХОДА ");
    const evaluationAction = title.startsWith("YOU — ") || title.startsWith("ВЫ — ");
    if (autoRunHeader || evaluationArtifact) {
      channel = "evaluations";
      evaluationOpening = title.includes(" — session-");
    } else if (evaluationAction) {
      channel = "evaluations";
      evaluationOpening = false;
      evaluationTurn = true;
    } else if (evaluationOpening && (title.endsWith(" — OPENING") || title.endsWith(" — НАЧАЛО"))) {
      channel = "evaluations";
      evaluationOpening = false;
    } else if (evaluationTurn && (title === "D100 CHECK" || title === "ПРОВЕРКА D100")) {
      channel = "evaluations";
    } else if (evaluationTurn && (title.includes(" — TURN ") || title.includes(" — ХОД "))) {
      channel = "evaluations";
      evaluationTurn = false;
    } else if (title.startsWith("CAMPAIGN PREVIEW — ")) {
      channel = "campaign";
    } else if (title === "PROVIDER SAVED"
      || title.includes("CONNECTION + REQUIRED SCHEMAS")
      || title.includes("СОЕДИНЕНИЕ И ОБЯЗАТЕЛЬНЫЕ СХЕМЫ")) {
      channel = "provider";
    } else if (title === "WORLD RULES SAVED") {
      channel = "world";
    }
    return { ...entry, channel };
  }).filter(Boolean);
}

function appendTerminalEntry(entry) {
  if (terminal.dataset.pristine === "true") terminal.replaceChildren();
  const marker = entry.mode === "error" ? "!!" : entry.mode === "success" ? ">>" : "==";
  const section = document.createElement("section");
  section.className = `terminal-entry ${entry.mode}`;
  const heading = document.createElement("div");
  heading.className = "terminal-entry-heading";
  const markerElement = document.createElement("span");
  markerElement.className = "terminal-entry-marker";
  markerElement.textContent = marker;
  const titleElement = document.createElement("strong");
  titleElement.textContent = entry.title;
  heading.append(markerElement, titleElement);
  const body = document.createElement("pre");
  body.textContent = entry.text;
  section.append(heading, body);
  terminal.append(section);
  terminal.dataset.pristine = "false";
}

function currentTerminalChannel() {
  const selected = panelTabs().find((button) => button.getAttribute("aria-selected") === "true");
  return TERMINAL_CHANNELS.has(selected?.dataset.panel) ? selected.dataset.panel : "game";
}

function renderTerminalChannel(channel = currentTerminalChannel()) {
  terminal.replaceChildren();
  terminal.dataset.channel = channel;
  const visible = terminalHistory.filter((entry) => entry.channel === channel);
  if (visible.length) {
    visible.forEach(appendTerminalEntry);
  } else {
    setTerminalReady();
  }
  if (channel === "evaluations" && status?.evaluationTask) renderTask(status.evaluationTask);
  requestAnimationFrame(() => { terminal.scrollTop = terminal.scrollHeight; });
}

function persistTerminalHistory() {
  if (terminalCampaignId === undefined) return;
  let entries = terminalHistory.slice(-TERMINAL_MAX_ENTRIES);
  let serialized = JSON.stringify({ version: 2, entries });
  while (entries.length > 1 && serialized.length > TERMINAL_MAX_STORAGE) {
    entries = entries.slice(1);
    serialized = JSON.stringify({ version: 2, entries });
  }
  terminalHistory = entries;
  try { localStorage.setItem(terminalStorageKey(terminalCampaignId), serialized); } catch { /* Storage can be disabled or full. */ }
}

function readTerminalHistory(campaignId) {
  try {
    const raw = localStorage.getItem(terminalStorageKey(campaignId));
    if (raw === null) return { found: false, entries: [] };
    const parsed = JSON.parse(raw);
    const values = Array.isArray(parsed) ? parsed : [1, 2].includes(parsed?.version) ? parsed.entries : [];
    const entries = Array.isArray(values)
      ? migratedTerminalEntries(values).slice(-TERMINAL_MAX_ENTRIES)
      : [];
    const visibleEntries = entries.filter((entry) => !isLegacyEvaluationTranscriptEntry(entry));
    if (entries.some((entry) => LEGACY_JOURNAL_DUMP_TITLES.has(entry.title))) {
      return { found: false, entries: [] };
    }
    return { found: true, entries: visibleEntries };
  } catch {
    return { found: false, entries: [] };
  }
}

async function switchTerminalCampaign(campaign) {
  const campaignId = campaign?.campaignId ?? null;
  if (terminalCampaignId === campaignId) return;
  const restored = readTerminalHistory(campaignId);
  terminalCampaignId = campaignId;
  terminalHistory = restored.entries;
  renderTerminalChannel();

  // Browser transcripts created before this feature cannot exist in local
  // storage. Reconstruct the authoritative recent player-visible turns once,
  // then persist the same alternating terminal entries used during live play.
  if (campaign && campaign.turn > 0 && !restored.found) {
    try {
      const body = await api("/api/game/transcript");
      for (const turn of body.turns) {
        if (turn.turn === 0) {
          print(`CAMPAIGN BEGINS — ${campaign.title}`, turn.narration, "success", "game");
          continue;
        }
        print(t("you"), turn.action, "normal", "game");
        if (turn.checkText) print(t("check"), turn.checkText, "normal", "game");
        print(`${t("dm")} — ${locale === "ru" ? "ХОД" : "TURN"} ${turn.turn}`, turn.narration, "success", "game");
      }
    } catch { /* Status and normal play remain available if transcript restoration is temporarily busy. */ }
  }
}

function loadCommandLog() {
  try {
    const saved = JSON.parse(localStorage.getItem(COMMAND_STORAGE_KEY) || "[]");
    commandLog = Array.isArray(saved) ? saved.filter((entry) => typeof entry?.command === "string").slice(-250) : [];
  } catch {
    commandLog = [];
  }
}

function renderCommandLog() {
  const output = $("#command-log");
  if (!output) return;
  output.textContent = commandLog.length
    ? commandLog.map((entry) => `[${entry.at}] ${entry.command}`).join("\n")
    : t("noCommands");
  $("#command-count").textContent = String(commandLog.length);
}

function recordCommand(command) {
  commandLog.push({ at: new Date().toLocaleTimeString(), command });
  if (commandLog.length > 250) commandLog = commandLog.slice(-250);
  try { localStorage.setItem(COMMAND_STORAGE_KEY, JSON.stringify(commandLog)); } catch { /* Storage can be disabled. */ }
  renderCommandLog();
}

function quoted(value, maximum = 100) {
  const text = String(value ?? "").replace(/\s+/g, " ").trim();
  const shortened = text.length > maximum ? `${text.slice(0, maximum - 1)}…` : text;
  return JSON.stringify(shortened);
}

const SPLIT_STORAGE = { desktop: "llm-dungeon:terminal-width", mobile: "llm-dungeon:terminal-height" };
const SPLIT_DEFAULT = { desktop: 64, mobile: 46 };
let activeSplitDrag = null;

function splitMode() {
  return window.matchMedia("(max-width: 850px)").matches ? "mobile" : "desktop";
}

function splitLimits(mode) {
  const rect = workspace.getBoundingClientRect();
  const total = mode === "mobile" ? rect.height : rect.width;
  const firstMinimum = mode === "mobile" ? 160 : 280;
  const secondMinimumWithDivider = mode === "mobile" ? 228 : 328;
  return {
    min: total > 0 ? firstMinimum / total * 100 : 25,
    max: total > 0 ? (total - secondMinimumWithDivider) / total * 100 : 75,
  };
}

function storedSplit(mode) {
  try {
    const value = Number(localStorage.getItem(SPLIT_STORAGE[mode]));
    return Number.isFinite(value) && value > 0 ? value : SPLIT_DEFAULT[mode];
  } catch {
    return SPLIT_DEFAULT[mode];
  }
}

function setSplitRatio(rawRatio, persist = true) {
  const mode = splitMode();
  const limits = splitLimits(mode);
  const ratio = Math.min(Math.max(rawRatio, limits.min), Math.max(limits.min, limits.max));
  workspace.style.setProperty(mode === "mobile" ? "--terminal-pane-mobile" : "--terminal-pane", `${ratio}%`);
  workspaceResizer.setAttribute("aria-orientation", mode === "mobile" ? "horizontal" : "vertical");
  workspaceResizer.setAttribute("aria-valuemin", String(Math.round(limits.min)));
  workspaceResizer.setAttribute("aria-valuemax", String(Math.round(Math.max(limits.min, limits.max))));
  workspaceResizer.setAttribute("aria-valuenow", String(Math.round(ratio)));
  if (persist) {
    try { localStorage.setItem(SPLIT_STORAGE[mode], String(ratio)); } catch { /* Storage can be disabled. */ }
  }
  return ratio;
}

function ratioFromPointer(event, mode) {
  const rect = workspace.getBoundingClientRect();
  return mode === "mobile"
    ? (event.clientY - rect.top) / rect.height * 100
    : (event.clientX - rect.left) / rect.width * 100;
}

function initializeSplitPane() {
  setSplitRatio(storedSplit(splitMode()), false);
  workspaceResizer.addEventListener("pointerdown", (event) => {
    if (!event.isPrimary || event.button !== 0) return;
    activeSplitDrag = { pointerId: event.pointerId, mode: splitMode() };
    workspace.classList.add("resizing");
    workspaceResizer.setPointerCapture?.(event.pointerId);
    event.preventDefault();
  });
  window.addEventListener("pointermove", (event) => {
    if (!activeSplitDrag || event.pointerId !== activeSplitDrag.pointerId) return;
    setSplitRatio(ratioFromPointer(event, activeSplitDrag.mode));
    event.preventDefault();
  });
  const finishDrag = (event) => {
    if (!activeSplitDrag || event.pointerId !== activeSplitDrag.pointerId) return;
    activeSplitDrag = null;
    workspace.classList.remove("resizing");
  };
  window.addEventListener("pointerup", finishDrag);
  window.addEventListener("pointercancel", finishDrag);
  workspaceResizer.addEventListener("dblclick", () => setSplitRatio(SPLIT_DEFAULT[splitMode()]));
  workspaceResizer.addEventListener("keydown", (event) => {
    const mode = splitMode();
    const current = Number(workspaceResizer.getAttribute("aria-valuenow")) || SPLIT_DEFAULT[mode];
    const delta = mode === "mobile"
      ? ({ ArrowUp: -2, ArrowDown: 2 }[event.key] ?? 0)
      : ({ ArrowLeft: -2, ArrowRight: 2 }[event.key] ?? 0);
    if (delta) {
      setSplitRatio(current + delta);
      event.preventDefault();
    } else if (event.key === "Home") {
      setSplitRatio(SPLIT_DEFAULT[mode]);
      event.preventDefault();
    }
  });
  window.addEventListener("resize", () => setSplitRatio(storedSplit(splitMode()), false));
}

async function api(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: { "Content-Type": "application/json", ...(options.headers || {}) },
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(body.error || `Request failed (${response.status})`);
  return body;
}

function print(title, text, mode = "normal", channel = currentTerminalChannel()) {
  const entry = normalizedTerminalEntry({ title, text, mode, channel });
  if (!entry) return;
  terminalHistory.push(entry);
  persistTerminalHistory();
  if (entry.channel === currentTerminalChannel()) {
    appendTerminalEntry(entry);
    requestAnimationFrame(() => { terminal.scrollTop = terminal.scrollHeight; });
  }
}

function error(error, channel = currentTerminalChannel()) {
  print("ERROR", error instanceof Error ? error.message : String(error), "error", channel);
}

async function work(label, operation) {
  const channel = currentTerminalChannel();
  busy.querySelector("b").textContent = label;
  busy.classList.remove("hidden");
  try { return await operation(); }
  catch (caught) { error(caught, channel); return undefined; }
  finally { busy.classList.add("hidden"); await refreshStatus().catch(() => {}); }
}

function setStatus(element, text, kind) {
  element.textContent = text;
  element.className = `status ${kind || ""}`;
}

function renderProviderCompatibility() {
  const card = $("#schema-compatibility");
  if (!card) return;
  const title = $("#schema-compatibility-title");
  const detail = $("#schema-compatibility-detail");
  const rule = $("#schema-compatibility-rule");
  rule.textContent = t("schemaRule");
  if (!providerCompatibility) {
    card.className = "capability-card untested";
    title.textContent = t("schemaRequired");
    detail.textContent = t("schemaUntested");
    return;
  }
  if (providerCompatibility.status === "failed") {
    card.className = "capability-card bad";
    title.textContent = t("schemaFailedTitle");
    detail.textContent = `${t("schemaFailedDetail")} ${providerCompatibility.error || ""}`.trim();
    return;
  }
  card.className = "capability-card ok";
  title.textContent = t("schemaFullTitle");
  const requirement = providerCompatibility.provider === "openrouter"
    ? t("openrouterSchemaRequirement")
    : t("geminiSchemaRequirement");
  detail.textContent = `${providerLabel(providerCompatibility.provider)}/${displayModelId(providerCompatibility.provider, providerCompatibility.model)} — ${t("schemaFullDetail")} ${requirement}`;
}

function invalidateProviderCompatibility() {
  providerCompatibility = null;
  renderProviderCompatibility();
}

async function refreshStatus() {
  if (polling) return;
  polling = true;
  try {
    status = await api("/api/status");
    syncLanguageOptions(status.languages);
    if (status.language !== gameLanguage) {
      const untouched = terminal.dataset.pristine === "true";
      applyUiLanguage(status.language, { resetTerminal: untouched });
    }
    const provider = status.config;
    if (!provider) setStatus($("#provider-status"), t("providerMissing"), "bad");
    else {
      const hasKey = status.keyStatus[provider.provider];
      setStatus($("#provider-status"), `${providerLabel(provider.provider)}: ${displayModelId(provider.provider, provider.model)}${hasKey ? "" : ` · ${t("noKey")}`}`, hasKey ? "ok" : "bad");
    }
    $("#evaluation-provider").textContent = provider
      ? `${t("autoUses")}: ${providerLabel(provider.provider)}/${displayModelId(provider.provider, provider.model)}. ${locale === "ru" ? "Игрок по умолчанию" : "Default player"}: google/gemini-3.1-flash-lite.`
      : t("configureAuto");
    const campaign = status.game.campaign;
    await switchTerminalCampaign(campaign);
    setStatus(
      $("#campaign-status"),
      campaign ? `${locale === "ru" ? "кампания" : "campaign"}: ${campaign.title} · ${locale === "ru" ? "ход" : "turn"} ${campaign.turn} · ${campaign.status}` : t("campaignNone"),
      campaign?.status === "active" ? "ok" : campaign ? "warn" : "",
    );
    $("#game-summary").textContent = campaign
      ? `${campaign.title} — ${locale === "ru" ? "ход" : "turn"} ${campaign.turn}, ${campaign.timeLabel}, ${locale === "ru" ? "статус" : "status"}: ${campaign.status}${status.game.pending ? ` · ${t("pendingAvailable")}` : ""}`
      : t("noCampaign");
    const gameBusy = Boolean(status.game.busy);
    const hasGame = Boolean(status.game.exists);
    const canPlay = hasGame && campaign?.status === "active" && !status.game.pending && !gameBusy;
    const hasPendingAction = status.game.pending?.kind === "action";
    $("#action").disabled = !canPlay;
    $("#play").disabled = !canPlay;
    $("#retry").disabled = !hasPendingAction || gameBusy;
    $("#discard").disabled = !hasPendingAction || gameBusy;
    $("#pending-help").classList.toggle("hidden", !hasPendingAction);
    $("#archive").disabled = !hasGame || gameBusy;
    $$("#inspect-buttons button").forEach((button) => { button.disabled = !hasGame || gameBusy; });
    $("#archive-on-confirm").disabled = !hasGame;
    if (!hasGame) $("#archive-on-confirm").checked = false;
    const task = status.evaluationTask;
    const taskFailed = task && (task.status === "failed" || task.status === "completed_with_failures");
    setStatus($("#task-status"), task ? `${locale === "ru" ? "автопрогон" : "evaluation"}: ${task.status} · ${task.runId}` : t("evaluationIdle"), task?.status === "running" ? "warn" : taskFailed ? "bad" : task ? "ok" : "");
    if (task?.status === "running") {
      $("#start-evaluation").disabled = true;
      renderTask(task);
    } else {
      $("#start-evaluation").disabled = selectedProfileIds().length === 0;
      if (task && $("#task-status").dataset.lastTask !== task.id) {
        $("#task-status").dataset.lastTask = task.id;
        renderTask(task);
        await loadRuns();
      }
    }
  } finally { polling = false; }
}

function renderTask(task) {
  if (currentTerminalChannel() !== "evaluations") return;
  let entry = $$(".evaluation-progress").find((candidate) => candidate.dataset.taskId === task.id);
  const isNew = !entry;
  if (!entry) {
    if (terminal.dataset.pristine === "true") terminal.replaceChildren();
    entry = document.createElement("section");
    entry.className = "terminal-entry evaluation-progress";
    entry.dataset.taskId = task.id;
    const heading = document.createElement("div");
    heading.className = "terminal-entry-heading";
    const marker = document.createElement("span");
    marker.className = "terminal-entry-marker";
    marker.textContent = "↻";
    const title = document.createElement("strong");
    title.textContent = `AUTO-RUN ${task.runId}`;
    heading.append(marker, title);
    const body = document.createElement("pre");
    entry.append(heading, body);
    terminal.append(entry);
    terminal.dataset.pristine = "false";
  }
  entry.classList.toggle("success", task.status === "completed");
  entry.classList.toggle("error", task.status === "failed" || task.status === "completed_with_failures");
  const events = Object.values(task.sessionProgress || {}).sort((a, b) => a.sessionId.localeCompare(b.sessionId));
  const rows = events.map((event) => {
    const filled = Math.round(event.completedTurns / Math.max(event.totalTurns, 1) * 12);
    const bar = `${"█".repeat(filled)}${"░".repeat(12 - filled)}`;
    return `${event.sessionId} [${bar}] ${String(event.completedTurns).padStart(3)}/${event.totalTurns}  ${event.phase.replace("_", " ").padEnd(10)}  $${event.estimatedCostUsd.toFixed(4)}  retries ${event.retries}`;
  });
  const totalCost = events.reduce((sum, event) => sum + event.estimatedCostUsd, 0);
  const finished = events.filter((event) => ["completed", "failed", "cost_limit"].includes(event.phase)).length;
  const lastLog = task.logs.at(-1) || "Waiting for first progress event…";
  entry.querySelector("pre").textContent = [
    `${task.status.toUpperCase()} · ${finished}/${events.length || "?"} sessions · $${totalCost.toFixed(4)}`,
    ...rows,
    `\n${lastLog}`,
    ...(task.error ? [task.error] : []),
  ].join("\n");
  if (isNew) requestAnimationFrame(() => { terminal.scrollTop = terminal.scrollHeight; });
}

function panelTabs() {
  return $$('.tabs [role="tab"]');
}

function showPanel(name, { focus = false } = {}) {
  const selectedTab = panelTabs().find((button) => button.dataset.panel === name);
  if (!selectedTab) return;
  panelTabs().forEach((button) => {
    const selected = button === selectedTab;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-selected", String(selected));
    button.tabIndex = selected ? 0 : -1;
  });
  $$(".panel").forEach((panel) => {
    const selected = panel.id === `panel-${name}`;
    panel.classList.toggle("active", selected);
    panel.hidden = !selected;
  });
  // The play transcript is part of the campaign experience and should not be
  // accidentally erased. Other channel-local output remains disposable.
  $("#clear-terminal").hidden = name === "game";
  renderTerminalChannel(name);
  if (focus) selectedTab.focus();
  if (name === "provider") loadProvider().catch((caught) => error(caught, "provider"));
  if (name === "world") loadWorld().catch((caught) => error(caught, "world"));
  if (name === "evaluations") loadRuns().catch((caught) => error(caught, "evaluations"));
}

function handleTabKeydown(event) {
  const tabs = panelTabs();
  const current = tabs.indexOf(event.currentTarget);
  if (current < 0) return;
  let next = current;
  if (event.key === "ArrowRight" || event.key === "ArrowDown") next = (current + 1) % tabs.length;
  else if (event.key === "ArrowLeft" || event.key === "ArrowUp") next = (current - 1 + tabs.length) % tabs.length;
  else if (event.key === "Home") next = 0;
  else if (event.key === "End") next = tabs.length - 1;
  else return;
  event.preventDefault();
  showPanel(tabs[next].dataset.panel, { focus: true });
}

async function loadProvider() {
  const body = await api("/api/config/provider");
  if (body.config) {
    $("#provider").value = body.config.provider;
    setModelValue(body.config.model);
    $("#temperature").value = body.config.temperature;
    $("#max-tokens").value = body.config.maxOutputTokens;
    $("#endpoint").value = body.config.endpoint || "";
  } else {
    setModelValue("google/gemini-3.5-flash");
  }
  $("#key-status").textContent = `Gemini: ${body.keyStatus.gemini ? t("present") : t("missing")} · OpenRouter: ${body.keyStatus.openrouter ? t("present") : t("missing")}`;
}

function providerFormPayload() {
  const provider = $("#provider").value;
  return {
    provider,
    model: requestModelId(provider, $("#model").value),
    temperature: Number($("#temperature").value),
    maxOutputTokens: Number($("#max-tokens").value),
    endpoint: $("#endpoint").value.trim(),
    apiKey: $("#api-key").value.trim() || undefined,
  };
}

async function saveProvider() {
  const payload = providerFormPayload();
  recordCommand(`llm-dungeon configure  # provider=${payload.provider} model=${quoted(payload.model)} api-key=${payload.apiKey ? "[redacted]" : "[unchanged]"}`);
  const body = await api("/api/config/provider", {
    method: "PUT",
    body: JSON.stringify(payload),
  });
  $("#api-key").value = "";
  print("PROVIDER SAVED", `${providerLabel(body.config.provider)}/${displayModelId(body.config.provider, body.config.model)}\nAPI key storage: memory only`, "success", "provider");
  await loadProvider();
}

async function loadWorld() {
  $("#world-markdown").value = (await api("/api/config/world")).markdown;
}

async function generateCampaign() {
  recordCommand(`llm-dungeon new  # premise=${quoted($("#premise").value || "default")} character=${quoted($("#character").value || "default")}`);
  const body = await api("/api/campaign/draft", {
    method: "POST",
    body: JSON.stringify({ premise: $("#premise").value, character: $("#character").value }),
  });
  currentDraft = body;
  const setup = body.setup;
  print(
    `CAMPAIGN PREVIEW — ${setup.campaignTitle}`,
    `${setup.scenarioMarkdown}\n\n--- ${setup.player.name} ---\n${setup.player.description}\n\nTraits: ${setup.player.traits.join(", ") || "none"}\n\n--- OPENING ---\n${setup.openingNarration}`,
    "normal",
    "campaign",
  );
  $("#draft-controls").classList.remove("hidden");
}

async function confirmCampaign() {
  if (!currentDraft) throw new Error("Generate a campaign preview first");
  recordCommand(`campaign.accept --draft ${currentDraft.draftId}${$("#archive-on-confirm").checked ? " --archive-current" : ""}`);
  const body = await api("/api/campaign/confirm", {
    method: "POST",
    body: JSON.stringify({ draftId: currentDraft.draftId, archiveCurrent: $("#archive-on-confirm").checked }),
  });
  await switchTerminalCampaign(body.state);
  print(`CAMPAIGN BEGINS — ${body.state.title}`, body.openingNarration, "success", "game");
  currentDraft = null;
  $("#draft-controls").classList.add("hidden");
  showPanel("game");
}

async function play() {
  const action = $("#action").value.trim();
  if (!action) throw new Error("Enter an action first");
  recordCommand(`> ${action}`);
  print(t("you"), action, "normal", "game");
  $("#action").value = "";
  const result = await api("/api/game/play", { method: "POST", body: JSON.stringify({ action }) });
  if (result.checkText) print(t("check"), result.checkText, "normal", "game");
  print(`${t("dm")} — ${locale === "ru" ? "ХОД" : "TURN"} ${result.turn}`, result.narration, "success", "game");
  if (result.state.status !== "active") print(t("campaignEnded"), `${locale === "ru" ? "Статус" : "Status"}: ${result.state.status}`, "error", "game");
}

async function retry() {
  recordCommand(":retry");
  const result = await api("/api/game/retry", { method: "POST", body: "{}" });
  if (result.checkText) print(t("check"), result.checkText, "normal", "game");
  print(`${t("dm")} — ${locale === "ru" ? "ХОД" : "TURN"} ${result.turn}`, result.narration, "success", "game");
}

async function inspect(view) {
  recordCommand(`:${view}`);
  const body = await api(`/api/game/inspect?view=${encodeURIComponent(view)}`);
  print(view.toUpperCase(), body.text, "normal", "game");
}

function runPayload() {
  const playerProfiles = selectedProfileIds();
  if (!playerProfiles.length) throw new Error(locale === "ru" ? "Выберите хотя бы один профиль игрока" : "Select at least one player profile");
  return {
    sessions: Number($("#sessions").value),
    turns: Number($("#turns").value),
    concurrency: Number($("#concurrency").value),
    maxCostUsd: Number($("#max-cost").value),
    playerProfiles,
    playerModel: requestModelId(status?.config?.provider, $("#player-model").value) || undefined,
  };
}

function selectedProfileIds() {
  return profileSelectionOrder.filter((id) => {
    const input = $(`#profile-pool input[value="${id}"]`);
    return Boolean(input?.checked);
  });
}

function syncProfilePool(changedInput) {
  const checkedInDisplayOrder = $$("#profile-pool input:checked").map((input) => input.value);
  profileSelectionOrder = profileSelectionOrder.filter((id) => checkedInDisplayOrder.includes(id));
  if (changedInput?.checked) {
    profileSelectionOrder = profileSelectionOrder.filter((id) => id !== changedInput.value);
    profileSelectionOrder.push(changedInput.value);
  }
  for (const id of checkedInDisplayOrder) {
    if (!profileSelectionOrder.includes(id)) profileSelectionOrder.push(id);
  }
  const selected = selectedProfileIds();
  const labels = selected.map((id) => $(`#profile-pool input[value="${id}"]`)?.closest("label")?.querySelector("b")?.textContent ?? id);
  const selectionField = $("#profile-selection-summary");
  selectionField.textContent = labels.length ? labels.join(", ") : (locale === "ru" ? "Выберите профили…" : "Select profiles…");
  selectionField.title = labels.join(" → ");
  selectionField.classList.toggle("error", selected.length === 0);
  const order = $("#profile-order");
  order.classList.toggle("error", selected.length === 0);
  order.textContent = selected.length === 0
    ? (locale === "ru" ? "Выберите хотя бы один профиль." : "Select at least one profile.")
    : selected.length === 1
      ? `${locale === "ru" ? "Каждая сессия" : "Every session"}: ${labels[0]}`
      : `${locale === "ru" ? "Порядок ротации" : "Rotation order"}: ${labels.join(" → ")}`;
  $("#start-evaluation").disabled = status?.evaluationTask?.status === "running" || selected.length === 0;
}

async function startEvaluation() {
  const payload = runPayload();
  recordCommand(`llm-dungeon evaluate --sessions ${payload.sessions} --turns ${payload.turns} --concurrency ${payload.concurrency} --max-cost ${payload.maxCostUsd} --player-profiles ${payload.playerProfiles.join(",")}${payload.playerModel ? ` --player-model ${quoted(payload.playerModel)}` : ""}`);
  const body = await api("/api/evaluations/start", { method: "POST", body: JSON.stringify(payload) });
  preferredRunId = body.task.runId;
  const configuredProfiles = body.config.playerProfiles;
  const profileLine = configuredProfiles.length === 1
    ? `Profile for every session: ${configuredProfiles[0]}`
    : `Profile rotation: ${configuredProfiles.join(" → ")}`;
  print("AUTO-RUN STARTED", `${body.task.runId}\nDM: ${body.config.dm.config.provider}/${body.config.dm.config.model}\nPlayer: ${body.config.player.config.provider}/${body.config.player.config.model}\n${profileLine}\n${$("#sessions").value} session(s) × ${$("#turns").value} turns · ${body.config.concurrency ?? 3} parallel\nCost ceiling: $${$("#max-cost").value}`, "success", "evaluations");
  await refreshStatus();
}

function addOption(select, value, label) {
  const option = document.createElement("option");
  option.value = value;
  option.textContent = label;
  select.append(option);
}

async function loadRuns() {
  const body = await api("/api/evaluations/runs");
  evaluationRuns = body.runs;
  const selected = preferredRunId || $("#run-select").value;
  const select = $("#run-select");
  select.replaceChildren();
  if (!evaluationRuns.length) addOption(select, "", "No runs yet");
  for (const run of evaluationRuns) {
    const detail = run.status === "inspection_failed"
      ? `${run.runId} · inspection failed`
      : `${run.runId} · ${run.status} · $${run.totalEstimatedCostUsd.toFixed(4)}`;
    addOption(select, run.runId, detail);
  }
  if (evaluationRuns.some((run) => run.runId === selected)) $("#run-select").value = selected;
  if (preferredRunId && evaluationRuns.some((run) => run.runId === preferredRunId)) preferredRunId = null;
  updateSessions();
}

function selectedRun() {
  const id = $("#run-select").value;
  const run = evaluationRuns.find((candidate) => candidate.runId === id);
  if (!run) throw new Error("Select an evaluation run first");
  return run;
}

function updateSessions() {
  const run = evaluationRuns.find((candidate) => candidate.runId === $("#run-select").value);
  $("#session-select").replaceChildren();
  if (!run) { addOption($("#session-select"), "", "Select a run"); return; }
  if (run.status === "inspection_failed") {
    addOption($("#session-select"), "", `Inspection failed: ${run.inspectionError}`);
    return;
  }
  for (const session of run.sessions) addOption($("#session-select"), session.id, `${session.id} · ${session.profile} · ${session.status}`);
}

async function artifact(kind) {
  const run = selectedRun();
  const sessionId = kind === "report" ? "" : $("#session-select").value;
  if (kind !== "report" && !sessionId) throw new Error("Select a session first");
  recordCommand(`artifact.show --run ${run.runId} --kind ${kind}${sessionId ? ` --session ${sessionId}` : ""}`);
  const query = new URLSearchParams({ runId: run.runId, kind, ...(sessionId ? { sessionId } : {}) });
  const body = await api(`/api/evaluations/artifact?${query}`);
  if (kind === "transcript" && body.presentation) {
    const transcript = body.presentation;
    print(
      `${locale === "ru" ? "АВТОПРОГОН" : "AUTO-RUN"} — ${sessionId}`,
      `${locale === "ru" ? "Профиль" : "Profile"}: ${transcript.profile}`,
      "normal",
      "evaluations",
    );
    if (transcript.opening) {
      print(`${t("dm")} — ${locale === "ru" ? "НАЧАЛО" : "OPENING"}`, transcript.opening, "success", "evaluations");
    }
    for (const turn of transcript.turns) {
      const approach = String(turn.approach || "").replaceAll("_", " ").toUpperCase();
      print(`${t("you")}${approach ? ` — ${approach}` : ""}`, turn.action, "normal", "evaluations");
      if (turn.checkText) print(t("check"), turn.checkText, "normal", "evaluations");
      if (turn.narration) {
        print(`${t("dm")} — ${locale === "ru" ? "ХОД" : "TURN"} ${turn.turn}`, turn.narration, "success", "evaluations");
      }
      if (turn.status === "failed") {
        print(
          `${locale === "ru" ? "СБОЙ ХОДА" : "TURN FAILED"} ${turn.turn}`,
          turn.error || (locale === "ru" ? "Неизвестная техническая ошибка" : "Unknown technical failure"),
          "error",
          "evaluations",
        );
      }
    }
    return;
  }
  print(`${kind.toUpperCase()} — ${run.runId}${sessionId ? ` / ${sessionId}` : ""}`, body.text, "normal", "evaluations");
}

$("#language-select").addEventListener("change", () => work(locale === "ru" ? "Меняю язык…" : "Changing language…", async () => {
  const outputChannel = currentTerminalChannel();
  const language = $("#language-select").value;
  recordCommand(`llm-dungeon language ${language}`);
  await api("/api/config/language", {
    method: "PUT",
    body: JSON.stringify({ language, applyToCurrent: true }),
  });
  applyUiLanguage(language);
  print(t("changed"), t("changedBody"), "success", outputChannel);
}));
panelTabs().forEach((button) => {
  button.addEventListener("click", () => showPanel(button.dataset.panel));
  button.addEventListener("keydown", handleTabKeydown);
});
$("#clear-terminal").addEventListener("click", () => {
  const channel = currentTerminalChannel();
  terminalHistory = terminalHistory.filter((entry) => entry.channel !== channel);
  persistTerminalHistory();
  renderTerminalChannel(channel);
});
$("#save-provider").addEventListener("click", () => work("Saving provider…", saveProvider));
$("#test-provider").addEventListener("click", () => work("Testing provider…", async () => {
  const payload = providerFormPayload();
  recordCommand(`provider.test --provider ${payload.provider} --model ${quoted(payload.model)} --api-key ${payload.apiKey ? "[redacted]" : "[configured]"}`);
  try {
    const body = await api("/api/config/provider/test", { method: "POST", body: JSON.stringify(payload) });
    providerCompatibility = { status: "ok", provider: body.provider, model: body.model, ...body.structuredOutput };
    renderProviderCompatibility();
    const mode = locale === "ru"
      ? "схема создания кампании + точная Gameplay Contract V1 с машинными кодами + локальная проверка домена"
      : "campaign setup + exact Gameplay Contract V1 machine-code schema + local domain validation";
    const safety = locale === "ru"
      ? "неограниченный резервный режим намеренно отключён (ошибка вместо ослабления схемы)"
      : "unrestricted fallback intentionally disabled (fail closed)";
    print(t("connectionSchemaOk"), `${body.provider}/${body.model}\nEnforcement: ${mode}\nSafety: ${safety}`, "success", "provider");
  } catch (caught) {
    providerCompatibility = { status: "failed", error: caught instanceof Error ? caught.message : String(caught) };
    renderProviderCompatibility();
    throw caught;
  }
}));
$("#provider").addEventListener("change", () => {
  invalidateProviderCompatibility();
  setModelValue($("#model").value);
});
$("#model").addEventListener("input", () => { invalidateProviderCompatibility(); renderModelGuidance(); });
$("#endpoint").addEventListener("input", invalidateProviderCompatibility);
$("#save-world").addEventListener("click", () => work("Saving world rules…", async () => {
  recordCommand("world.save config/world.md");
  await api("/api/config/world", { method: "PUT", body: JSON.stringify({ markdown: $("#world-markdown").value }) });
  print("WORLD RULES SAVED", "Changes will apply to future campaigns.", "success", "world");
}));
$("#generate-campaign").addEventListener("click", () => work("Generating campaign…", generateCampaign));
$("#regenerate-campaign").addEventListener("click", () => work("Regenerating campaign…", generateCampaign));
$("#confirm-campaign").addEventListener("click", () => work("Creating campaign…", confirmCampaign));
$("#play").addEventListener("click", () => work("The dungeon master considers the world…", play));
$("#retry").addEventListener("click", () => work("Retrying pending turn…", retry));
$("#discard").addEventListener("click", () => work("Discarding pending turn…", async () => {
  recordCommand(":discard");
  await api("/api/game/discard", { method: "POST", body: "{}" }); print("PENDING TURN", "Discarded without changing campaign state.", "success", "game");
}));
$("#archive").addEventListener("click", () => {
  if (!confirm("Archive the current campaign? This cannot be undone or resumed.")) return;
  recordCommand("campaign.archive");
  work("Archiving campaign…", async () => {
    await api("/api/game/archive", { method: "POST", body: "{}" });
    await switchTerminalCampaign(null);
    print("CAMPAIGN ARCHIVED", "You can now create a new campaign.", "success", "game");
  });
});
$("#inspect-buttons").addEventListener("click", (event) => {
  const view = event.target.dataset?.view;
  if (view) work(`Loading ${view}…`, () => inspect(view));
});
$("#action").addEventListener("keydown", (event) => {
  if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) { event.preventDefault(); work("The dungeon master considers the world…", play); }
});
$("#start-evaluation").addEventListener("click", () => work("Starting auto-run…", startEvaluation));
$("#profile-pool").addEventListener("change", (event) => {
  if (event.target.matches('input[type="checkbox"]')) syncProfilePool(event.target);
});
document.addEventListener("click", (event) => {
  const dropdown = $("#profile-dropdown");
  if (dropdown.open && !dropdown.contains(event.target)) dropdown.open = false;
  for (const picker of $$('[data-model-picker]')) {
    if (!picker.contains(event.target)) closeModelPicker(picker);
  }
});
$("#run-select").addEventListener("change", updateSessions);
$("#show-report").addEventListener("click", () => work("Loading report…", () => artifact("report")));
$("#show-transcript").addEventListener("click", () => work("Loading transcript…", () => artifact("transcript")));
$("#show-evaluation").addEventListener("click", () => work("Loading AI evaluation…", () => artifact("evaluation")));
$("#resume-run").addEventListener("click", () => work("Resuming run…", async () => {
  const run = selectedRun();
  recordCommand(`llm-dungeon evaluate:resume ${run.runId}`);
  await api("/api/evaluations/resume", { method: "POST", body: JSON.stringify({ runId: run.runId }) });
  print("AUTO-RUN RESUMED", run.runId, "success", "evaluations");
}));
$("#regenerate-report").addEventListener("click", () => work("Regenerating report…", async () => {
  const run = selectedRun();
  recordCommand(`llm-dungeon evaluate:report ${run.runId}`);
  const body = await api("/api/evaluations/report", { method: "POST", body: JSON.stringify({ runId: run.runId }) });
  print(`REPORT — ${run.runId}`, body.report, "success", "evaluations");
}));
$("#command-log-toggle").addEventListener("click", () => {
  renderCommandLog();
  $("#command-log-dialog").showModal();
});
$("#command-log-close").addEventListener("click", () => $("#command-log-dialog").close());
$("#command-log-dialog").addEventListener("click", (event) => {
  if (event.target === $("#command-log-dialog")) $("#command-log-dialog").close();
});
$("#copy-command-log").addEventListener("click", async () => {
  await navigator.clipboard.writeText($("#command-log").textContent);
  const button = $("#copy-command-log");
  const original = button.textContent;
  button.textContent = t("copied");
  setTimeout(() => { button.textContent = original; }, 1200);
});
$("#clear-command-log").addEventListener("click", () => {
  commandLog = [];
  try { localStorage.removeItem(COMMAND_STORAGE_KEY); } catch { /* Storage can be disabled. */ }
  renderCommandLog();
});

loadCommandLog();
initializeSplitPane();
initializeModelPickers();
syncProfilePool();
applyUiLanguage("en");
refreshStatus().catch(error);
setInterval(() => refreshStatus().catch(() => {}), 2000);
