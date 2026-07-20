import { readFile } from "node:fs/promises";
import path from "node:path";
import type { ServerResponse } from "node:http";
import { sendJson } from "./http.js";

const STATIC_ASSETS: Record<string, { name: string; type: string }> = {
  "/": { name: "index.html", type: "text/html; charset=utf-8" },
  "/index.html": { name: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { name: "app.js", type: "text/javascript; charset=utf-8" },
  "/ui-copy.js": { name: "ui-copy.js", type: "text/javascript; charset=utf-8" },
  "/ui-utils.js": { name: "ui-utils.js", type: "text/javascript; charset=utf-8" },
  "/chat-ui.js": { name: "chat-ui.js", type: "text/javascript; charset=utf-8" },
  "/inspection-ui.js": { name: "inspection-ui.js", type: "text/javascript; charset=utf-8" },
  "/setup-settings.js": { name: "setup-settings.js", type: "text/javascript; charset=utf-8" },
  "/terminal-history.js": { name: "terminal-history.js", type: "text/javascript; charset=utf-8" },
  "/styles.css": { name: "styles.css", type: "text/css; charset=utf-8" },
};

/** Serve the fixed browser asset set with the application's CSP headers. */
export async function serveStaticAsset(
  webRoot: string,
  response: ServerResponse,
  pathname: string,
): Promise<void> {
  const asset = STATIC_ASSETS[pathname];
  if (!asset) { sendJson(response, 404, { error: "Not found" }); return; }
  const content = await readFile(path.join(webRoot, asset.name));
  response.writeHead(200, {
    "Content-Type": asset.type,
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; frame-ancestors 'none'",
  });
  response.end(content);
}
