import { createHash } from "node:crypto";
import { secureRollD100, type RollD100 } from "../mechanics.js";

function seedNumber(seed: string): number {
  const digest = createHash("sha256").update(seed).digest();
  return digest.readUInt32LE(0) || 0x6d2b79f5;
}

/** Stable seeded d100 stream for resumable autoplay. */
export function seededRollD100(seed: string, skip = 0): RollD100 {
  let state = seedNumber(seed) >>> 0;
  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
  for (let index = 0; index < skip; index += 1) next();
  return () => Math.floor(next() * 100) + 1;
}

/** Returns each declared roll once and fails closed if a scripted package asks for an undeclared roll. */
export function scriptedRollD100(rolls: readonly number[], used = 0): RollD100 {
  let index = used;
  for (const roll of rolls) {
    if (!Number.isInteger(roll) || roll < 1 || roll > 100) {
      throw new Error("Scripted d100 rolls must be integers from 1 to 100");
    }
  }
  return () => {
    const roll = rolls[index];
    index += 1;
    if (roll === undefined) throw new Error("Scripted playtest exhausted its declared d100 rolls");
    return roll;
  };
}

export function rollPolicy(
  policy: { kind: "scripted"; rolls: readonly number[] }
    | { kind: "seeded_random"; seed: string }
    | { kind: "secure_random" },
  used = 0,
): RollD100 {
  if (policy.kind === "scripted") return scriptedRollD100(policy.rolls, used);
  if (policy.kind === "seeded_random") return seededRollD100(policy.seed, used);
  return secureRollD100;
}
