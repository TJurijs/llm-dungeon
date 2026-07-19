import matter from "gray-matter";
import {
  ChronicleEventSchema,
  EntitySchema,
  StateOperationSchema,
  ThreadSchema,
  type ChronicleEvent,
  type Entity,
  type Fact,
  type StateOperation,
  type Thread,
} from "../schemas.js";
import type { CommittedTurn, PlayerVisibleTurn, TurnKind } from "../types.js";
import { CheckResultSchema, formatCheck, type CheckResult } from "../mechanics.js";
import { DEFAULT_LANGUAGE, type LanguageCode } from "../language.js";
import { UsageSchema, type Usage } from "../usage.js";

const SECTION_HEADINGS: Record<Fact["section"], string> = {
  established: "Established Facts",
  secrets: "Secrets",
  knowledge: "Player Knowledge",
  beliefs: "Beliefs and Rumors",
  intentions: "Intentions",
  history: "History",
};

const CONTENT_CODEC = "escaped-markdown";
const EMPTY_DESCRIPTION = "_No description recorded._";
const INACTIVE_FACT_MARKER = /^  <!-- inactive-section: (established|secrets|knowledge|beliefs|intentions|history) -->$/;
const PRIVATE_FACT_SECTIONS = new Set<Fact["section"]>(["secrets", "beliefs", "intentions"]);

interface TaggedEntry {
  id: string;
  text: string;
  inactiveSection?: Fact["section"];
}

export interface TurnOperationLedger {
  turn: number;
  kind: TurnKind;
  operations: StateOperation[];
}

export interface TurnGenerationMetadata {
  turn: number;
  provider: string;
  model: string;
  usage?: Usage;
}

export function entityFilename(id: string): string {
  // `@` is outside SafeIdSchema, so this mapping is injective and reversible.
  return id.replace(":", "@") + ".md";
}

function stripLeadingLineBreak(value: string): string {
  if (value.startsWith("\r\n")) return value.slice(2);
  if (value.startsWith("\n")) return value.slice(1);
  return value;
}

function stripTrailingLineBreak(value: string): string {
  if (value.endsWith("\r\n")) return value.slice(0, -2);
  if (value.endsWith("\n")) return value.slice(0, -1);
  return value;
}

/**
 * Read one generated level-two section without trimming its payload. Generated
 * documents put one framing line break on either side of section content; only
 * those framing breaks are removed so leading/trailing breaks in the actual
 * value remain reversible.
 */
function extractSection(body: string, heading: string, occurrence: "first" | "last" = "first"): string {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const matches = [...body.matchAll(new RegExp(`(?:^|\\n)## ${escaped}\\r?\\n`, "g"))];
  const match = occurrence === "last" ? matches.at(-1) : matches[0];
  if (!match || match.index === undefined) return "";
  const start = match.index + match[0].length;
  const nextHeading = /\n## [^\r\n]+\r?\n/g;
  nextHeading.lastIndex = start;
  const next = nextHeading.exec(body);
  const raw = body.slice(start, next?.index ?? body.length);
  return stripTrailingLineBreak(stripLeadingLineBreak(raw));
}

function hasSection(body: string, heading: string): boolean {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|\\n)## ${escaped}\\r?\\n`).test(body);
}

function encodeSectionText(value: string, escapeEmptyDescription = false): string {
  return value.split("\n").map((line) => {
    if (line.startsWith("\\") || line.startsWith("## ") || (escapeEmptyDescription && line === EMPTY_DESCRIPTION)) {
      return `\\${line}`;
    }
    return line;
  }).join("\n");
}

function decodeSectionText(value: string, encoded: boolean): string {
  if (!encoded) return value;
  return value.split("\n").map((line) => {
    if (line.startsWith("\\\\") || line.startsWith("\\## ") || line === `\\${EMPTY_DESCRIPTION}`) {
      return line.slice(1);
    }
    return line;
  }).join("\n");
}

function storedSectionText(body: string, heading: string, encoded: boolean): string {
  const value = extractSection(body, heading);
  return decodeSectionText(encoded ? value : value.trim(), encoded);
}

function renderTaggedEntry(entry: TaggedEntry): string {
  if (entry.inactiveSection) {
    const body = entry.text.split("\n").map((line) => `  >${line ? ` ${line}` : ""}`).join("\n");
    return `- [${entry.id}]\n  <!-- inactive-section: ${entry.inactiveSection} -->\n${body}`;
  }
  if (!entry.text.includes("\n")) return `- [${entry.id}] ${entry.text}`;
  const body = entry.text.split("\n").map((line) => `  >${line ? ` ${line}` : ""}`).join("\n");
  return `- [${entry.id}]\n${body}`;
}

