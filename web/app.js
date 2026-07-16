import {
  committedTerminalTurns,
  hasUnpairedPlayerAction,
  isTerminalChannel,
  normalizeTerminalEntry,
  parseTerminalHistory,
  serializeTerminalHistory,
  terminalStorageKey,
} from "./terminal-history.js";

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
let uiLanguageInitialized = false;
let profileSelectionOrder = [];
let providerCompatibility = null;
let languageCatalog = [];
let activeInspectionView = null;
let currentInspection = null;
let inspectionRequestSequence = 0;
let inspectionCampaignKey = null;
let actionAvailable = false;
let pendingRecoveryAvailable = false;
const COMMAND_STORAGE_KEY = "llm-dungeon:web-cli-command-log";
let commandLog = [];
let terminalCampaignId;
let terminalHistory = [];

const UI_COPY = {
  en: {
    controlRoom: "web-cli", output: "TERMINAL OUTPUT", clear: "clear", language: "Language", commands: "activity log", close: "close",
    commandTitle: "Activity log", commandHint: "A local audit trail of actions performed through this interface. API keys are always redacted.", activityCloseLabel: "Close activity log", copy: "Copy", clearLog: "Clear activity", noCommands: "No activity recorded yet.", copied: "Copied", online: "WEB-CLI ONLINE",
    campaignGroup: "Campaign", configurationGroup: "Configuration", testingGroup: "Testing",
    game: "Play", newCampaign: "New campaign", providerKey: "Provider & key", autoRuns: "Auto-runs", worldRules: "World & style",
    play: "Play", whatDo: "What do you do?", send: "Send action",
    sendHint: "Ctrl/⌘ + Enter sends the action. Use :ask <question> for an answer that does not advance the turn.",
    pendingHint: "Pending recovery: Enter :retry to resume the same action or appeal, including its locked roll, or :discard to remove it without changing the world.",
    pendingCommandRequired: "A turn is pending. Enter :retry or :discard before sending another action.", pendingDiscardedHeading: "PENDING TURN", pendingDiscardedBody: "Discarded without changing campaign state.",
    inspect: "Inspect", character: "Character", location: "Location", threads: "Story threads", archive: "Archive campaign…",
    askGenericLabel: "Ask the DM without advancing the turn", askGenericTitle: "Prefill an out-of-character question; nothing is sent yet", askTurnLabel: "Ask about turn {turn}", askTurnTitle: "Prefill a question about turn {turn}; nothing is sent yet", askTurnPrefix: "Regarding turn {turn}: ",
    appealGenericLabel: "Appeal a state or DM mistake", appealGenericTitle: "Prefill a general appeal; nothing is sent yet", appealTurnLabel: "Appeal turn {turn}", appealTurnTitle: "Prefill an appeal for turn {turn}; nothing is sent yet", appealHeading: "APPEAL",
    inspectionViewsAria: "Inspection views", inspectionRegionAria: "Campaign inspection", inspectionLoading: "Loading campaign state…", inspectionLoadFailed: "Could not load campaign state.",
    descriptionHeading: "Description", traitsHeading: "Traits", conditionsHeading: "Conditions", inventoryHeading: "Inventory", featuresHeading: "Features", factsHeading: "Facts", knowledgeHeading: "Player knowledge", historyHeading: "History", relationshipsHeading: "Relationships", knownDetailsHeading: "Known details", activeThreadsHeading: "Active", resolvedThreadsHeading: "Resolved", failedThreadsHeading: "Failed", noDescription: "No description recorded.", emptyList: "None.",
    archiveConfirm: "Archive the current campaign? This cannot be undone or resumed.", archivingCampaign: "Archiving campaign…", campaignArchived: "CAMPAIGN ARCHIVED", campaignArchivedBody: "You can now create a new campaign.",
    premise: "Premise / scenario (optional)", characterConcept: "Character concept (optional)",
    generate: "Generate preview", archiveExisting: "Archive the current campaign if one exists", accept: "Accept & begin", regenerate: "Regenerate",
    provider: "Provider", googleRecommended: "Google — recommended", openrouter: "OpenRouter", model: "Model ID", recommended: "recommended", showModelOptions: "Show model options", noModelMatches: "No preset matches. Your entered model ID will be used.", temperature: "Temperature", maxTokens: "Max output tokens", apiKey: "Session API key (leave blank to use .env)", saveConfig: "Save config", test: "Test connection",
    recommendedDm: "Recommended DM model.", listedModel: "Listed model. Run Test connection before use with the selected provider.", unverifiedModel: "Manually entered model. It may reject schemas or behave differently; run Test connection before use.",
    keyNotice: "Leave the session key blank to use GEMINI_API_KEY or OPENROUTER_API_KEY from .env. A key entered here overrides it only for this server session and is never written to files or returned by the API.",
    schemaRequired: "Structured output required", schemaUntested: "The selected model must accept both campaign-setup and Gameplay Contract V1 schemas. Run Test connection after changing provider or model.", schemaRule: "Unsupported models fail closed; the game never falls back to unrestricted JSON.",
    schemaFullTitle: "Compatible · setup and gameplay schemas enforced", schemaFullDetail: "The provider accepted the campaign-setup schema and exact Gameplay Contract V1 wire schema; no degraded fallback is used.", schemaFailedTitle: "Incompatible · required schema rejected", schemaFailedDetail: "This provider/model cannot pass every schema required to create and play a campaign.", openrouterSchemaRequirement: "The selected model route supports strict response_format=json_schema.", geminiSchemaRequirement: "The selected Gemini model accepts both provider-enforced schemas.", playerSchemaHint: "A player-model override must also support schema-constrained JSON output.", connectionSchemaOk: "CONNECTION + REQUIRED SCHEMAS OK",
    selfPlay: "Self-play auto-runs", cost: "Cost ceiling ($)", sessions: "Sessions", turnsSession: "Turns / session", concurrency: "Parallel sessions", playerProfile: "Player profile pool", profileHint: "Select one or more. Sessions rotate through profiles in the order you select them.", playerModel: "Simulated-player model (optional override)", startRun: "Start bounded auto-run", artifacts: "Run artifacts", run: "Run", report: "Show report", resume: "Resume run", regenReport: "Regenerate report", session: "Session", transcript: "Transcript", aiEvaluation: "AI evaluation",
    worldNotice: "This creative Markdown controls setting, tone, pacing, and boundaries for future campaigns. Engine rules and protocols remain protected.", worldProfileMarkdown: "Creative profile Markdown", saveWorld: "Save creative profile", working: "Working…",
    promptInspector: "Prompt inspector", promptNotice: "Read-only static templates with safe placeholders. Live campaign context and secrets are never exposed here.", promptPhase: "Prompt phase", showPrompt: "Show prompt", promptChoose: "Choose a phase to inspect its static template.",
    phaseDmSystem: "DM system", phaseSetup: "Campaign setup", phaseAdjudication: "Turn adjudication", phaseDifficulty: "Check difficulty", phaseResolution: "Locked resolution", phaseQuestion: "Out-of-character question", phaseAppeal: "Appeal review", phaseSchemaRepair: "Schema repair", phaseDomainCorrection: "Domain correction", phaseSimulatedPlayer: "Simulated player", phaseJudge: "Evaluation judge", phaseConnectionProbe: "Provider probe",
    profileDefault: "built-in native default", profileLocalized: "language-specific override", profileLegacy: "legacy custom profile", defaultPrefix: "Default",
    noCampaign: "No current campaign. Create one in the New campaign panel.", pendingAvailable: "pending action available", none: "none",
    providerMissing: "provider: not configured", noKey: "no key", campaignNone: "campaign: none", evaluationIdle: "evaluation: idle",
    autoUses: "Auto-runs use the saved provider; completed sessions are judged by the same DM model", configureAuto: "Configure and save a provider before starting an auto-run.",
    ready: "llm-dungeon web-cli ready.\n\nConfigure a provider, create or resume a campaign, then enter any action.", emptyOutput: "No output for this tab yet.",
    changed: "LANGUAGE CHANGED", changedBody: "The selected language now applies to the interface where translated and to new campaign narration.",
    actionPlaceholder: "I approach the hooded traveler and ask why they have been watching the door.", premisePlaceholder: "Default: A classical opening in a tavern, with immediate but optional possibilities.", characterPlaceholder: "Default: A grounded adventurer with two useful traits and one complicating trait.", playerModelPlaceholder: "google/gemini-3.1-flash-lite — recommended",
    keyPlaceholder: "Optional session override", present: "present", missing: "missing", you: "YOU", check: "D100 CHECK", dm: "DUNGEON MASTER", answerHeading: "ANSWER — NO TURN", campaignEnded: "CAMPAIGN ENDED",
    controlPanelsAria: "Control panels", languageAria: "Game and interface language", selectedProfilesAria: "Selected player profiles",
    campaignNoun: "campaign", turnNoun: "turn", turnHeading: "TURN", statusNoun: "status", statusHeading: "Status", evaluationNoun: "evaluation", defaultPlayer: "Default player",
    selectPlayerProfileError: "Select at least one player profile", selectProfiles: "Select profiles…", selectProfileError: "Select at least one profile.", everySession: "Every session", rotationOrder: "Rotation order",
    autoRunHeading: "AUTO-RUN", profileHeading: "Profile", openingHeading: "OPENING", turnFailedHeading: "TURN FAILED", unknownTechnicalFailure: "Unknown technical failure", changingLanguage: "Changing language…",
    connectionEnforcementLabel: "Enforcement", connectionEnforcementMode: "campaign setup + exact Gameplay Contract V1 machine-code schema + local domain validation", connectionSafetyLabel: "Safety", connectionSafetyMode: "unrestricted fallback intentionally disabled (fail closed)",
    splitLabel: "Resize terminal and controls", splitTitle: "Drag to resize · Double-click to reset",
  },
  ru: {
    controlRoom: "web-cli", output: "ВЫВОД ТЕРМИНАЛА", clear: "очистить", language: "Язык", commands: "журнал действий", close: "закрыть",
    commandTitle: "Журнал действий", commandHint: "Локальный журнал действий, выполненных через этот интерфейс. Ключи API всегда скрыты.", activityCloseLabel: "Закрыть журнал действий", copy: "Копировать", clearLog: "Очистить действия", noCommands: "Действий пока нет.", copied: "Скопировано", online: "WEB-CLI ГОТОВ",
    campaignGroup: "Кампания", configurationGroup: "Настройки", testingGroup: "Тестирование",
    game: "Играть", newCampaign: "Новая кампания", providerKey: "Провайдер и ключ", autoRuns: "Автопрогоны", worldRules: "Мир и стиль",
    play: "Играть", whatDo: "Что вы делаете?", send: "Отправить действие",
    sendHint: "Ctrl/⌘ + Enter отправляет действие. Используйте :ask <вопрос>, чтобы получить ответ без нового хода.",
    pendingHint: "Восстановление: введите :retry, чтобы продолжить действие или апелляцию с сохранённым броском, либо :discard, чтобы удалить запрос без изменения мира.",
    pendingCommandRequired: "Есть незавершённый ход. Введите :retry или :discard перед новым действием.", pendingDiscardedHeading: "НЕЗАВЕРШЁННЫЙ ХОД", pendingDiscardedBody: "Удалён без изменения состояния кампании.",
    inspect: "Просмотр", character: "Персонаж", location: "Локация", threads: "Сюжетные линии", archive: "Архивировать кампанию…",
    askGenericLabel: "Задать мастеру вопрос без нового хода", askGenericTitle: "Вставить внеигровой вопрос; ничего не отправляется", askTurnLabel: "Спросить о ходе {turn}", askTurnTitle: "Вставить вопрос о ходе {turn}; ничего не отправляется", askTurnPrefix: "О ходе {turn}: ",
    appealGenericLabel: "Оспорить состояние игры или ошибку мастера", appealGenericTitle: "Вставить общую апелляцию; ничего не отправляется", appealTurnLabel: "Оспорить ход {turn}", appealTurnTitle: "Вставить апелляцию на ход {turn}; ничего не отправляется", appealHeading: "АПЕЛЛЯЦИЯ",
    inspectionViewsAria: "Разделы состояния", inspectionRegionAria: "Состояние кампании", inspectionLoading: "Загружаю состояние кампании…", inspectionLoadFailed: "Не удалось загрузить состояние кампании.",
    descriptionHeading: "Описание", traitsHeading: "Черты", conditionsHeading: "Состояния", inventoryHeading: "Инвентарь", featuresHeading: "Особенности", factsHeading: "Факты", knowledgeHeading: "Знания игрока", historyHeading: "История", relationshipsHeading: "Отношения", knownDetailsHeading: "Известные сведения", activeThreadsHeading: "Активные", resolvedThreadsHeading: "Завершённые", failedThreadsHeading: "Проваленные", noDescription: "Описание отсутствует.", emptyList: "Нет.",
    archiveConfirm: "Архивировать текущую кампанию? Это нельзя отменить, и кампанию нельзя продолжить.", archivingCampaign: "Архивирую кампанию…", campaignArchived: "КАМПАНИЯ АРХИВИРОВАНА", campaignArchivedBody: "Теперь можно создать новую кампанию.",
    premise: "Завязка / сценарий (необязательно)", characterConcept: "Концепция персонажа (необязательно)",
    generate: "Создать предпросмотр", archiveExisting: "Архивировать текущую кампанию, если она существует", accept: "Принять и начать", regenerate: "Создать заново",
    provider: "Провайдер", googleRecommended: "Google — рекомендуется", openrouter: "OpenRouter", model: "ID модели", recommended: "рекомендуется", showModelOptions: "Показать варианты моделей", noModelMatches: "Подходящих вариантов нет. Будет использован введённый ID модели.", temperature: "Температура", maxTokens: "Макс. токенов ответа", apiKey: "Сеансовый API-ключ (оставьте пустым для .env)", saveConfig: "Сохранить", test: "Проверить соединение",
    recommendedDm: "Рекомендуемая модель мастера.", listedModel: "Модель из списка. Перед использованием с выбранным провайдером запустите проверку соединения.", unverifiedModel: "Модель введена вручную. Она может отклонить схему или вести себя иначе; сначала запустите проверку соединения.",
    keyNotice: "Оставьте сеансовый ключ пустым, чтобы использовать GEMINI_API_KEY или OPENROUTER_API_KEY из .env. Введённый здесь ключ заменяет его только для текущего процесса сервера, не записывается в файлы и не возвращается API.",
    schemaRequired: "Требуется структурированный вывод", schemaUntested: "Выбранная модель должна принять схемы создания кампании и Gameplay Contract V1. После смены провайдера или модели запустите проверку.", schemaRule: "Неподдерживаемые модели отклоняются; игра никогда не переходит к JSON без ограничений.",
    schemaFullTitle: "Совместимо · схемы создания и игры применяются", schemaFullDetail: "Провайдер принял схему создания кампании и точную схему Gameplay Contract V1; ослабленный резервный режим не используется.", schemaFailedTitle: "Несовместимо · обязательная схема отклонена", schemaFailedDetail: "Эта комбинация провайдера и модели не прошла все проверки, необходимые для создания и игры кампании.", openrouterSchemaRequirement: "Выбранный маршрут модели поддерживает строгий response_format=json_schema.", geminiSchemaRequirement: "Выбранная модель Gemini принимает обе схемы, заданные провайдеру.", playerSchemaHint: "Переопределённая модель игрока также должна поддерживать JSON с ограничением схемой.", connectionSchemaOk: "СОЕДИНЕНИЕ И ОБЯЗАТЕЛЬНЫЕ СХЕМЫ В ПОРЯДКЕ",
    selfPlay: "Автоматические тестовые игры", cost: "Лимит стоимости ($)", sessions: "Сессии", turnsSession: "Ходов в сессии", concurrency: "Параллельные сессии", playerProfile: "Набор профилей игрока", profileHint: "Выберите один или несколько. Сессии чередуют профили в порядке выбора.", playerModel: "Модель игрока (необязательная замена)", startRun: "Запустить ограниченный автопрогон", artifacts: "Материалы прогонов", run: "Прогон", report: "Показать отчёт", resume: "Продолжить прогон", regenReport: "Обновить отчёт", session: "Сессия", transcript: "Транскрипт", aiEvaluation: "Оценка ИИ",
    worldNotice: "Этот творческий Markdown задаёт мир, тон, темп и границы будущих кампаний. Правила движка и протоколы защищены от изменений.", worldProfileMarkdown: "Markdown творческого профиля", saveWorld: "Сохранить творческий профиль", working: "Работаю…",
    promptInspector: "Инспектор промптов", promptNotice: "Статические шаблоны только для чтения с безопасными заполнителями. Контекст и секреты текущей кампании здесь не раскрываются.", promptPhase: "Этап промпта", showPrompt: "Показать промпт", promptChoose: "Выберите этап для просмотра статического шаблона.",
    phaseDmSystem: "Системный промпт мастера", phaseSetup: "Создание кампании", phaseAdjudication: "Решение по ходу", phaseDifficulty: "Сложность проверки", phaseResolution: "Разрешение броска", phaseQuestion: "Внеигровой вопрос", phaseAppeal: "Рассмотрение апелляции", phaseSchemaRepair: "Исправление схемы", phaseDomainCorrection: "Исправление состояния", phaseSimulatedPlayer: "Симуляция игрока", phaseJudge: "Судья автопрогона", phaseConnectionProbe: "Проверка провайдера",
    profileDefault: "встроенный профиль", profileLocalized: "языковая настройка", profileLegacy: "старый пользовательский профиль", defaultPrefix: "По умолчанию",
    noCampaign: "Текущей кампании нет. Создайте её на вкладке «Новая кампания».", pendingAvailable: "есть ожидающее действие", none: "нет",
    providerMissing: "провайдер: не настроен", noKey: "нет ключа", campaignNone: "кампания: нет", evaluationIdle: "автопрогон: не запущен",
    autoUses: "Автопрогоны используют сохранённого провайдера; завершённые сессии оценивает та же модель мастера", configureAuto: "Настройте и сохраните провайдера перед запуском.",
    ready: "llm-dungeon web-cli готов.\n\nНастройте провайдера, создайте или продолжите кампанию, затем введите любое действие.", emptyOutput: "На этой вкладке пока нет вывода.",
    changed: "ЯЗЫК ИЗМЕНЁН", changedBody: "Язык интерфейса и текущей кампании обновлён. Новое повествование будет на русском.",
    actionPlaceholder: "Я подхожу к путнику в капюшоне и спрашиваю, почему он следит за дверью.", premisePlaceholder: "По умолчанию: классическое начало в таверне с немедленными, но необязательными возможностями.", characterPlaceholder: "По умолчанию: приземлённый искатель приключений с двумя полезными и одной осложняющей чертой.", playerModelPlaceholder: "google/gemini-3.1-flash-lite — рекомендуется",
    keyPlaceholder: "Необязательная замена на сеанс", present: "есть", missing: "нет", you: "ВЫ", check: "ПРОВЕРКА D100", dm: "МАСТЕР ПОДЗЕМЕЛИЙ", answerHeading: "ОТВЕТ — БЕЗ ХОДА", campaignEnded: "КАМПАНИЯ ЗАВЕРШЕНА",
    controlPanelsAria: "Панели управления", languageAria: "Язык игры и интерфейса", selectedProfilesAria: "Выбранные профили игрока",
    campaignNoun: "кампания", turnNoun: "ход", turnHeading: "ХОД", statusNoun: "статус", statusHeading: "Статус", evaluationNoun: "автопрогон", defaultPlayer: "Игрок по умолчанию",
    selectPlayerProfileError: "Выберите хотя бы один профиль игрока", selectProfiles: "Выберите профили…", selectProfileError: "Выберите хотя бы один профиль.", everySession: "Каждая сессия", rotationOrder: "Порядок ротации",
    autoRunHeading: "АВТОПРОГОН", profileHeading: "Профиль", openingHeading: "НАЧАЛО", turnFailedHeading: "СБОЙ ХОДА", unknownTechnicalFailure: "Неизвестная техническая ошибка", changingLanguage: "Меняю язык…",
    connectionEnforcementLabel: "Применение схем", connectionEnforcementMode: "схема создания кампании + точная Gameplay Contract V1 с машинными кодами + локальная проверка домена", connectionSafetyLabel: "Безопасность", connectionSafetyMode: "неограниченный резервный режим намеренно отключён (ошибка вместо ослабления схемы)",
    splitLabel: "Изменить размер терминала и панели", splitTitle: "Перетащите для изменения · Двойной щелчок сбрасывает размер",
  },
};

