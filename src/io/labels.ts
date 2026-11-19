/**
 * Segment names as JSON, for the formats that have no field of their own for
 * them: a NIfTI comment extension and an extra MetaImage header line.
 */

const APP_KEY = 'w-annotator';

/** The names with their label values in ascending order, or undefined when there are none. */
function sortedLabels(labels: Record<number, string> | undefined): Record<string, string> | undefined {
  if (!labels) return undefined;
  const values = Object.keys(labels)
    .filter((k) => /^\d+$/.test(k) && typeof labels[Number(k)] === 'string')
    .map(Number)
    .sort((a, b) => a - b);
  if (values.length === 0) return undefined;
  const out: Record<string, string> = {};
  for (const v of values) out[String(v)] = labels[v];
  return out;
}

/** `{"w-annotator":{"labels":{"1":"Liver",...}}}`, or undefined when there are no names. */
export function labelsDocument(labels: Record<number, string> | undefined): string | undefined {
  const sorted = sortedLabels(labels);
  return sorted && JSON.stringify({ [APP_KEY]: { labels: sorted } });
}

/** `{"1":"Liver",...}` on one line in plain ASCII (other characters as \uXXXX), or undefined. */
export function labelsLine(labels: Record<number, string> | undefined): string | undefined {
  const sorted = sortedLabels(labels);
  if (!sorted) return undefined;
  return JSON.stringify(sorted).replace(/[^\x20-\x7e]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`);
}

/**
 * Reads names from the document form, and from the bare map too unless
 * `documentOnly` is set. Never throws: text that is not ours, or
 * that is damaged, gives undefined, and entries that are not "integer: string"
 * are dropped.
 */
export function parseLabels(text: string, documentOnly = false): Record<number, string> | undefined {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return undefined;
  }
  const object = (v: unknown): Record<string, unknown> | undefined =>
    typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : undefined;
  const top = object(doc);
  if (!top) return undefined;
  const map = Object.hasOwn(top, APP_KEY) ? object(object(top[APP_KEY])?.labels) : documentOnly ? undefined : top;
  if (!map) return undefined;
  const labels: Record<number, string> = {};
  let found = false;
  for (const [key, name] of Object.entries(map)) {
    if (!/^\d+$/.test(key) || typeof name !== 'string') continue;
    labels[Number(key)] = name;
    found = true;
  }
  return found ? labels : undefined;
}
