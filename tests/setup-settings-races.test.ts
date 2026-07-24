import { afterEach, describe, expect, it, vi } from "vitest";
import { createSetupSettingsController } from "../web/setup-settings.js";

type Listener = (event: {
  target: FakeElement | { closest: (selector: string) => unknown };
}) => void;

class FakeElement {
  readonly listeners = new Map<string, Listener[]>();
  value = "";

  constructor(readonly id: string) {}

  addEventListener(type: string, listener: Listener): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(
    type: string,
    target: Listener extends (event: infer Event) => void ? Event["target"] : never = this,
  ): void {
    for (const listener of this.listeners.get(type) ?? []) listener({ target });
  }
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("campaign setup request ordering", () => {
  it("does not let a pending scenario seed overwrite newer manual setup text", async () => {
    const elements = new Map<string, FakeElement>();
    const element = (selector: string): FakeElement => {
      const existing = elements.get(selector);
      if (existing) return existing;
      const created = new FakeElement(selector.startsWith("#") ? selector.slice(1) : selector);
      elements.set(selector, created);
      return created;
    };
    vi.stubGlobal("document", {
      querySelector: (selector: string) => element(selector),
    });

    element("#setup-language").value = "en";
    let resolveSeed!: (value: unknown) => void;
    const seedResponse = new Promise((resolve) => {
      resolveSeed = resolve;
    });
    const api = vi.fn(async (url: string) => {
      if (url.startsWith("/api/scenario-seeds/")) return seedResponse;
      throw new Error(`Unexpected request: ${url}`);
    });
    const controller = createSetupSettingsController({
      api,
      applyLocale: vi.fn(),
      getStatus: () => ({ language: "en", languages: [], llm: { providers: [] } }),
      onCampaignCreated: vi.fn(),
      refreshStatus: vi.fn(),
      setDefaults: vi.fn(),
      showToast: vi.fn(),
      t: (key: string) => key,
      withButtonBusy: vi.fn(),
    });
    controller.bind();

    element("#scenario-seed-list").dispatch("click", {
      closest: () => ({ dataset: { seedId: "seed-one" } }),
    });
    expect(api).toHaveBeenCalledWith("/api/scenario-seeds/seed-one?language=en");

    element("#premise").value = "My newer premise";
    element("#character").value = "My newer character";
    element("#setup-world").value = "My newer world";
    element("#campaign-setup-form").dispatch("input", element("#premise"));
    resolveSeed({
      seed: {
        id: "seed-one",
        premise: "Stale seed premise",
        character: "Stale seed character",
        worldRules: "Stale seed world",
      },
    });
    await seedResponse;
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(element("#premise").value).toBe("My newer premise");
    expect(element("#character").value).toBe("My newer character");
    expect(element("#setup-world").value).toBe("My newer world");
  });
});