const STATIC_TARGETS = {
  ".subtitle": "controlRoom", ".terminal-title > span": "output", "#clear-terminal": "clear", ".language-picker span": "language",
  "#command-log-label": "commands", "#command-log-close": "close", ".command-dialog h2": "commandTitle", ".command-dialog > .hint": "commandHint", "#copy-command-log": "copy", "#clear-command-log": "clearLog",
  "#tab-group-campaign-label": "campaignGroup", "#tab-group-configuration-label": "configurationGroup", "#tab-group-testing-label": "testingGroup",
  '[data-panel="game"]': "game", '[data-panel="campaign"]': "newCampaign", '[data-panel="provider"]': "providerKey", '[data-panel="evaluations"]': "autoRuns", '[data-panel="world"]': "worldRules",
  "#panel-game h1": "play", 'label[for="action"]': "whatDo", "#play": "send", "#panel-game .hint:not(#pending-help)": "sendHint", "#pending-help": "pendingHint", "#panel-game h2": "inspect",
  '[data-view="character"]': "character", '[data-view="location"]': "location", '[data-view="threads"]': "threads", "#archive-label": "archive",
  "#panel-campaign h1": "newCampaign", 'label[for="premise"]': "premise", 'label[for="character"]': "characterConcept", "#generate-campaign": "generate", ".check span": "archiveExisting", "#confirm-campaign": "accept", "#regenerate-campaign": "regenerate",
  "#panel-provider h1": "providerKey", "#panel-provider .notice": "keyNotice", 'label[for="provider"]': "provider", '#provider option[value="gemini"]': "googleRecommended", '#provider option[value="openrouter"]': "openrouter", 'label[for="model"]': "model", 'label[for="temperature"]': "temperature", 'label[for="max-tokens"]': "maxTokens", 'label[for="api-key"]': "apiKey", "#save-provider": "saveConfig", "#test-provider": "test", "#player-model-schema-hint": "playerSchemaHint",
  "#panel-evaluations h1": "selfPlay", 'label[for="max-cost"]': "cost", 'label[for="sessions"]': "sessions", 'label[for="turns"]': "turnsSession", 'label[for="concurrency"]': "concurrency", "#profile-control legend": "playerProfile", "#profile-help": "profileHint", 'label[for="player-model"]': "playerModel", "#start-evaluation": "startRun", "#panel-evaluations h2": "artifacts", 'label[for="run-select"]': "run", "#show-report": "report", "#resume-run": "resume", "#regenerate-report": "regenReport", 'label[for="session-select"]': "session", "#show-transcript": "transcript", "#show-evaluation": "aiEvaluation",
  "#panel-world h1": "worldRules", "#panel-world .notice": "worldNotice", 'label[for="world-markdown"]': "worldProfileMarkdown", "#save-world": "saveWorld", "#prompt-inspector-title": "promptInspector", "#prompt-inspector-notice": "promptNotice", 'label[for="prompt-phase"]': "promptPhase", "#show-prompt": "showPrompt", "#busy b": "working",
};

