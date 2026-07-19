const TERMINAL_STORAGE_PREFIX = "llm-dungeon:web-terminal:";
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

export function campaignApiPath(campaignId, action = "") {
  if (typeof campaignId !== "string" || !campaignId.trim()) throw new Error("Campaign ID is required");
  const suffix = String(action).replace(/^\/+/, "");
  return `/api/campaigns/${encodeURIComponent(campaignId)}${suffix ? `/${suffix}` : ""}`;
}

export function sortCampaigns(campaigns) {
  return [...(Array.isArray(campaigns) ? campaigns : [])].sort((left, right) => {
    const archived = Number(Boolean(left?.archived)) - Number(Boolean(right?.archived));
    if (archived) return archived;
    return String(right?.updatedAt ?? "").localeCompare(String(left?.updatedAt ?? ""));
  });
}

export function chooseCampaignId(campaigns, preferredId) {
  const available = sortCampaigns(campaigns);
  if (available.some((campaign) => campaign?.campaignId === preferredId)) return preferredId;
  return available.find((campaign) => !campaign?.archived)?.campaignId
    ?? available[0]?.campaignId
    ?? null;
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
  const sourceGeneration = value.generation;
  const generation = sourceGeneration && typeof sourceGeneration === "object"
    && typeof sourceGeneration.provider === "string" && sourceGeneration.provider.trim()
    && typeof sourceGeneration.model === "string" && sourceGeneration.model.trim()
    ? {
        provider: sourceGeneration.provider.slice(0, 100),
        model: sourceGeneration.model.slice(0, 300),
        ...(Number.isFinite(sourceGeneration.costUsd) && sourceGeneration.costUsd >= 0
          ? { costUsd: sourceGeneration.costUsd }
          : {}),
        ...(["exact", "estimated"].includes(sourceGeneration.costBasis)
          ? { costBasis: sourceGeneration.costBasis }
          : {}),
      }
    : undefined;
  return {
    title: String(value.title ?? "").slice(0, 500),
    text: String(value.text ?? "").slice(0, TERMINAL_MAX_TEXT),
    mode,
    channel,
    ...(kind ? { kind } : {}),
    ...(turn !== undefined ? { turn } : {}),
    ...(appealTargetTurn !== undefined ? { appealTargetTurn } : {}),
    ...(generation ? { generation } : {}),
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

function committedEntryIdentity(entry) {
  return entry?.channel === "game"
    && ["opening", "gameplay", "appeal"].includes(entry.kind)
    && Number.isSafeInteger(entry.turn)
    ? `${entry.kind}:${entry.turn}`
    : null;
}

function normalizedTitle(entry) {
  return String(entry?.title ?? "").trim().toUpperCase();
}

function isPlayerEntry(entry) {
  return entry?.channel === "game"
    && !entry.kind
    && PLAYER_ACTION_TITLES.has(normalizedTitle(entry));
}

function isCheckEntry(entry) {
  const title = normalizedTitle(entry);
  return entry?.channel === "game"
    && !entry.kind
    && entry.mode === "normal"
    && (title.includes("D100") || title.includes("ПРОВЕРКА"));
}

function sameProjectedEntry(authoritative, existing) {
  const authoritativeCommit = committedEntryIdentity(authoritative);
  const existingCommit = committedEntryIdentity(existing);
  if (authoritativeCommit || existingCommit) return authoritativeCommit === existingCommit;
  if (isPlayerEntry(authoritative) && isPlayerEntry(existing)) {
    return authoritative.text === existing.text;
  }
  if (isCheckEntry(authoritative) && isCheckEntry(existing)) {
    return authoritative.text === existing.text;
  }
  return authoritative?.channel === existing?.channel
    && authoritative?.kind === existing?.kind
    && authoritative?.turn === existing?.turn
    && authoritative?.appealTargetTurn === existing?.appealTargetTurn
    && authoritative?.mode === existing?.mode
    && authoritative?.title === existing?.title
    && authoritative?.text === existing?.text;
}

function localOnlyEntryFlags(existing) {
  const flags = new Uint8Array(existing.length);
  let lastCommittedIndex = -1;
  for (let index = 0; index < existing.length; index += 1) {
    if (committedEntryIdentity(existing[index])) lastCommittedIndex = index;
  }

  for (let index = 0; index < existing.length; index += 1) {
    const entry = existing[index];
    if (entry?.channel !== "game" || entry.kind) continue;
    const localOutcome = entry.mode === "error" || entry.mode === "success";
    const pendingPlayerAction = index > lastCommittedIndex && isPlayerEntry(entry);
    if (!localOutcome && !pendingPlayerAction) continue;
    flags[index] = 1;

    if (!localOutcome) continue;
    for (let candidate = index - 1; candidate >= 0; candidate -= 1) {
      if (committedEntryIdentity(existing[candidate])) break;
      if (isPlayerEntry(existing[candidate])) {
        flags[candidate] = 1;
        break;
      }
    }
  }
  return flags;
}

/**
 * Uses the complete persisted transcript as the ordering authority while
 * retaining browser-only questions, errors, and the current pending action.
 * The result is chronological before storage limits remove its oldest entries.
 */
export function mergeAuthoritativeTerminalEntries(authoritativeValues, existingValues) {
  const authoritative = Array.isArray(authoritativeValues) ? authoritativeValues : [];
  const existing = Array.isArray(existingValues) ? existingValues : [];
  if (!existing.length) return [...authoritative];
  if (!authoritative.length) {
    const localFlags = localOnlyEntryFlags(existing);
    return existing.filter((_, index) => localFlags[index]);
  }

  const localFlags = localOnlyEntryFlags(existing);
  const matches = Array.from(
    { length: authoritative.length + 1 },
    () => new Uint32Array(existing.length + 1),
  );
  for (let authoritativeIndex = authoritative.length - 1; authoritativeIndex >= 0; authoritativeIndex -= 1) {
    for (let existingIndex = existing.length - 1; existingIndex >= 0; existingIndex -= 1) {
      matches[authoritativeIndex][existingIndex] = sameProjectedEntry(
        authoritative[authoritativeIndex],
        existing[existingIndex],
      )
        ? matches[authoritativeIndex + 1][existingIndex + 1] + 1
        : Math.max(
          matches[authoritativeIndex + 1][existingIndex],
          matches[authoritativeIndex][existingIndex + 1],
        );
    }
  }

  const merged = [];
  let authoritativeIndex = 0;
  let existingIndex = 0;
  while (authoritativeIndex < authoritative.length && existingIndex < existing.length) {
    if (sameProjectedEntry(authoritative[authoritativeIndex], existing[existingIndex])) {
      merged.push(authoritative[authoritativeIndex]);
      authoritativeIndex += 1;
      existingIndex += 1;
    } else if (matches[authoritativeIndex + 1][existingIndex]
      > matches[authoritativeIndex][existingIndex + 1]) {
      merged.push(authoritative[authoritativeIndex]);
      authoritativeIndex += 1;
    } else {
      if (localFlags[existingIndex]) merged.push(existing[existingIndex]);
      existingIndex += 1;
    }
  }
  merged.push(...authoritative.slice(authoritativeIndex));
  for (; existingIndex < existing.length; existingIndex += 1) {
    if (localFlags[existingIndex]) merged.push(existing[existingIndex]);
  }
  return merged;
}
