/**
 * Enough of PEP 440 to tell, before any installer runs, that a requirement cannot accept
 * the version the bundle ships. The installer, run with the bundle's versions as
 * constraints, stays the authority: this only answers "certainly excluded" and leaves
 * every doubtful case (local versions, arbitrary equality, text it cannot parse) to it.
 */

export type Version = {
  epoch: number;
  release: number[];
  pre: [number, number] | null;
  post: number | null;
  dev: number | null;
  local: string | null;
};

const VERSION = new RegExp(
  '^v?(?:(\\d+)!)?(\\d+(?:\\.\\d+)*)' +
    '(?:[-_.]?(alpha|a|beta|b|preview|pre|c|rc)[-_.]?(\\d+)?)?' +
    '(?:-(\\d+)|[-_.]?(post|rev|r)[-_.]?(\\d+)?)?' +
    '(?:[-_.]?(dev)[-_.]?(\\d+)?)?' +
    '(?:\\+([a-z0-9]+(?:[-_.][a-z0-9]+)*))?$',
  'i'
);

const PRE_ORDER: Record<string, number> = { a: 0, alpha: 0, b: 1, beta: 1, c: 2, rc: 2, pre: 2, preview: 2 };

/** Parse a PEP 440 version; undefined when the text is not one. */
export function parseVersion(text: string): Version | undefined {
  const match = VERSION.exec(text.trim());
  if (!match) return undefined;
  const [, epoch, release, preLabel, preNumber, postImplicit, postLabel, postNumber, devLabel, devNumber, local] =
    match;
  return {
    epoch: epoch ? Number(epoch) : 0,
    release: release.split('.').map(Number),
    pre: preLabel ? [PRE_ORDER[preLabel.toLowerCase()], preNumber ? Number(preNumber) : 0] : null,
    post: postImplicit ? Number(postImplicit) : postLabel ? (postNumber ? Number(postNumber) : 0) : null,
    dev: devLabel ? (devNumber ? Number(devNumber) : 0) : null,
    local: local ? local.toLowerCase() : null,
  };
}

function compareReleases(left: number[], right: number[]): number {
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** A dev release of the bare version sorts before every pre-release; a final sorts after them. */
const preKey = (version: Version): [number, number] =>
  version.pre ?? (version.post === null && version.dev !== null ? [-1, 0] : [3, 0]);

/** Order two versions by their public part (the local label is not compared). */
export function compareVersions(left: Version, right: Version): number {
  if (left.epoch !== right.epoch) return left.epoch - right.epoch;
  const release = compareReleases(left.release, right.release);
  if (release !== 0) return release;
  const [leftPre, rightPre] = [preKey(left), preKey(right)];
  if (leftPre[0] !== rightPre[0]) return leftPre[0] - rightPre[0];
  if (leftPre[1] !== rightPre[1]) return leftPre[1] - rightPre[1];
  const post = (left.post ?? -1) - (right.post ?? -1);
  if (post !== 0) return post;
  return (left.dev ?? Infinity) === (right.dev ?? Infinity) ? 0 : (left.dev ?? Infinity) - (right.dev ?? Infinity);
}

/** Full PEP 440 order, including normalized local version segments. */
export function compareInstalledVersions(left: Version, right: Version): number {
  const publicOrder = compareVersions(left, right);
  if (publicOrder !== 0 || left.local === right.local) return publicOrder;
  if (left.local === null) return -1;
  if (right.local === null) return 1;
  const a = left.local.split(/[-_.]/);
  const b = right.local.split(/[-_.]/);
  for (let index = 0; index < Math.min(a.length, b.length); index += 1) {
    const l = a[index];
    const r = b[index];
    if (l === r) continue;
    const lNumeric = /^\d+$/.test(l);
    const rNumeric = /^\d+$/.test(r);
    if (lNumeric !== rNumeric) return lNumeric ? 1 : -1;
    if (lNumeric) {
      const x = BigInt(l);
      const y = BigInt(r);
      if (x !== y) return x < y ? -1 : 1;
    } else return l < r ? -1 : 1;
  }
  return a.length - b.length;
}

const isPreRelease = (version: Version): boolean => version.pre !== null || version.dev !== null;

/** True, false, or undefined when this module cannot decide. */
function clauseAccepts(operator: string, operand: string, version: Version, compareLocal = false): boolean | undefined {
  if (operator === '===') return undefined;
  if (operand.endsWith('.*')) {
    if (operator !== '==' && operator !== '!=') return undefined;
    const prefix = /^v?(?:(\d+)!)?(\d+(?:\.\d+)*)$/i.exec(operand.slice(0, -2));
    if (!prefix) return undefined;
    const wanted = prefix[2].split('.').map(Number);
    const matches =
      (prefix[1] ? Number(prefix[1]) : 0) === version.epoch &&
      wanted.every((segment, index) => (version.release[index] ?? 0) === segment);
    return operator === '==' ? matches : !matches;
  }
  const bound = parseVersion(operand);
  if (!bound) return undefined;
  if (bound.local !== null) {
    if (!compareLocal) return undefined;
    if (operator === '==') return compareInstalledVersions(version, bound) === 0;
    if (operator === '!=') return compareInstalledVersions(version, bound) !== 0;
    return undefined;
  }
  const order = compareVersions(version, bound);
  switch (operator) {
    case '==':
      return order === 0;
    case '!=':
      return order !== 0;
    case '>=':
      return order >= 0;
    case '<=':
      return order <= 0;
    case '<':
      // Excludes pre-releases of the bound unless the bound is itself a pre-release.
      return (
        order < 0 &&
        !(!isPreRelease(bound) && isPreRelease(version) && compareVersions(version, { ...bound, dev: 0 }) >= 0)
      );
    case '>':
      // Excludes post-releases of the bound unless the bound is itself a post-release.
      return (
        order > 0 &&
        !(
          bound.post === null &&
          version.post !== null &&
          compareVersions({ ...version, post: null, dev: null }, bound) === 0
        )
      );
    case '~=': {
      if (bound.release.length < 2) return undefined;
      const prefix = bound.release.slice(0, -1);
      return (
        order >= 0 &&
        version.epoch === bound.epoch &&
        prefix.every((segment, index) => (version.release[index] ?? 0) === segment)
      );
    }
    default:
      return undefined;
  }
}

/**
 * Whether a version specifier (comma-separated clauses, as in `Requires-Dist`) certainly
 * excludes `installed`. Returns false whenever a clause or the version cannot be decided.
 */
export function specifierExcludes(specifier: string, installed: string): boolean {
  const version = parseVersion(installed);
  if (!version || version.local !== null) return false;
  for (const clause of specifier.split(',')) {
    const match = /^(~=|===|==|!=|<=|>=|<|>)\s*(?![<>=!~])(\S+)$/.exec(clause.trim());
    if (!match) continue;
    if (clauseAccepts(match[1], match[2], version) === false) return true;
  }
  return false;
}

/** Require every saved clause to accept the actual installed metadata, including local pins. */
export function acceptsInstalledVersion(specifier: string, installed: string): boolean {
  if (specifier === '') return true;
  const version = parseVersion(installed);
  return Boolean(
    version &&
    specifier.split(',').every((clause) => {
      const match = /^(~=|===|==|!=|<=|>=|<|>)\s*(\S+)$/.exec(clause.trim());
      if (!match) return false;
      if (match[1] === '===') return match[2].toLowerCase() === installed.toLowerCase();
      return clauseAccepts(match[1], match[2], version, true) === true;
    })
  );
}