const PROMPT_PHASE_COPY = {
  "dm-system": "phaseDmSystem", setup: "phaseSetup", adjudication: "phaseAdjudication", difficulty: "phaseDifficulty",
  resolution: "phaseResolution", question: "phaseQuestion", appeal: "phaseAppeal", "schema-repair": "phaseSchemaRepair", "domain-correction": "phaseDomainCorrection",
  "simulated-player": "phaseSimulatedPlayer", judge: "phaseJudge", "connection-probe": "phaseConnectionProbe",
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
  languageCatalog = languages;
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
  refreshSetupPlaceholders();
}

function refreshSetupPlaceholders() {
  const languageMetadata = languageCatalog.find((item) => item.code === gameLanguage);
  $("#premise").placeholder = languageMetadata?.setupDefaults?.premise
    ? `${t("defaultPrefix")}: ${languageMetadata.setupDefaults.premise}`
    : t("premisePlaceholder");
  $("#character").placeholder = languageMetadata?.setupDefaults?.characterConcept
    ? `${t("defaultPrefix")}: ${languageMetadata.setupDefaults.characterConcept}`
    : t("characterPlaceholder");
}

function clearCurrentDraft() {
  currentDraft = null;
  $("#draft-controls").classList.add("hidden");
}

function applyUiLanguage(language, { resetTerminal = false } = {}) {
  const languageChanged = uiLanguageInitialized && language !== gameLanguage;
  if (languageChanged) clearCurrentDraft();
  gameLanguage = language;
  locale = UI_COPY[language] ? language : "en";
  uiLanguageInitialized = true;
  document.documentElement.lang = locale;
  $("#language-select").value = gameLanguage;
  for (const [selector, key] of Object.entries(STATIC_TARGETS)) {
    const element = $(selector);
    if (element) element.textContent = t(key);
  }
  $("#action").placeholder = t("actionPlaceholder");
  refreshSetupPlaceholders();
  $("#player-model").placeholder = t("playerModelPlaceholder");
  for (const root of $$('[data-model-picker]')) {
    root.querySelector(".model-picker-toggle").setAttribute("aria-label", t("showModelOptions"));
    if (!root.querySelector('[role="listbox"]').hidden) renderModelPickerOptions(root);
  }
  $("#api-key").placeholder = t("keyPlaceholder");
  renderModelGuidance();
  $(".tabs").setAttribute("aria-label", t("controlPanelsAria"));
  $("#command-log-close").setAttribute("aria-label", t("activityCloseLabel"));
  $("#language-select").setAttribute("aria-label", t("languageAria"));
  $("#profile-selection-summary").setAttribute("aria-label", t("selectedProfilesAria"));
  $("#inspect-buttons").setAttribute("aria-label", t("inspectionViewsAria"));
  $("#inspection-output").setAttribute("aria-label", t("inspectionRegionAria"));
  updatePrefillControlLabels();
  workspaceResizer.setAttribute("aria-label", t("splitLabel"));
  workspaceResizer.title = t("splitTitle");
  for (const option of $("#prompt-phase").options) {
    option.textContent = t(PROMPT_PHASE_COPY[option.value]);
  }
  if ($("#prompt-preview").dataset.loaded !== "true") $("#prompt-preview").textContent = t("promptChoose");
  document.title = "llm-dungeon web-cli";
  syncProfilePool();
  renderCommandLog();
  renderProviderCompatibility();
  if (currentInspection) renderInspection(currentInspection);
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

function turnCopy(key, turn) {
  return t(key).replace("{turn}", String(turn));
}

function setPrefillButtonCopy(button, kind, turn) {
  const prefix = kind === "ask" ? "ask" : "appeal";
  const label = turn === undefined ? t(`${prefix}GenericLabel`) : turnCopy(`${prefix}TurnLabel`, turn);
  const title = turn === undefined ? t(`${prefix}GenericTitle`) : turnCopy(`${prefix}TurnTitle`, turn);
  button.setAttribute("aria-label", label);
  button.title = title;
}

function updatePrefillControlLabels() {
  setPrefillButtonCopy($("#ask-generic"), "ask");
  setPrefillButtonCopy($("#appeal-generic"), "appeal");
  $$('[data-ask-turn]').forEach((button) => setPrefillButtonCopy(button, "ask", Number(button.dataset.askTurn)));
  $$('[data-appeal-turn]').forEach((button) => setPrefillButtonCopy(button, "appeal", Number(button.dataset.appealTurn)));
}

function updatePrefillAvailability() {
  $("#ask-generic").disabled = !actionAvailable;
  $("#appeal-generic").disabled = !actionAvailable;
  $$('[data-ask-turn]').forEach((button) => { button.disabled = !actionAvailable; });
  $$('[data-appeal-turn]').forEach((button) => { button.disabled = !actionAvailable; });
}

function createTurnPrefillButton(kind, turn) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = `action-prefill-button ${kind}-button`;
  button.dataset[kind === "ask" ? "askTurn" : "appealTurn"] = String(turn);
  button.append($(`#${kind}-generic svg`).cloneNode(true));
  button.disabled = !actionAvailable;
  setPrefillButtonCopy(button, kind, turn);
  return button;
}