/** Parse both the current continuation format and the original plain bullets. */
function parseTaggedLines(value: string, allowInactiveMetadata = false): TaggedEntry[] {
  const entries: TaggedEntry[] = [];
  let current: { id: string; lines: string[]; inactiveSection?: Fact["section"] } | undefined;
  const flush = (): void => {
    if (!current) return;
    entries.push({
      id: current.id,
      text: current.lines.join("\n"),
      ...(current.inactiveSection ? { inactiveSection: current.inactiveSection } : {}),
    });
    current = undefined;
  };

  for (const line of value.split("\n")) {
    const tagged = line.match(/^-\s+\[([^\]]+)](?:\s(.*))?$/)
      ?? line.match(/^\s+-\s+\[([^\]]+)](?:\s(.*))?$/);
    if (tagged?.[1]) {
      flush();
      current = { id: tagged[1], lines: tagged[2] === undefined ? [] : [tagged[2]] };
      continue;
    }
    if (!current) continue;
    const inactive = allowInactiveMetadata
      ? line.match(INACTIVE_FACT_MARKER)?.[1] as Fact["section"] | undefined
      : undefined;
    if (inactive) {
      current.inactiveSection = inactive;
      continue;
    }
    const continuation = line.match(/^  >(?: (.*))?$/);
    if (continuation) {
      current.lines.push(continuation[1] ?? "");
      continue;
    }
    // The original renderer wrote multiline values as unindented continuation
    // lines. Retaining them here recovers those files without changing their
    // one-line bullet behavior.
    current.lines.push(line);
  }
  flush();
  return entries;
}

export function renderEntity(entity: Entity, includePrivate = true): string {
  const data = {
    contentCodec: CONTENT_CODEC,
    id: entity.id,
    kind: entity.kind,
    name: entity.name,
    status: entity.status,
    ...(entity.location ? { location: entity.location } : {}),
    tags: entity.tags,
    updatedTurn: entity.updatedTurn,
    traits: entity.traits,
    conditions: entity.conditions,
    inventory: entity.inventory,
  };
  const sections = (Object.entries(SECTION_HEADINGS) as Array<[Fact["section"], string]>)
    .filter(([section]) => includePrivate || !PRIVATE_FACT_SECTIONS.has(section))
    .map(([section, heading]) => {
      const active = entity.facts
        .filter((fact) => fact.section === section && fact.active)
        .map((fact) => renderTaggedEntry({ id: fact.id, text: fact.text }));
      const inactive = section === "history"
        ? entity.facts
            .filter((fact) => !fact.active && (includePrivate || !PRIVATE_FACT_SECTIONS.has(fact.section)))
            .map((fact) => renderTaggedEntry({ id: fact.id, text: fact.text, inactiveSection: fact.section }))
        : [];
      const lines = [...active, ...inactive];
      return `## ${heading}\n\n${lines.join("\n") || "_None._"}`;
    });
  const relationships = entity.relationships.map(
    (relationship) => renderTaggedEntry({ id: relationship.targetId, text: relationship.summary }),
  );
  const body = [
    `# ${encodeSectionText(entity.name)}`,
    "## Description",
    entity.description ? encodeSectionText(entity.description, true) : EMPTY_DESCRIPTION,
    ...sections,
    "## Relationships",
    relationships.join("\n") || "_None._",
  ].join("\n\n");
  return matter.stringify(`${body}\n`, data);
}

