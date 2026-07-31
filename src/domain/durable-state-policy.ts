import type { SetupResult, StateOperation } from "../schemas.js";
import { rejectDomainChange } from "./validation-error.js";
import type { DomainViolation } from "./violations.js";

export const DURABLE_TEXT_LIMIT_CODE = "durable_text_limit";

/** Receives one violated limit so callers can collect or throw. */
type LimitSink = (message: string) => void;

/**
 * New-write limits keep one generated record from monopolizing deterministic
 * working context. Persisted V1 schemas intentionally remain lenient so old
 * Markdown campaigns with longer values stay readable and exportable.
 */
export const DURABLE_TEXT_LIMITS = {
  entityName: 200,
  entityStatus: 320,
  entityDescription: 1_200,
  fact: 800,
  trait: 1_600,
  condition: 500,
  relationship: 800,
  threadTitle: 200,
  threadSummary: 1_600,
  majorEvent: 1_200,
  turnSummary: 1_200,
} as const;

function reportLimit(sink: LimitSink, value: string, label: string, limit: number): void {
  if (value.length > limit) {
    sink(`${label} exceeds the ${limit}-character durable-state limit`);
  }
}

function throwingSink(message: string): never {
  return rejectDomainChange(message, DURABLE_TEXT_LIMIT_CODE);
}

function assertEntitySeedLimits(
  sink: LimitSink,
  entity: SetupResult["player"] | SetupResult["entities"][number],
  label: string,
): void {
  reportLimit(sink, entity.name, `${label} name`, DURABLE_TEXT_LIMITS.entityName);
  reportLimit(sink, entity.status, `${label} status`, DURABLE_TEXT_LIMITS.entityStatus);
  reportLimit(
    sink,
    entity.description,
    `${label} description`,
    DURABLE_TEXT_LIMITS.entityDescription,
  );
  for (const fact of [...entity.establishedFacts, ...entity.secrets, ...entity.playerKnowledge]) {
    reportLimit(sink, fact, `${label} fact`, DURABLE_TEXT_LIMITS.fact);
  }
  for (const trait of entity.traits) {
    reportLimit(sink, trait, `${label} trait`, DURABLE_TEXT_LIMITS.trait);
  }
  for (const condition of entity.conditions) {
    reportLimit(sink, condition, `${label} condition`, DURABLE_TEXT_LIMITS.condition);
  }
}

export function assertInitialDurableTextLimits(setup: SetupResult): void {
  const sink = throwingSink;
  assertEntitySeedLimits(sink, setup.player, "Initial player");
  for (const entity of setup.entities) assertEntitySeedLimits(sink, entity, `Initial ${entity.id}`);
  for (const thread of setup.threads) {
    reportLimit(
      sink,
      thread.title,
      `Initial thread ${thread.id} title`,
      DURABLE_TEXT_LIMITS.threadTitle,
    );
    reportLimit(
      sink,
      thread.summary,
      `Initial thread ${thread.id} summary`,
      DURABLE_TEXT_LIMITS.threadSummary,
    );
  }
}

/** Validate a complete generated operation list before any state clone mutates. */
export function assertOperationDurableTextLimits(operations: readonly StateOperation[]): void {
  reportOperationDurableTextLimits(throwingSink, operations);
}

/** Collect every exceeded limit so one correction can address them together. */
export function collectOperationDurableTextViolations(
  operations: readonly StateOperation[],
): DomainViolation[] {
  const violations: DomainViolation[] = [];
  reportOperationDurableTextLimits((message) => {
    violations.push({ code: DURABLE_TEXT_LIMIT_CODE, message });
  }, operations);
  return violations;
}

function reportOperationDurableTextLimits(
  sink: LimitSink,
  operations: readonly StateOperation[],
): void {
  for (const operation of operations) {
    switch (operation.type) {
      case "create_entity":
        reportLimit(
          sink,
          operation.entity.name,
          `Entity ${operation.entity.id} name`,
          DURABLE_TEXT_LIMITS.entityName,
        );
        reportLimit(
          sink,
          operation.entity.status,
          `Entity ${operation.entity.id} status`,
          DURABLE_TEXT_LIMITS.entityStatus,
        );
        reportLimit(
          sink,
          operation.entity.description,
          `Entity ${operation.entity.id} description`,
          DURABLE_TEXT_LIMITS.entityDescription,
        );
        for (const fact of [
          ...operation.entity.establishedFacts,
          ...operation.entity.secrets,
          ...operation.entity.playerKnowledge,
        ]) {
          reportLimit(sink, fact, `Entity ${operation.entity.id} fact`, DURABLE_TEXT_LIMITS.fact);
        }
        break;
      case "add_fact":
        reportLimit(
          sink,
          operation.text,
          `Fact on ${operation.targetId}`,
          DURABLE_TEXT_LIMITS.fact,
        );
        break;
      case "supersede_fact":
        reportLimit(
          sink,
          operation.replacementText,
          `Replacement fact on ${operation.targetId}`,
          DURABLE_TEXT_LIMITS.fact,
        );
        break;
      case "set_entity_state":
        if (operation.name !== undefined) {
          reportLimit(
            sink,
            operation.name,
            `Entity ${operation.targetId} name`,
            DURABLE_TEXT_LIMITS.entityName,
          );
        }
        if (operation.status !== undefined) {
          reportLimit(
            sink,
            operation.status,
            `Entity ${operation.targetId} status`,
            DURABLE_TEXT_LIMITS.entityStatus,
          );
        }
        break;
      case "add_condition":
      case "remove_condition":
        reportLimit(
          sink,
          operation.condition,
          `Condition on ${operation.targetId}`,
          DURABLE_TEXT_LIMITS.condition,
        );
        break;
      case "add_trait":
        reportLimit(
          sink,
          operation.trait,
          `Trait on ${operation.targetId}`,
          DURABLE_TEXT_LIMITS.trait,
        );
        break;
      case "set_relationship":
        reportLimit(
          sink,
          operation.summary,
          `Relationship ${operation.sourceId} -> ${operation.targetId}`,
          DURABLE_TEXT_LIMITS.relationship,
        );
        break;
      case "create_thread":
        reportLimit(
          sink,
          operation.title,
          `Thread ${operation.threadId} title`,
          DURABLE_TEXT_LIMITS.threadTitle,
        );
        reportLimit(
          sink,
          operation.summary,
          `Thread ${operation.threadId} summary`,
          DURABLE_TEXT_LIMITS.threadSummary,
        );
        break;
      case "update_thread":
        reportLimit(
          sink,
          operation.summary,
          `Thread ${operation.threadId} summary`,
          DURABLE_TEXT_LIMITS.threadSummary,
        );
        break;
      case "resolve_thread":
        reportLimit(
          sink,
          operation.outcome,
          `Thread ${operation.threadId} outcome`,
          DURABLE_TEXT_LIMITS.threadSummary,
        );
        break;
      case "record_major_event":
        reportLimit(
          sink,
          operation.text,
          `Major event ${operation.eventId}`,
          DURABLE_TEXT_LIMITS.majorEvent,
        );
        break;
      case "end_campaign":
        // The ending reason is persisted as a chronicle event by application
        // code, so it shares the same new-write limit as record_major_event.
        reportLimit(
          sink,
          operation.reason,
          "Campaign ending reason",
          DURABLE_TEXT_LIMITS.majorEvent,
        );
        break;
      default:
        break;
    }
  }
}