function createTurnPrefillControls(turn) {
  const controls = document.createElement("span");
  controls.className = "terminal-turn-actions";
  controls.append(createTurnPrefillButton("ask", turn), createTurnPrefillButton("appeal", turn));
  return controls;
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
  if (entry.channel === "game" && entry.kind === "gameplay" && Number.isSafeInteger(entry.turn) && entry.turn > 0) {
    heading.append(createTurnPrefillControls(entry.turn));
  }
  const body = document.createElement("pre");
  body.textContent = entry.text;
  section.append(heading, body);
  terminal.append(section);
  terminal.dataset.pristine = "false";
}

function currentTerminalChannel() {
  const selected = panelTabs().find((button) => button.getAttribute("aria-selected") === "true");
  return isTerminalChannel(selected?.dataset.panel) ? selected.dataset.panel : "game";
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
  const { entries, serialized } = serializeTerminalHistory(terminalHistory);
  terminalHistory = entries;
  try { localStorage.setItem(terminalStorageKey(terminalCampaignId), serialized); } catch { /* Storage can be disabled or full. */ }
}

function readTerminalHistory(campaignId) {
  try {
    return parseTerminalHistory(localStorage.getItem(terminalStorageKey(campaignId)));
  } catch {
    return { entries: [], migrated: false };
  }
}

