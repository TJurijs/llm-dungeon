export interface PromptSection {
  readonly id: string;
  readonly title?: string;
  readonly content: string;
}

export interface PromptDocument {
  readonly sections: readonly PromptSection[];
  readonly text: string;
}

export function section(id: string, title: string | undefined, content: string): PromptSection {
  return { id, ...(title ? { title } : {}), content: content.trim() };
}

/** Compose prompts deterministically so their ownership and ordering remain inspectable. */
export function renderPrompt(sections: readonly PromptSection[]): PromptDocument {
  const normalized = sections.filter((item) => item.content.length > 0);
  return {
    sections: normalized,
    text: normalized
      .map((item) => item.title ? `${item.title}\n${item.content}` : item.content)
      .join("\n\n"),
  };
}
