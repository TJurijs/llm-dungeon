import { describe, expect, it } from "vitest";
import {
  createDomainRepairCause,
  sanitizeDomainRepairMessage,
} from "../src/llm/domain-repair-cause.js";
import { DOMAIN_RULES } from "../src/domain/rules/registry.js";
import { DomainValidationError } from "../src/domain/validation-error.js";
import { TransactionValidationError } from "../src/domain/transaction.js";

const cause = (error: unknown, validationStage: "setup" | "turn_commit" = "turn_commit") =>
  createDomainRepairCause(error, {
    logicalOperationId: "11111111-1111-4111-8111-111111111111",
    validationStage,
  });

describe("domain repair cause redaction", () => {
  it("redacts from the rule declaration instead of the rendered message", () => {
    const error = new DomainValidationError(
      'Entity npc:secret-keeper uses reserved mutable-state tag "hidden"',
      {
        violations: [
          {
            code: "reserved_mutable_state_tag",
            message: 'Entity npc:secret-keeper uses reserved mutable-state tag "hidden"',
          },
        ],
      },
    );

    const redacted = cause(error);
    expect(redacted.errorMessage).toBe(
      `[reserved_mutable_state_tag] ${DOMAIN_RULES.reserved_mutable_state_tag.redacted}`,
    );
    expect(redacted.errorMessage).not.toContain("npc:secret-keeper");
    expect(redacted.errorMessage).not.toContain("hidden");
  });

  it("unwraps declarations carried through a wrapping transaction error", () => {
    const domain = new DomainValidationError("Unknown entity reference npc:ghost", {
      violations: [
        { code: "unknown_entity_reference", message: "Unknown entity reference npc:ghost" },
      ],
    });

    const redacted = cause(
      new TransactionValidationError(domain.message, {
        cause: domain,
        violations: domain.violations,
      }),
    );
    expect(redacted.errorMessage).toBe(
      `[unknown_entity_reference] ${DOMAIN_RULES.unknown_entity_reference.redacted}`,
    );
    expect(redacted.errorMessage).not.toContain("npc:ghost");
  });

  it("lists every violated rule under a stage-appropriate header", () => {
    const redacted = cause(
      new DomainValidationError("two faults", {
        violations: [
          { code: "setup_self_containment", message: "Initial entity location:a inside itself" },
          { code: "setup_inventory_cycle", message: "Initial inventory cycle a -> b -> a" },
        ],
      }),
      "setup",
    );

    expect(redacted.errorMessage).toBe(
      [
        "Initial setup validation failed:",
        `- [setup_self_containment] ${DOMAIN_RULES.setup_self_containment.redacted}`,
        `- [setup_inventory_cycle] ${DOMAIN_RULES.setup_inventory_cycle.redacted}`,
      ].join("\n"),
    );
  });

  it("groups the same rules under one fingerprint regardless of campaign text", () => {
    const violations = (suffix: string) => [
      { code: "unknown_item_reference" as const, message: `Unknown item reference item:${suffix}` },
    ];

    expect(
      cause(new DomainValidationError("a", { violations: violations("alpha") })),
    ).toMatchObject({
      errorFingerprint: cause(new DomainValidationError("b", { violations: violations("omega") }))
        .errorFingerprint,
    });
  });

  it("degrades an undeclared error source to the generic rule without leaking text", () => {
    const redacted = cause(
      new Error("player:hero lost the quiet violet password at location:vault"),
    );

    expect(redacted.errorMessage).toBe("Local domain validation rejected the structured result");
    expect(redacted.errorMessage).not.toContain("quiet violet password");
    expect(redacted.errorMessage).not.toContain("location:vault");
  });

  it("keeps the legacy classifier available for already-recorded telemetry", () => {
    expect(
      sanitizeDomainRepairMessage(
        "Transaction validation failed:\n- [inventory_cycle] Inventory ownership contains a cycle: item:a -> item:b",
      ),
    ).toBe(
      `Transaction validation failed:\n- [inventory_cycle] ${DOMAIN_RULES.inventory_cycle.redacted}`,
    );
  });
});
