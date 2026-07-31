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

function claim(base: string, used: Set<string>): string {
  let candidate = base;
  let suffix = 2;
  while (used.has(candidate)) {
    candidate = `${base}-${suffix}`;
    suffix += 1;
  }
  used.add(candidate);
  return candidate;
}

/**
 * Allocate a durable ID the model has to reproduce on every later reference.
 *
 * The name the model chose must be enough to predict the ID: an unpredictable
 * marker turns each subsequent mention into an exact-transcription task, and
 * reference errors scale with how many of those a turn contains. Callers seed
 * `used` with every existing ID, so uniqueness never depended on the turn
 * number; a disambiguator is appended only when the slug is genuinely taken.
 */
export function allocateGeneratedId(namespace: string, seed: string, used: Set<string>): string {
  return claim(`${namespace}:${slug(seed)}`, used);
}

/**
 * Allocate a durable ID that is addressed structurally rather than retyped.
 *
 * Superseding a fact can free its slug again, so reusing one would let a new
 * record inherit a retired ID that chronicle entries and thread references
 * still point at. The turn marker keeps those namespaces append-only, and it
 * costs nothing because nothing has to transcribe them from memory.
 */
export function allocateTurnScopedId(
  namespace: string,
  seed: string,
  turn: number,
  used: Set<string>,
): string {
  return claim(`${namespace}:${slug(seed)}-turn-${turn}`, used);
}