export function parseEntity(content: string, requireStructuredMetadata = false): Entity {
  const parsed = matter(content);
  const encoded = parsed.data.contentCodec === CONTENT_CODEC;
  if (requireStructuredMetadata) {
    if (!encoded) throw new Error(`Entity document must use contentCodec ${CONTENT_CODEC}`);
    for (const key of [
      "contentCodec",
      "id",
      "kind",
      "name",
      "status",
      "tags",
      "updatedTurn",
      "traits",
      "conditions",
      "inventory",
    ]) {
      if (!Object.prototype.hasOwnProperty.call(parsed.data, key)) {
        throw new Error(`Entity document is missing structured ${key} metadata`);
      }
    }
    for (const heading of [
      "Description",
      ...Object.values(SECTION_HEADINGS),
      "Relationships",
    ]) {
      if (!hasSection(parsed.content, heading)) {
        throw new Error(`Entity document is missing generated ${heading} section`);
      }
    }
  }
  const facts: Fact[] = [];
  for (const [section, heading] of Object.entries(SECTION_HEADINGS) as Array<[Fact["section"], string]>) {
    const sectionText = extractSection(parsed.content, heading);
    facts.push(...parseTaggedLines(encoded ? sectionText : sectionText.trim(), encoded).map((fact) => ({
      id: fact.id,
      text: fact.text,
      section: fact.inactiveSection ?? section,
      active: fact.inactiveSection === undefined,
    })));
  }
  const relationshipsText = extractSection(parsed.content, "Relationships");
  const relationships = parseTaggedLines(encoded ? relationshipsText : relationshipsText.trim()).map(
    (relationship) => ({ targetId: relationship.id, summary: relationship.text }),
  );
  const encodedDescription = encoded
    ? extractSection(parsed.content, "Description")
    : extractSection(parsed.content, "Description").trim();
  const description = encodedDescription === EMPTY_DESCRIPTION
    ? ""
    : decodeSectionText(encodedDescription, encoded);
  return EntitySchema.parse({
    ...parsed.data,
    description,
    facts,
    relationships,
    traits: requireStructuredMetadata ? parsed.data.traits : parsed.data.traits ?? [],
    conditions: requireStructuredMetadata ? parsed.data.conditions : parsed.data.conditions ?? [],
    inventory: requireStructuredMetadata ? parsed.data.inventory : parsed.data.inventory ?? [],
    tags: requireStructuredMetadata ? parsed.data.tags : parsed.data.tags ?? [],
  });
}

export function renderThreads(threads: Thread[]): string {
  const groups = (["active", "resolved", "failed"] as const).map((status) => {
    const lines = threads
      .filter((thread) => thread.status === status)
      .map((thread) => `- [${thread.id}] **${thread.title}** — ${thread.summary}`);
    return `## ${status[0]!.toUpperCase()}${status.slice(1)}\n\n${lines.join("\n") || "_None._"}`;
  });
  return matter.stringify(`# Story Threads\n\n${groups.join("\n\n")}\n`, { threads });
}

export function parseThreads(content: string, requireStructuredMetadata = false): Thread[] {
  const document = matter(content);
  const hasStructuredMetadata = Object.prototype.hasOwnProperty.call(document.data, "threads");
  if (requireStructuredMetadata && !hasStructuredMetadata) {
    throw new Error("Threads document is missing structured thread metadata");
  }
  return ThreadSchema.array().parse(
    requireStructuredMetadata ? document.data.threads : document.data.threads ?? [],
  );
}

export function renderChronicle(events: ChronicleEvent[]): string {
  const lines = events.map((event) => `- **Turn ${event.turn}:** ${event.text} <!-- ${event.id} -->`);
  return matter.stringify(`# Chronicle\n\n${lines.join("\n") || "_No major events yet._"}\n`, { events });
}

export function parseChronicle(content: string, requireStructuredMetadata = false): ChronicleEvent[] {
  const document = matter(content);
  const hasStructuredMetadata = Object.prototype.hasOwnProperty.call(document.data, "events");
  if (requireStructuredMetadata && !hasStructuredMetadata) {
    throw new Error("Chronicle document is missing structured event metadata");
  }
  return ChronicleEventSchema.array().parse(
    requireStructuredMetadata ? document.data.events : document.data.events ?? [],
  );
}

export function renderThreadsForContext(threads: Thread[]): string {
  return threads.length
    ? threads.map((thread) => `- [${thread.id}] (${thread.status}) ${thread.title}: ${thread.summary}`).join("\n")
    : "_None._";
}

export function renderChronicleForContext(events: ChronicleEvent[]): string {
  return events.length
    ? events.map((event) => `- Turn ${event.turn} [${event.id}]: ${event.text}`).join("\n")
    : "_No major events yet._";
}

export function compactTurnHistory(logs: string[], fullNarrationCount = 1): string {
  return logs.map((log, index) => {
    const parsed = matter(log);
    const turn = typeof parsed.data.turn === "number" ? parsed.data.turn : "?";
    const kind = turnKind(parsed.data.turn, parsed.data.turnKind);
    const encoded = parsed.data.contentCodec === CONTENT_CODEC;
    const action = storedSectionText(parsed.content, "Player Action", encoded);
    const summary = storedSectionText(parsed.content, "Summary", encoded);
    const narration = storedSectionText(parsed.content, "Narration", encoded);
    const includeNarration = index >= logs.length - fullNarrationCount;
    if (kind === "appeal") {
      return [
        `### Administrative Appeal ${turn}`,
        `Appeal request: ${action}`,
        ...(includeNarration ? [`Decision explanation:\n${narration}`] : []),
        `Administrative decision summary: ${summary || narration}`,
        "This append-only correction does not advance in-world time and is not a new fictional event.",
      ].join("\n\n");
    }
    return [
      `### Turn ${turn}`,
      `Action: ${action}`,
      ...(includeNarration ? [`Immediate narration:\n${narration}`] : []),
      `Durable outcome summary: ${summary || narration}`,
    ].join("\n\n");
  }).join("\n\n---\n\n");
}

