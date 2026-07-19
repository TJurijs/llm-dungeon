import type { ProviderRequestDiagnostics } from "../types.js";

const diagnosticsByError = new WeakMap<object, ProviderRequestDiagnostics>();

export function attachRequestDiagnostics(
  error: unknown,
  diagnostics: ProviderRequestDiagnostics,
): void {
  if ((typeof error === "object" && error !== null) || typeof error === "function") {
    const target = error as object;
    if (!diagnosticsByError.has(target)) diagnosticsByError.set(target, diagnostics);
  }
}

export function requestDiagnosticsFor(error: unknown): ProviderRequestDiagnostics | undefined {
  return ((typeof error === "object" && error !== null) || typeof error === "function")
    ? diagnosticsByError.get(error as object)
    : undefined;
}
