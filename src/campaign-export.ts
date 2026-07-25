import { languageDefinition } from "./language.js";
import type { GameState } from "./schemas.js";
import type {
  CampaignLogSnapshot,
  CampaignStartSettings,
  PlayerVisibleTurn,
} from "./types.js";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function metadataText(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replace(/([\\`*_{}\[\]#+!|])/g, "\\$1")
    .replace(/\r?\n/g, " ");
}

function storyText(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

function quote(value: string): string {
  const clean = storyText(value).replace(/\r\n/g, "\n").trim();
  return clean
    .split("\n")
    .map((line) => `> ${line || " "}`)
    .join("\n");
}

function markdownDataBlock(value: string, language = "text"): string {
  const clean = value.replace(/\r\n/g, "\n").trim();
  const longestRun = Math.max(0, ...(clean.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}${language}\n${clean}\n${fence}`;
}

function renderSetupMarkdown(state: GameState, setup: CampaignStartSettings | undefined): string {
  const copy = languageDefinition(state.language).campaignExport;
  if (!setup) return `## ${copy.campaignSetup}\n\n_${copy.setupUnavailable}_`;
  return [
    `## ${copy.campaignSetup}`,
    `### ${copy.premise}`,
    markdownDataBlock(setup.premise),
    `### ${copy.characterConcept}`,
    markdownDataBlock(setup.character),
    `### ${copy.worldStyle}`,
    markdownDataBlock(setup.worldRules, "markdown"),
    `### ${copy.language}`,
    metadataText(languageDefinition(setup.language).nativeName),
  ].join("\n\n");
}

function renderTurnMarkdown(
  state: GameState,
  playerName: string,
  entry: PlayerVisibleTurn,
): string {
  const copy = languageDefinition(state.language).campaignExport;
  if (entry.kind === "opening") {
    return [
      `### ${copy.opening}`,
      `#### ${copy.dungeonMaster}`,
      storyText(entry.narration.trim()),
    ].join("\n\n");
  }

  const appeal = entry.kind === "appeal";
  const sections = [`### ${appeal ? copy.appeal : copy.turn} ${entry.turn}`];
  if (appeal && entry.appealTargetTurn !== undefined) {
    sections.push(`**${copy.reviewedTurn}:** ${entry.appealTargetTurn}`);
  }
  sections.push(`#### ${appeal ? copy.playerAppeal : metadataText(playerName)}`, quote(entry.action));
  if (entry.checkText) sections.push(`#### ${copy.check}`, quote(entry.checkText));
  sections.push(
    `#### ${appeal ? copy.decision : copy.dungeonMaster}`,
    storyText(entry.narration.trim()),
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
  const body = turns
    .map((entry) => renderTurnMarkdown(state, snapshot.playerName, entry))
    .join("\n\n---\n\n");
  const sections = [
    `# ${metadataText(state.title)}`,
    `> ${copy.documentLabel}`,
    metadata,
    renderSetupMarkdown(state, snapshot.setup),
    `## ${copy.turnLog}`,
    body,
  ];
  return sections.filter(Boolean).join("\n\n") + "\n";
}

function inlineMarkdownHtml(value: string): string {
  return escapeHtml(value)
    .replace(/`([^`\n]+)`/g, "<code>$1</code>")
    .replace(/\*\*([^*\n]+)\*\*/g, "<strong>$1</strong>");
}

function renderSimpleMarkdownHtml(value: string): string {
  const lines = value.replace(/\r\n/g, "\n").trim().split("\n");
  const output: string[] = [];
  let paragraph: string[] = [];
  let listType: "ul" | "ol" | undefined;
  const flushParagraph = () => {
    if (!paragraph.length) return;
    output.push(`<p>${inlineMarkdownHtml(paragraph.join(" "))}</p>`);
    paragraph = [];
  };
  const closeList = () => {
    if (!listType) return;
    output.push(`</${listType}>`);
    listType = undefined;
  };

  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.+)$/.exec(line);
    const bullet = /^[-*]\s+(.+)$/.exec(line);
    const numbered = /^\d+[.)]\s+(.+)$/.exec(line);
    if (heading) {
      flushParagraph();
      closeList();
      const level = Math.min(5, heading[1]!.length + 3);
      output.push(`<h${level}>${inlineMarkdownHtml(heading[2]!)}</h${level}>`);
    } else if (bullet || numbered) {
      flushParagraph();
      const nextType = bullet ? "ul" : "ol";
      if (listType !== nextType) {
        closeList();
        listType = nextType;
        output.push(`<${listType}>`);
      }
      output.push(`<li>${inlineMarkdownHtml((bullet ?? numbered)![1]!)}</li>`);
    } else if (!line.trim()) {
      flushParagraph();
      closeList();
    } else {
      closeList();
      paragraph.push(line.trim());
    }
  }
  flushParagraph();
  closeList();
  return output.join("\n");
}

function proseHtml(value: string): string {
  return value
    .replace(/\r\n/g, "\n")
    .trim()
    .split(/\n{2,}/)
    .map((paragraph) => `<p>${escapeHtml(paragraph).replaceAll("\n", "<br>")}</p>`)
    .join("\n");
}

function chatEntryHtml(
  kind: "dm" | "player" | "check" | "appeal",
  label: string,
  text: string,
): string {
  const icons = { dm: "◆", player: "●", check: "d100", appeal: "!" } as const;
  return `<article class="entry ${kind}">
  <header><span class="icon" aria-hidden="true">${icons[kind]}</span>${escapeHtml(label)}</header>
  <div class="entry-body">${proseHtml(text)}</div>
</article>`;
}

function renderTurnHtml(snapshot: CampaignLogSnapshot, entry: PlayerVisibleTurn): string {
  const copy = languageDefinition(snapshot.state.language).campaignExport;
  if (entry.kind === "opening") {
    return chatEntryHtml("dm", copy.opening, entry.narration);
  }
  const appeal = entry.kind === "appeal";
  const entries: string[] = [];
  if (appeal && entry.appealTargetTurn !== undefined) {
    entries.push(
      `<p class="turn-marker">${escapeHtml(copy.appeal)} ${entry.turn} · ${escapeHtml(copy.reviewedTurn)} ${entry.appealTargetTurn}</p>`,
    );
  } else {
    entries.push(`<p class="turn-marker">${escapeHtml(copy.turn)} ${entry.turn}</p>`);
  }
  entries.push(
    chatEntryHtml(
      appeal ? "appeal" : "player",
      appeal ? copy.playerAppeal : snapshot.playerName,
      entry.action,
    ),
  );
  if (entry.checkText) entries.push(chatEntryHtml("check", copy.check, entry.checkText));
  entries.push(
    chatEntryHtml("dm", appeal ? copy.decision : copy.dungeonMaster, entry.narration),
  );
  return entries.join("\n");
}

function renderSetupHtml(snapshot: CampaignLogSnapshot): string {
  const copy = languageDefinition(snapshot.state.language).campaignExport;
  if (!snapshot.setup) return `<p>${escapeHtml(copy.setupUnavailable)}</p>`;
  return [
    `<section><h3>${escapeHtml(copy.premise)}</h3>${renderSimpleMarkdownHtml(snapshot.setup.premise)}</section>`,
    `<section><h3>${escapeHtml(copy.characterConcept)}</h3>${renderSimpleMarkdownHtml(snapshot.setup.character)}</section>`,
    `<section><h3>${escapeHtml(copy.worldStyle)}</h3>${renderSimpleMarkdownHtml(snapshot.setup.worldRules)}</section>`,
    `<section><h3>${escapeHtml(copy.language)}</h3><p>${escapeHtml(languageDefinition(snapshot.setup.language).nativeName)}</p></section>`,
  ].join("\n");
}

export function renderCampaignHtml(snapshot: CampaignLogSnapshot): string {
  const { state } = snapshot;
  const copy = languageDefinition(state.language).campaignExport;
  const setupButton = snapshot.setup
    ? `<button class="setup-button" type="button" onclick="document.getElementById('campaign-setup').showModal()">${escapeHtml(copy.campaignSetup)}</button>`
    : `<button class="setup-button" type="button" disabled>${escapeHtml(copy.campaignSetup)}</button>`;
  const turns = snapshot.turns.map((entry) => renderTurnHtml(snapshot, entry)).join("\n");
  return `<!doctype html>
<html lang="${escapeHtml(state.language)}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="dark">
<title>${escapeHtml(state.title)} · llm-dungeon</title>
<style>
:root{color-scheme:dark;--bg:#11120f;--surface:#1d1f1a;--raised:#282a24;--line:#3a3d34;--text:#edede5;--muted:#9fa196;--accent:#b6e36f;--amber:#e2b968;--content:820px}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at top,#23271d 0,#11120f 34rem);color:var(--text);font:15px/1.55 Inter,ui-sans-serif,system-ui,sans-serif}main{width:min(calc(100% - 2rem),var(--content));margin:auto;padding:3.5rem 0 5rem}.hero{padding:0 0 2rem;border-bottom:1px solid var(--line)}.eyebrow{margin:0 0 .35rem;color:var(--accent);font-size:.72rem;font-weight:800;letter-spacing:.13em;text-transform:uppercase}h1{margin:0;font:700 clamp(1.8rem,5vw,3rem)/1.1 ui-serif,Georgia,serif}.meta{display:flex;flex-wrap:wrap;gap:.5rem;margin:1rem 0}.meta span{padding:.28rem .55rem;border:1px solid var(--line);border-radius:999px;color:var(--muted);font-size:.75rem}.setup-button,dialog button{min-height:40px;padding:.5rem .8rem;border:1px solid #759548;border-radius:9px;background:#b6e36f;color:#17200d;font-weight:750;cursor:pointer}.setup-button:disabled{opacity:.45;cursor:not-allowed}.log-title{margin:2.2rem 0 1.7rem;font-size:1.1rem}.turn-marker{margin:2rem 0 .8rem;color:var(--muted);font-size:.72rem;font-weight:800;letter-spacing:.08em;text-transform:uppercase}.entry{margin:0 0 1.55rem}.entry header{display:flex;align-items:center;gap:.55rem;margin-bottom:.42rem;color:var(--muted);font-size:.76rem;font-weight:750}.icon{width:26px;height:26px;display:grid;place-items:center;border:1px solid var(--line);border-radius:7px;background:var(--surface);color:var(--accent);font-size:.62rem}.entry-body{max-width:76ch;padding-left:2.15rem;font:16px/1.68 ui-serif,Georgia,Cambria,serif}.entry-body p{margin:.35rem 0}.player,.appeal{display:flex;flex-direction:column;align-items:flex-end}.player .entry-body,.appeal .entry-body{max-width:min(82%,680px);padding:.72rem .9rem;border:1px solid #41443b;border-radius:14px 14px 4px 14px;background:var(--raised);font:inherit}.appeal .icon{color:var(--amber)}.check .entry-body{max-width:none;padding:.68rem .8rem;border:1px solid var(--line);border-left:3px solid var(--amber);border-radius:9px;background:var(--surface);color:#ded2ba;font:.82rem/1.55 ui-monospace,monospace}.check .icon{color:var(--amber)}dialog{width:min(720px,calc(100% - 2rem));max-height:82vh;padding:0;overflow:hidden;border:1px solid var(--line);border-radius:14px;background:var(--surface);color:var(--text);box-shadow:0 24px 80px #000b}dialog::backdrop{background:#060705d9;backdrop-filter:blur(3px)}.dialog-header{position:sticky;top:0;display:flex;align-items:center;justify-content:space-between;padding:1rem 1.2rem;border-bottom:1px solid var(--line);background:var(--surface)}.dialog-header h2{margin:0}.dialog-body{max-height:calc(82vh - 74px);padding:1.2rem;overflow:auto}.dialog-body section+section{margin-top:1.25rem;padding-top:1.25rem;border-top:1px solid var(--line)}.dialog-body h3{margin:0 0 .55rem;font-size:1rem}.dialog-body h4,.dialog-body h5{margin:1rem 0 .4rem;color:#d9e6c5}.dialog-body p{margin:.4rem 0;color:#d8d9d0}.dialog-body li{margin:.38rem 0}.dialog-body strong{color:#f2f4e9}.close-button{min-width:74px;background:transparent;color:var(--text);border-color:var(--line)}@media(max-width:620px){main{padding-top:2rem}.entry-body{padding-left:.5rem}.player .entry-body,.appeal .entry-body{max-width:94%}}
</style>
</head>
<body>
<main>
  <header class="hero">
    <p class="eyebrow">llm-dungeon</p>
    <h1>${escapeHtml(state.title)}</h1>
    <div class="meta">
      <span>${escapeHtml(copy.status)}: ${escapeHtml(copy.statuses[state.status])}</span>
      <span>${escapeHtml(copy.turnCount)}: ${state.turn}</span>
      <span>${escapeHtml(copy.inWorldTime)}: ${escapeHtml(state.timeLabel)}</span>
    </div>
    ${setupButton}
  </header>
  <h2 class="log-title">${escapeHtml(copy.turnLog)}</h2>
  ${turns}
</main>
<dialog id="campaign-setup">
  <header class="dialog-header"><h2>${escapeHtml(copy.campaignSetup)}</h2><form method="dialog"><button class="close-button">${escapeHtml(copy.close)}</button></form></header>
  <div class="dialog-body">${renderSetupHtml(snapshot)}</div>
</dialog>
</body>
</html>\n`;
}

function campaignFilename(title: string, extension: "md" | "html"): string {
  const safeTitle = Array.from(
    title
      .normalize("NFKC")
      .replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-")
      .replace(/\s+/g, " ")
      .replace(/[. ]+$/g, "")
      .trim(),
  )
    .slice(0, 80)
    .join("");
  return `${safeTitle || "llm-dungeon-campaign"}.${extension}`;
}

export function campaignMarkdownFilename(title: string): string {
  return campaignFilename(title, "md");
}

export function campaignHtmlFilename(title: string): string {
  return campaignFilename(title, "html");
}
