import { writeFile } from "node:fs/promises";
import path from "node:path";
import { atomicWriteJson as writeJson } from "../persistence/files.js";
import type { EvaluationManifest } from "./contracts.js";
import { readEvaluationManifest } from "./manifest.js";

export function runReport(manifest: EvaluationManifest): string {
  const metrics = manifest.sessions.flatMap((session) => (session.metrics ? [session.metrics] : []));
  const completed = metrics.filter((metric) => metric.status === "completed").length;
  const turns = metrics.reduce((sum, metric) => sum + metric.turnsCompleted, 0);
  const dmCalls = metrics.reduce((sum, metric) => sum + metric.dmCalls, 0);
  const playerCalls = metrics.reduce((sum, metric) => sum + metric.playerCalls, 0);
  const checks = metrics.reduce((sum, metric) => sum + metric.checks, 0);
  const checkRate = turns ? checks / turns : 0;
  const schemaRepairs = metrics.reduce((sum, metric) => sum + (metric.schemaRepairCalls ?? 0), 0);
  const transientRetries = metrics.reduce((sum, metric) => sum + (metric.transientRetryCalls ?? 0), 0);
  const domainRepairs = metrics.reduce((sum, metric) => sum + (metric.domainRepairCalls ?? 0), 0);
  const failures = metrics.reduce((sum, metric) => sum + metric.failedCalls, 0);
  const failedCallCost = metrics.reduce((sum, metric) => sum + (metric.failedCallCostUsd ?? 0), 0);
  const successfulRepairs = metrics.reduce((sum, metric) => sum + (metric.repairCallsSucceeded ?? 0), 0);
  const exhaustedRepairs = metrics.reduce((sum, metric) => sum + (metric.repairCallsFailed ?? 0), 0);
  const exhaustedDomainRepairs = metrics.reduce((sum, metric) => sum + (metric.domainRepairsExhausted ?? 0), 0);
  const qualityPassed = metrics.filter((metric) => metric.qualityGatePassed).length;
  const fingerprints = new Map<string, number>();
  for (const metric of metrics) {
    for (const [fingerprint, count] of Object.entries(metric.failureFingerprints ?? {})) {
      fingerprints.set(fingerprint, (fingerprints.get(fingerprint) ?? 0) + count);
    }
  }
  const fingerprintReport = [...fingerprints.entries()]
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .map(([fingerprint, count]) => `- ${count} × \`${fingerprint}\``)
    .join("\n");
  const judged = metrics.filter((metric) => metric.judgeStatus === "completed" && metric.judgeScore !== undefined);
  const averageJudgeScore = judged.length
    ? judged.reduce((sum, metric) => sum + metric.judgeScore!, 0) / judged.length
    : undefined;
  const rows = metrics.map((metric) => {
    const rate = metric.checkRate ?? (metric.turnsCompleted ? metric.checks / metric.turnsCompleted : 0);
    return `| ${metric.sessionId} | ${metric.profile} | ${metric.status} | ${metric.turnsCompleted} | ${metric.checks} (${(rate * 100).toFixed(0)}%) | ${metric.judgeVerdict ?? metric.judgeStatus} | ${metric.judgeScore ?? "—"} | $${metric.estimatedCostUsd.toFixed(4)} |`;
  });
  const highCheckSessions = metrics.filter((metric) => {
    const rate = metric.checkRate ?? (metric.turnsCompleted ? metric.checks / metric.turnsCompleted : 0);
    return metric.turnsCompleted > 0 && rate > 0.5;
  });
  const checkWarning = highCheckSessions.length
    ? `\n> **Mechanical alert:** Check usage exceeded 50% in ${highCheckSessions.map((metric) => `${metric.sessionId} (${((metric.checkRate ?? metric.checks / metric.turnsCompleted) * 100).toFixed(0)}%)`).join(", ")}. Review whether established danger or opposition justified those checks.\n`
    : "";
  return `# Self-Play Evaluation: ${manifest.runId}

- Status: **${manifest.status}**
- Language: **${manifest.config.language}**
- DM: **${manifest.config.dm.config.provider}/${manifest.config.dm.config.model}**
- Player: **${manifest.config.player.config.provider}/${manifest.config.player.config.model}**

## Summary

- Sessions completed successfully: ${completed}/${manifest.config.sessions}
- Parallel workers: ${manifest.config.concurrency ?? 3}
- Turns completed: ${turns}
- DM calls: ${dmCalls}
- Player calls: ${playerCalls}
- Checks: ${checks} (${(checkRate * 100).toFixed(1)}% of completed turns)
- Schema repair calls: ${schemaRepairs}
- Transient provider retries: ${transientRetries}
- Domain transaction repair calls: ${domainRepairs}
- Failed structured calls: ${failures}
- Failed-call cost: $${failedCallCost.toFixed(4)}
- Successful structured repairs: ${successfulRepairs}
- Exhausted structured repairs: ${exhaustedRepairs}
- Exhausted domain repairs: ${exhaustedDomainRepairs}
- AI judge evaluations completed: ${judged.length}/${completed}
- Clean quality gates: ${qualityPassed}/${manifest.config.sessions}
- Average AI judge score: ${averageJudgeScore === undefined ? "not available" : `${averageJudgeScore.toFixed(1)}/10`}
- Estimated cost: $${manifest.totalEstimatedCostUsd.toFixed(4)}
- Configured cost ceiling: $${manifest.config.maxCostUsd.toFixed(2)}
${checkWarning}

## Sessions

| Session | Profile | Status | Turns | Checks (rate) | Judge | Score | Cost |
|---|---|---:|---:|---:|---:|---:|---:|
${rows.join("\n") || "| _No completed sessions_ | | | | | | | |"}

## Failure fingerprints

${fingerprintReport || "_No structured-call failures._"}

## AI game evaluations

After a session reaches its configured turn limit or ends naturally, the same
provider/model used as dungeon master judges the complete transcript, committed
operations, and final persistent state. The structured result is saved as
\`evaluation.md\`. Technical failures do not receive a fictional-quality score.
`;
}

export async function generateEvaluationReport(runDir: string): Promise<string> {
  const manifest = await readEvaluationManifest(path.join(runDir, "manifest.json"));
  const metrics = manifest.sessions.flatMap((session) => (session.metrics ? [session.metrics] : []));
  await writeJson(path.join(runDir, "metrics.json"), {
    runId: manifest.runId,
    status: manifest.status,
    sessions: metrics,
    totalEstimatedCostUsd: manifest.totalEstimatedCostUsd,
  });
  const reportPath = path.join(runDir, "report.md");
  await writeFile(reportPath, runReport(manifest), "utf8");
  return reportPath;
}
