import { z } from "zod";
import type { SchemaProjectionId } from "../model-execution-profile.js";

/** Provider-specific JSON Schema projections and local-schema prompt scaffolding. */
export function jsonSchemaFor<T>(schema: z.ZodType<T>): Record<string, unknown> {
  return z.toJSONSchema(schema, { target: "draft-7" }) as Record<string, unknown>;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface ProviderSchemaProjection {
  schema: Record<string, unknown>;
  normalize?: (value: unknown) => unknown;
}

/**
 * OpenAI strict structured outputs require every object property to be listed
 * in `required`. Optional application fields are represented as nullable on
 * the wire, then deterministically restored to omission before authoritative
 * local validation. Gameplay Contract V1 has no optional wire fields, so its
 * schema and decoded value pass through unchanged.
 */
export function projectOpenAiStrictSchema(schema: Record<string, unknown>): ProviderSchemaProjection {
  const unsupportedAnnotations = new Set(["$schema", "default", "examples", "minLength", "maxLength"]);

  function project(value: unknown): unknown {
    if (Array.isArray(value)) return value.map(project);
    if (!isRecord(value)) return value;

    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) {
      if (unsupportedAnnotations.has(key)) continue;
      if (key === "properties" && isRecord(item)) {
        output.properties = Object.fromEntries(
          Object.entries(item).map(([name, propertySchema]) => [name, project(propertySchema)]),
        );
        continue;
      }
      if (key === "$defs" && isRecord(item)) {
        output.$defs = Object.fromEntries(
          Object.entries(item).map(([name, definition]) => [name, project(definition)]),
        );
        continue;
      }
      output[key] = project(item);
    }

    if (isRecord(value.properties)) {
      const required = new Set(Array.isArray(value.required) ? value.required.filter((item): item is string => typeof item === "string") : []);
      const properties = output.properties as Record<string, unknown>;
      for (const name of Object.keys(value.properties)) {
        if (!required.has(name)) {
          properties[name] = { anyOf: [properties[name], { type: "null" }] };
        }
      }
      output.required = Object.keys(value.properties);
      output.additionalProperties = false;
    }
    return output;
  }

  function restoreOptionalOmissions(value: unknown, sourceSchema: unknown): unknown {
    if (!isRecord(sourceSchema)) return value;
    if (Array.isArray(value)) {
      return value.map((item) => restoreOptionalOmissions(item, sourceSchema.items));
    }
    if (!isRecord(value) || !isRecord(sourceSchema.properties)) return value;

    const required = new Set(Array.isArray(sourceSchema.required)
      ? sourceSchema.required.filter((item): item is string => typeof item === "string")
      : []);
    const restored: Record<string, unknown> = { ...value };
    for (const [name, propertySchema] of Object.entries(sourceSchema.properties)) {
      if (!required.has(name) && restored[name] === null) {
        delete restored[name];
      } else if (name in restored) {
        restored[name] = restoreOptionalOmissions(restored[name], propertySchema);
      }
    }
    return restored;
  }

  return {
    schema: project(schema) as Record<string, unknown>,
    normalize: (value) => restoreOptionalOmissions(value, schema),
  };
}

export const ANTHROPIC_UNSUPPORTED_SCHEMA_KEYWORDS = new Set([
  "$schema",
  "default",
  "examples",
  "minimum",
  "maximum",
  "exclusiveMinimum",
  "exclusiveMaximum",
  "multipleOf",
  "minLength",
  "maxLength",
  "pattern",
  "maxItems",
  "uniqueItems",
  "minProperties",
  "maxProperties",
]);

export const ANTHROPIC_SUPPORTED_STRING_FORMATS = new Set([
  "date-time",
  "time",
  "date",
  "duration",
  "email",
  "hostname",
  "uri",
  "ipv4",
  "ipv6",
  "uuid",
]);

/** Provider projection follows Anthropic's documented SDK transformation. */
export function sanitizeAnthropicSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeAnthropicSchema);
  if (!isRecord(value)) return value;

  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    if (ANTHROPIC_UNSUPPORTED_SCHEMA_KEYWORDS.has(key)) continue;
    if (key === "format" && (typeof item !== "string" || !ANTHROPIC_SUPPORTED_STRING_FORMATS.has(item))) continue;
    if (key === "minItems" && item !== 0 && item !== 1) continue;
    if ((key === "properties" || key === "$defs") && isRecord(item)) {
      output[key] = Object.fromEntries(
        Object.entries(item).map(([name, schema]) => [name, sanitizeAnthropicSchema(schema)]),
      );
      continue;
    }
    output[key] = sanitizeAnthropicSchema(item);
  }
  if (isRecord(value.properties) && output.additionalProperties === undefined) {
    output.additionalProperties = false;
  }
  return output;
}

export const GEMINI_SCHEMA_KEYWORDS = new Set([
  "$id",
  "$defs",
  "$ref",
  "$anchor",
  "type",
  "format",
  "title",
  "description",
  "enum",
  "items",
  "prefixItems",
  "minItems",
  "maxItems",
  "minimum",
  "maximum",
  "anyOf",
  "oneOf",
  "properties",
  "additionalProperties",
  "required",
  "propertyOrdering",
]);

