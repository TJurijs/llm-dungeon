import type { AppealInput } from "./types.js";

const APPEAL_COMMAND = ":appeal";

function validateClaim(value: string): string {
  const claim = value.trim();
  if (!claim) throw new Error("Appeal requires an explanation");
  if (claim.length > 10_000) throw new Error("Appeal explanation exceeds 10,000 characters");
  return claim;
}

export function parseAppealCommand(value: string): AppealInput | undefined {
  const input = value.trim();
  if (!input.startsWith(APPEAL_COMMAND)) return undefined;
  const boundary = input.charAt(APPEAL_COMMAND.length);
  if (boundary && !/\s/.test(boundary)) return undefined;

  const remainder = input.slice(APPEAL_COMMAND.length).trimStart();
  if (!remainder.startsWith("--turn") || (remainder.length > 6 && !/\s/.test(remainder.charAt(6)))) {
    return { claim: validateClaim(remainder) };
  }

  const targeted = /^--turn\s+(\d+)\s+([\s\S]+)$/.exec(remainder);
  if (!targeted?.[1] || targeted[2] === undefined) {
    throw new Error("Use :appeal --turn <number> <explanation>");
  }
  const targetTurn = Number(targeted[1]);
  if (!Number.isSafeInteger(targetTurn) || targetTurn < 1) {
    throw new Error("Appeal turn must be a positive committed turn number");
  }
  return { claim: validateClaim(targeted[2]), targetTurn };
}

export function formatAppealCommand(input: AppealInput): string {
  const claim = validateClaim(input.claim);
  if (input.targetTurn === undefined) return `${APPEAL_COMMAND} ${claim}`;
  if (!Number.isSafeInteger(input.targetTurn) || input.targetTurn < 1) {
    throw new Error("Appeal turn must be a positive committed turn number");
  }
  return `${APPEAL_COMMAND} --turn ${input.targetTurn} ${claim}`;
}
