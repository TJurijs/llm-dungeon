export interface ContextSection {
  readonly id: string;
  readonly title: string;
  readonly content: string;
}

export function contextSection(id: string, title: string, content: string): ContextSection {
  return { id, title, content: content.trim() };
}

/** Render deterministic context while keeping section ownership testable. */
export function renderContextDocument(sections: readonly ContextSection[]): string {
  return sections.map((item) => `${item.title}\n${item.content}`).join("\n\n");
}
