import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { StateStore } from "../src/store.js";
import {
  playtestPlayerPrompt,
  playtestPlayerSystemPrompt,
} from "../tools/playtest/prompts/playtest-player.js";
import { createTestStore, setupFixture } from "./helpers.js";

describe("simulated playtest player", () => {
  it("receives concise player-safe state and enough action history to notice a stalled tactic", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "llm-dungeon-playtest-player-"));
    const store = new StateStore(path.join(directory, "data"));
    const setup = structuredClone(setupFixture);
    setup.player.secrets = ["The hero has a private fear that has never been revealed."];
    setup.entities.push({
      id: "item:hidden-cache",
      kind: "item",
      name: "Hidden Smuggler Cache",
      status: "concealed",
      tags: ["cache"],
      description: "A cache concealed beneath the floorboards.",
      establishedFacts: [],
      secrets: ["The cache contains a royal cipher."],
      playerKnowledge: [],
      traits: [],
      conditions: [],
      inventory: [],
    });
    const location = setup.entities.find((entity) => entity.id === "location:crooked-crown")!;
    location.inventory.push({ entityId: "item:hidden-cache", quantity: 1 });
    setup.threads.push({
      id: "thread:resolved-decoy",
      title: "Resolved Decoy Lead",
      summary: "A false trail that is already closed.",
      status: "resolved",
      relatedEntityIds: [],
    });
    await store.createGame({
      setup,
      worldRules: "Hidden referee-only world rule: the sealed letter is a decoy.",
      setupInput: {
        premise: "Discover why travelers vanished along the northern road.",
        character: "A patient scout who protects travelers and distrusts easy answers.",
      },
    });
    await store.commitTurn({
      action: "I shoulder the swollen cellar door again.",
      resolved: {
        narration: "You press against the swollen door, but it does not move.",
        turnSummary: "The cellar door remains shut and reveals no new route.",
        operations: [],
      },
      provider: "fake",
      model: "fake-model",
    });
    await store.commitTurn({
      action: "I shoulder the swollen cellar door again.",
      resolved: {
        narration: "The same swollen door holds fast; your second attempt changes nothing.",
        turnSummary: "A second identical attempt made no progress at the cellar door.",
        operations: [],
      },
      provider: "fake",
      model: "fake-model",
    });

    const context = await store.buildPlayerContext();

    expect(context).toContain("PLAYER-VISIBLE CURRENT SITUATION");
    expect(context).toContain("Current location: The Crooked Crown; status=open");
    expect(context).toContain("The tavern stands beside the northern road.");
    expect(context).toContain("PLAYER-SUPPLIED CAMPAIGN PURPOSE AND CHARACTER CONCEPT");
    expect(context).toContain("Discover why travelers vanished along the northern road.");
    expect(context).toContain("A patient scout who protects travelers and distrusts easy answers.");
    expect(context).toContain("CHARACTER TEMPERAMENT, TRAITS, AND CURRENT STATE");
    expect(context).toContain("A road-worn scout with a careful eye.");
    expect(context).toContain("- Keen-eyed");
    expect(context).toContain("- Patient");
    expect(context).toContain("PLAYER-VISIBLE INVENTORY");
    expect(context).toContain("1 × Travel Sword; status=intact; A plain, serviceable sword.");
    expect(context).toContain("ACTIVE GOALS AND STORY THREADS");
    expect(context).toContain(
      "Silence on the Northern Road — exact objective: Travelers have stopped arriving from the north.; current progress: Travelers have stopped arriving from the north.",
    );
    expect(context).toContain("RESOLVED AND FAILED GOALS — DO NOT REOPEN");
    expect(context).toContain(
      "(resolved) Resolved Decoy Lead: A false trail that is already closed.",
    );
    expect(context).toContain("RECENT PLAYER ACTIONS AND OUTCOMES");
    expect(context.match(/I shoulder the swollen cellar door again\./g)).toHaveLength(2);
    expect(context).toContain("The cellar door remains shut and reveals no new route.");
    expect(context).toContain("A second identical attempt made no progress");
    expect(context).not.toContain("You press against the swollen door");
    expect(context).toContain("your second attempt changes nothing");

    expect(context).not.toContain("The hero has a private fear");
    expect(context).not.toContain("watch captain takes bribes");
    expect(context).not.toContain("Mara Venn");
    expect(context).not.toContain("Hidden Smuggler Cache");
    expect(context).not.toContain("royal cipher");
    expect(context).not.toContain("item:travel-sword");
    expect(context).not.toContain("contentCodec");
    expect(context).not.toContain("Hidden referee-only world rule");
    expect(context).not.toContain(setup.scenarioMarkdown);
  });

  it("gracefully omits origin seeds for legacy campaigns", async () => {
    const store = await createTestStore();

    const context = await store.buildPlayerContext();

    expect(context).not.toContain("PLAYER-SUPPLIED CAMPAIGN PURPOSE AND CHARACTER CONCEPT");
    expect(context).toContain("PLAYER-VISIBLE CURRENT SITUATION");
  });

  it("retains a closed campaign goal after its resolving turn leaves recent memory", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "llm-dungeon-playtest-player-"));
    const store = new StateStore(path.join(directory, "data"));
    await store.createGame({
      setup: structuredClone(setupFixture),
      worldRules: "Classic fantasy test rules.",
      setupInput: {
        premise: "Restore travel on the silent northern road.",
        character: "A patient scout who finishes what they begin.",
      },
    });
    const roadThreadId = (await store.load()).threads.find(
      (thread) => thread.title === "Silence on the Northern Road",
    )!.id;
    await store.commitTurn({
      action: "I present the final proof that resolves the northern-road mystery.",
      resolved: {
        narration: "The proof holds, and safe travel resumes on the northern road.",
        turnSummary: "The northern-road mystery was resolved and travel resumed.",
        operations: [
          {
            type: "resolve_thread",
            threadId: roadThreadId,
            status: "resolved",
            outcome: "The disappearances were explained and safe travel resumed.",
          },
        ],
      },
      provider: "fake",
      model: "fake-model",
    });
    for (let turn = 2; turn <= 8; turn += 1) {
      await store.commitTurn({
        action: `I pursue an unrelated settled task ${turn}.`,
        resolved: {
          narration: `The unrelated task ${turn} passes without reopening the road mystery.`,
          turnSummary: `Unrelated task ${turn} was completed.`,
          operations: [],
        },
        provider: "fake",
        model: "fake-model",
      });
    }

    const context = await store.buildPlayerContext();

    expect(context).toContain("Restore travel on the silent northern road.");
    expect(context).toContain("RESOLVED AND FAILED GOALS — DO NOT REOPEN");
    expect(context).toContain(
      "(resolved) Silence on the Northern Road: The disappearances were explained and safe travel resumed.",
    );
    expect(context).not.toContain(
      "I present the final proof that resolves the northern-road mystery.",
    );
  });

  it("retains linked completion evidence after it leaves recent action memory", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "llm-dungeon-playtest-player-"));
    const store = new StateStore(path.join(directory, "data"));
    const setup = structuredClone(setupFixture);
    setup.threads[0]!.relatedEntityIds = ["location:crooked-crown"];
    await store.createGame({ setup, worldRules: "Classic fantasy test rules." });
    await store.commitTurn({
      action: "I open the northern gate.",
      resolved: {
        narration: "The northern gate opens and remains unlocked.",
        turnSummary: "The northern gate was opened.",
        operations: [
          {
            type: "add_fact",
            targetId: "location:crooked-crown",
            section: "knowledge",
            factId: "fact:gate-open",
            text: "The northern gate is already open and unlocked.",
          },
        ],
      },
      provider: "fake",
      model: "fake-model",
    });
    for (let turn = 2; turn <= 8; turn += 1) {
      await store.commitTurn({
        action: `I handle a separate task ${turn}.`,
        resolved: {
          narration: `The separate task ${turn} is handled.`,
          turnSummary: `Separate task ${turn} was handled.`,
          operations: [],
        },
        provider: "fake",
        model: "fake-model",
      });
    }

    const context = await store.buildPlayerContext();

    expect(context).toContain("CURRENT DURABLE EVIDENCE FOR ACTIVE GOALS");
    expect(context).toContain("The Crooked Crown: The northern gate is already open and unlocked.");
    expect(context).toContain(
      "Never repeat a completed action merely because its thread remains active.",
    );
    expect(context).not.toContain("I open the northern gate.");
  });

  it("keeps private active-thread retrieval links out of player and story projections", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "llm-dungeon-playtest-player-"));
    const store = new StateStore(path.join(directory, "data"));
    const setup = structuredClone(setupFixture);
    setup.entities.push(
      {
        id: "location:moonless-cellar",
        kind: "location",
        name: "Moonless Cellar",
        status: "sealed",
        tags: ["cellar"],
        description: "A concealed stone cellar beneath an abandoned tollhouse.",
        establishedFacts: ["The cellar is the medicine crate's true hiding place."],
        secrets: ["Only the hidden custodian knows the cellar's release sequence."],
        playerKnowledge: [],
        traits: [],
        conditions: [],
        inventory: [],
      },
      {
        id: "npc:hidden-custodian",
        kind: "person",
        name: "Ilyan the Custodian",
        status: "in hiding",
        location: "location:moonless-cellar",
        tags: ["custodian"],
        description: "A careful quartermaster with an unremarkable traveling coat.",
        establishedFacts: ["Ilyan secretly diverted the medicine shipment."],
        secrets: ["Ilyan intends to ransom the medicine after the search moves north."],
        playerKnowledge: [],
        traits: [],
        conditions: [],
        inventory: [{ entityId: "item:medicine-crate", quantity: 1 }],
      },
      {
        id: "item:medicine-crate",
        kind: "item",
        name: "Medicine Crate",
        status: "missing",
        tags: ["medical-supplies"],
        description: "A reinforced shipment crate marked with a blue seal.",
        establishedFacts: ["The crate remains in Ilyan's custody inside the Moonless Cellar."],
        secrets: ["The false manifest was prepared before the crate disappeared."],
        playerKnowledge: ["The missing medicine crate bears a blue seal."],
        traits: [],
        conditions: [],
        inventory: [],
      },
    );
    setup.threads[0] = {
      ...setup.threads[0]!,
      title: "The Missing Medicine",
      summary: "A blue-sealed medicine crate is unaccounted for.",
      relatedEntityIds: ["item:medicine-crate", "npc:hidden-custodian", "location:moonless-cellar"],
    };
    await store.createGame({ setup, worldRules: "Classic fantasy test rules." });

    const dmContext = await store.buildContext();
    const playerContext = await store.buildPlayerContext();
    const storyContext = (await store.buildCompletedStoryContextDocument()).text;

    expect(dmContext).toContain("Ilyan the Custodian");
    expect(dmContext).toContain("Moonless Cellar");
    expect(dmContext).toContain("Ilyan secretly diverted the medicine shipment.");
    expect(dmContext).toContain("Only the hidden custodian knows the cellar's release sequence.");
    for (const projection of [playerContext, storyContext]) {
      expect(projection).toContain("The Missing Medicine");
      expect(projection).toContain("Medicine Crate: The missing medicine crate bears a blue seal.");
      expect(projection).not.toContain("Ilyan the Custodian");
      expect(projection).not.toContain("Moonless Cellar");
      expect(projection).not.toContain("secretly diverted");
      expect(projection).not.toContain("true hiding place");
      expect(projection).not.toContain("release sequence");
      expect(projection).not.toContain("ransom the medicine");
      expect(projection).not.toContain("false manifest");
    }
  });

  it("bounds closed goals while retaining deterministic earliest and latest outcomes", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "llm-dungeon-playtest-player-"));
    const store = new StateStore(path.join(directory, "data"));
    const setup = structuredClone(setupFixture);
    setup.threads = Array.from({ length: 10 }, (_, index) => ({
      id: `thread:closed-${index}`,
      title: `Closed Goal ${index}`,
      summary: `Outcome ${index}.`,
      status: index % 2 === 0 ? ("resolved" as const) : ("failed" as const),
      relatedEntityIds: [],
    }));
    await store.createGame({ setup, worldRules: "Classic fantasy test rules." });

    const context = await store.buildPlayerContext();

    expect(context.match(/\((?:resolved|failed)\) Closed Goal/g)).toHaveLength(8);
    for (const index of [0, 1, 2, 3, 6, 7, 8, 9]) {
      expect(context).toContain(`Closed Goal ${index}: Outcome ${index}.`);
    }
    expect(context).not.toContain("Closed Goal 4: Outcome 4.");
    expect(context).not.toContain("Closed Goal 5: Outcome 5.");
    expect(context).toContain("2 additional closed goals omitted from this compact view.");
  });

  it("requires goal-level adaptation after stalls while allowing narrow retry exceptions", () => {
    const system = playtestPlayerSystemPrompt(
      {
        id: "cautious-investigator",
        instruction: "Gather evidence, prepare carefully, and verify claims.",
      },
      "en",
    );
    const prompt = playtestPlayerPrompt("PLAYER-VISIBLE CONTEXT");

    expect(system).toContain("exactly one immediate action");
    expect(system).toContain("latest DM narration and outcome as authoritative");
    expect(system).toContain("do not contradict, reinterpret, undo, or replace them");
    expect(system).toContain("contract, offered choice, and item");
    expect(system).toContain("latest narration presents it");
    expect(system).toContain("inventory says so");
    expect(system).toContain("copy its exact full canonical visible name from context");
    expect(system).toContain('"Tala Venn" or "Dr. Eli Mercer"');
    expect(system).toContain("first name, surname, role, or natural alias");
    expect(system).toContain("privately match it to one exact visible inventory entry");
    expect(system).toContain("generic mask, light, pry bar, rope, key, ammunition");
    expect(system).toContain("exhaustive capability contract");
    expect(system).toContain("scanner, terminal, medkit, or weapon");
    expect(system).toContain("read logs, detect life, reconstruct past movement");
    expect(system).toContain(
      "generic compact kit, survival kit, field kit, toolkit, multi-tool, or unspecified tool",
    );
    expect(system).toContain(
      "does not provide specialized electronic diagnostics, scanning, programming",
    );
    expect(system).toContain("passive sensing does not transmit");
    expect(system).toContain(
      "does not establish semantic purpose, intent, origin, destination, or safe operation",
    );
    expect(system).toContain("never present it as already known");
    expect(system).toContain("phrase the action conditionally");
    expect(system).toContain("then inspect or recover it only if found");
    expect(system).toContain("at a guessed destination merely because your action names it");
    expect(system).toContain("Do not conveniently name a precise unobserved compartment");
    expect(system).toContain(
      "search the relevant established area for concealed storage, exits, controls, evidence",
    );
    expect(system).toContain("investigation step already answered");
    expect(system).toContain("even if an active thread is stale");
    expect(system).toContain("Do not revisit a completed location search");
    expect(system).toContain("pursue the next genuinely unresolved question");
    expect(system).toContain("Never claim that a threat is contained");
    expect(system).toContain("Ask an NPC to accompany, move, agree, transfer, or act");
    expect(system).toContain('"I lead them there" still assumes consent');
    expect(system).toContain("affordance the visible context establishes");
    expect(system).toContain("Being in character does not give you authorship");
    expect(system).toContain("at goal level");
    expect(system).toContain("Keep technical actions high-level and non-procedural");
    expect(system).toContain(
      "Do not invent command sequences, wiring steps, diagnostic modes, protocols, exploits",
    );
    expect(system).toContain("known, routine, uncontested route in one action");
    expect(system).toContain("does not permit bundling a second consequential");
    expect(system).toContain("re-inspecting the same unchanged object");
    expect(system).toContain("routine preflight, stable monitoring, and transit beat");
    expect(system).toContain("until the next meaningful change");
    expect(system).toContain("State only what the character intends, attempts, says, chooses");
    expect(system).toContain("Never narrate that a DM-controlled response");
    expect(system).toContain("If that end state is already true, do not repeat the action");
    expect(system).toContain("leave their success, failure, and consequences for the DM");
    expect(system).toContain("no meaningful progress twice");
    expect(system).toContain(
      "do not make the same item, sense, spell, social gambit, or maneuver the primary method for three consecutive actions",
    );
    expect(system).toContain("do not submit it a third time unchanged");
    expect(system).toContain("circumstances have materially changed its prospects");
    expect(system).toContain("no other coherent action remains");
    expect(system).toContain("change method or active lead");
    expect(system).toContain("resupply or gather missing information");
    expect(system).toContain("retreat or reposition");
    expect(system).toContain("take a grounded risk");
    expect(system).toContain("Mere hope for a different roll is not a changed circumstance");
    expect(system).toContain("injures, shocks, endangers, or throws an ally");
    expect(system).toContain("assess or secure that ally");
    expect(system).toContain("at most three sentences and 800 characters");
    expect(prompt).toContain("authoritative current state and latest DM narration/outcome");
    expect(prompt).toContain("current known details, active-goal evidence");
    expect(prompt).toContain("exact inventory names");
    expect(prompt).toContain(
      "Never repeat an action or revisit an investigation step whose intended end state is already established",
    );
    expect(prompt).toContain("pursue the next unresolved question");
    expect(prompt).toContain("phrase any search for a missing or unlocated target conditionally");
    expect(prompt).toContain("then inspect or recover it only if found");
    expect(prompt).toContain("rather than asserting that it is present at a guessed destination");
    expect(prompt).toContain(
      "recent action/outcome history for completion, progress, or stagnation",
    );
    expect(prompt).toContain("was the primary method in the previous two actions");
    expect(prompt).toContain("one goal-level immediate action");
    expect(prompt).toContain("stalled twice");
    expect(prompt).toContain("visible circumstances materially changed its prospects");
    expect(prompt).toContain("no viable alternative exists");
    expect(prompt).toContain("Do not add or change world facts");
    expect(prompt).toContain("NPC decisions, or object capabilities");
    expect(prompt).toContain("treat item descriptions as exhaustive");
    expect(prompt).toContain(
      "never infer specialized electronic or interface capability from a generic kit or tool",
    );
    expect(prompt).toContain("Keep technical intent high-level and non-procedural");
    expect(prompt).toContain(
      "mention a carried, worn, drawn, or used item only when its exact name is in visible inventory",
    );
    expect(prompt).toContain("only for an explicitly listed capability");
    expect(prompt).toContain("only established possessions and genuinely presented options");
    expect(prompt).toContain("FINAL OUTPUT AUDIT");
    expect(prompt).toContain(
      "replace every shortened person or place reference with its exact full canonical visible name",
    );
    expect(prompt).toContain(
      "phrase NPC participation as a request unless the current visible state or latest outcome already establishes their participation",
    );
    expect(prompt).toContain("never invent cooperation");
    expect(prompt).toContain("State the intended action, not its result");
  });

  it("preserves explicit adversarial profiles without letting them author resolved outcomes", () => {
    for (const id of ["rule-challenger", "chaotic"]) {
      const system = playtestPlayerSystemPrompt(
        {
          id,
          instruction: "Submit deliberately unsupported attempts for boundary testing.",
        },
        "en",
      );

      expect(system).toContain("explicit adversarial-testing exception");
      expect(system).toContain("deliberately unsupported possession");
      expect(system).toContain("Use rule_challenge");
      expect(system).toContain("Never narrate that a DM-controlled response");
      expect(system).toContain("leave their success, failure, and consequences for the DM");
      expect(system).not.toContain("latest DM narration and outcome as authoritative");
    }
  });
});
