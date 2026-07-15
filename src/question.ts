const QUESTION_COMMAND = ":ask";

function validateQuestion(value: string): string {
  const question = value.trim();
  if (!question) throw new Error("Question requires text after :ask");
  if (question.length > 10_000) throw new Error("Question exceeds 10,000 characters");
  return question;
}

export function parseQuestionCommand(value: string): string | undefined {
  const input = value.trim();
  if (!input.startsWith(QUESTION_COMMAND)) return undefined;
  const boundary = input.charAt(QUESTION_COMMAND.length);
  if (boundary && !/\s/.test(boundary)) return undefined;
  return validateQuestion(input.slice(QUESTION_COMMAND.length));
}

export function formatQuestionCommand(question: string): string {
  return `${QUESTION_COMMAND} ${validateQuestion(question)}`;
}
