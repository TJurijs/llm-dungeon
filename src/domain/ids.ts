import { createHash } from "node:crypto";

function shortHash(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 10);
}

export function slug(value: string): string {
  const normalized = value
    .toLowerCase()
    .replaceAll(":", "-")
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return normalized || `entry-${shortHash(value.normalize("NFKC"))}`;
}

export function canonicalEntityName(name: string): string {
  const canonical = name
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim()
    .replace(/^(?:the|a|an)\s+/, "");
  return canonical || `#${shortHash(name.normalize("NFKC"))}`;
}

export function allocateGeneratedId(
  namespace: string,
  seed: string,
  turn: number,
  used: Set<string>,
): string {
  const base = `${namespace}:${slug(seed)}-turn-${turn}`;
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}
