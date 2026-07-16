import { languageDefinition } from "./language.js";
import type { GameState } from "./schemas.js";
import type { CampaignLogSnapshot, PlayerVisibleTurn } from "./types.js";

function metadataText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/([\\`*_{}\[\]#+!|])/g, "\\$1")
    .replace(/\r?\n/g, " ");
}

function storyText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function quote(value: string): string {
  const clean = storyText(value).replace(/\r\n/g, "\n").trim();
  return clean.split("\n").map((line) => `> ${line || " "}`).join("\n");
}

function renderTurn(state: GameState, entry: PlayerVisibleTurn): string {
  const copy = languageDefinition(state.language).campaignExport;
  if (entry.kind === "opening") {
    return [
      `## ${copy.opening}`,
      `### ${copy.dungeonMaster}`,
      storyText(entry.narration.trim()),
      `**${copy.summary}:** ${metadataText(entry.summary.trim())}`,
    ].join("\n\n");
  }

  const appeal = entry.kind === "appeal";
  const sections = [`## ${appeal ? copy.appeal : copy.turn} ${entry.turn}`];
  if (appeal && entry.appealTargetTurn !== undefined) {
    sections.push(`**${copy.reviewedTurn}:** ${entry.appealTargetTurn}`);
  }
  sections.push(`### ${appeal ? copy.playerAppeal : copy.player}`, quote(entry.action));
  if (entry.checkText) sections.push(`### ${copy.check}`, quote(entry.checkText));
  sections.push(
    `### ${appeal ? copy.decision : copy.dungeonMaster}`,
    storyText(entry.narration.trim()),
    `**${copy.summary}:** ${metadataText(entry.summary.trim())}`,
  );
  return sections.join("\n\n");
}

export function renderCampaignMarkdown(snapshot: CampaignLogSnapshot): string {
  const { state, turns } = snapshot;
  const copy = languageDefinition(state.language).campaignExport;
  const metadata = [
    `- **${copy.status}:** ${copy.statuses[state.status]}`,
    `- **${copy.turnCount}:** ${state.turn}`,
    `- **${copy.inWorldTime}:** ${metadataText(state.timeLabel)}`,
    `- **${copy.updated}:** ${state.updatedAt}`,
  ].join("\n");
  const body = turns.map((entry) => renderTurn(state, entry)).join("\n\n---\n\n");
  const header = [`# ${metadataText(state.title)}`, `> ${copy.documentLabel}`, metadata].join("\n\n");
  return [header, body].filter(Boolean).join("\n\n") + "\n";
}

export function campaignMarkdownFilename(title: string): string {
  const safeTitle = Array.from(title
    .normalize("NFKC")
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
    .replace(/\s+/g, " ")
    .replace(/[. ]+$/g, "")
    .trim())
    .slice(0, 80)
    .join("");
  return `${safeTitle || "llm-dungeon-campaign"}.md`;
}
