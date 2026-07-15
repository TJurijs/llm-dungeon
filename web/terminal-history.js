const TERMINAL_STORAGE_PREFIX = "llm-dungeon:web-cli-terminal:";
const TERMINAL_MAX_ENTRIES = 300;
const TERMINAL_MAX_TEXT = 50_000;
const TERMINAL_MAX_STORAGE = 750_000;
const TERMINAL_CHANNELS = new Set(["game", "campaign", "provider", "evaluations", "world"]);
const PLAYER_ACTION_TITLES = new Set(["YOU", "ВЫ"]);
const LEGACY_INSPECTION_TITLES = new Set([
  "CHARACTER",
  "INVENTORY",
  "LOCATION",
  "THREADS",
  "STORY THREADS",
  "JOURNAL",
  "ПЕРСОНАЖ",
  "ИНВЕНТАРЬ",
  "ЛОКАЦИЯ",
  "СЮЖЕТНЫЕ ЛИНИИ",
  "ЖУРНАЛ",
  "RECENT JOURNAL — RESTORED",
  "НЕДАВНИЙ ЖУРНАЛ — ВОССТАНОВЛЕН",
]);

export function terminalStorageKey(campaignId) {
  return `${TERMINAL_STORAGE_PREFIX}${campaignId ?? "no-campaign"}`;
}

export function isTerminalChannel(value) {
  return TERMINAL_CHANNELS.has(value);
}

export function normalizeTerminalEntry(value, fallbackChannel = "game") {
  if (!value || typeof value !== "object") return null;
  const mode = ["normal", "success", "error"].includes(value.mode) ? value.mode : "normal";
  const channel = isTerminalChannel(value.channel) ? value.channel : fallbackChannel;
  const kind = ["opening", "gameplay", "appeal"].includes(value.kind) ? value.kind : undefined;
  const turn = Number.isSafeInteger(value.turn) && value.turn >= 0 ? value.turn : undefined;
  const appealTargetTurn = Number.isSafeInteger(value.appealTargetTurn) && value.appealTargetTurn >= 1
    ? value.appealTargetTurn
    : undefined;
  return {
    title: String(value.title ?? "").slice(0, 500),
    text: String(value.text ?? "").slice(0, TERMINAL_MAX_TEXT),
    mode,
    channel,
    ...(kind ? { kind } : {}),
    ...(turn !== undefined ? { turn } : {}),
    ...(appealTargetTurn !== undefined ? { appealTargetTurn } : {}),
  };
}

function withLegacyGameTurnMetadata(entry) {
  if (!entry || entry.channel !== "game" || entry.kind) return entry;
  if (["CAMPAIGN BEGINS — ", "КАМПАНИЯ НАЧИНАЕТСЯ — ", "НАЧАЛО КАМПАНИИ — "]
    .some((prefix) => entry.title.startsWith(prefix))) {
    return { ...entry, kind: "opening", turn: 0 };
  }
  const match = entry.title.match(/^DUNGEON MASTER — TURN ([1-9]\d*)$/)
    ?? entry.title.match(/^МАСТЕР ПОДЗЕМЕЛИЙ — ХОД ([1-9]\d*)$/);
  if (!match) return entry;
  const turn = Number(match[1]);
  return Number.isSafeInteger(turn) ? { ...entry, kind: "gameplay", turn } : entry;
}

function isLegacyEvaluationTranscriptEntry(entry) {
  return entry.title.startsWith("TRANSCRIPT — ")
    && entry.text.trimStart().startsWith("# Self-Play Transcript:");
}

function isLegacyInspectionEntry(entry) {
  return entry.channel === "game" && LEGACY_INSPECTION_TITLES.has(entry.title);
}

export function migrateTerminalEntries(values) {
  let evaluationOpening = false;
  let evaluationTurn = false;
  return values.map((value) => {
    if (isTerminalChannel(value?.channel)) return withLegacyGameTurnMetadata(normalizeTerminalEntry(value));
    const entry = normalizeTerminalEntry(value);
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
    return withLegacyGameTurnMetadata({ ...entry, channel });
  }).filter(Boolean);
}

export function parseTerminalHistory(raw) {
  try {
    if (raw === null) return { entries: [], migrated: false };
    const parsed = JSON.parse(raw);
    const legacyArray = Array.isArray(parsed);
    const version = legacyArray ? 0 : parsed?.version;
    if (!legacyArray && ![1, 2, 3].includes(version)) {
      return { entries: [], migrated: false };
    }
    const values = legacyArray ? parsed : parsed.entries;
    const entries = Array.isArray(values)
      ? migrateTerminalEntries(values).slice(-TERMINAL_MAX_ENTRIES)
      : [];
    const visibleEntries = entries.filter((entry) =>
      !isLegacyEvaluationTranscriptEntry(entry) && !isLegacyInspectionEntry(entry));
    return {
      entries: visibleEntries,
      migrated: legacyArray || version !== 3 || visibleEntries.length !== entries.length,
    };
  } catch {
    return { entries: [], migrated: false };
  }
}

export function serializeTerminalHistory(values) {
  let entries = values.slice(-TERMINAL_MAX_ENTRIES);
  let serialized = JSON.stringify({ version: 3, entries });
  while (entries.length > 1 && serialized.length > TERMINAL_MAX_STORAGE) {
    entries = entries.slice(1);
    serialized = JSON.stringify({ version: 3, entries });
  }
  return { entries, serialized };
}

export function committedTerminalTurns(entries) {
  return new Set(entries
    .filter((entry) => entry.channel === "game"
      && ["opening", "gameplay", "appeal"].includes(entry.kind)
      && Number.isSafeInteger(entry.turn)
      && entry.turn >= 0)
    .map((entry) => entry.turn));
}

export function hasUnpairedPlayerAction(entries, action) {
  let latestCommittedIndex = -1;
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.channel === "game" && entry.kind && Number.isSafeInteger(entry.turn)) {
      latestCommittedIndex = index;
      break;
    }
  }
  return entries.slice(latestCommittedIndex + 1).some((entry) =>
    entry.channel === "game" && PLAYER_ACTION_TITLES.has(entry.title) && entry.text === action);
}