function turnKind(turn: unknown, value: unknown): TurnKind {
  if (value === undefined) return turn === 0 ? "opening" : "gameplay";
  if (value === "opening" || value === "gameplay" || value === "appeal") return value;
  throw new Error("Turn log has an invalid turn kind");
}

export function parseTurnOperations(log: string): StateOperation[] {
  const parsed = matter(log);
  // The generated operations block is the final State Operations section. An
  // older unescaped action may contain an earlier lookalike heading; selecting
  // the final section keeps those existing logs recoverable and non-blocking.
  const section = extractSection(parsed.content, "State Operations", "last").trim();
  const fenced = section.match(/^```json\s*([\s\S]*?)\s*```$/);
  if (!fenced?.[1]) throw new Error("Turn log is missing its structured state operations");
  return StateOperationSchema.array().parse(JSON.parse(fenced[1]));
}

/** Decode the private, application-locked check payload for recovery/auditing. */
export function parseTurnCheck(log: string): CheckResult | undefined {
  const parsed = matter(log);
  const section = extractSection(parsed.content, "Check").trim();
  if (section === "_No check._") return undefined;
  const fenced = section.match(/^```json\s*([\s\S]*?)\s*```$/);
  if (!fenced?.[1]) throw new Error("Turn log has invalid structured check metadata");
  return CheckResultSchema.parse(JSON.parse(fenced[1]));
}

/** Decode private provider usage metadata without exposing narrative or operations. */
export function parseTurnGenerationMetadata(log: string): TurnGenerationMetadata {
  const parsed = matter(log);
  if (!Number.isInteger(parsed.data.turn) || parsed.data.turn < 0) {
    throw new Error("Turn log is missing a valid turn number");
  }
  const provider = typeof parsed.data.provider === "string" && parsed.data.provider
    ? parsed.data.provider
    : "unknown";
  const model = typeof parsed.data.model === "string" && parsed.data.model
    ? parsed.data.model
    : "unknown";
  const parsedUsage = UsageSchema.safeParse(parsed.data.usage);
  const usage = parsedUsage.success ? parsedUsage.data : undefined;
  return {
    turn: parsed.data.turn as number,
    provider,
    model,
    ...(usage ? { usage } : {}),
  };
}

/** Decode the private operation ledger metadata needed by deterministic state selection. */
export function parseTurnOperationLedger(log: string): TurnOperationLedger {
  const parsed = matter(log);
  if (!Number.isInteger(parsed.data.turn) || parsed.data.turn < 0) {
    throw new Error("Turn log is missing a valid turn number");
  }
  const turn = parsed.data.turn as number;
  return {
    turn,
    kind: turnKind(turn, parsed.data.turnKind),
    operations: parseTurnOperations(log),
  };
}

/**
 * Validate a newly prepared durable turn log without tightening legacy reads.
 * Pending commits are generated by renderTurnLog(), so every narrative section
 * and the complete private check payload must survive before any write begins.
 */
export function validatePreparedTurnLog(log: string): TurnOperationLedger {
  const parsed = matter(log);
  if (!Number.isInteger(parsed.data.turn) || parsed.data.turn < 0) {
    throw new Error("Prepared turn log is missing a valid turn number");
  }
  const turn = parsed.data.turn as number;
  const kind = turnKind(turn, parsed.data.turnKind);
  if ((turn === 0) !== (kind === "opening")) {
    throw new Error("Only turn zero may be an opening turn");
  }
  const appealTargetTurn = parsed.data.appealTargetTurn;
  if (appealTargetTurn !== undefined
    && (!Number.isInteger(appealTargetTurn)
      || appealTargetTurn < 1
      || appealTargetTurn >= turn
      || kind !== "appeal")) {
    throw new Error("Prepared turn log has invalid appeal target metadata");
  }

  const encoded = parsed.data.contentCodec === CONTENT_CODEC;
  for (const heading of ["Player Action", "Narration", "Summary"] as const) {
    if (!storedSectionText(parsed.content, heading, encoded).length) {
      throw new Error(`Prepared turn log is missing nonempty ${heading}`);
    }
  }

  const checkSection = extractSection(parsed.content, "Check").trim();
  if (!checkSection) throw new Error("Prepared turn log is missing its Check section");
  if (checkSection !== "_No check._") {
    parseTurnCheck(log);
    if (kind === "appeal") throw new Error("An appeal turn cannot contain a check");
  }

  return { turn, kind, operations: parseTurnOperations(log) };
}

