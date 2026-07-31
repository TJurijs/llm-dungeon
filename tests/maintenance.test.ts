import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, readdir, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { CampaignCatalog } from "../src/campaign-catalog.js";
import { DURABLE_TEXT_LIMITS } from "../src/domain/durable-state-policy.js";
import {
  createProjectBackup,
  formatDoctorReport,
  inspectProject,
  type BackupManifest,
} from "../src/maintenance.js";
import { capturePendingCommitPreimages, contentHash } from "../src/persistence/commit.js";
import {
  CAMPAIGN_MIGRATION_INTENT_FILE,
  CampaignMetadataSchema,
  CampaignMigrationIntentSchema,
} from "../src/persistence/campaign-catalog.js";
import { acquireFileLock } from "../src/persistence/lock.js";
import { CURRENT_PENDING_COMMIT_FORMAT_VERSION } from "../src/persistence/pending.js";
import { renderEntity, renderTurnLog } from "../src/persistence/markdown.js";
import type { ProviderConfig } from "../src/schemas.js";
import { NEW_CAMPAIGN_IMMUTABLE_CONTEXT_LIMITS, StateStore } from "../src/store.js";
import { setupFixture } from "./helpers.js";

const providerConfig: ProviderConfig = {
  provider: "gemini",
  model: "gemini-test",
  temperature: 0.8,
  maxOutputTokens: 4000,
};

const execFileAsync = promisify(execFile);

function setup(title: string) {
  return { ...structuredClone(setupFixture), campaignTitle: title };
}

async function projectFixture(): Promise<{
  root: string;
  catalog: CampaignCatalog;
}> {
  const root = await mkdtemp(path.join(tmpdir(), "llm-dungeon-maintenance-"));
  const catalog = new CampaignCatalog(path.join(root, "data"), {
    defaultProviderConfig: providerConfig,
  });
  return { root, catalog };
}

async function treeSnapshot(root: string): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  const visit = async (directory: string, prefix: string): Promise<void> => {
    const entries = (await readdir(directory, { withFileTypes: true })).sort((left, right) =>
      left.name.localeCompare(right.name),
    );
    for (const entry of entries) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      const target = path.join(directory, entry.name);
      if (entry.isDirectory()) await visit(target, relative);
      else snapshot[relative] = (await readFile(target)).toString("base64");
    }
  };
  await visit(root, "");
  return snapshot;
}

async function writePreparedCommit(currentDir: string, pendingPath: string): Promise<void> {
  const manifestPath = path.join(currentDir, "manifest.json");
  const manifestText = await readFile(manifestPath, "utf8");
  const manifest = JSON.parse(manifestText) as {
    campaignId: string;
    turn: number;
    updatedAt: string;
  };
  const targetTurn = manifest.turn + 1;
  const turnPath = `turns/${String(targetTurn).padStart(6, "0")}.md`;
  const writes = {
    [turnPath]: renderTurnLog(targetTurn, {
      action: "Continue the diagnostic fixture.",
      resolved: {
        narration: "The fixture remains stable.",
        turnSummary: "The fixture was inspected.",
        operations: [],
      },
      provider: "fake",
      model: "fake-model",
    }),
    "manifest.json": `${JSON.stringify({ ...manifest, turn: targetTurn }, null, 2)}\n`,
  };
  await writeFile(
    pendingPath,
    `${JSON.stringify(
      {
        kind: "commit",
        formatVersion: CURRENT_PENDING_COMMIT_FORMAT_VERSION,
        campaignId: manifest.campaignId,
        expectedPreviousTurn: manifest.turn,
        targetTurn,
        preManifestHash: contentHash(manifestText),
        writes,
        preimages: await capturePendingCommitPreimages(currentDir, writes),
      },
      null,
      2,
    )}\n`,
    "utf8",
  );
}

