export interface ContextSection {
  readonly id: string;
  readonly title: string;
  readonly content: string;
}

export interface ContextDocument {
  readonly sections: readonly ContextSection[];
  readonly text: string;
}

export function contextSection(id: string, title: string, content: string): ContextSection {
  return { id, title, content: content.trim() };
}

/** Compose deterministic context while keeping section ownership testable. */
export function contextDocument(sections: readonly ContextSection[]): ContextDocument {
  return {
    sections,
    text: sections.map((item) => `${item.title}\n${item.content}`).join("\n\n"),
  };
}

/** Compatibility renderer for context consumers that need only text. */
export function renderContextDocument(sections: readonly ContextSection[]): string {
  return contextDocument(sections).text;
}
