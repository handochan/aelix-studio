/**
 * Entry point of the full-verification gate action. Reads the event from the environment that
 * `action.yml` prepares, then publishes the decision as step outputs, a notice and a step summary.
 */
import fs from 'node:fs';
import { decideFullVerification, renderGateSummary } from './gate.mjs';

const { GATE_EVENT_NAME, GATE_LABELS, GATE_CHANGED_FILES, GATE_JOBS, GITHUB_OUTPUT, GITHUB_STEP_SUMMARY } = process.env;

// `toJSON` of the label names is `null` outside pull requests. Malformed input throws, which
// fails the gate job visibly instead of silently skipping verification.
const labels = JSON.parse(GATE_LABELS || 'null') ?? [];
if (!Array.isArray(labels) || labels.some((label) => typeof label !== 'string'))
  throw new Error('GATE_LABELS must be a JSON array of label names');

// NUL-separated output of `git diff --name-only -z`; a missing file means the diff was unavailable.
const changedFiles =
  GATE_CHANGED_FILES && fs.existsSync(GATE_CHANGED_FILES)
    ? fs.readFileSync(GATE_CHANGED_FILES, 'utf8').split('\0').filter(Boolean)
    : null;

const decision = decideFullVerification({ eventName: GATE_EVENT_NAME ?? '', labels, changedFiles });
// Workflow command properties are comma-separated, so the title carries no comma.
const title = decision.run ? 'Full verification runs' : 'Full verification SKIPPED - not run and not passed';

console.log(`::notice title=${title}::${decision.reason}`);
if (GITHUB_OUTPUT) fs.appendFileSync(GITHUB_OUTPUT, `run=${decision.run}\nreason=${decision.reason}\n`);
if (GITHUB_STEP_SUMMARY)
  fs.appendFileSync(GITHUB_STEP_SUMMARY, renderGateSummary(decision, GATE_JOBS || 'full-verification jobs'));