/** Decode only player-visible turn history, excluding provider metadata and state operations. */
export function parsePlayerVisibleTurn(log: string, language: LanguageCode = DEFAULT_LANGUAGE): PlayerVisibleTurn {
  const parsed = matter(log);
  const encoded = parsed.data.contentCodec === CONTENT_CODEC;
  if (!Number.isInteger(parsed.data.turn) || parsed.data.turn < 0) {
    throw new Error("Turn log is missing a valid turn number");
  }
  const turn = parsed.data.turn as number;
  const kind = turnKind(turn, parsed.data.turnKind);
  const appealTargetTurn = parsed.data.appealTargetTurn;
  if (appealTargetTurn !== undefined
    && (!Number.isInteger(appealTargetTurn) || appealTargetTurn < 1 || kind !== "appeal")) {
    throw new Error("Turn log has invalid appeal target metadata");
  }
  const action = storedSectionText(parsed.content, "Player Action", encoded);
  const checkSection = extractSection(parsed.content, "Check").trim();
  let check = "";
  const fencedCheck = checkSection.match(/^```json\s*([\s\S]*?)\s*```$/);
  if (fencedCheck?.[1]) {
    try {
      check = formatCheck(CheckResultSchema.parse(JSON.parse(fencedCheck[1])), language);
    } catch {
      // Corrupt or older private check metadata is never echoed to a player.
    }
  }
  const narration = storedSectionText(parsed.content, "Narration", encoded);
  const summary = storedSectionText(parsed.content, "Summary", encoded);
  return {
    turn,
    kind,
    ...(appealTargetTurn === undefined ? {} : { appealTargetTurn }),
    action,
    narration,
    summary,
    ...(check ? { checkText: check } : {}),
  };
}

export function renderContextEntities(entities: Entity[], mandatoryIds: Set<string>, budget: number): string {
  const included: string[] = [];
  const omitted: string[] = [];
  let used = 0;
  for (const entity of entities) {
    const rendered = renderEntity(entity, true);
    if (mandatoryIds.has(entity.id) || used + rendered.length <= budget) {
      included.push(rendered);
      used += rendered.length;
    } else {
      omitted.push(`[${entity.id}] ${entity.name}`);
    }
  }
  if (omitted.length) {
    included.push(`CONTEXT BUDGET NOTE\n${omitted.length} lower-priority linked entities were omitted from this prompt view: ${omitted.join(", ")}. Their Markdown state remains intact.`);
  }
  return included.join("\n\n---\n\n");
}

export function renderTurnLog(turn: number, committed: CommittedTurn): string {
  const kind = committed.kind ?? (turn === 0 ? "opening" : "gameplay");
  if (kind === "opening" && turn !== 0) throw new Error("Only turn zero may be an opening turn");
  if (kind === "appeal" && committed.check) throw new Error("An appeal cannot contain a check");
  if (committed.appealTargetTurn !== undefined
    && (!Number.isInteger(committed.appealTargetTurn)
      || committed.appealTargetTurn < 1
      || committed.appealTargetTurn >= turn)) {
    throw new Error("An appeal target must reference an earlier committed turn");
  }
  if (kind !== "appeal" && committed.appealTargetTurn !== undefined) {
    throw new Error("Only an appeal may reference an appeal target turn");
  }
  const check = committed.check
    ? `## Check\n\n\`\`\`json\n${JSON.stringify(committed.check, null, 2)}\n\`\`\``
    : "## Check\n\n_No check._";
  const metadata = {
    contentCodec: CONTENT_CODEC,
    turn,
    turnKind: kind,
    ...(committed.appealTargetTurn === undefined ? {} : { appealTargetTurn: committed.appealTargetTurn }),
    provider: committed.provider,
    model: committed.model,
    ...(committed.protocolVersion === undefined ? {} : { protocolVersion: committed.protocolVersion }),
    ...(committed.usage ? { usage: committed.usage } : {}),
  };
  return matter.stringify(
    [
      `# Turn ${turn}`,
      "## Player Action",
      encodeSectionText(committed.action),
      check,
      "## Narration",
      encodeSectionText(committed.resolved.narration),
      "## Summary",
      encodeSectionText(committed.resolved.turnSummary),
      "## State Operations",
      `\`\`\`json\n${JSON.stringify(committed.resolved.operations, null, 2)}\n\`\`\``,
    ].join("\n\n") + "\n",
    metadata,
  );
}
