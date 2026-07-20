import { describe, expect, it } from "vitest";
import { CampaignTurnScheduler, PlaytestProviderScheduler } from "../tools/playtest/harness/scheduler.js";
import { PlaytestCostLimitError, PlaytestCostManager } from "../tools/playtest/harness/cost.js";

describe("playtest scheduling", () => {
  it("enforces provider-specific limits while allowing independent providers", async () => {
    const scheduler = new PlaytestProviderScheduler(4, { gemini: 1, openai: 2 });
    const active = new Map<string, number>();
    const maximum = new Map<string, number>();
    const call = (provider: string) => scheduler.schedule(provider, async () => {
      const next = (active.get(provider) ?? 0) + 1;
      active.set(provider, next);
      maximum.set(provider, Math.max(maximum.get(provider) ?? 0, next));
      await new Promise((resolve) => setTimeout(resolve, 10));
      active.set(provider, next - 1);
      return provider;
    });

    await Promise.all([
      call("gemini"), call("gemini"), call("gemini"),
      call("openai"), call("openai"), call("openai"),
    ]);

    expect(maximum.get("gemini")).toBe(1);
    expect(maximum.get("openai")).toBe(2);
  });

  it("does not let calls queued in one provider pool occupy global permits", async () => {
    const scheduler = new PlaytestProviderScheduler(2, { gemini: 1, openai: 1 });
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const first = scheduler.schedule("gemini", async () => {
      await firstGate;
      return "first";
    });
    const queuedA = scheduler.schedule("gemini", async () => "second");
    const independent = scheduler.schedule("openai", async () => "independent");

    await expect(independent).resolves.toMatchObject({ value: "independent" });
    releaseFirst();
    await expect(Promise.all([first, queuedA])).resolves.toHaveLength(2);
  });

  it("never executes two turns from one campaign concurrently", async () => {
    const scheduler = new CampaignTurnScheduler();
    let activeA = 0;
    let maxA = 0;
    let activeB = 0;
    let sawIndependentOverlap = false;
    const turn = (campaignId: string) => scheduler.run(campaignId, async () => {
      if (campaignId === "campaign-a") {
        activeA += 1;
        maxA = Math.max(maxA, activeA);
        if (activeB > 0) sawIndependentOverlap = true;
      } else {
        activeB += 1;
        if (activeA > 0) sawIndependentOverlap = true;
      }
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (campaignId === "campaign-a") activeA -= 1;
      else activeB -= 1;
    });

    await Promise.all([turn("campaign-a"), turn("campaign-a"), turn("campaign-b")]);
    expect(maxA).toBe(1);
    expect(sawIndependentOverlap).toBe(true);
  });
});

describe("shared playtest cost manager", () => {
  it("reserves across lanes and stops new calls after the ceiling is committed", async () => {
    const budget = new PlaytestCostManager(0.01);
    const first = await budget.acquire(0.006);
    let secondResolved = false;
    const second = budget.acquire(0.006).then((token) => {
      secondResolved = true;
      return token;
    });
    await Promise.resolve();
    expect(secondResolved).toBe(false);
    budget.commit(first, 0.004);
    const secondToken = await second;
    budget.commit(secondToken, 0.006);
    await expect(budget.acquire(0.001)).rejects.toBeInstanceOf(PlaytestCostLimitError);
    expect(budget.spentUsd).toBe(0.01);
  });

  it("never starts a call whose reservation exceeds the remaining hard ceiling", async () => {
    const budget = new PlaytestCostManager(0.01);
    await expect(budget.acquire(0.011)).rejects.toBeInstanceOf(PlaytestCostLimitError);

    const active = await budget.acquire(0.006);
    const waiting = budget.acquire(0.006);
    budget.commit(active, 0.005);
    await expect(waiting).rejects.toBeInstanceOf(PlaytestCostLimitError);
    expect(budget.spentUsd).toBe(0.005);
  });
});