export function sanitizeGeminiSchema(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sanitizeGeminiSchema);
  if (!value || typeof value !== "object") return value;

  const input = value as Record<string, unknown>;
  const output: Record<string, unknown> = {};

  for (const [key, item] of Object.entries(input)) {
    // Gemini multiplies nested schema complexity by maxItems and can reject
    // otherwise supported object schemas. Cardinality remains authoritative in
    // the local Zod validator for every request.
    if (key === "maxItems") continue;
    // A literal is represented as `const` by Zod, while Gemini supports `enum`.
    if (key === "const" && input.enum === undefined) {
      output.enum = [item];
      continue;
    }
    if (!GEMINI_SCHEMA_KEYWORDS.has(key)) continue;

    // Keys inside these maps are user-defined names, not schema keywords.
    if ((key === "properties" || key === "$defs") && item && typeof item === "object" && !Array.isArray(item)) {
      output[key] = Object.fromEntries(
        Object.entries(item as Record<string, unknown>).map(([name, schema]) => [name, sanitizeGeminiSchema(schema)]),
      );
      continue;
    }

    output[key] = sanitizeGeminiSchema(item);
  }

  return output;
}

export function routesToGemini(model: string): boolean {
  return /(?:^|\/)gemini(?:-|$)/i.test(model);
}

export function projectSchemaById(
  schema: Record<string, unknown>,
  projection: SchemaProjectionId,
): ProviderSchemaProjection {
  if (projection === "openai_strict_v1") return projectOpenAiStrictSchema(schema);
  if (projection === "gemini_compatible_v1") {
    return { schema: sanitizeGeminiSchema(schema) as Record<string, unknown> };
  }
  if (projection === "anthropic_compatible_v1") {
    return { schema: sanitizeAnthropicSchema(schema) as Record<string, unknown> };
  }
  return { schema };
}


export function jsonExampleForSchema(schema: unknown): unknown {
  if (!isRecord(schema)) return null;
  if ("const" in schema) return schema.const;
  if (Array.isArray(schema.enum) && schema.enum.length > 0) return schema.enum[0];
  if (Array.isArray(schema.anyOf) && schema.anyOf.length > 0) {
    const preferred = schema.anyOf.find((entry) => !isRecord(entry) || entry.type !== "null") ?? schema.anyOf[0];
    return jsonExampleForSchema(preferred);
  }
  if (schema.type === "object" || isRecord(schema.properties)) {
    const properties = isRecord(schema.properties) ? schema.properties : {};
    const required = new Set(Array.isArray(schema.required)
      ? schema.required.filter((name): name is string => typeof name === "string")
      : Object.keys(properties));
    return Object.fromEntries(Object.entries(properties)
      .filter(([name]) => required.has(name))
      .map(([name, propertySchema]) => [name, jsonExampleForSchema(propertySchema)]));
  }
  if (schema.type === "array") {
    const count = typeof schema.minItems === "number" && schema.minItems > 0 ? Math.ceil(schema.minItems) : 0;
    return Array.from({ length: count }, () => jsonExampleForSchema(schema.items));
  }
  if (schema.type === "integer" || schema.type === "number") {
    return typeof schema.minimum === "number" ? schema.minimum : 0;
  }
  if (schema.type === "boolean") return false;
  if (schema.type === "string") {
    const length = typeof schema.minLength === "number" && schema.minLength > 0 ? Math.ceil(schema.minLength) : 0;
    return "x".repeat(length);
  }
  return null;
}

/**
 * JSON Object mode does not enforce a provider-side schema. Repeat the nested
 * required-field sets in a compact, human-readable form so models do not miss
 * fields on individual array elements while reading the full JSON Schema.
 */
export function requiredObjectFieldGuide(schema: unknown): string {
  const lines: string[] = [];
  const maximumLines = 32;

  function visit(value: unknown, location: string): void {
    if (lines.length >= maximumLines || !isRecord(value)) return;

    if (Array.isArray(value.anyOf)) {
      value.anyOf.forEach((branch, index) => visit(branch, `${location}.anyOf[${index}]`));
    }

    const properties = isRecord(value.properties) ? value.properties : undefined;
    if (properties) {
      const required = Array.isArray(value.required)
        ? value.required.filter((name): name is string => typeof name === "string")
        : Object.keys(properties);
      if (required.length > 0) lines.push(`${location}: ${required.join(", ")}`);
      for (const [name, propertySchema] of Object.entries(properties)) {
        visit(propertySchema, `${location}.${name}`);
      }
    }

    if (value.type === "array" || value.items !== undefined) {
      visit(value.items, `${location}[]`);
    }
  }

  visit(schema, "$" );
  return lines.join("\n");
}

export function localSchemaSystemPrompt(
  original: string,
  provider: string,
  schemaName: string,
  schema: Record<string, unknown>,
): string {
  const requiredFields = requiredObjectFieldGuide(schema);
  return `${original}\n\n${provider.toUpperCase()} JSON OUTPUT CONTRACT\nReturn exactly one valid JSON object and no other text. Do not use Markdown fences. The JSON object is validated locally against the complete schema below; include every required field, use only documented fields, and obey all enum and numeric constraints. Required fields apply independently to every object inside an array: if an array item is present, none of its required keys may be omitted, even when its value is an empty string, zero, or an empty array. Before returning, audit every object against the compact field list below.\nSchema name: ${schemaName}\nJSON Schema: ${JSON.stringify(schema)}\nRequired fields by object path:\n${requiredFields || "(none)"}\nExample JSON object with the required shape: ${JSON.stringify(jsonExampleForSchema(schema))}`;
}
