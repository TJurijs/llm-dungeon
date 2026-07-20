import { readFile } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { readLegacyEvaluationManifest } from "../legacy-evaluation-artifacts.js";
import { CheckResultSchema, formatCheck } from "../../../src/mechanics.js";
import { asError } from "../../../src/web/http.js";

const EvaluationTranscriptTurnSchema = z.object({
  turn: z.number().int().positive(),
  action: z.string(),
  approach: z.string(),
  narration: z.string().optional(),
  check: CheckResultSchema.optional(),
  status: z.enum(["completed", "failed"]),
  error: z.string().optional(),
});

const SAFE_ARTIFACT_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

export function assertSafeId(value: string, label: string): string {
  if (!SAFE_ARTIFACT_ID.test(value)) throw new Error(`Invalid ${label}`);
  return value;
}

function transcriptOpening(markdown: string): string {
  const heading = "## Opening";
  const start = markdown.indexOf(heading);
  if (start < 0) return "";
  const contentStart = start + heading.length;
  const nextTurn = markdown.indexOf("\n## Turn ", contentStart);
  return markdown.slice(contentStart, nextTurn < 0 ? undefined : nextTurn).trim();
}

function parseEvaluationTurns(jsonLines: string): Array<z.infer<typeof EvaluationTranscriptTurnSchema>> {
  return jsonLines
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line, index) => {
      try {
        return EvaluationTranscriptTurnSchema.parse(JSON.parse(line));
      } catch (error) {
        throw new Error(`Invalid evaluation turn record ${index + 1}: ${asError(error)}`);
      }
    });
}

export function evaluationArtifactPath(
  evaluationsRoot: string,
  runId: string,
  kind: string,
  sessionId?: string,
): string {
  const safeRun = assertSafeId(runId, "run ID");
  const runDir = path.join(evaluationsRoot, "runs", safeRun);
  if (kind === "report") return path.join(runDir, "report.md");
  if (kind === "manifest") return path.join(runDir, "manifest.json");
  if (kind !== "transcript" && kind !== "evaluation") throw new Error("Invalid artifact kind");
  if (!sessionId) throw new Error("A session ID is required");
  return path.join(runDir, "sessions", assertSafeId(sessionId, "session ID"), `${kind}.md`);
}

/** Reconstruct the browser's evaluation transcript without treating Markdown as state. */
export async function evaluationTranscriptPresentation(
  evaluationsRoot: string,
  runId: string,
  sessionId: string,
  markdown: string,
): Promise<unknown> {
  const safeRunId = assertSafeId(runId, "run ID");
  const safeSessionId = assertSafeId(sessionId, "session ID");
  const runDir = path.join(evaluationsRoot, "runs", safeRunId);
  const manifest = await readLegacyEvaluationManifest(path.join(runDir, "manifest.json"));
  const session = manifest.sessions.find((candidate) => candidate.id === safeSessionId);
  if (!session) throw new Error(`Evaluation session ${safeSessionId} is not present in run ${safeRunId}`);
  let jsonLines = "";
  try {
    jsonLines = await readFile(path.join(runDir, "sessions", safeSessionId, "turns.jsonl"), "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const turns = parseEvaluationTurns(jsonLines).map((turn) => ({
    turn: turn.turn,
    action: turn.action,
    approach: turn.approach,
    status: turn.status,
    ...(turn.narration ? { narration: turn.narration } : {}),
    ...(turn.check ? { checkText: formatCheck(turn.check, manifest.config.language) } : {}),
    ...(turn.error ? { error: turn.error } : {}),
  }));
  return {
    profile: session.profile,
    opening: transcriptOpening(markdown),
    turns,
  };
}
