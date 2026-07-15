import type { IncomingMessage, ServerResponse } from "node:http";
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

/** Enforce the local Web CLI's JSON and same-origin mutation boundary. */
export function rejectUnsafeMutation(request: IncomingMessage, response: ServerResponse): boolean {
  const method = request.method ?? "GET";
  if (method !== "POST" && method !== "PUT") return false;
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
