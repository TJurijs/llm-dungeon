import type { IncomingMessage, ServerResponse } from "node:http";
import { isIP } from "node:net";
import { z } from "zod";

export function asError(error: unknown): string {
  if (error instanceof z.ZodError) {
    return error.issues
      .map((issue) => `${issue.path.join(".") || "request"}: ${issue.message}`)
      .join("; ");
  }
  return error instanceof Error ? error.message : String(error);
}

export async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_000_000) throw new Error("Request body exceeds 1 MB");
    chunks.push(buffer);
  }
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Request body must be valid JSON");
  }
}

export function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(JSON.stringify(value));
}

export function sendTextDownload(
  response: ServerResponse,
  status: number,
  text: string,
  filename: string,
): void {
  const encodedFilename = encodeURIComponent(filename).replace(/[!'()*]/g, (character) =>
    `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  response.writeHead(status, {
    "Content-Type": "text/markdown; charset=utf-8",
    "Content-Disposition": `attachment; filename="llm-dungeon-campaign.md"; filename*=UTF-8''${encodedFilename}`,
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  response.end(text);
}

function requestHostname(value: string | undefined): string | undefined {
  if (!value || value.length > 512) return undefined;
  try {
    const parsed = new URL(`http://${value}`);
    if (parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash) {
      return undefined;
    }
    return parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  } catch {
    return undefined;
  }
}

function configuredHostname(value: string): string | undefined {
  const normalized = value.trim().toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (!normalized || normalized.includes("/") || normalized.includes("@") || /\s/.test(normalized)) {
    return undefined;
  }
  if (isIP(normalized) !== 0) return normalized;
  return /^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)(?:\.(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?))*$/.test(normalized)
    ? normalized
    : undefined;
}

function isLoopbackHostname(hostname: string): boolean {
  if (hostname === "localhost" || hostname === "::1") return true;
  if (isIP(hostname) !== 4) return false;
  return hostname.split(".", 1)[0] === "127";
}

function isWildcardHostname(hostname: string): boolean {
  return hostname === "0.0.0.0" || hostname === "::";
}

/** Reject Host-header and DNS-rebinding requests before serving reads or mutations. */
export function rejectUntrustedHost(
  request: IncomingMessage,
  response: ServerResponse,
  configuredHost: string,
): boolean {
  const requested = requestHostname(request.headers.host);
  const configured = configuredHostname(configuredHost);
  const trusted = requested !== undefined && configured !== undefined && (
    isLoopbackHostname(configured)
      ? isLoopbackHostname(requested)
      : isWildcardHostname(configured)
        ? isLoopbackHostname(requested) || isIP(requested) !== 0
        : requested === configured
  );
  if (trusted) return false;
  sendJson(response, 421, { error: "Request host is not allowed" });
  return true;
}

/** Enforce the local Web CLI's JSON and same-origin mutation boundary. */
export function rejectUnsafeMutation(request: IncomingMessage, response: ServerResponse): boolean {
  const method = request.method ?? "GET";
  if (method !== "POST" && method !== "PUT" && method !== "DELETE") return false;
  const contentType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") {
    sendJson(response, 415, { error: "Mutating requests require Content-Type: application/json" });
    return true;
  }
  const fetchSite = request.headers["sec-fetch-site"];
  if (fetchSite === "cross-site") {
    sendJson(response, 403, { error: "Cross-site requests are not allowed" });
    return true;
  }
  const origin = request.headers.origin;
  const host = request.headers.host;
  if (origin && (!host || origin !== `http://${host}`)) {
    sendJson(response, 403, { error: "Foreign request origins are not allowed" });
    return true;
  }
  return false;
}