async function switchTerminalCampaign(campaign, { openingNarration } = {}) {
  const campaignId = campaign?.campaignId ?? null;
  if (terminalCampaignId !== campaignId) {
    resetInspection();
    const restored = readTerminalHistory(campaignId);
    terminalCampaignId = campaignId;
    terminalHistory = restored.entries;
    if (restored.migrated) persistTerminalHistory();
    renderTerminalChannel();
  }

  // Reconcile the browser-only presentation cache with authoritative committed
  // turns. This also repairs the crash window where a player action reached the
  // server and committed, but the browser closed before persisting the reply.
  const committedTurns = committedTerminalTurns(terminalHistory);
  if (campaign?.turn === 0 && openingNarration && !committedTurns.has(0)) {
    print(`CAMPAIGN BEGINS — ${campaign.title}`, openingNarration, "success", "game", { kind: "opening", turn: 0 });
    committedTurns.add(0);
  }
  if (campaign && !committedTurns.has(campaign.turn)) {
    try {
      const body = await api("/api/game/transcript");
      for (const turn of body.turns) {
        if (committedTurns.has(turn.turn)) continue;
        if (turn.kind === "opening" || turn.turn === 0) {
          print(`CAMPAIGN BEGINS — ${campaign.title}`, turn.narration, "success", "game", { kind: "opening", turn: 0 });
          committedTurns.add(turn.turn);
          continue;
        }
        if (!hasUnpairedPlayerAction(terminalHistory, turn.action)) print(t("you"), turn.action, "normal", "game");
        printCommittedResponse(turn);
        committedTurns.add(turn.turn);
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

function print(title, text, mode = "normal", channel = currentTerminalChannel(), metadata = {}) {
  const entry = normalizeTerminalEntry({ title, text, mode, channel, ...metadata });
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

async function work(label, operation, errorChannel) {
  const channel = errorChannel ?? currentTerminalChannel();
  busy.querySelector("b").textContent = label;
  busy.classList.remove("hidden");
  try { return await operation(); }
  catch (caught) { error(caught, channel); return undefined; }
  finally { busy.classList.add("hidden"); await refreshStatus().catch(() => {}); }
}

function inspectionElement(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function inspectionValues(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string" && item.trim()) : [];
}

function appendInspectionSection(parent, heading, values, { chips = false } = {}) {
  const section = inspectionElement("section", "inspection-section");
  section.append(inspectionElement("h4", "", heading));
  const items = inspectionValues(values);
  if (!items.length) {
    section.append(inspectionElement("p", "inspection-empty", t("emptyList")));
  } else {
    const list = inspectionElement("ul", chips ? "inspection-chip-list" : "inspection-text-list");
    for (const value of items) list.append(inspectionElement("li", chips ? "inspection-chip" : "", value));
    section.append(list);
  }
  parent.append(section);
}

function createInspectionHeader(inspection) {
  const header = inspectionElement("header", "inspection-card-header");
  header.append(inspectionElement("h3", "", inspection.name));
  header.append(inspectionElement("span", "inspection-status", inspection.status));
  return header;
}

function appendDescription(parent, description) {
  const section = inspectionElement("section", "inspection-section");
  section.append(inspectionElement("h4", "", t("descriptionHeading")));
  section.append(inspectionElement("p", "inspection-description", description || t("noDescription")));
  parent.append(section);
}

function appendInventory(parent, heading, inventory) {
  const section = inspectionElement("section", "inspection-section inspection-inventory");
  section.append(inspectionElement("h4", "", heading));
  const items = Array.isArray(inventory) ? inventory : [];
  if (!items.length) {
    section.append(inspectionElement("p", "inspection-empty", t("emptyList")));
    parent.append(section);
    return;
  }
  const list = inspectionElement("ul", "inspection-item-list");
  for (const item of items) {
    const row = inspectionElement("li", "inspection-item");
    const itemHeader = inspectionElement("div", "inspection-item-header");
    itemHeader.append(inspectionElement("strong", "", item.name));
    itemHeader.append(inspectionElement("span", "inspection-quantity", `× ${item.quantity}`));
    row.append(itemHeader);
    if (item.status) row.append(inspectionElement("small", "inspection-item-status", item.status));
    if (item.description) row.append(inspectionElement("p", "", item.description));
    list.append(row);
  }
  section.append(list);
  parent.append(section);
}

function appendKnownDetails(parent, facts) {
  const groups = [
    ["factsHeading", facts?.established],
    ["knowledgeHeading", facts?.knowledge],
    ["historyHeading", facts?.history],
  ];
  const count = groups.reduce((sum, [, values]) => sum + inspectionValues(values).length, 0);
  const details = inspectionElement("details", "inspection-details");
  details.append(inspectionElement("summary", "", `${t("knownDetailsHeading")} (${count})`));
  for (const [headingKey, values] of groups) appendInspectionSection(details, t(headingKey), values);
  parent.append(details);
}

function appendRelationships(parent, relationships) {
  const values = Array.isArray(relationships)
    ? relationships.map((relationship) => `${relationship.name} — ${relationship.summary}`)
    : [];
  appendInspectionSection(parent, t("relationshipsHeading"), values);
}

function renderCharacterInspection(inspection) {
  const card = inspectionElement("article", "inspection-card");
  card.append(createInspectionHeader(inspection));
  appendDescription(card, inspection.description);
  const grid = inspectionElement("div", "inspection-grid");
  appendInspectionSection(grid, t("traitsHeading"), inspection.traits, { chips: true });
  appendInspectionSection(grid, t("conditionsHeading"), inspection.conditions, { chips: true });
  card.append(grid);
  appendInventory(card, t("inventoryHeading"), inspection.inventory);
  appendRelationships(card, inspection.relationships);
  appendKnownDetails(card, inspection.facts);
  return card;
}

function renderLocationInspection(inspection) {
  const card = inspectionElement("article", "inspection-card");
  card.append(createInspectionHeader(inspection));
  appendDescription(card, inspection.description);
  const grid = inspectionElement("div", "inspection-grid");
  appendInspectionSection(grid, t("featuresHeading"), inspection.features, { chips: true });
  appendInspectionSection(grid, t("conditionsHeading"), inspection.conditions, { chips: true });
  card.append(grid);
  appendKnownDetails(card, inspection.facts);
  return card;
}

function createThreadList(threads) {
  const list = inspectionElement("ul", "inspection-thread-list");
  if (!threads.length) {
    list.append(inspectionElement("li", "inspection-empty", t("emptyList")));
    return list;
  }
  for (const thread of threads) {
    const item = inspectionElement("li", "inspection-thread");
    item.append(inspectionElement("strong", "", thread.title));
    item.append(inspectionElement("p", "", thread.summary));
    list.append(item);
  }
  return list;
}

function renderThreadsInspection(inspection) {
  const card = inspectionElement("article", "inspection-card inspection-threads");
  card.append(inspectionElement("h3", "", t("threads")));
  const threads = Array.isArray(inspection.threads) ? inspection.threads : [];
  const groups = [
    ["active", "activeThreadsHeading", false],
    ["resolved", "resolvedThreadsHeading", true],
    ["failed", "failedThreadsHeading", true],
  ];
  for (const [statusValue, headingKey, collapsed] of groups) {
    const matching = threads.filter((thread) => thread.status === statusValue);
    if (collapsed) {
      const details = inspectionElement("details", "inspection-details inspection-thread-group");
      details.append(inspectionElement("summary", "", `${t(headingKey)} (${matching.length})`));
      details.append(createThreadList(matching));
      card.append(details);
    } else {
      const section = inspectionElement("section", "inspection-section inspection-thread-group");
      section.append(inspectionElement("h4", "", `${t(headingKey)} (${matching.length})`));
      section.append(createThreadList(matching));
      card.append(section);
    }
  }
  return card;
}

function selectInspectionView(view) {
  $$("#inspect-buttons button").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.view === view));
  });
}

function showInspectionMessage(message, mode = "status") {
  const output = $("#inspection-output");
  output.hidden = false;
  const text = inspectionElement("p", `inspection-message ${mode}`, message);
  if (mode === "status") text.setAttribute("role", "status");
  output.replaceChildren(text);
}

function renderInspection(inspection) {
  const output = $("#inspection-output");
  currentInspection = inspection;
  activeInspectionView = inspection.view;
  selectInspectionView(inspection.view);
  let card;
  if (inspection.view === "character") card = renderCharacterInspection(inspection);
  else if (inspection.view === "location") card = renderLocationInspection(inspection);
  else if (inspection.view === "threads") card = renderThreadsInspection(inspection);
  else {
    showInspectionMessage(t("inspectionLoadFailed"), "error");
    return;
  }
  output.hidden = false;
  output.replaceChildren(card);
}

function resetInspection() {
  inspectionRequestSequence += 1;
  activeInspectionView = null;
  currentInspection = null;
  inspectionCampaignKey = null;
  selectInspectionView(null);
  const output = $("#inspection-output");
  output.setAttribute("aria-busy", "false");
  output.replaceChildren();
  output.hidden = true;
}

function campaignInspectionStateKey(campaign) {
  return campaign ? `${campaign.campaignId}:${campaign.turn}:${campaign.updatedAt ?? ""}` : null;
}

async function refreshInspectionAfterCommit(state) {
  inspectionCampaignKey = campaignInspectionStateKey(state);
  if (activeInspectionView) {
    await loadInspection(activeInspectionView, { record: false, showLoading: false });
  }
}

async function loadInspection(view, { record = true, showLoading = true } = {}) {
  const requestId = ++inspectionRequestSequence;
  if (currentInspection?.view !== view) currentInspection = null;
  activeInspectionView = view;
  selectInspectionView(view);
  const output = $("#inspection-output");
  output.setAttribute("aria-busy", "true");
  if (showLoading || !currentInspection || currentInspection.view !== view) {
    showInspectionMessage(t("inspectionLoading"));
  }
  if (record) recordCommand(`:${view}`);
  try {
    const body = await api(`/api/game/inspect?view=${encodeURIComponent(view)}`);
    if (requestId !== inspectionRequestSequence || activeInspectionView !== view) return;
    if (!body.inspection || body.inspection.view !== view) throw new Error(t("inspectionLoadFailed"));
    renderInspection(body.inspection);
  } catch (caught) {
    if (requestId !== inspectionRequestSequence || activeInspectionView !== view) return;
    const detail = caught instanceof Error ? caught.message : String(caught);
    const message = detail === t("inspectionLoadFailed")
      ? detail
      : `${t("inspectionLoadFailed")} ${detail}`.trim();
    showInspectionMessage(message, "error");
  } finally {
    if (requestId === inspectionRequestSequence) output.setAttribute("aria-busy", "false");
  }
}

function setActionPrefill(prefix, pattern) {
  const input = $("#action");
  const existing = input.value.trim();
  const currentPrefill = existing.match(pattern);
  const content = (currentPrefill ? currentPrefill[1] ?? "" : existing).trim();
  input.value = content ? `${prefix}${content}` : prefix;
  input.focus({ preventScroll: false });
  input.setSelectionRange(input.value.length, input.value.length);
}

function prefillAsk(turn) {
  const context = turn === undefined ? "" : turnCopy("askTurnPrefix", turn);
  setActionPrefill(`:ask ${context}`, /^:ask(?:\s+(?:Regarding turn|О ходе)\s+\d+:)?(?:\s+([\s\S]*))?$/);
}

function prefillAppeal(turn) {
  const prefix = turn === undefined ? ":appeal " : `:appeal --turn ${turn} `;
  setActionPrefill(prefix, /^:appeal(?:\s+--turn\s+\d+)?(?:\s+([\s\S]*))?$/);
}

function printCommittedResponse(result) {
  if (result.checkText) print(t("check"), result.checkText, "normal", "game");
  const kind = result.kind === "appeal" ? "appeal" : "gameplay";
  if (kind === "appeal") {
    const hasTarget = Number.isSafeInteger(result.appealTargetTurn) && result.appealTargetTurn >= 1;
    const title = hasTarget
      ? `${t("appealHeading")} — ${t("turnHeading")} ${result.appealTargetTurn}`
      : t("appealHeading");
    print(title, result.narration, "success", "game", {
      kind,
      turn: result.turn,
      ...(hasTarget ? { appealTargetTurn: result.appealTargetTurn } : {}),
    });
    return;
  }
  print(`${t("dm")} — ${t("turnHeading")} ${result.turn}`, result.narration, "success", "game", {
    kind,
    turn: result.turn,
  });
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
      ? `${t("autoUses")}: ${providerLabel(provider.provider)}/${displayModelId(provider.provider, provider.model)}. ${t("defaultPlayer")}: google/gemini-3.1-flash-lite.`
      : t("configureAuto");
    const campaign = status.game.campaign;
    const previousInspectionCampaignKey = inspectionCampaignKey;
    await switchTerminalCampaign(campaign);
    const nextInspectionCampaignKey = campaignInspectionStateKey(campaign);
    const shouldRefreshInspection = Boolean(
      activeInspectionView
      && previousInspectionCampaignKey
      && previousInspectionCampaignKey !== nextInspectionCampaignKey,
    );
    inspectionCampaignKey = nextInspectionCampaignKey;
    setStatus(
      $("#campaign-status"),
      campaign ? `${t("campaignNoun")}: ${campaign.title} · ${t("turnNoun")} ${campaign.turn} · ${campaign.status}` : t("campaignNone"),
      campaign?.status === "active" ? "ok" : campaign ? "warn" : "",
    );
    $("#game-summary").textContent = campaign
      ? `${campaign.title} — ${t("turnNoun")} ${campaign.turn}, ${campaign.timeLabel}, ${t("statusNoun")}: ${campaign.status}${status.game.pending ? ` · ${t("pendingAvailable")}` : ""}`
      : t("noCampaign");
    const gameBusy = Boolean(status.game.busy);
    const hasGame = Boolean(status.game.exists);
    const hasPendingRequest = status.game.pending?.kind === "action" || status.game.pending?.kind === "appeal";
    const canPlay = hasGame && campaign?.status === "active" && !status.game.pending && !gameBusy;
    const canEnterRecoveryCommand = hasGame && campaign?.status === "active" && hasPendingRequest && !gameBusy;
    actionAvailable = canPlay;
    pendingRecoveryAvailable = canEnterRecoveryCommand;
    $("#action").disabled = !canPlay && !canEnterRecoveryCommand;
    $("#play").disabled = !canPlay && !canEnterRecoveryCommand;
    $("#pending-help").classList.toggle("hidden", !hasPendingRequest);
    $("#archive").disabled = !hasGame || gameBusy;
    $$("#inspect-buttons button").forEach((button) => { button.disabled = !hasGame || gameBusy; });
    updatePrefillAvailability();
    $("#archive-on-confirm").disabled = !hasGame;
    if (!hasGame) $("#archive-on-confirm").checked = false;
    if (shouldRefreshInspection && hasGame) {
      await loadInspection(activeInspectionView, { record: false, showLoading: false });
    }
    const task = status.evaluationTask;
    const taskFailed = task && (task.status === "failed" || task.status === "completed_with_failures");
    setStatus($("#task-status"), task ? `${t("evaluationNoun")}: ${task.status} · ${task.runId}` : t("evaluationIdle"), task?.status === "running" ? "warn" : taskFailed ? "bad" : task ? "ok" : "");
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
    apiKey: $("#api-key").value.trim(),
  };
}

async function saveProvider() {
  const payload = providerFormPayload();
  recordCommand(`llm-dungeon configure  # provider=${payload.provider} model=${quoted(payload.model)} api-key=${payload.apiKey ? "[redacted]" : "[.env]"}`);
  const body = await api("/api/config/provider", {
    method: "PUT",
    body: JSON.stringify(payload),
  });
  $("#api-key").value = "";
  print("PROVIDER SAVED", `${providerLabel(body.config.provider)}/${displayModelId(body.config.provider, body.config.model)}\nAPI key source: ${payload.apiKey ? "session memory" : ".env"}`, "success", "provider");
  await loadProvider();
}

async function loadWorld() {
  const requestedLanguage = gameLanguage;
  const body = await api(`/api/config/world?language=${encodeURIComponent(requestedLanguage)}`);
  if (requestedLanguage !== gameLanguage || body.language !== requestedLanguage) return;
  $("#world-markdown").value = body.markdown;
  const sourceLabels = {
    default: t("profileDefault"),
    localized_override: t("profileLocalized"),
    legacy_override: t("profileLegacy"),
  };
  $("#world-profile-meta").textContent = `${body.language} · ${sourceLabels[body.source] || body.source}`;
}

async function loadPromptPreview() {
  const phase = $("#prompt-phase").value;
  const requestedLanguage = gameLanguage;
  const body = await api(`/api/config/prompts?phase=${encodeURIComponent(phase)}&language=${encodeURIComponent(requestedLanguage)}`);
  if (requestedLanguage !== gameLanguage || phase !== $("#prompt-phase").value) return;
  const output = [
    `PROMPT SUITE V${body.version} · ${body.phase}`,
    `SECTIONS: ${body.sections.join(", ") || "none"}`,
    ...(body.system ? [`\n=== SYSTEM ===\n${body.system}`] : []),
    ...(body.prompt ? [`\n=== TASK ===\n${body.prompt}`] : []),
  ];
  $("#prompt-preview").textContent = output.join("\n");
  $("#prompt-preview").dataset.loaded = "true";
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
  await switchTerminalCampaign(body.state, { openingNarration: body.openingNarration });
  currentDraft = null;
  $("#draft-controls").classList.add("hidden");
  showPanel("game");
}

function lockActionControls() {
  actionAvailable = false;
  pendingRecoveryAvailable = false;
  $("#action").disabled = true;
  $("#play").disabled = true;
  updatePrefillAvailability();
}

async function play() {
  const action = $("#action").value.trim();
  if (!action) throw new Error("Enter an action first");
  if (action === ":retry") {
    lockActionControls();
    $("#action").value = "";
    return retry();
  }
  if (action === ":discard") {
    lockActionControls();
    $("#action").value = "";
    return discardPending();
  }
  if (pendingRecoveryAvailable) throw new Error(t("pendingCommandRequired"));
  lockActionControls();
  recordCommand(`> ${action}`);
  print(t("you"), action, "normal", "game");
  $("#action").value = "";
  const result = await api("/api/game/play", { method: "POST", body: JSON.stringify({ action }) });
  if (result.kind === "question") {
    print(`${t("dm")} — ${t("answerHeading")}`, result.answer, "success", "game");
    return;
  }
  printCommittedResponse(result);
  await refreshInspectionAfterCommit(result.state);
  if (result.state.status !== "active") print(t("campaignEnded"), `${t("statusHeading")}: ${result.state.status}`, "error", "game");
}

async function retry() {
  recordCommand(":retry");
  const result = await api("/api/game/retry", { method: "POST", body: "{}" });
  printCommittedResponse(result);
  await refreshInspectionAfterCommit(result.state);
}

async function discardPending() {
  recordCommand(":discard");
  await api("/api/game/discard", { method: "POST", body: "{}" });
  print(t("pendingDiscardedHeading"), t("pendingDiscardedBody"), "success", "game");
}

function runPayload() {
  const playerProfiles = selectedProfileIds();
  if (!playerProfiles.length) throw new Error(t("selectPlayerProfileError"));
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
  selectionField.textContent = labels.length ? labels.join(", ") : t("selectProfiles");
  selectionField.title = labels.join(" → ");
  selectionField.classList.toggle("error", selected.length === 0);
  const order = $("#profile-order");
  order.classList.toggle("error", selected.length === 0);
  order.textContent = selected.length === 0
    ? t("selectProfileError")
    : selected.length === 1
      ? `${t("everySession")}: ${labels[0]}`
      : `${t("rotationOrder")}: ${labels.join(" → ")}`;
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
      `${t("autoRunHeading")} — ${sessionId}`,
      `${t("profileHeading")}: ${transcript.profile}`,
      "normal",
      "evaluations",
    );
    if (transcript.opening) {
      print(`${t("dm")} — ${t("openingHeading")}`, transcript.opening, "success", "evaluations");
    }
    for (const turn of transcript.turns) {
      const approach = String(turn.approach || "").replaceAll("_", " ").toUpperCase();
      print(`${t("you")}${approach ? ` — ${approach}` : ""}`, turn.action, "normal", "evaluations");
      if (turn.checkText) print(t("check"), turn.checkText, "normal", "evaluations");
      if (turn.narration) {
        print(`${t("dm")} — ${t("turnHeading")} ${turn.turn}`, turn.narration, "success", "evaluations");
      }
      if (turn.status === "failed") {
        print(
          `${t("turnFailedHeading")} ${turn.turn}`,
          turn.error || t("unknownTechnicalFailure"),
          "error",
          "evaluations",
        );
      }
    }
    return;
  }
  print(`${kind.toUpperCase()} — ${run.runId}${sessionId ? ` / ${sessionId}` : ""}`, body.text, "normal", "evaluations");
}

