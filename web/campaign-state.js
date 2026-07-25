const STATE_VIEWS = ["character", "location", "threads"];

function validCampaignState(state) {
  return (
    state &&
    typeof state === "object" &&
    typeof state.revision === "string" &&
    state.revision.length > 0 &&
    STATE_VIEWS.every((view) => state[view]?.view === view)
  );
}

export function campaignRevision(campaign) {
  if (!campaign) return "";
  if (typeof campaign.stateRevision === "string" && campaign.stateRevision) {
    return campaign.stateRevision;
  }
  return `${campaign.turn ?? ""}:${campaign.updatedAt ?? ""}`;
}

/**
 * Keeps one coherent player-safe snapshot per campaign and one request per
 * expected revision. Invalidating a campaign preserves its stale snapshot for
 * display while preventing an older in-flight response from replacing it.
 */
export class CampaignStateCache {
  constructor() {
    this.entries = new Map();
    this.loads = new Map();
    this.generations = new Map();
  }

  get(campaignId) {
    return this.entries.get(campaignId) ?? null;
  }

  isFresh(campaignId, expectedRevision) {
    const cached = this.get(campaignId);
    return Boolean(cached && (!expectedRevision || cached.revision === expectedRevision));
  }

  invalidate(campaignId) {
    this.generations.set(campaignId, (this.generations.get(campaignId) ?? 0) + 1);
  }

  remove(campaignId) {
    this.invalidate(campaignId);
    this.entries.delete(campaignId);
    this.loads.delete(campaignId);
  }

  /**
   * @param {string} campaignId
   * @param {string} expectedRevision
   * @param {() => Promise<{state: unknown}>} fetchState
   */
  async refresh(campaignId, expectedRevision, fetchState) {
    const cached = this.get(campaignId);
    if (cached && (!expectedRevision || cached.revision === expectedRevision)) return cached;

    let generation = this.generations.get(campaignId) ?? 0;
    const active = this.loads.get(campaignId);
    if (
      active &&
      active.generation === generation &&
      active.expectedRevision === expectedRevision
    ) {
      return active.promise;
    }
    if (active) {
      generation += 1;
      this.generations.set(campaignId, generation);
    }

    const promise = Promise.resolve()
      .then(fetchState)
      .then((body) => {
        const state = /** @type {any} */ (body?.state);
        if (!validCampaignState(state)) throw new Error("Campaign state response is invalid");
        if ((this.generations.get(campaignId) ?? 0) !== generation) {
          return this.get(campaignId);
        }
        this.entries.set(campaignId, state);
        return state;
      });
    this.loads.set(campaignId, { expectedRevision, generation, promise });
    try {
      return await promise;
    } finally {
      if (this.loads.get(campaignId)?.promise === promise) this.loads.delete(campaignId);
    }
  }
}

export function scheduleIdleTask(callback, environment = globalThis) {
  if (typeof environment.requestIdleCallback === "function") {
    const handle = environment.requestIdleCallback(callback, { timeout: 1000 });
    return () => environment.cancelIdleCallback?.(handle);
  }
  const handle = environment.setTimeout(callback, 0);
  return () => environment.clearTimeout(handle);
}
