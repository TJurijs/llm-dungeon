export const MINIMUM_NODE_MAJOR = 22;

export function unsupportedNodeMessage(version: string): string | undefined {
  const majorText = /^(\d+)/.exec(version)?.[1];
  const major = majorText === undefined ? Number.NaN : Number(majorText);
  if (Number.isInteger(major) && major >= MINIMUM_NODE_MAJOR) return undefined;
  return `llm-dungeon requires Node.js ${MINIMUM_NODE_MAJOR} or newer. Current version: ${version}.`;
}