$("#language-select").addEventListener("change", () => work(t("changingLanguage"), async () => {
  const language = $("#language-select").value;
  recordCommand(`llm-dungeon language ${language}`);
  await api("/api/config/language", {
    method: "PUT",
    body: JSON.stringify({ language, applyToCurrent: true }),
  });
  applyUiLanguage(language);
  if (currentTerminalChannel() === "world") await loadWorld();
  print(t("changed"), t("changedBody"), "success", "world");
}, "world"));
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
  recordCommand(`provider.test --provider ${payload.provider} --model ${quoted(payload.model)} --api-key ${payload.apiKey ? "[redacted]" : "[.env]"}`);
  try {
    const body = await api("/api/config/provider/test", { method: "POST", body: JSON.stringify(payload) });
    providerCompatibility = { status: "ok", provider: body.provider, model: body.model, ...body.structuredOutput };
    renderProviderCompatibility();
    print(
      t("connectionSchemaOk"),
      `${body.provider}/${body.model}\n${t("connectionEnforcementLabel")}: ${t("connectionEnforcementMode")}\n${t("connectionSafetyLabel")}: ${t("connectionSafetyMode")}`,
      "success",
      "provider",
    );
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
$("#save-world").addEventListener("click", () => work("Saving world and style…", async () => {
  const language = gameLanguage;
  recordCommand(`world.set --language ${language}`);
  await api("/api/config/world", { method: "PUT", body: JSON.stringify({ language, markdown: $("#world-markdown").value }) });
  await loadWorld();
  print("WORLD & STYLE SAVED", "Changes will apply to future campaigns.", "success", "world");
}));
$("#show-prompt").addEventListener("click", () => work("Loading prompt template…", loadPromptPreview));
$("#generate-campaign").addEventListener("click", () => work("Generating campaign…", generateCampaign));
$("#regenerate-campaign").addEventListener("click", () => work("Regenerating campaign…", generateCampaign));
$("#confirm-campaign").addEventListener("click", () => work("Creating campaign…", confirmCampaign));
$("#play").addEventListener("click", () => work("The dungeon master considers the world…", play));
$("#archive").addEventListener("click", () => {
  if (!confirm(t("archiveConfirm"))) return;
  recordCommand("campaign.archive");
  work(t("archivingCampaign"), async () => {
    await api("/api/game/archive", { method: "POST", body: "{}" });
    await switchTerminalCampaign(null);
    print(t("campaignArchived"), t("campaignArchivedBody"), "success", "game");
  });
});
$("#inspect-buttons").addEventListener("click", (event) => {
  const button = event.target instanceof Element ? event.target.closest("button[data-view]") : null;
  if (button?.dataset.view) loadInspection(button.dataset.view);
});
$("#ask-generic").addEventListener("click", () => prefillAsk());
$("#appeal-generic").addEventListener("click", () => prefillAppeal());
terminal.addEventListener("click", (event) => {
  const button = event.target instanceof Element ? event.target.closest("[data-ask-turn], [data-appeal-turn]") : null;
  if (!button || button.disabled) return;
  const turn = Number(button.dataset.askTurn ?? button.dataset.appealTurn);
  if (!Number.isSafeInteger(turn) || turn < 1) return;
  if (button.dataset.askTurn) prefillAsk(turn);
  else prefillAppeal(turn);
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
