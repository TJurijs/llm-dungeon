/** @typedef {import("../src/web/contracts.js").BrowserApiOperation} BrowserApiOperation */

/**
 * @template {BrowserApiOperation} Operation
 * @typedef {import("../src/web/contracts.js").BrowserApiCall<Operation>} BrowserApiCall
 */

/**
 * @template {BrowserApiOperation} Operation
 * @typedef {import("../src/web/contracts.js").BrowserApiResponse<Operation>} BrowserApiResponse
 */

/**
 * @typedef {{
 *   params?: { campaignId?: string, seedId?: string },
 *   query?: { language?: string },
 *   body?: unknown,
 *   signal?: AbortSignal,
 * }} BrowserRuntimeCall
 */

/** @typedef {{ url: string, options: RequestInit }} BrowserBuiltRequest */

/** @param {unknown} value @param {string} label */
function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  return value;
}

/** @param {BrowserRuntimeCall} input @param {string} action */
function campaignPath(input, action) {
  const campaignId = requiredString(input.params?.campaignId, "Campaign ID");
  return `/api/campaigns/${encodeURIComponent(campaignId)}/${action}`;
}

/** @param {BrowserRuntimeCall} input */
function worldProfilePath(input) {
  const language = requiredString(input.query?.language, "World profile language");
  return `/api/config/world?language=${encodeURIComponent(language)}`;
}

/** @param {BrowserRuntimeCall} input */
function scenarioSeedPath(input) {
  const seedId = requiredString(input.params?.seedId, "Scenario seed ID");
  const language = requiredString(input.query?.language, "Scenario seed language");
  return `/api/scenario-seeds/${encodeURIComponent(seedId)}?language=${encodeURIComponent(language)}`;
}

/**
 * Resolve one named private operation to its concrete same-origin request.
 * Exported for deterministic route-contract tests; callers use browserApi().
 *
 * @template {BrowserApiOperation} Operation
 * @param {Operation} operation
 * @param {BrowserApiCall<Operation>} call
 * @returns {BrowserBuiltRequest}
 */
export function buildBrowserApiRequest(operation, call) {
  const input = /** @type {BrowserRuntimeCall} */ (call);
  let url;
  let method;
  switch (operation) {
    case "bootstrap":
      url = "/api/status";
      method = "GET";
      break;
    case "readWorldProfile":
      url = worldProfilePath(input);
      method = "GET";
      break;
    case "saveWorldProfile":
      url = "/api/config/world";
      method = "PUT";
      break;
    case "saveLanguage":
      url = "/api/config/language";
      method = "PUT";
      break;
    case "listScenarioSeeds":
      url = "/api/scenario-seeds";
      method = "GET";
      break;
    case "readScenarioSeed":
      url = scenarioSeedPath(input);
      method = "GET";
      break;
    case "createDraft":
      url = "/api/campaigns/draft";
      method = "POST";
      break;
    case "detachDraft":
      url = "/api/campaigns/draft/detach";
      method = "POST";
      break;
    case "confirmDraft":
      url = "/api/campaigns/confirm";
      method = "POST";
      break;
    case "testModel":
      url = "/api/llm/models/test";
      method = "POST";
      break;
    case "addModel":
      url = "/api/llm/models";
      method = "POST";
      break;
    case "setModelEnabled":
      url = "/api/llm/models";
      method = "PUT";
      break;
    case "removeModel":
      url = "/api/llm/models";
      method = "DELETE";
      break;
    case "setDefaultModel":
      url = "/api/llm/default";
      method = "PUT";
      break;
    case "setSessionKey":
      url = "/api/llm/keys";
      method = "PUT";
      break;
    case "testProviderConnection":
      url = "/api/llm/connections/test";
      method = "POST";
      break;
    case "reloadEnvironment":
      url = "/api/llm/environment/reload";
      method = "POST";
      break;
    case "campaignStatus":
      url = campaignPath(input, "status");
      method = "GET";
      break;
    case "campaignBudget":
      url = campaignPath(input, "budget");
      method = "GET";
      break;
    case "updateCampaignBudget":
      url = campaignPath(input, "budget");
      method = "PUT";
      break;
    case "renameCampaign":
      url = campaignPath(input, "title");
      method = "PUT";
      break;
    case "campaignTranscript":
      url = campaignPath(input, "transcript");
      method = "GET";
      break;
    case "play":
      url = campaignPath(input, "play");
      method = "POST";
      break;
    case "retry":
      url = campaignPath(input, "retry");
      method = "POST";
      break;
    case "discard":
      url = campaignPath(input, "discard");
      method = "POST";
      break;
    case "setCampaignModel":
      url = campaignPath(input, "config");
      method = "PUT";
      break;
    case "campaignInspection":
      url = campaignPath(input, "inspect");
      method = "GET";
      break;
    case "archiveCampaign":
      url = campaignPath(input, "archive");
      method = "POST";
      break;
    case "campaignSetup":
      url = campaignPath(input, "setup");
      method = "GET";
      break;
    case "campaignStory":
      url = campaignPath(input, "story");
      method = "GET";
      break;
    case "generateCampaignStory":
      url = campaignPath(input, "story");
      method = "POST";
      break;
    case "deleteCampaign":
      url = campaignPath(input, "delete");
      method = "DELETE";
      break;
    default:
      throw new Error(`Unknown browser operation: ${String(operation)}`);
  }

  const serializedBody = "body" in input ? JSON.stringify(input.body) : undefined;
  return {
    url,
    options: {
      method,
      headers: { "Content-Type": "application/json" },
      ...(serializedBody === undefined ? {} : { body: serializedBody }),
      ...(input.signal === undefined ? {} : { signal: input.signal }),
      ...(operation === "detachDraft" ? { keepalive: true } : {}),
    },
  };
}

/** @param {unknown} value @param {number} status */
function errorMessage(value, status) {
  if (
    value !== null &&
    typeof value === "object" &&
    "error" in value &&
    typeof value.error === "string" &&
    value.error
  ) {
    return value.error;
  }
  return `Request failed (${status})`;
}

/** @param {unknown} error */
function isAbortError(error) {
  return Boolean(
    error && typeof error === "object" && "name" in error && error.name === "AbortError",
  );
}

/** @param {unknown} value */
function validSuccessBody(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The sole JSON trust boundary for the private browser/server contract.
 * Server construction and every consumer are checked against the same map;
 * runtime validation remains concentrated on the untrusted error envelope.
 *
 * @template {BrowserApiOperation} Operation
 * @param {Operation} operation
 * @param {BrowserApiCall<Operation>} call
 * @returns {Promise<BrowserApiResponse<Operation>>}
 */
export async function browserApi(operation, call) {
  const request = buildBrowserApiRequest(operation, call);
  const response = await fetch(request.url, request.options);
  /** @type {unknown} */
  let body;
  try {
    body = await response.json();
  } catch (error) {
    if (isAbortError(error)) throw error;
    if (response.ok) throw new Error("Server returned an invalid JSON response");
    body = null;
  }
  if (!response.ok) {
    const error = /** @type {Error & { status?: number, code?: string, scope?: string }} */ (
      new Error(errorMessage(body, response.status))
    );
    error.status = response.status;
    if (body && typeof body === "object") {
      if ("code" in body && typeof body.code === "string") error.code = body.code;
      if ("scope" in body && typeof body.scope === "string") error.scope = body.scope;
    }
    throw error;
  }
  if (!validSuccessBody(body)) throw new Error("Server returned an invalid JSON response");
  return /** @type {BrowserApiResponse<Operation>} */ (body);
}
