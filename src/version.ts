import { readFileSync } from "node:fs";

const packageMetadata = JSON.parse(
  readFileSync(new URL("../package.json", import.meta.url), "utf8"),
) as { version?: unknown };

if (typeof packageMetadata.version !== "string" || !packageMetadata.version) {
  throw new Error("package.json is missing a valid version");
}

export const APPLICATION_VERSION = packageMetadata.version;
