import { canonicalName } from './metadata.js';

export type Requirement = {
  /** Canonical distribution name. */
  name: string;
  extras: string[];
  /** Set for a direct reference (`name @ url`); the installer would fetch this address. */
  url?: string;
  /** Version clauses as written, without surrounding parentheses. Empty when there are none. */
  specifier: string;
  /** Environment marker as written, when present. */
  marker?: string;
};

const NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?/;
const EXTRA = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;
const CLAUSE = /^(?:~=|===|==|!=|<=|>=|<|>)\s*(?![<>=!~])[^\s,;()]+$/;

/**
 * Parse one PEP 508 dependency specifier (a `Requires-Dist` value).
 *
 * The form is read structurally: a name, optional extras, then either `@` and an address
 * or version clauses, then an optional marker. A search for " @ " is not enough, because
 * `name@git+ssh://host/repo` is a direct reference without any space.
 *
 * Returns undefined when the text is not a requirement this parser understands; callers
 * treat that as a refusal, never as "no direct reference".
 */
export function parseRequirement(text: string): Requirement | undefined {
  let rest = text.trim();
  const name = NAME.exec(rest)?.[0];
  if (!name) return undefined;
  rest = rest.slice(name.length).trimStart();
  let extras: string[] = [];
  if (rest[0] === '[') {
    const close = rest.indexOf(']');
    if (close < 0) return undefined;
    const inner = rest.slice(1, close).trim();
    extras = inner === '' ? [] : inner.split(',').map((extra) => extra.trim());
    if (extras.some((extra) => !EXTRA.test(extra))) return undefined;
    rest = rest.slice(close + 1).trimStart();
  }
  if (rest[0] === '@') {
    // PEP 508 ends the address at whitespace followed by ';'. The address itself may hold ';'.
    const body = rest.slice(1).trim();
    const split = /\s;/.exec(body);
    const url = (split ? body.slice(0, split.index) : body).trim();
    const marker = split ? body.slice(split.index + split[0].length).trim() : undefined;
    if (url === '' || marker === '') return undefined;
    return { name: canonicalName(name), extras, url, specifier: '', ...(marker ? { marker } : {}) };
  }
  const semicolon = rest.indexOf(';');
  let specifier = (semicolon < 0 ? rest : rest.slice(0, semicolon)).trim();
  const marker = semicolon < 0 ? undefined : rest.slice(semicolon + 1).trim();
  if (marker === '') return undefined;
  if (specifier.startsWith('(')) {
    if (!specifier.endsWith(')')) return undefined;
    specifier = specifier.slice(1, -1).trim();
  }
  if (specifier !== '' && specifier.split(',').some((clause) => !CLAUSE.test(clause.trim()))) return undefined;
  return { name: canonicalName(name), extras, specifier, ...(marker ? { marker } : {}) };
}
