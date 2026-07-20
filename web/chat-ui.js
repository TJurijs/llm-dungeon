import {
  normalizeTerminalEntry,
  parseTerminalHistory,
  serializeTerminalHistory,
  terminalStorageKey,
} from "./terminal-history.js";

const ACTION_COMMAND_PREFIX = /^:(?:ask|appeal)\b(?:\s+--turn\s+\d+)?\s*/i;

export function actionPrefillValue(value, kind) {
  if (kind !== "ask" && kind !== "appeal") throw new Error("Unknown action prefill kind");
  let content = String(value ?? "").trim();
  while (ACTION_COMMAND_PREFIX.test(content)) {
    content = content.replace(ACTION_COMMAND_PREFIX, "").trimStart();
  }
  return content ? `:${kind} ${content}` : `:${kind} `;
}

export class BrowserChatHistory {
  constructor(storage = globalThis.localStorage) {
    this.storage = storage;
    this.histories = new Map();
  }

  entries(campaignId) {
    if (!this.histories.has(campaignId)) {
      let parsed = { entries: [], migrated: false };
      try { parsed = parseTerminalHistory(this.storage?.getItem(terminalStorageKey(campaignId))); } catch { /* Storage can be unavailable. */ }
      this.histories.set(campaignId, parsed.entries);
      if (parsed.migrated) this.persist(campaignId);
    }
    return this.histories.get(campaignId);
  }

  append(campaignId, value) {
    const entry = normalizeTerminalEntry({ channel: "game", ...value });
    if (!entry) return null;
    this.entries(campaignId).push(entry);
    this.persist(campaignId);
    return entry;
  }

  replace(campaignId, values) {
    const entries = (Array.isArray(values) ? values : [])
      .map((value) => normalizeTerminalEntry({ channel: "game", ...value }))
      .filter(Boolean);
    this.histories.set(campaignId, entries);
    this.persist(campaignId);
    return this.histories.get(campaignId);
  }

  remove(campaignId) {
    this.histories.delete(campaignId);
    try { this.storage?.removeItem(terminalStorageKey(campaignId)); } catch { /* Storage can be unavailable. */ }
  }

  persist(campaignId) {
    const { entries, serialized } = serializeTerminalHistory(this.histories.get(campaignId) ?? []);
    this.histories.set(campaignId, entries);
    try { this.storage?.setItem(terminalStorageKey(campaignId), serialized); } catch { /* Storage can be unavailable or full. */ }
  }
}

export function chatEntryPresentation(entry) {
  const title = entry.title.toUpperCase();
  if (["YOU", "ВЫ"].includes(title)) return { type: "user", icon: "player" };
  if (title.includes("D100") || title.includes("ПРОВЕРКА")) return { type: "check", icon: "◆" };
  if (entry.mode === "error") return { type: "error", icon: "!" };
  if (entry.kind === "appeal" || title.includes("APPEAL") || title.includes("АПЕЛЛЯЦ")) return { type: "appeal", icon: "!" };
  if (title.includes("ANSWER") || title.includes("ОТВЕТ")) return { type: "question", icon: "?" };
  if (!entry.kind && entry.mode === "success") return { type: "question", icon: "?" };
  return { type: entry.kind === "opening" ? "opening" : "assistant", icon: "◆" };
}

function playerIcon() {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("focusable", "false");
  svg.setAttribute("aria-hidden", "true");
  const head = document.createElementNS(svg.namespaceURI, "circle");
  head.setAttribute("cx", "12");
  head.setAttribute("cy", "8");
  head.setAttribute("r", "3.25");
  const shoulders = document.createElementNS(svg.namespaceURI, "path");
  shoulders.setAttribute("d", "M5.5 20c.35-4.25 2.45-6.4 6.5-6.4s6.15 2.15 6.5 6.4");
  svg.append(head, shoulders);
  return svg;
}

export function generationTooltip(generation) {
  if (!generation?.provider || !generation?.model) return "";
  const model = `${generation.provider} · ${generation.model}`;
  if (!Number.isFinite(generation.costUsd)) return `${model} · cost unavailable`;
  const decimals = generation.costUsd < 0.01 ? 4 : 2;
  const cost = `$${generation.costUsd.toFixed(decimals)}`;
  return `${model} · ${generation.costBasis === "estimated" ? "≈" : ""}${cost}`;
}

function localizedEntryTitle(entry, presentation, playerName, labels) {
  if (presentation.type === "user" && playerName) return playerName;
  if (!labels) return entry.title;
  if (presentation.type === "check") return labels.check;
  if (presentation.type === "question") return labels.answerNoTurn;
  if (presentation.type === "error") return labels.error;
  if (presentation.type === "opening") return `${labels.openingHeading} · ${labels.campaignTitle}`;
  if (presentation.type === "appeal") {
    return `${labels.appealHeading}${entry.appealTargetTurn ? ` · ${labels.turn} ${entry.appealTargetTurn}` : ""}`;
  }
  if (presentation.type === "assistant" && Number.isSafeInteger(entry.turn)) {
    return `${labels.dm} · ${labels.turn} ${entry.turn}`;
  }
  return entry.title;
}

export function createChatEntry(entry, playerName, labels) {
  const presentation = chatEntryPresentation(entry);
  const article = document.createElement("article");
  article.className = `chat-entry ${presentation.type}`;
  const header = document.createElement("header");
  header.className = "chat-entry-header";
  const icon = document.createElement("span");
  icon.className = "chat-entry-icon";
  icon.setAttribute("aria-hidden", "true");
  const tooltip = generationTooltip(entry.generation);
  if (tooltip && ["opening", "assistant", "appeal", "question"].includes(presentation.type)) icon.title = tooltip;
  if (presentation.icon === "player") icon.append(playerIcon());
  else icon.textContent = presentation.icon;
  const label = document.createElement("span");
  label.textContent = localizedEntryTitle(entry, presentation, playerName, labels);
  header.append(icon, label);
  const body = document.createElement("div");
  body.className = "chat-entry-body";
  body.textContent = entry.text;
  article.append(header, body);
  return article;
}

export function createThinkingEntry(label) {
  const article = document.createElement("article");
  article.className = "chat-entry assistant thinking-entry";
  const header = document.createElement("header");
  header.className = "chat-entry-header";
  const icon = document.createElement("span");
  icon.className = "chat-entry-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = "◆";
  const title = document.createElement("span");
  title.textContent = label.dm;
  header.append(icon, title);
  const body = document.createElement("div");
  body.className = "chat-entry-body thinking-dots";
  body.textContent = label.working;
  article.append(header, body);
  return article;
}
