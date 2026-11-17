import path from 'node:path';
import { parseRequirement } from '../inspect/requirement.js';
import { INSTALLER } from '../inspect/site.js';
import { specifierExcludes } from '../inspect/version.js';
import { isEntryName, isObjectReference } from '../inspect/metadata.js';
import { isInterpreterName, readWheel, WheelError, type WheelFacts } from '../inspect/wheel.js';
import type { BundleFacts } from '../store/layout.js';
import type { ImportRefusalCode } from '../types.js';

export type ImportProblem = { code: ImportRefusalCode; message: string };

export type ImportCheck = {
  /** The requested wheel, when it could be read. */
  target?: WheelFacts;
  /** Every wheel of the set that could be read, the requested one included. */
  wheels: WheelFacts[];
  problems: ImportProblem[];
};

/**
 * Check an import set before any installer runs (D04 ADR 5.9, decisions B1, B2, B4). Only
 * files are read; nothing in them is imported, built or run.
 *
 * For every wheel of the set:
 * - it must be a readable wheel (a source archive would run build code and fetch build tools);
 * - no requirement may be a direct reference (`name @ url`): the installer would fetch that
 *   address, or run `git clone`, whatever index settings it is given.
 *
 * For the requested wheel, which is certain to be installed:
 * - it provides at least one `aelix.extensions` entry point;
 * - it ships no file that runs when an interpreter starts (`.pth`, `sitecustomize`, `usercustomize`);
 * - neither its distribution name nor a top-level name belongs to the bundle or the installer,
 *   and it installs no script under a name of the interpreter or the installer;
 * - no unconditional requirement excludes the version of a library the bundle ships.
 *
 * The same rules are enforced again after the installer ran, on what was actually installed
 * (the generation scan), and by the installer itself through the bundle's constraints.
 * This check gives an early refusal with a precise reason; it is not the only gate.
 */
export async function checkImport(target: string, files: string[], bundle: BundleFacts): Promise<ImportCheck> {
  const check: ImportCheck = { wheels: [], problems: [] };
  const report = (code: ImportRefusalCode, file: string, message: string): void => {
    check.problems.push({ code, message: `${path.basename(file)}: ${message}` });
  };
  for (const file of files) {
    let wheel: WheelFacts;
    try {
      // oxlint-disable-next-line no-await-in-loop -- wheels are opened one at a time
      wheel = await readWheel(file);
    } catch (error) {
      if (!(error instanceof WheelError)) throw error;
      report(file.endsWith('.whl') ? 'INVALID_WHEEL' : 'NOT_A_WHEEL', file, error.message);
      continue;
    }
    check.wheels.push(wheel);
    if (file === target) check.target = wheel;
    for (const text of wheel.requires) {
      const requirement = parseRequirement(text);
      if (!requirement) report('INVALID_WHEEL', file, `requirement cannot be read: ${text}`);
      else if (requirement.url !== undefined) report('DIRECT_REFERENCE', file, `direct-reference dependency ${text}`);
    }
  }
  const wheel = check.target;
  if (!wheel) {
    if (!check.problems.some((problem) => problem.message.startsWith(path.basename(target))))
      report('NOT_A_WHEEL', target, 'the requested wheel is not in the import set');
    return check;
  }
  if (wheel.extensions.size === 0) report('NOT_AN_EXTENSION', target, 'provides no aelix.extensions entry point');
  for (const [name, reference] of wheel.extensions)
    if (!isEntryName(name) || !isObjectReference(reference))
      report('INVALID_WHEEL', target, `entry point ${name} cannot be passed to native`);
  for (const member of wheel.startupFiles) report('STARTUP_CODE', target, `${member} runs when the interpreter starts`);
  if (wheel.name === INSTALLER || bundle.distributions.has(wheel.name))
    report('BUNDLE_OVERLAP', target, `distribution ${wheel.name} is shipped with Studio`);
  for (const name of wheel.topLevel)
    if (name === INSTALLER || bundle.topLevel.has(name))
      report('BUNDLE_OVERLAP', target, `top-level module ${name} is shipped with Studio`);
  for (const script of wheel.scripts)
    if (isInterpreterName(script))
      report('BUNDLE_OVERLAP', target, `script ${script} would replace the interpreter or installer of Studio`);
  for (const text of wheel.requires) {
    const requirement = parseRequirement(text);
    if (!requirement || requirement.url !== undefined || requirement.marker !== undefined) continue;
    const shipped = bundle.distributions.get(requirement.name);
    if (shipped !== undefined && specifierExcludes(requirement.specifier, shipped))
      report('BUNDLE_VERSION_CONFLICT', target, `requires ${text}; Studio ships ${requirement.name} ${shipped}`);
  }
  return check;
}
