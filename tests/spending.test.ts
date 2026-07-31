import { appendFile, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { GenerationFailure } from "../src/llm/failures.js";
import { StructuredClient } from "../src/llm/structured-generation.js";
import {
  BudgetedProvider,
  CampaignBudgetExhaustedError,
  CampaignSpendingController,
  CampaignSpendingTransferPayloadSchema,
  runWithReservedSpendingOperation,
  runWithSpendingOperation,
} from "../src/spending.js";
import type {
  LlmProvider,
  ProviderAttemptMetadata,
  StructuredRequest,
  StructuredResult,
} from "../src/types.js";

const AnswerSchema = z.object({ answer: z.string() });
const PRICE = { inputPerMillion: 1, outputPerMillion: 1 } as const;

function attemptMetadata(
  overrides: Partial<ProviderAttemptMetadata> = {},
): ProviderAttemptMetadata {
  return {
    provider: "custom",
    model: "priced-test-model",
    route: "direct",
    generationPhase: "decision",
    attemptKind: "initial",
    profileFingerprint: "profile-fingerprint",
    structuredMode: "exact_schema",
    schemaProjection: "identity_v1",
    outputTokenField: "max_tokens",
    outputTokenBudget: 1_000,
    timeoutMs: 30_000,
    retryBackoffMs: 125,
    finishReason: "stop",
    truncated: false,
    ...overrides,
  };
}

async function temporaryController(
  options: ConstructorParameters<typeof CampaignSpendingController>[1] = {},
): Promise<CampaignSpendingController> {
  const root = await mkdtemp(path.join(tmpdir(), "llm-dungeon-spending-"));
  return new CampaignSpendingController(root, options);
}

function request(prompt = "prompt"): StructuredRequest<{ answer: string }> {
  return {
    schemaName: "answer",
    schema: AnswerSchema,
    system: "system",
    prompt,
    generationPhase: "decision",
  };
}

function provider(generate: LlmProvider["generateStructured"], outputBudget = 1_000): LlmProvider {
  return {
    id: "custom",
    model: "priced-test-model",
    effectiveOutputTokenBudget: () => outputBudget,
    generateStructured: generate,
  };
}

describe("campaign spending", () => {
  it("rejects an unaffordable physical call before the provider and delegates output budget", async () => {
    const spending = await temporaryController();
    await spending.updateCampaignBudget({ campaignUsd: 0.005 });
    let providerCalls = 0;
    const base = provider(async () => {
      providerCalls += 1;
      throw new Error("must not run");
    });
    const budgeted = new BudgetedProvider(base, spending, { price: PRICE });

    expect(budgeted.effectiveOutputTokenBudget({ generationPhase: "decision" })).toBe(1_000);
    await expect(budgeted.generateStructured(request())).rejects.toMatchObject({
      code: "campaign_budget_exhausted",
      reason: "campaign_limit",
    });
    expect(providerCalls).toBe(0);
    expect(await spending.campaignBudget()).toMatchObject({
      spentUsd: 0,
      reservedUsd: 0,
      paused: true,
      pauseReason: "campaign_limit",
      settledAttempts: 0,
      unsettledAttempts: 0,
    });
    expect(await spending.acknowledgePricingChange()).toMatchObject({
      paused: true,
      pauseReason: "campaign_limit",
    });
  });

  it("accounts every retry separately while sharing the logical-turn cap", async () => {
    const spending = await temporaryController();
    await spending.updateCampaignBudget({ logicalTurnUsd: 0.012 });
    let providerCalls = 0;
    const base = provider(async () => {
      providerCalls += 1;
      throw new GenerationFailure("network", "temporary", true);
    });
    const budgeted = new BudgetedProvider(base, spending, { price: PRICE });

    await expect(
      runWithSpendingOperation({ operationId: "turn-7", lane: "gameplay" }, () =>
        new StructuredClient(budgeted).generate(request(), { transientDelayMs: 0 }),
      ),
    ).rejects.toBeInstanceOf(CampaignBudgetExhaustedError);

    expect(providerCalls).toBe(1);
    expect(await spending.campaignBudget()).toMatchObject({
      settledAttempts: 1,
      unsettledAttempts: 0,
      paused: true,
      pauseReason: "logical_turn_limit",
      basis: "reserved",
    });
  });

  it("accounts a content repair as a distinct physical attempt", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "llm-dungeon-content-repair-spending-"));
    const spending = new CampaignSpendingController(root);
    let calls = 0;
    const base = provider(async <T>(input: StructuredRequest<T>): Promise<StructuredResult<T>> => {
      calls += 1;
      if (calls === 1) {
        throw new GenerationFailure("content_block", "blocked fictional output", false);
      }
      return {
        data: input.schema.parse({ answer: "ok" }),
        provider: "custom",
        model: "priced-test-model",
      };
    });

    await runWithSpendingOperation({ operationId: "turn-content", lane: "gameplay" }, () =>
      new StructuredClient(new BudgetedProvider(base, spending, { price: PRICE })).generate(
        request(),
      ),
    );

    const attempts = (await readFile(path.join(root, "spending-attempts.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line) as { attemptKind?: string; success?: boolean });
    expect(attempts).toMatchObject([
      { attemptKind: "initial", success: false },
      { attemptKind: "content_repair", success: true },
    ]);
    expect(await spending.campaignBudget()).toMatchObject({ settledAttempts: 2 });
  });

  it("uses exact billed cost, token-price estimates, and permits unpriced calls without caps", async () => {
    const spending = await temporaryController();
    let call = 0;
    const base = provider(async <T>(input: StructuredRequest<T>): Promise<StructuredResult<T>> => {
      call += 1;
      return {
        data: input.schema.parse({ answer: "ok" }),
        provider: "custom",
        model: "priced-test-model",
        usage:
          call === 1
            ? { inputTokens: 500, outputTokens: 100, billedCostUsd: 0.004 }
            : { inputTokens: 1_000, outputTokens: 200 },
      };
    });
    const budgeted = new BudgetedProvider(base, spending, { price: PRICE });
    await budgeted.generateStructured(request());
    await budgeted.generateStructured(request());

    expect(await spending.campaignBudget()).toMatchObject({
      spentUsd: 0.0052,
      basis: "mixed",
      settledAttempts: 2,
      unsettledAttempts: 0,
    });

    const unpricedSpending = await temporaryController();
    const unpriced = new BudgetedProvider(
      provider(async <T>(input: StructuredRequest<T>): Promise<StructuredResult<T>> => ({
        data: input.schema.parse({ answer: "ok" }),
        provider: "custom",
        model: "unknown-model",
      })),
      unpricedSpending,
    );
    await expect(unpriced.generateStructured(request())).resolves.toMatchObject({
      data: { answer: "ok" },
    });
    expect(await unpricedSpending.campaignBudget()).toMatchObject({
      spentUsd: 0,
      basis: "unpriced",
      settledAttempts: 1,
    });
    await unpricedSpending.updateCampaignBudget({ campaignUsd: 0.02 });
    await expect(
      runWithReservedSpendingOperation(
        unpricedSpending,
        { operationId: "unpriced-turn", lane: "gameplay" },
        () => unpriced.generateStructured(request()),
      ),
    ).rejects.toMatchObject({ reason: "pricing_unavailable" });
    expect(await unpricedSpending.campaignBudget()).toMatchObject({
      paused: true,
      pauseReason: "pricing_unavailable",
    });
    await unpricedSpending.updateCampaignBudget({ campaignUsd: null });
    expect(await unpricedSpending.campaignBudget()).toMatchObject({
      paused: false,
      pauseReason: null,
    });
  });

  it("charges a foreign-session reservation conservatively after a crash", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "llm-dungeon-spending-crash-"));
    const beforeCrash = new CampaignSpendingController(root, { sessionId: "session-before" });
    await runWithSpendingOperation({ operationId: "turn-crash", lane: "gameplay" }, () =>
      beforeCrash.reserve({
        provider: "custom",
        model: "priced-test-model",
        schemaName: "answer",
        reservedUsd: 0.009,
        priced: true,
      }),
    );

    expect(await beforeCrash.campaignBudget()).toMatchObject({
      spentUsd: 0,
      reservedUsd: 0.009,
      unsettledAttempts: 1,
    });
    const afterCrash = new CampaignSpendingController(root, { sessionId: "session-after" });
    expect(await afterCrash.campaignBudget()).toMatchObject({
      spentUsd: 0.009,
      reservedUsd: 0,
      basis: "reserved",
      settledAttempts: 1,
      unsettledAttempts: 0,
    });
    const archived = JSON.parse((await readFile(afterCrash.archivePath, "utf8")).trim()) as {
      status: string;
      costBasis: string;
      success: boolean;
    };
    expect(archived).toMatchObject({ status: "settled", costBasis: "reserved", success: false });
  });

  it("recovers an exact journaled settlement once after append-before-aggregate interruption", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "llm-dungeon-spending-journal-"));
    const beforeCrash = new CampaignSpendingController(root, { sessionId: "journal-before" });
    const reservation = await runWithSpendingOperation(
      { operationId: "journaled-turn", lane: "gameplay" },
      () =>
        beforeCrash.reserve({
          provider: "custom",
          model: "priced-test-model",
          schemaName: "answer",
          outputTokenBudget: 1_000,
          retryBackoffMs: 0,
          reservedUsd: 0.009,
          priced: true,
        }),
    );
    const ledger = JSON.parse(await readFile(beforeCrash.ledgerPath, "utf8")) as {
      attempts: Array<Record<string, unknown>>;
    };
    const hot = ledger.attempts.find((attempt) => attempt.id === reservation.id);
    expect(hot).toBeDefined();
    await appendFile(
      beforeCrash.archivePath,
      `${JSON.stringify({
        ...hot,
        status: "settled",
        settledAt: "2026-07-29T12:00:00.000Z",
        costUsd: 0.002,
        costBasis: "exact",
        success: true,
      })}\n`,
      "utf8",
    );

    const afterCrash = new CampaignSpendingController(root, { sessionId: "journal-after" });
    expect(await afterCrash.campaignBudget()).toMatchObject({
      spentUsd: 0.002,
      reservedUsd: 0,
      basis: "exact",
      settledAttempts: 1,
      unsettledAttempts: 0,
    });
    expect((await readFile(afterCrash.archivePath, "utf8")).trim().split("\n")).toHaveLength(1);
    expect(await afterCrash.campaignBudget()).toMatchObject({
      spentUsd: 0.002,
      settledAttempts: 1,
    });
  });

  it("acknowledges only a stale pricing pause and re-pauses before the next unpriced call", async () => {
    const spending = await temporaryController();
    await spending.updateCampaignBudget({ campaignUsd: 1 });
    let providerCalls = 0;
    const unpriced = new BudgetedProvider(
      provider(async <T>(input: StructuredRequest<T>): Promise<StructuredResult<T>> => {
        providerCalls += 1;
        return {
          data: input.schema.parse({ answer: "ok" }),
          provider: "custom",
          model: "unknown-model",
        };
      }),
      spending,
    );

    await expect(unpriced.generateStructured(request())).rejects.toMatchObject({
      reason: "pricing_unavailable",
    });
    expect(await spending.acknowledgePricingChange()).toMatchObject({
      paused: false,
      pauseReason: null,
    });
    await expect(unpriced.generateStructured(request())).rejects.toMatchObject({
      reason: "pricing_unavailable",
    });
    expect(providerCalls).toBe(0);
    expect(await spending.campaignBudget()).toMatchObject({
      paused: true,
      pauseReason: "pricing_unavailable",
    });
  });

  it("serializes concurrent reservations so only one can consume the remaining cap", async () => {
    const spending = await temporaryController();
    await spending.updateCampaignBudget({ campaignUsd: 0.01 });
    let providerCalls = 0;
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => {
      release = resolve;
    });
    const base = provider(async <T>(input: StructuredRequest<T>): Promise<StructuredResult<T>> => {
      providerCalls += 1;
      await blocked;
      return {
        data: input.schema.parse({ answer: "ok" }),
        provider: "custom",
        model: "priced-test-model",
        usage: { billedCostUsd: 0.002 },
      };
    });
    const budgeted = new BudgetedProvider(base, spending, { price: PRICE });
    const first = runWithSpendingOperation({ operationId: "turn-a", lane: "gameplay" }, () =>
      budgeted.generateStructured(request()),
    );
    while (providerCalls === 0) await new Promise((resolve) => setTimeout(resolve, 0));

    await expect(
      runWithSpendingOperation({ operationId: "turn-b", lane: "gameplay" }, () =>
        budgeted.generateStructured(request()),
      ),
    ).rejects.toBeInstanceOf(CampaignBudgetExhaustedError);
    expect(providerCalls).toBe(1);
    release();
    await first;
  });

  it("holds a whole-turn envelope across decision and resolution, then releases the remainder", async () => {
    const spending = await temporaryController();
    await spending.updateCampaignBudget({ campaignUsd: 0.02, logicalTurnUsd: 0.015 });
    const base = provider(async <T>(input: StructuredRequest<T>): Promise<StructuredResult<T>> => ({
      data: input.schema.parse({ answer: "ok" }),
      provider: "custom",
      model: "priced-test-model",
      usage: { billedCostUsd: 0.002 },
    }));
    const budgeted = new BudgetedProvider(base, spending, {
      price: { inputPerMillion: 0.5, outputPerMillion: 0.5 },
    });

    await runWithReservedSpendingOperation(
      spending,
      { operationId: "checked-turn", lane: "gameplay" },
      async () => {
        expect(await spending.campaignBudget()).toMatchObject({ reservedUsd: 0.015 });
        await budgeted.generateStructured(request());
        await budgeted.generateStructured(request());
        expect(await spending.campaignBudget()).toMatchObject({
          spentUsd: 0.004,
          reservedUsd: 0.011,
        });
      },
    );

    expect(await spending.campaignBudget()).toMatchObject({
      spentUsd: 0.004,
      reservedUsd: 0,
      projectedNextTurnUsd: 0.004,
      projected100TurnsUsd: 0.4,
      paused: false,
    });
  });

  it("retains prior physical cost when the same pending operation resumes", async () => {
    const spending = await temporaryController();
    await spending.updateCampaignBudget({ logicalTurnUsd: 0.012 });
    let providerCalls = 0;
    const base = provider(async <T>(input: StructuredRequest<T>): Promise<StructuredResult<T>> => {
      providerCalls += 1;
      if (providerCalls === 1) throw new GenerationFailure("network", "interrupted", true);
      return {
        data: input.schema.parse({ answer: "ok" }),
        provider: "custom",
        model: "priced-test-model",
        usage: { billedCostUsd: 0.001 },
      };
    });
    const budgeted = new BudgetedProvider(base, spending, { price: PRICE });
    const operation = { operationId: "durable-pending-turn", lane: "gameplay" } as const;

    await expect(
      runWithReservedSpendingOperation(spending, operation, () =>
        budgeted.generateStructured(request()),
      ),
    ).rejects.toThrow("interrupted");
    expect(await spending.campaignBudget()).toMatchObject({
      spentUsd: 0.009014,
      settledAttempts: 1,
    });

    await spending.updateCampaignBudget({ logicalTurnUsd: 0.015 });
    expect(await spending.campaignBudget()).toMatchObject({ paused: false, pauseReason: null });
    await expect(
      runWithReservedSpendingOperation(spending, operation, () =>
        budgeted.generateStructured(request()),
      ),
    ).rejects.toMatchObject({ reason: "logical_turn_limit" });
    expect(providerCalls).toBe(1);

    await spending.updateCampaignBudget({ logicalTurnUsd: 0.02 });
    await expect(
      runWithReservedSpendingOperation(spending, operation, () =>
        budgeted.generateStructured(request()),
      ),
    ).resolves.toMatchObject({ data: { answer: "ok" } });
    expect(providerCalls).toBe(2);
    expect(await spending.campaignBudget()).toMatchObject({
      spentUsd: 0.010014,
      settledAttempts: 2,
    });
  });

  it("does not apply the logical-turn cap to questions and resumes after raising a campaign cap", async () => {
    const spending = await temporaryController();
    await spending.updateCampaignBudget({ campaignUsd: 0.005, logicalTurnUsd: 0.001 });
    let calls = 0;
    const base = provider(async <T>(input: StructuredRequest<T>): Promise<StructuredResult<T>> => {
      calls += 1;
      return {
        data: input.schema.parse({ answer: "ok" }),
        provider: "custom",
        model: "priced-test-model",
        usage: { billedCostUsd: 0.002 },
      };
    });
    const budgeted = new BudgetedProvider(base, spending, { price: PRICE });

    await expect(
      runWithSpendingOperation({ lane: "question" }, () => budgeted.generateStructured(request())),
    ).rejects.toMatchObject({ reason: "campaign_limit" });
    await spending.updateCampaignBudget({ campaignUsd: 0.02 });
    await expect(
      runWithSpendingOperation({ lane: "question" }, () => budgeted.generateStructured(request())),
    ).resolves.toMatchObject({ data: { answer: "ok" } });
    expect(calls).toBe(1);
    expect(await spending.campaignBudget()).toMatchObject({ paused: false, pauseReason: null });
  });

  it("keeps the hot snapshot bounded while appending settled attempt details", async () => {
    const spending = await temporaryController();
    const base = provider(async <T>(input: StructuredRequest<T>): Promise<StructuredResult<T>> => ({
      data: input.schema.parse({ answer: "ok" }),
      provider: "custom",
      model: "priced-test-model",
      usage: { billedCostUsd: 0.0001 },
    }));
    const budgeted = new BudgetedProvider(base, spending, { price: PRICE });
    for (let turn = 1; turn <= 40; turn += 1) {
      await runWithReservedSpendingOperation(
        spending,
        { operationId: `turn-${turn}`, lane: "gameplay", reservationUsd: 0.01 },
        () => budgeted.generateStructured(request()),
      );
    }

    const ledger = JSON.parse(await readFile(spending.ledgerPath, "utf8")) as {
      attempts: unknown[];
      operations: unknown[];
      recentOperations: unknown[];
    };
    expect(ledger.attempts).toHaveLength(0);
    expect(ledger.operations).toHaveLength(0);
    expect(ledger.recentOperations).toHaveLength(16);
    expect((await readFile(spending.archivePath, "utf8")).trim().split("\n")).toHaveLength(40);
    expect(await spending.campaignBudget()).toMatchObject({ settledAttempts: 40 });
  });

  it("exports and idempotently imports a secret-free physical-attempt ledger", async () => {
    const sourceRoot = await mkdtemp(path.join(tmpdir(), "llm-dungeon-spending-source-"));
    let sourceHistoricalReads = 0;
    const source = new CampaignSpendingController(sourceRoot, {
      historicalCost: async () => {
        sourceHistoricalReads += 1;
        return { totalUsd: 0.003, basis: "estimated" };
      },
    });
    await source.updateCampaignBudget({ campaignUsd: 0.02, logicalTurnUsd: 0.01 });
    const base = provider(async <T>(input: StructuredRequest<T>): Promise<StructuredResult<T>> => ({
      data: input.schema.parse({ answer: "ok" }),
      provider: "custom",
      model: "priced-test-model",
      rawText: "RAW_RESPONSE_SECRET_SENTINEL",
      requestDiagnostics: {
        timestamp: "2026-07-29T12:00:00.000Z",
        provider: "custom",
        model: "priced-test-model",
        clientRequestId: "private-correlation-id",
        rateLimitHeaders: { "x-ratelimit-secret": "HEADER_SECRET_SENTINEL" },
      },
      usage: { billedCostUsd: 0.002 },
      attemptMetadata: attemptMetadata(),
    }));
    await new BudgetedProvider(base, source, { price: PRICE }).generateStructured(
      request("PROMPT_SECRET_SENTINEL"),
    );

    const payload = await source.exportTransferPayload();
    expect(sourceHistoricalReads).toBe(1);
    expect(
      CampaignSpendingTransferPayloadSchema.parse(JSON.parse(JSON.stringify(payload))),
    ).toEqual(payload);
    expect(payload).toMatchObject({
      schemaVersion: 1,
      limits: { campaignUsd: 0.02, logicalTurnUsd: 0.01 },
      baseline: { costUsd: 0.003, basis: "estimated" },
      settled: { costUsd: 0.002, attempts: 1, exactAttempts: 1 },
      attempts: [
        {
          generationPhase: "decision",
          attemptKind: "initial",
          route: "direct",
          profileFingerprint: "profile-fingerprint",
          structuredMode: "exact_schema",
          schemaProjection: "identity_v1",
          outputTokenField: "max_tokens",
          outputTokenBudget: 1_000,
          timeoutMs: 30_000,
          retryBackoffMs: 125,
          finishReason: "stop",
          truncated: false,
        },
      ],
    });
    const serialized = JSON.stringify(payload);
    expect(serialized).not.toContain("PROMPT_SECRET_SENTINEL");
    expect(serialized).not.toContain("RAW_RESPONSE_SECRET_SENTINEL");
    expect(serialized).not.toContain("HEADER_SECRET_SENTINEL");
    expect(() =>
      CampaignSpendingTransferPayloadSchema.parse({ ...payload, rawText: "forbidden" }),
    ).toThrow();

    const destinationRoot = await mkdtemp(path.join(tmpdir(), "llm-dungeon-spending-destination-"));
    let destinationHistoricalReads = 0;
    const destination = new CampaignSpendingController(destinationRoot, {
      historicalCost: async () => {
        destinationHistoricalReads += 1;
        return { totalUsd: 0.003, basis: "estimated" };
      },
    });
    // Simulate a crash after the destination journal append but before its
    // aggregate ledger replacement; import must adopt the same attempt once.
    await appendFile(
      destination.archivePath,
      `${JSON.stringify({
        ...payload.attempts[0],
        sessionId: "transferred",
        status: "settled",
      })}\n`,
      "utf8",
    );
    expect(await destination.importTransferPayload(payload)).toMatchObject({
      limits: { campaignUsd: 0.02, logicalTurnUsd: 0.01 },
      spentUsd: 0.005,
      basis: "mixed",
      settledAttempts: 1,
    });
    expect(destinationHistoricalReads).toBe(0);
    expect(await destination.importTransferPayload(payload)).toMatchObject({
      spentUsd: 0.005,
      settledAttempts: 1,
    });
    expect((await readFile(destination.archivePath, "utf8")).trim().split("\n")).toHaveLength(1);

    await expect(
      destination.importTransferPayload({
        ...payload,
        baseline: { ...payload.baseline, costUsd: 0.004 },
      }),
    ).rejects.toThrow(/different spending transfer/i);
  });
});
