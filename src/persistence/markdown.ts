import matter from "gray-matter";
import {
  ChronicleEventSchema,
  CompletedStoryArtifactSchema,
  AutomaticOutcomeSchema,
  EntitySchema,
  StateOperationSchema,
  ThreadSchema,
  type ChronicleEvent,
  type CompletedStoryArtifact,
  type AutomaticOutcome,
  type Entity,
  type Fact,
  type StateOperation,
  type Thread,
} from "../schemas.js";
import type { CommittedTurn, PlayerVisibleTurn, TurnKind } from "../types.js";
import {
  CheckResultSchema,
  formatAutomaticOutcome,
  formatCheck,
  type CheckResult,
} from "../mechanics.js";
import { DEFAULT_LANGUAGE, type LanguageCode } from "../language.js";
import { UsageSchema, type Usage } from "../usage.js";
import { conservativeInputTokenEstimate } from "../input-budget.js";

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
const INACTIVE_FACT_MARKER =
  /^  <!-- inactive-section: (established|secrets|knowledge|beliefs|intentions|history) -->$/;
const FACT_CREATED_TURN_MARKER = /^  <!-- created-turn: ([0-9]+) -->$/;
const FACT_SUPERSEDED_TURN_MARKER = /^  <!-- superseded-turn: ([0-9]+) -->$/;
const FACT_BASIS_MARKER =
  /^  <!-- basis: (observed|reported|inferred|recorded|established)(?: from ([^ ]+))? -->$/;
const PRIVATE_FACT_SECTIONS = new Set<Fact["section"]>(["secrets", "beliefs", "intentions"]);