describe("project maintenance", () => {
  it("runs doctor without opening the project's .env", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "llm-dungeon-doctor-secret-boundary-"));
    // Reading a directory as an env file fails. Successful execution therefore
    // proves CLI bootstrap did not inspect this path before dispatching doctor.
    await mkdir(path.join(root, ".env"));
    const repositoryRoot = process.cwd();
    const { stdout } = await execFileAsync(
      process.execPath,
      [
        path.join(repositoryRoot, "node_modules", "tsx", "dist", "cli.mjs"),
        path.join(repositoryRoot, "src", "cli.ts"),
        "doctor",
      ],
      { cwd: root },
    );

    expect(stdout).toContain("No data directory exists");
  });

  it("validates campaigns and prepared recovery without mutating any artifact", async () => {
    const { root, catalog } = await projectFixture();
    const created = await catalog.createCampaign({
      setup: setup("Doctor Fixture"),
      worldRules: "Deterministic rules.",
    });
    await writePreparedCommit(created.store.currentDir, created.store.pendingPath);
    await writeFile(path.join(root, ".env"), "GEMINI_API_KEY=must-never-appear\n", "utf8");
    const before = await treeSnapshot(root);

    const report = await inspectProject(root);

    expect(report).toMatchObject({ healthy: true, campaignsInspected: 1, errorCount: 0 });
    expect(report.findings).toContainEqual(
      expect.objectContaining({
        severity: "warning",
        scope: `campaign/${created.campaignId}`,
        message: expect.stringContaining("Valid prepared commit for turn 1"),
      }),
    );
    expect(formatDoctorReport(report)).not.toContain("must-never-appear");
    expect(await treeSnapshot(root)).toEqual(before);
    expect(
      JSON.parse(await readFile(path.join(created.store.currentDir, "manifest.json"), "utf8")),
    ).toMatchObject({ turn: 0 });
    await expect(access(created.store.pendingPath)).resolves.toBeUndefined();
  });

  it("reports malformed pending state as an error and leaves it untouched", async () => {
    const { root, catalog } = await projectFixture();
    const created = await catalog.createCampaign({
      setup: setup("Broken Pending Fixture"),
      worldRules: "Deterministic rules.",
    });
    await writeFile(created.store.pendingPath, '{"kind":"commit","writes":{}}\n', "utf8");
    const before = await treeSnapshot(root);

    const report = await inspectProject(root);

    expect(report.healthy).toBe(false);
    expect(report.findings).toContainEqual(
      expect.objectContaining({
        severity: "error",
        message: expect.stringContaining("Pending turn is invalid"),
      }),
    );
    expect(await treeSnapshot(root)).toEqual(before);

    const target = path.join(root, "backups", "invalid");
    await expect(createProjectBackup(root, target)).rejects.toThrow(/Backup validation failed/);
    await expect(access(target)).rejects.toThrow();
    expect((await readdir(path.dirname(target))).some((name) => name.includes(".tmp-"))).toBe(
      false,
    );
  });

  it("warns about legacy context and durable fields that exceed new admission limits", async () => {
    const { root, catalog } = await projectFixture();
    const created = await catalog.createCampaign({
      setup: setup("Legacy Long Context"),
      worldRules: "Compact rules.",
      setupInput: { premise: "A compact premise.", character: "A compact hero." },
    });
    const loaded = await created.store.load();
    const player = loaded.entities.get(loaded.manifest.playerId)!;
    await writeFile(
      path.join(created.store.currentDir, "entities", loaded.entityFiles.get(player.id)!),
      renderEntity({
        ...player,
        description: "D".repeat(DURABLE_TEXT_LIMITS.entityDescription + 1),
      }),
      "utf8",
    );
    await writeFile(
      path.join(created.store.currentDir, "scenario.md"),
      `# Campaign Rules Snapshot\n\n${"W".repeat(
        NEW_CAMPAIGN_IMMUTABLE_CONTEXT_LIMITS.worldRules + 1,
      )}\n\n# Scenario\n\n${"S".repeat(NEW_CAMPAIGN_IMMUTABLE_CONTEXT_LIMITS.scenario + 1)}\n`,
      "utf8",
    );
    await writeFile(
      path.join(created.store.currentDir, "setup", "premise.md"),
      `${"P".repeat(NEW_CAMPAIGN_IMMUTABLE_CONTEXT_LIMITS.premise + 1)}\n`,
      "utf8",
    );
    const before = await treeSnapshot(root);

    const report = await inspectProject(root);

    expect(report.healthy).toBe(true);
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "warning",
          message: expect.stringContaining("world and DM style snapshot"),
        }),
        expect.objectContaining({
          severity: "warning",
          message: expect.stringContaining("generated scenario"),
        }),
        expect.objectContaining({
          severity: "warning",
          message: expect.stringContaining("starting premise"),
        }),
        expect.objectContaining({
          severity: "warning",
          message: expect.stringContaining(`entity ${player.id} description`),
        }),
      ]),
    );
    expect(await treeSnapshot(root)).toEqual(before);
  });

  it("treats malformed spending authority as an error without repairing it", async () => {
    const { root, catalog } = await projectFixture();
    const created = await catalog.createCampaign({
      setup: setup("Broken Spending"),
      worldRules: "Deterministic rules.",
    });
    await writeFile(
      path.join(created.store.dataRoot, "spending.json"),
      '{"schemaVersion":1,"limits":{"campaignUsd":-1}}\n',
      "utf8",
    );
    const before = await treeSnapshot(root);

    const report = await inspectProject(root);

    expect(report.healthy).toBe(false);
    expect(report.findings).toContainEqual(
      expect.objectContaining({
        severity: "error",
        scope: `campaign/${created.campaignId}/spending`,
        message: expect.stringContaining("Authoritative spending.json is invalid"),
      }),
    );
    expect(await treeSnapshot(root)).toEqual(before);
    await expect(
      createProjectBackup(root, path.join(root, "backups", "broken-spending")),
    ).rejects.toThrow(/Backup validation failed: .*spending\.json is invalid/);
  });

  it("reports unsettled reservations and archive-to-aggregate mismatches read-only", async () => {
    const { root, catalog } = await projectFixture();
    const created = await catalog.createCampaign({
      setup: setup("Unsettled Spending"),
      worldRules: "Deterministic rules.",
    });
    const reservedAt = "2026-07-29T12:00:00.000Z";
    const attemptId = "cbe31ff8-4bbb-48b1-bb1e-c5397ed8e9cc";
    const operationId = "turn:pending";
    await writeFile(
      path.join(created.store.dataRoot, "spending.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          limits: { campaignUsd: 2, logicalTurnUsd: 0.5 },
          baseline: { costUsd: 0, basis: "unpriced" },
          settled: {
            costUsd: 0,
            attempts: 0,
            exactAttempts: 0,
            estimatedAttempts: 0,
            reservedAttempts: 0,
            unpricedAttempts: 0,
          },
          operations: [
            {
              operationId,
              lane: "gameplay",
              sessionId: "interrupted-session",
              reservedAt,
              reservedUsd: 0.5,
              costUsd: 0,
            },
          ],
          recentOperations: [],
          attempts: [
            {
              id: attemptId,
              operationId,
              lane: "gameplay",
              provider: "gemini",
              model: "gemini-test",
              schemaName: "gameplay",
              sessionId: "interrupted-session",
              reservedAt,
              reservedUsd: 0.25,
              status: "reserved",
            },
          ],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await writeFile(
      path.join(created.store.dataRoot, "spending-attempts.jsonl"),
      `${JSON.stringify({
        id: "19e44b71-289d-44c9-88e9-1be519071d70",
        operationId: "turn:older",
        lane: "gameplay",
        provider: "gemini",
        model: "gemini-test",
        schemaName: "gameplay",
        sessionId: "older-session",
        reservedAt,
        reservedUsd: 0.25,
        status: "settled",
        settledAt: reservedAt,
        costUsd: 0.2,
        costBasis: "estimated",
        success: true,
      })}\n`,
      "utf8",
    );
    const before = await treeSnapshot(root);

    const report = await inspectProject(root);

    expect(report.healthy).toBe(true);
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          severity: "warning",
          message: expect.stringContaining("unsettled physical reservation"),
        }),
        expect.objectContaining({
          severity: "warning",
          message: expect.stringContaining("while spending.json aggregates"),
        }),
      ]),
    );
    expect(await treeSnapshot(root)).toEqual(before);
  });

  it("inspects a valid archived campaign spending ledger", async () => {
    const { root, catalog } = await projectFixture();
    const created = await catalog.createCampaign({
      setup: setup("Archived Spending"),
      worldRules: "Deterministic rules.",
    });
    await writeFile(
      path.join(created.store.dataRoot, "spending.json"),
      `${JSON.stringify(
        {
          schemaVersion: 1,
          limits: { campaignUsd: 1 },
          baseline: { costUsd: 0.1, basis: "estimated" },
          settled: {
            costUsd: 0,
            attempts: 0,
            exactAttempts: 0,
            estimatedAttempts: 0,
            reservedAttempts: 0,
            unpricedAttempts: 0,
          },
          operations: [],
          recentOperations: [],
          attempts: [],
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await catalog.archiveCampaign(created.campaignId);
    const before = await treeSnapshot(root);

    const report = await inspectProject(root);

    expect(report.healthy).toBe(true);
    expect(report.findings).toContainEqual(
      expect.objectContaining({
        severity: "ok",
        scope: `campaign/${created.campaignId}/spending`,
        message: expect.stringContaining("Spending ledger is valid"),
      }),
    );
    expect(await treeSnapshot(root)).toEqual(before);
  });

  it("rejects recoverable pending state inside a legacy archived campaign", async () => {
    const { root } = await projectFixture();
    const dataRoot = path.join(root, "data");
    const store = new StateStore(dataRoot);
    await store.createGame({
      setup: setup("Legacy Archived Pending Fixture"),
      worldRules: "Deterministic rules.",
    });
    await store.setPendingRequest({
      kind: "action",
      action: "Wait for another clue.",
      phase: "requested",
    });
    const archiveRoot = path.join(dataRoot, "archive");
    const archivedDirectory = path.join(archiveRoot, "legacy-pending");
    await mkdir(archiveRoot, { recursive: true });
    await rename(store.currentDir, archivedDirectory);
    const before = await treeSnapshot(root);

    const report = await inspectProject(root);

    expect(report).toMatchObject({ healthy: false, campaignsInspected: 1, errorCount: 1 });
    expect(report.findings).toContainEqual({
      severity: "error",
      scope: "legacy/archive/legacy-pending",
      message: "Archived campaign contains an unfinished pending turn",
    });
    expect(await treeSnapshot(root)).toEqual(before);

    const target = path.join(root, "backups", "legacy-archived-pending");
    await expect(createProjectBackup(root, target)).rejects.toThrow(
      /Backup validation failed: .*Archived campaign contains an unfinished pending turn/,
    );
    await expect(access(target)).rejects.toThrow();
    expect((await readdir(path.dirname(target))).some((name) => name.includes(".tmp-"))).toBe(
      false,
    );
  });

  it("rejects a schema-valid migration intent whose campaign has no source or target", async () => {
    const { root } = await projectFixture();
    const createdAt = "2026-07-28T12:00:00.000Z";
    const metadata = CampaignMetadataSchema.parse({
      schemaVersion: 1,
      campaignId: "campaign:missing-migration",
      registeredAt: createdAt,
      archived: false,
    });
    await mkdir(path.join(root, "data"), { recursive: true });
    await writeFile(
      path.join(root, "data", CAMPAIGN_MIGRATION_INTENT_FILE),
      `${JSON.stringify(
        CampaignMigrationIntentSchema.parse({
          schemaVersion: 1,
          createdAt,
          entries: [{ source: { kind: "current" }, metadata }],
        }),
        null,
        2,
      )}\n`,
      "utf8",
    );
    const before = await treeSnapshot(root);

    const report = await inspectProject(root);

    expect(report.healthy).toBe(false);
    expect(report.findings).toContainEqual(
      expect.objectContaining({
        severity: "error",
        scope: "catalog/migration",
        message: expect.stringContaining("neither its legacy source nor catalog target"),
      }),
    );
    expect(await treeSnapshot(root)).toEqual(before);
  });

  it("creates a validated snapshot with checksums and excludes secrets and ephemeral data", async () => {
    const { root, catalog } = await projectFixture();
    const first = await catalog.createCampaign({
      setup: setup("Backup One"),
      worldRules: "Rules one.",
    });
    await catalog.createCampaign({
      setup: setup("Backup Two"),
      worldRules: "Rules two.",
    });
    await first.store.setPendingRequest({
      kind: "action",
      action: "Wait here.",
      phase: "requested",
    });
    await mkdir(path.join(root, "config", "worlds"), { recursive: true });
    await writeFile(path.join(root, "config", "app.json"), '{"language":"en"}\n', "utf8");
    await writeFile(path.join(root, "config", "worlds", "en.md"), "# Custom world\n", "utf8");
    await writeFile(path.join(root, "config", ".env"), "SECRET=config-secret\n", "utf8");
    await writeFile(path.join(root, "config", "api-key.txt"), "config-secret\n", "utf8");
    await writeFile(path.join(root, ".env"), "SECRET=root-secret\n", "utf8");
    await mkdir(path.join(root, "data", ".drafts", "draft:test"), { recursive: true });
    await writeFile(path.join(root, "data", ".drafts", "draft:test", "note"), "discard", "utf8");
    const target = path.join(root, "backups", "fixture");

    const result = await createProjectBackup(root, target, {
      now: () => new Date("2026-07-28T12:00:00.000Z"),
    });

    expect(result.target).toBe(target);
    expect(result.doctor).toMatchObject({ healthy: true, campaignsInspected: 2 });
    expect(result.doctor.warningCount).toBeGreaterThan(0);
    await expect(access(path.join(target, "data", ".drafts"))).rejects.toThrow();
    await expect(access(path.join(target, "config", ".env"))).rejects.toThrow();
    await expect(access(path.join(target, "config", "api-key.txt"))).rejects.toThrow();
    await expect(access(path.join(target, ".env"))).rejects.toThrow();
    await expect(access(path.join(target, "config", "app.json"))).resolves.toBeUndefined();
    await expect(access(path.join(target, "config", "worlds", "en.md"))).resolves.toBeUndefined();
    expect((await treeSnapshot(target))["data/.campaign-catalog.lock"]).toBeUndefined();
    expect(
      Object.keys(await treeSnapshot(target)).some((name) => name.endsWith(".campaign.lock")),
    ).toBe(false);

    const manifest = JSON.parse(
      await readFile(path.join(target, "backup-manifest.json"), "utf8"),
    ) as BackupManifest;
    expect(manifest).toMatchObject({
      formatVersion: 1,
      createdAt: "2026-07-28T12:00:00.000Z",
      applicationVersion: "1.0.0",
      schemaVersions: { campaignManifest: 1, campaignCatalog: 1, pendingCommit: 2 },
    });
    expect(manifest.files.map((file) => file.path)).toEqual(
      [...manifest.files.map((file) => file.path)].sort(),
    );
    for (const file of manifest.files) {
      const contents = await readFile(path.join(target, ...file.path.split("/")));
      expect(file.bytes).toBe(contents.byteLength);
      expect(file.sha256).toBe(createHash("sha256").update(contents).digest("hex"));
    }
    expect((await inspectProject(target)).healthy).toBe(true);
  });

  it("refuses overlapping, existing, and concurrently locked backup targets without leftovers", async () => {
    const { root, catalog } = await projectFixture();
    const created = await catalog.createCampaign({
      setup: setup("Locked Backup"),
      worldRules: "Rules.",
    });
    await expect(createProjectBackup(root, path.join(root, "data", "backup"))).rejects.toThrow(
      /overlaps the project data directory/,
    );
    const existing = path.join(root, "existing");
    await mkdir(existing);
    await expect(createProjectBackup(root, existing)).rejects.toThrow(/already exists/);

    const target = path.join(root, "backups", "blocked");
    const release = await acquireFileLock(created.store.lockPath, "Test campaign");
    try {
      await expect(createProjectBackup(root, target, { lockWaitMs: 0 })).rejects.toThrow(
        /locked by another running process/,
      );
    } finally {
      await release();
    }
    await expect(access(target)).rejects.toThrow();

    const spendingTarget = path.join(root, "backups", "blocked-spending");
    const releaseSpending = await acquireFileLock(
      path.join(created.store.dataRoot, ".spending.lock"),
      "Test campaign spending",
    );
    try {
      await expect(createProjectBackup(root, spendingTarget, { lockWaitMs: 0 })).rejects.toThrow(
        /locked by another running process/,
      );
    } finally {
      await releaseSpending();
    }
    await expect(access(spendingTarget)).rejects.toThrow();
    await expect(access(path.join(root, "data", ".campaign.lock"))).rejects.toThrow();
    await expect(access(path.join(root, "data", ".campaign-catalog.lock"))).rejects.toThrow();
    await expect(access(path.join(created.store.dataRoot, ".spending.lock"))).rejects.toThrow();
    const backupParentEntries = await readdir(path.dirname(target));
    expect(backupParentEntries.some((name) => name.includes(".tmp-"))).toBe(false);
  });
});
