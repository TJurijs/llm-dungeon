import { describe, expect, it } from "vitest";
import { CampaignOperationCoordinator } from "../src/web/campaign-operations.js";

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

describe("campaign operation coordination", () => {
  it("allows different campaigns to run concurrently while rejecting overlap within one campaign", async () => {
    const coordinator = new CampaignOperationCoordinator(2);
    const first = deferred();
    const second = deferred();
    let started = 0;

    const a = coordinator.run("campaign:a", async () => {
      started += 1;
      await first.promise;
      return "a";
    });
    const b = coordinator.run("campaign:b", async () => {
      started += 1;
      await second.promise;
      return "b";
    });

    await Promise.resolve();
    expect(started).toBe(2);
    expect(coordinator.isBusy("campaign:a")).toBe(true);
    await expect(coordinator.run("campaign:a", async () => "duplicate"))
      .rejects.toThrow("Another operation is still running for this campaign");

    first.resolve();
    second.resolve();
    await expect(Promise.all([a, b])).resolves.toEqual(["a", "b"]);
    expect(coordinator.isBusy("campaign:a")).toBe(false);
  });

  it("queues excess campaigns and releases capacity after failures", async () => {
    const coordinator = new CampaignOperationCoordinator(1);
    const gate = deferred();
    const order: string[] = [];
    const first = coordinator.run("campaign:a", async () => {
      order.push("a:start");
      await gate.promise;
      order.push("a:end");
      throw new Error("failed");
    });
    const second = coordinator.run("campaign:b", async () => {
      order.push("b:start");
      return "ok";
    });

    await Promise.resolve();
    expect(order).toEqual(["a:start"]);
    expect(coordinator.isBusy("campaign:b")).toBe(true);
    gate.resolve();
    await expect(first).rejects.toThrow("failed");
    await expect(second).resolves.toBe("ok");
    expect(order).toEqual(["a:start", "a:end", "b:start"]);
  });

  it("hands a released permit directly to the oldest queued campaign", async () => {
    const coordinator = new CampaignOperationCoordinator(1);
    const firstGate = deferred();
    const secondGate = deferred();
    let active = 0;
    let maximumActive = 0;
    const run = (campaignId: string, gate?: ReturnType<typeof deferred>) => coordinator.run(campaignId, async () => {
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      if (gate) await gate.promise;
      active -= 1;
    });

    const first = run("campaign:a", firstGate);
    const second = run("campaign:b", secondGate);
    await Promise.resolve();
    firstGate.resolve();
    const third = run("campaign:c");
    await first;
    await Promise.resolve();
    expect(active).toBe(1);
    secondGate.resolve();
    await Promise.all([second, third]);
    expect(maximumActive).toBe(1);
  });
});
