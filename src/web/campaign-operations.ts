/**
 * Serializes mutations per campaign while allowing a bounded number of
 * different campaigns to generate concurrently.
 */
export class CampaignOperationCoordinator {
  private readonly busyCampaigns = new Set<string>();
  private readonly waiters: Array<() => void> = [];
  private active = 0;

  constructor(private readonly maxConcurrent = 3) {
    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
      throw new Error("Campaign concurrency must be a positive integer");
    }
  }

  isBusy(campaignId: string): boolean {
    return this.busyCampaigns.has(campaignId);
  }

  private async acquire(): Promise<void> {
    if (this.active < this.maxConcurrent) {
      this.active += 1;
      return;
    }
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  private release(): void {
    const next = this.waiters.shift();
    if (next) next();
    else this.active -= 1;
  }

  async run<T>(campaignId: string, operation: () => Promise<T>): Promise<T> {
    if (this.busyCampaigns.has(campaignId)) {
      throw new Error("Another operation is still running for this campaign");
    }
    this.busyCampaigns.add(campaignId);
    try {
      await this.acquire();
      try {
        return await operation();
      } finally {
        this.release();
      }
    } finally {
      this.busyCampaigns.delete(campaignId);
    }
  }
}