interface TaggedEntry {
  id: string;
  text: string;
  inactiveSection?: Fact["section"];
  createdTurn?: number;
  supersededTurn?: number;
  basis?: Fact["basis"];
  sourceId?: string;
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

/** Render the independent, player-safe post-completion campaign artifact. */
export function renderCompletedStory(artifact: CompletedStoryArtifact): string {
  const validated = CompletedStoryArtifactSchema.parse(artifact);
  const { story, ...metadata } = validated;
  return matter.stringify(
    `# Completed Campaign Story\n\n## Story\n\n${encodeSectionText(story)}\n`,
    { contentCodec: CONTENT_CODEC, ...metadata },
  );
}

/** Fail closed if a completed-story file has missing, extra, or stale-format metadata. */
export function parseCompletedStory(content: string): CompletedStoryArtifact {
  const parsed = matter(content);
  if (parsed.data.contentCodec !== CONTENT_CODEC) {
    throw new Error(`Completed story must use contentCodec ${CONTENT_CODEC}`);
  }
  if (!hasSection(parsed.content, "Story")) {
    throw new Error("Completed story is missing its generated Story section");
  }
  const metadata = { ...parsed.data };
  delete metadata.contentCodec;
  return CompletedStoryArtifactSchema.parse({
    ...metadata,
    story: storedSectionText(parsed.content, "Story", true),
  });
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
function extractSection(
  body: string,
  heading: string,
  occurrence: "first" | "last" = "first",
): string {
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
  return value
    .split("\n")
    .map((line) => {
      if (
        line.startsWith("\\") ||
        line.startsWith("## ") ||
        (escapeEmptyDescription && line === EMPTY_DESCRIPTION)
      ) {
        return `\\${line}`;
      }
      return line;
    })
    .join("\n");
}

function decodeSectionText(value: string, encoded: boolean): string {
  if (!encoded) return value;
  return value
    .split("\n")
    .map((line) => {
      if (
        line.startsWith("\\\\") ||
        line.startsWith("\\## ") ||
        line === `\\${EMPTY_DESCRIPTION}`
      ) {
        return line.slice(1);
      }
      return line;
    })
    .join("\n");
}

function storedSectionText(body: string, heading: string, encoded: boolean): string {
  const value = extractSection(body, heading);
  return decodeSectionText(encoded ? value : value.trim(), encoded);
}

function renderTaggedEntry(entry: TaggedEntry): string {
  const lifecycle = [
    ...(entry.createdTurn === undefined ? [] : [`  <!-- created-turn: ${entry.createdTurn} -->`]),
    ...(entry.supersededTurn === undefined
      ? []
      : [`  <!-- superseded-turn: ${entry.supersededTurn} -->`]),
    ...(entry.basis === undefined
      ? []
      : [`  <!-- basis: ${entry.basis}${entry.sourceId ? ` from ${entry.sourceId}` : ""} -->`]),
  ];
  if (entry.inactiveSection) {
    const body = entry.text
      .split("\n")
      .map((line) => `  >${line ? ` ${line}` : ""}`)
      .join("\n");
    return `- [${entry.id}]\n  <!-- inactive-section: ${entry.inactiveSection} -->\n${lifecycle.join("\n")}${lifecycle.length ? "\n" : ""}${body}`;
  }
  if (!entry.text.includes("\n")) {
    return `- [${entry.id}] ${entry.text}${lifecycle.length ? `\n${lifecycle.join("\n")}` : ""}`;
  }
  const body = entry.text
    .split("\n")
    .map((line) => `  >${line ? ` ${line}` : ""}`)
    .join("\n");
  return `- [${entry.id}]\n${lifecycle.join("\n")}${lifecycle.length ? "\n" : ""}${body}`;
}

/** Parse both the current continuation format and the original plain bullets. */
function parseTaggedLines(value: string, allowInactiveMetadata = false): TaggedEntry[] {
  const entries: TaggedEntry[] = [];
  let current:
    | {
        id: string;
        lines: string[];
        inactiveSection?: Fact["section"];
        createdTurn?: number;
        supersededTurn?: number;
        basis?: Fact["basis"];
        sourceId?: string;
      }
    | undefined;
  const flush = (): void => {
    if (!current) return;
    entries.push({
      id: current.id,
      text: current.lines.join("\n"),
      ...(current.inactiveSection ? { inactiveSection: current.inactiveSection } : {}),
      ...(current.createdTurn === undefined ? {} : { createdTurn: current.createdTurn }),
      ...(current.supersededTurn === undefined ? {} : { supersededTurn: current.supersededTurn }),
      ...(current.basis === undefined ? {} : { basis: current.basis }),
      ...(current.sourceId === undefined ? {} : { sourceId: current.sourceId }),
    });
    current = undefined;
  };

  for (const line of value.split("\n")) {
    const tagged =
      line.match(/^-\s+\[([^\]]+)](?:\s(.*))?$/) ?? line.match(/^\s+-\s+\[([^\]]+)](?:\s(.*))?$/);
    if (tagged?.[1]) {
      flush();
      current = { id: tagged[1], lines: tagged[2] === undefined ? [] : [tagged[2]] };
      continue;
    }
    if (!current) continue;
    const inactive = allowInactiveMetadata
      ? (line.match(INACTIVE_FACT_MARKER)?.[1] as Fact["section"] | undefined)
      : undefined;
    if (inactive) {
      current.inactiveSection = inactive;
      continue;
    }
    const createdTurn = allowInactiveMetadata
      ? line.match(FACT_CREATED_TURN_MARKER)?.[1]
      : undefined;
    if (createdTurn !== undefined) {
      current.createdTurn = Number(createdTurn);
      continue;
    }
    const supersededTurn = allowInactiveMetadata
      ? line.match(FACT_SUPERSEDED_TURN_MARKER)?.[1]
      : undefined;
    if (supersededTurn !== undefined) {
      current.supersededTurn = Number(supersededTurn);
      continue;
    }
    const basis = allowInactiveMetadata ? line.match(FACT_BASIS_MARKER) : undefined;
    if (basis) {
      current.basis = basis[1] as Fact["basis"];
      if (basis[2] !== undefined) current.sourceId = basis[2];
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
        .map((fact) =>
          renderTaggedEntry({
            id: fact.id,
            text: fact.text,
            ...(fact.createdTurn === undefined ? {} : { createdTurn: fact.createdTurn }),
            ...(fact.basis === undefined ? {} : { basis: fact.basis }),
            ...(fact.sourceId === undefined ? {} : { sourceId: fact.sourceId }),
          }),
        );
      const inactive =
        section === "history"
          ? entity.facts
              .filter(
                (fact) =>
                  !fact.active && (includePrivate || !PRIVATE_FACT_SECTIONS.has(fact.section)),
              )
              .map((fact) =>
                renderTaggedEntry({
                  id: fact.id,
                  text: fact.text,
                  inactiveSection: fact.section,
                  ...(fact.createdTurn === undefined ? {} : { createdTurn: fact.createdTurn }),
                  ...(fact.supersededTurn === undefined
                    ? {}
                    : { supersededTurn: fact.supersededTurn }),
                  ...(fact.basis === undefined ? {} : { basis: fact.basis }),
                  ...(fact.sourceId === undefined ? {} : { sourceId: fact.sourceId }),
                }),
              )
          : [];
      const lines = [...active, ...inactive];
      return `## ${heading}\n\n${lines.join("\n") || "_None._"}`;
    });
  const relationships = entity.relationships.map((relationship) =>
    renderTaggedEntry({ id: relationship.targetId, text: relationship.summary }),
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
    for (const heading of ["Description", ...Object.values(SECTION_HEADINGS), "Relationships"]) {
      if (!hasSection(parsed.content, heading)) {
        throw new Error(`Entity document is missing generated ${heading} section`);
      }
    }
  }
  const facts: Fact[] = [];
  for (const [section, heading] of Object.entries(SECTION_HEADINGS) as Array<
    [Fact["section"], string]
  >) {
    const sectionText = extractSection(parsed.content, heading);
    facts.push(
      ...parseTaggedLines(encoded ? sectionText : sectionText.trim(), encoded).map((fact) => ({
        id: fact.id,
        text: fact.text,
        section: fact.inactiveSection ?? section,
        active: fact.inactiveSection === undefined,
        ...(fact.createdTurn === undefined ? {} : { createdTurn: fact.createdTurn }),
        ...(fact.supersededTurn === undefined ? {} : { supersededTurn: fact.supersededTurn }),
        ...(fact.basis === undefined ? {} : { basis: fact.basis }),
        ...(fact.sourceId === undefined ? {} : { sourceId: fact.sourceId }),
      })),
    );
  }
  const relationshipsText = extractSection(parsed.content, "Relationships");
  const relationships = parseTaggedLines(
    encoded ? relationshipsText : relationshipsText.trim(),
  ).map((relationship) => ({ targetId: relationship.id, summary: relationship.text }));
  const encodedDescription = encoded
    ? extractSection(parsed.content, "Description")
    : extractSection(parsed.content, "Description").trim();
  const description =
    encodedDescription === EMPTY_DESCRIPTION ? "" : decodeSectionText(encodedDescription, encoded);
  return EntitySchema.parse({
    ...parsed.data,
    description,
    facts,
    relationships,
    traits: requireStructuredMetadata ? parsed.data.traits : (parsed.data.traits ?? []),
    conditions: requireStructuredMetadata ? parsed.data.conditions : (parsed.data.conditions ?? []),
    inventory: requireStructuredMetadata ? parsed.data.inventory : (parsed.data.inventory ?? []),
    tags: requireStructuredMetadata ? parsed.data.tags : (parsed.data.tags ?? []),
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
  return ThreadSchema.array()
    .parse(requireStructuredMetadata ? document.data.threads : (document.data.threads ?? []))
    .map((thread) => ({
      ...thread,
      // Reading is the safe migration point: subsequent manifest-last commits
      // persist the original rolling summary as an immutable objective.
      objective: thread.objective ?? thread.summary,
    }));
}

export function renderChronicle(events: ChronicleEvent[]): string {
  const lines = events.map(
    (event) => `- **Turn ${event.turn}:** ${event.text} <!-- ${event.id} -->`,
  );
  return matter.stringify(`# Chronicle\n\n${lines.join("\n") || "_No major events yet._"}\n`, {
    events,
  });
}

export function parseChronicle(
  content: string,
  requireStructuredMetadata = false,
): ChronicleEvent[] {
  const document = matter(content);
  const hasStructuredMetadata = Object.prototype.hasOwnProperty.call(document.data, "events");
  if (requireStructuredMetadata && !hasStructuredMetadata) {
    throw new Error("Chronicle document is missing structured event metadata");
  }
  return ChronicleEventSchema.array().parse(
    requireStructuredMetadata ? document.data.events : (document.data.events ?? []),
  );
}

export function renderThreadsForContext(threads: Thread[]): string {
  return threads.length
    ? threads
        .map(
          (thread) =>
            `- [${thread.id}] (${thread.status}) ${thread.title}; immutable objective: ${thread.objective ?? thread.summary}; current summary: ${thread.summary}`,
        )
        .join("\n")
    : "_None._";
}

export interface BoundedContextRenderOptions {
  /** Conservative Unicode/UTF-8 units, matching the provider-input preflight. */
  budget: number;
}

const CONTEXT_OMISSION_RESERVE = 180;

/**
 * Oldest DM-only constraints per entity that survive ahead of the newest-first
 * sweep. Hidden truth is established once and constrains every later turn,
 * unlike player knowledge, which accumulates and stays in recent memory.
 */
const PROTECTED_SECRET_FACTS = 6;

export function boundedContextExcerpt(value: string, budget: number, label: string): string {
  const trimmed = value.trim();
  if (budget <= 0) return "";
  if (conservativeInputTokenEstimate(trimmed) <= budget) return trimmed;
  const note = `[${label} abbreviated; canonical Markdown remains complete.]`;
  if (conservativeInputTokenEstimate(note) > budget) {
    const noteCharacters = [...note];
    let low = 0;
    let high = noteCharacters.length;
    while (low < high) {
      const middle = Math.ceil((low + high) / 2);
      if (conservativeInputTokenEstimate(noteCharacters.slice(0, middle).join("")) <= budget) {
        low = middle;
      } else {
        high = middle - 1;
      }
    }
    return noteCharacters.slice(0, low).join("");
  }
  const characters = [...trimmed];
  const candidate = (retainedCharacters: number): string => {
    if (retainedCharacters === 0) return note;
    const leadingCount = Math.ceil(retainedCharacters / 2);
    const trailingCount = retainedCharacters - leadingCount;
    const leading = characters.slice(0, leadingCount).join("");
    const trailing = trailingCount > 0 ? characters.slice(-trailingCount).join("") : "";
    return `${leading}\n${note}${trailing ? `\n${trailing}` : ""}`;
  };
  // Binary search keeps abbreviation linearithmic even for very large legacy
  // Markdown rather than repeatedly trimming and recounting the whole string.
  let low = 0;
  let high = characters.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (conservativeInputTokenEstimate(candidate(middle)) <= budget) low = middle;
    else high = middle - 1;
  }
  return candidate(low);
}

export function boundedContextLines(
  lines: readonly string[],
  budget: number,
  omittedLabel: string,
): string {
  if (lines.length === 0) return "_None._";
  const included: string[] = [];
  let omitted = 0;
  let used = 0;
  const contentBudget = Math.max(0, budget - CONTEXT_OMISSION_RESERVE);
  for (const line of lines) {
    // Summing independently estimated lines is slightly more conservative than
    // estimating the concatenation and avoids repeatedly rebuilding a growing
    // candidate string.
    const lineUnits = conservativeInputTokenEstimate(line) + (included.length ? 1 : 0);
    if (used + lineUnits <= contentBudget) {
      included.push(line);
      used += lineUnits;
    } else {
      omitted += 1;
    }
  }
  if (omitted > 0)
    included.push(
      `[${omitted} additional ${omittedLabel} omitted; canonical Markdown remains complete.]`,
    );
  const rendered = included.join("\n");
  return boundedContextExcerpt(rendered, budget, omittedLabel);
}

function coreAndNewest<T>(values: readonly T[], coreCount = 3): T[] {
  return [...values.slice(0, coreCount), ...values.slice().reverse()].filter(
    (value, index, all) => all.indexOf(value) === index,
  );
}

interface IndexedFact {
  fact: Fact;
  index: number;
}

function oldestFactFirst(left: IndexedFact, right: IndexedFact): number {
  const leftTimestamped = left.fact.createdTurn !== undefined;
  const rightTimestamped = right.fact.createdTurn !== undefined;
  // Untimestamped facts predate lifecycle metadata. Preserve their canonical
  // order as the deterministic established core ahead of later stamped facts.
  if (leftTimestamped !== rightTimestamped) return leftTimestamped ? 1 : -1;
  if (leftTimestamped && rightTimestamped) {
    return left.fact.createdTurn! - right.fact.createdTurn! || left.index - right.index;
  }
  return left.index - right.index;
}

function newestFactFirst(left: IndexedFact, right: IndexedFact): number {
  const leftTimestamped = left.fact.createdTurn !== undefined;
  const rightTimestamped = right.fact.createdTurn !== undefined;
  // Every stamped fact was written after any legacy fact lacking lifecycle
  // metadata. Never compare an application turn number with an array position.
  if (leftTimestamped !== rightTimestamped) return leftTimestamped ? -1 : 1;
  if (leftTimestamped && rightTimestamped) {
    return right.fact.createdTurn! - left.fact.createdTurn! || right.index - left.index;
  }
  return right.index - left.index;
}

export function renderThreadsForBoundedContext(
  threads: Thread[],
  options: BoundedContextRenderOptions,
): string {
  const ordered = [
    ...threads.filter((thread) => thread.status === "active"),
    ...threads
      .filter((thread) => thread.status !== "active")
      .slice()
      .reverse(),
  ];
  return boundedContextLines(
    ordered.map(
      (thread) =>
        `- [${thread.id}] (${thread.status}) ${boundedContextExcerpt(thread.title, 200, "thread title")}; immutable objective=${boundedContextExcerpt(thread.objective ?? thread.summary, 800, "thread objective")}; current summary=${boundedContextExcerpt(thread.summary, 1_200, "thread summary")}; lifecycle=created@${thread.createdTurn ?? "legacy"},updated@${thread.updatedTurn ?? "legacy"}${thread.closedTurn === undefined ? "" : `,closed@${thread.closedTurn}`}${
          thread.relatedEntityIds.length
            ? `; links=${thread.relatedEntityIds.map((id) => `[${id}]`).join(",")}`
            : ""
        }`,
    ),
    options.budget,
    "story threads",
  );
}

export function renderChronicleForContext(events: ChronicleEvent[]): string {
  return events.length
    ? events.map((event) => `- Turn ${event.turn} [${event.id}]: ${event.text}`).join("\n")
    : "_No major events yet._";
}

export function renderChronicleForBoundedContext(
  events: ChronicleEvent[],
  options: BoundedContextRenderOptions,
): string {
  const ordered = events.length <= 2 ? events : [events[0]!, ...events.slice(1).reverse()];
  return boundedContextLines(
    ordered.map(
      (event) =>
        `- Turn ${event.turn} [${event.id}]: ${boundedContextExcerpt(event.text, 1_200, "major event")}`,
    ),
    options.budget,
    "major events",
  );
}

export function compactTurnHistory(logs: string[], fullNarrationCount = 1): string {
  return logs
    .map((log, index) => {
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
    })
    .join("\n\n---\n\n");
}

/**
 * Fixed-size working-memory projection. Every selected turn keeps its action
 * and summary; only the newest requested turns retain a bounded narration.
 */
export function compactTurnHistoryForBoundedContext(
  logs: string[],
  fullNarrationCount: number,
  options: BoundedContextRenderOptions,
): string {
  if (logs.length === 0) return "_No committed turns yet._";
  const perTurnBudget = Math.max(320, Math.floor((options.budget - 240) / logs.length));
  const records = logs.map((log, index) => {
    const parsed = matter(log);
    const turn = typeof parsed.data.turn === "number" ? parsed.data.turn : "?";
    const kind = turnKind(parsed.data.turn, parsed.data.turnKind);
    const encoded = parsed.data.contentCodec === CONTENT_CODEC;
    const action = boundedContextExcerpt(
      storedSectionText(parsed.content, "Player Action", encoded),
      Math.max(100, Math.floor(perTurnBudget * 0.25)),
      "player action",
    );
    const summary = boundedContextExcerpt(
      storedSectionText(parsed.content, "Summary", encoded) ||
        storedSectionText(parsed.content, "Narration", encoded),
      Math.max(160, Math.floor(perTurnBudget * 0.45)),
      "turn summary",
    );
    const includeNarration = index >= logs.length - fullNarrationCount;
    const narration = includeNarration
      ? boundedContextExcerpt(
          storedSectionText(parsed.content, "Narration", encoded),
          Math.max(120, Math.floor(perTurnBudget * 0.3)),
          "latest narration",
        )
      : "";
    if (kind === "appeal") {
      return [
        `### Administrative Appeal ${turn}`,
        `Appeal request: ${action}`,
        ...(narration ? [`Decision explanation: ${narration}`] : []),
        `Administrative decision summary: ${summary}`,
        "Already applied; no fictional time advanced.",
      ].join("\n");
    }
    return [
      `### Turn ${turn}`,
      `Action: ${action}`,
      ...(narration ? [`Immediate narration: ${narration}`] : []),
      `Durable outcome summary: ${summary}`,
    ].join("\n");
  });
  return boundedContextLines(records, options.budget, "recent turn records");
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

/** Decode the adjudicator's player-visible certain-outcome classification. */
export function parseTurnAutomaticOutcome(log: string): AutomaticOutcome | undefined {
  const parsed = matter(log);
  const section = extractSection(parsed.content, "Automatic Outcome").trim();
  if (!section || section === "_None._") return undefined;
  const fenced = section.match(/^```json\s*([\s\S]*?)\s*```$/);
  if (!fenced?.[1]) throw new Error("Turn log has invalid automatic outcome metadata");
  return AutomaticOutcomeSchema.parse(JSON.parse(fenced[1]));
}

/** Decode private provider usage metadata without exposing narrative or operations. */
export function parseTurnGenerationMetadata(log: string): TurnGenerationMetadata {
  const parsed = matter(log);
  if (!Number.isInteger(parsed.data.turn) || parsed.data.turn < 0) {
    throw new Error("Turn log is missing a valid turn number");
  }
  const provider =
    typeof parsed.data.provider === "string" && parsed.data.provider
      ? parsed.data.provider
      : "unknown";
  const model =
    typeof parsed.data.model === "string" && parsed.data.model ? parsed.data.model : "unknown";
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
  if (
    appealTargetTurn !== undefined &&
    (!Number.isInteger(appealTargetTurn) ||
      appealTargetTurn < 1 ||
      appealTargetTurn >= turn ||
      kind !== "appeal")
  ) {
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
  const automaticSection = extractSection(parsed.content, "Automatic Outcome").trim();
  // A pending commit created before automatic outcomes existed has no section;
  // treat that legacy absence as "none" so crash recovery remains forward-compatible.
  if (automaticSection && automaticSection !== "_None._") {
    parseTurnAutomaticOutcome(log);
    if (kind !== "gameplay") {
      throw new Error("Only a gameplay turn may contain an automatic outcome");
    }
    if (checkSection !== "_No check._") {
      throw new Error("A turn cannot contain both a check and an automatic outcome");
    }
  }

  return { turn, kind, operations: parseTurnOperations(log) };
}

/** Decode only player-visible turn history, excluding provider metadata and state operations. */
export function parsePlayerVisibleTurn(
  log: string,
  language: LanguageCode = DEFAULT_LANGUAGE,
): PlayerVisibleTurn {
  const parsed = matter(log);
  const encoded = parsed.data.contentCodec === CONTENT_CODEC;
  if (!Number.isInteger(parsed.data.turn) || parsed.data.turn < 0) {
    throw new Error("Turn log is missing a valid turn number");
  }
  const turn = parsed.data.turn as number;
  const kind = turnKind(turn, parsed.data.turnKind);
  const appealTargetTurn = parsed.data.appealTargetTurn;
  if (
    appealTargetTurn !== undefined &&
    (!Number.isInteger(appealTargetTurn) || appealTargetTurn < 1 || kind !== "appeal")
  ) {
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
  if (!check) {
    try {
      const automaticOutcome = parseTurnAutomaticOutcome(log);
      if (automaticOutcome) check = formatAutomaticOutcome(automaticOutcome, language);
    } catch {
      // Corrupt private automatic-outcome metadata is never echoed to a player.
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

export function renderContextEntities(
  entities: Entity[],
  mandatoryIds: Set<string>,
  budget: number,
): string {
  const byId = new Map(entities.map((entity) => [entity.id, entity]));
  const ordered = [
    ...entities.filter((entity) => mandatoryIds.has(entity.id)),
    ...entities.filter((entity) => !mandatoryIds.has(entity.id)),
  ].filter(
    (entity, index, all) => all.findIndex((candidate) => candidate.id === entity.id) === index,
  );
  const included: string[] = [];
  let omitted = 0;
  const reservedForNote = Math.min(CONTEXT_OMISSION_RESERVE, Math.floor(budget / 5));
  const contentBudget = Math.max(0, budget - reservedForNote);
  let used = 0;

  const appendBlock = (
    lines: string[],
    label: string,
    values: readonly string[],
    allowance: number,
  ) => {
    if (values.length === 0 || allowance <= 0) return;
    const rendered = boundedContextLines(values, allowance, label);
    if (rendered !== "_None._") lines.push(rendered);
  };

  for (let entityIndex = 0; entityIndex < ordered.length; entityIndex += 1) {
    const entity = ordered[entityIndex]!;
    const remaining = contentBudget - used;
    if (remaining < 160) {
      omitted += 1;
      continue;
    }
    const remainingMandatory = ordered
      .slice(entityIndex)
      .filter((candidate) => mandatoryIds.has(candidate.id)).length;
    const perEntityLimit = Math.min(
      remaining,
      mandatoryIds.has(entity.id)
        ? Math.min(4_000, Math.floor(remaining / Math.max(1, remainingMandatory)))
        : 3_200,
    );
    const header = [
      `ENTITY [${entity.id}]`,
      `kind=${entity.kind}; name=${JSON.stringify(boundedContextExcerpt(entity.name, 200, "entity name"))}; status=${JSON.stringify(boundedContextExcerpt(entity.status, 320, "entity status"))}; updatedTurn=${entity.updatedTurn}${entity.location ? `; location=[${entity.location}]` : ""}`,
    ];
    const baseUnits = conservativeInputTokenEstimate(header.join("\n"));
    if (baseUnits > perEntityLimit) {
      const minimal = boundedContextExcerpt(header.join("\n"), remaining, "entity identity");
      included.push(minimal);
      used += conservativeInputTokenEstimate(minimal) + 6;
      continue;
    }
    const lines = [...header];
    let optionalBudget = perEntityLimit - baseUnits - 64;
    appendBlock(
      lines,
      "conditions",
      entity.conditions
        .slice()
        .reverse()
        .map(
          (condition) =>
            `condition=${JSON.stringify(boundedContextExcerpt(condition, 500, "condition"))}`,
        ),
      Math.min(700, Math.max(0, optionalBudget)),
    );
    optionalBudget = perEntityLimit - conservativeInputTokenEstimate(lines.join("\n")) - 64;
    appendBlock(
      lines,
      "inventory entries",
      coreAndNewest(entity.inventory).map((entry) => {
        const item = byId.get(entry.entityId);
        return `owns=${entry.quantity}x[${entry.entityId}]${item ? ` ${JSON.stringify(boundedContextExcerpt(item.name, 160, "item name"))}` : ""}`;
      }),
      Math.min(800, Math.max(0, optionalBudget)),
    );
    optionalBudget = perEntityLimit - conservativeInputTokenEstimate(lines.join("\n")) - 64;
    appendBlock(
      lines,
      "traits",
      coreAndNewest(entity.traits).map(
        (trait) => `trait=${JSON.stringify(boundedContextExcerpt(trait, 1_600, "trait"))}`,
      ),
      Math.min(1_800, Math.max(0, optionalBudget)),
    );
    optionalBudget = perEntityLimit - conservativeInputTokenEstimate(lines.join("\n")) - 64;
    appendBlock(
      lines,
      "active facts",
      [
        ...entity.facts
          .map((fact, index) => ({ fact, index }))
          .filter(({ fact }) => fact.active && fact.section === "established")
          .sort(oldestFactFirst)
          .slice(0, 4),
        // DM-only constraints are usually written at setup, so a newest-first
        // sweep evicts exactly the causal skeleton that later mystery turns
        // must stay compatible with. Protect the oldest ones explicitly.
        ...entity.facts
          .map((fact, index) => ({ fact, index }))
          .filter(({ fact }) => fact.active && fact.section === "secrets")
          .sort(oldestFactFirst)
          .slice(0, PROTECTED_SECRET_FACTS),
        ...entity.facts
          .map((fact, index) => ({ fact, index }))
          .filter(({ fact }) => fact.active)
          .sort(newestFactFirst),
      ]
        .filter(
          (entry, index, all) =>
            all.findIndex((candidate) => candidate.fact.id === entry.fact.id) === index,
        )
        .map(
          ({ fact }) =>
            `fact(${fact.section})[${fact.id}]${fact.createdTurn === undefined ? "" : `@turn=${fact.createdTurn}`}=${JSON.stringify(boundedContextExcerpt(fact.text, 800, "fact"))}`,
        ),
      Math.min(1_600, Math.max(0, optionalBudget)),
    );
    optionalBudget = perEntityLimit - conservativeInputTokenEstimate(lines.join("\n")) - 64;
    appendBlock(
      lines,
      "relationships",
      entity.relationships
        .slice()
        .reverse()
        .map(
          (relationship) =>
            `relationship->[${relationship.targetId}]=${JSON.stringify(boundedContextExcerpt(relationship.summary, 800, "relationship"))}`,
        ),
      Math.min(700, Math.max(0, optionalBudget)),
    );
    optionalBudget = perEntityLimit - conservativeInputTokenEstimate(lines.join("\n")) - 64;
    if (entity.description && optionalBudget > 0) {
      const description = `description=${JSON.stringify(
        boundedContextExcerpt(entity.description, Math.min(600, optionalBudget), "description"),
      )}`;
      lines.push(description);
    }
    const rendered = boundedContextExcerpt(lines.join("\n"), perEntityLimit, "entity projection");
    const separatorUnits = included.length ? 7 : 0;
    if (used + separatorUnits + conservativeInputTokenEstimate(rendered) <= contentBudget) {
      included.push(rendered);
      used += separatorUnits + conservativeInputTokenEstimate(rendered);
    } else {
      omitted += 1;
    }
  }
  if (omitted > 0) {
    included.push(
      `CONTEXT BUDGET NOTE\n${omitted} lower-priority entity records were omitted; their canonical Markdown remains complete and can be deterministically reactivated.`,
    );
  }
  return boundedContextExcerpt(included.join("\n\n---\n\n"), budget, "entity context");
}

export function renderTurnLog(turn: number, committed: CommittedTurn): string {
  const kind = committed.kind ?? (turn === 0 ? "opening" : "gameplay");
  if (kind === "opening" && turn !== 0) throw new Error("Only turn zero may be an opening turn");
  if (kind === "appeal" && committed.check) throw new Error("An appeal cannot contain a check");
  if (kind !== "gameplay" && committed.automaticOutcome) {
    throw new Error("Only a gameplay turn may contain an automatic outcome");
  }
  if (committed.check && committed.automaticOutcome) {
    throw new Error("A turn cannot contain both a check and an automatic outcome");
  }
  if (
    committed.appealTargetTurn !== undefined &&
    (!Number.isInteger(committed.appealTargetTurn) ||
      committed.appealTargetTurn < 1 ||
      committed.appealTargetTurn >= turn)
  ) {
    throw new Error("An appeal target must reference an earlier committed turn");
  }
  if (kind !== "appeal" && committed.appealTargetTurn !== undefined) {
    throw new Error("Only an appeal may reference an appeal target turn");
  }
  const check = committed.check
    ? `## Check\n\n\`\`\`json\n${JSON.stringify(committed.check, null, 2)}\n\`\`\``
    : "## Check\n\n_No check._";
  const automaticOutcome = committed.automaticOutcome
    ? `## Automatic Outcome\n\n\`\`\`json\n${JSON.stringify(AutomaticOutcomeSchema.parse(committed.automaticOutcome), null, 2)}\n\`\`\``
    : "## Automatic Outcome\n\n_None._";
  const metadata = {
    contentCodec: CONTENT_CODEC,
    turn,
    turnKind: kind,
    ...(committed.appealTargetTurn === undefined
      ? {}
      : { appealTargetTurn: committed.appealTargetTurn }),
    provider: committed.provider,
    model: committed.model,
    ...(committed.protocolVersion === undefined
      ? {}
      : { protocolVersion: committed.protocolVersion }),
    ...(committed.usage ? { usage: committed.usage } : {}),
  };
  return matter.stringify(
    [
      `# Turn ${turn}`,
      "## Player Action",
      encodeSectionText(committed.action),
      check,
      automaticOutcome,
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
