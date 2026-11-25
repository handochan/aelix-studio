import type { CancelReport, CancelReportEntry, CancelReportView, SubagentPresentation } from './types';

/*
 * The report a cancelled `agent` call leaves as its own result (aelix-ai #800,
 * ADR-0307 D1), as rendered by native `aelix_agents/aggregate.py`
 * `render_cancel_report` at the pinned commit:
 *
 *   <HEAD>\n\n<OPEN>\n<body>\n<CLOSE>\n<data note>[\n\n<position notes>]
 *
 * A single call's body is its one child's text. A batch's body is a header
 * line, then one block per member that had a child, in submitted order, each
 * starting `[i/N status]`. Positions without a child are named after the
 * fence, outside the children's control. Native escapes forged fence tags and
 * header markers inside the body, but a child can still write a blank line and
 * a fake `[i/N …]` heading, so a split is accepted only when every position
 * 1..N appears exactly once, in order, across blocks and notes.
 */
const HEAD = '[aelix system report — not user input]';
const OPEN = '<cancelled-delegation-report>';
const CLOSE = '</cancelled-delegation-report>';
const BATCH_HEADER = /^agent .+ · (parallel|chain) · (\d+) tasks$/;
const BLOCK_HEADING = /^\[(\d+)\/(\d+) [^\]\n]+\]/;
const BLOCK_BREAK = /\n\n(?=\[\d+\/\d+ [^\]\n]+\])/;
const LOST_NOTE =
  /^(Task|Step)s? (\d+(?:, \d+)*) of (\d+) had (?:an agent|agents) running that ended on an internal error; what (?:it|they) had done is not in this report\.$/;
const IDLE_NOTE =
  /^(Task|Step)s? (\d+(?:, \d+)*) of (\d+) had no agent running when the turn was cancelled: not started, or not reached\.$/;

const occurrences = (text: string, part: string): number => text.split(part).length - 1;

/** The fenced body and the trailing position notes, or null when the frame is not native's. */
const unfence = (output: string): { body: string; notes: string | undefined } | null => {
  if (!output.startsWith(HEAD) || occurrences(output, OPEN) !== 1 || occurrences(output, CLOSE) !== 1) return null;
  const open = output.indexOf(`\n\n${OPEN}\n`);
  const close = output.indexOf(`\n${CLOSE}\n`);
  if (open < 0 || close < open) return null;
  const body = output.slice(open + OPEN.length + 3, close);
  const tail = output.slice(close + CLOSE.length + 2);
  const split = tail.indexOf('\n\n');
  // The first paragraph after the fence is native's data note; it never holds a blank line.
  if (!tail.startsWith('(')) return null;
  return { body, notes: split < 0 ? undefined : tail.slice(split + 2) };
};

const positionsOf = (list: string): number[] => list.split(', ').map(Number);

const parseBatch = (header: RegExpExecArray, rest: string, notes: string | undefined): CancelReport | null => {
  const noun = header[1] === 'chain' ? 'step' : 'task';
  const total = Number(header[2]);
  if (!Number.isSafeInteger(total) || total < 1) return null;
  const entries = new Map<number, CancelReportEntry>();
  let previous = 0;
  for (const block of rest ? rest.split(BLOCK_BREAK) : []) {
    const heading = BLOCK_HEADING.exec(block);
    if (!heading || Number(heading[2]) !== total) return null;
    const position = Number(heading[1]);
    if (position <= previous || position > total) return null;
    previous = position;
    entries.set(position, { position, kind: 'ran', text: block });
  }
  const expectedNoun = noun === 'step' ? 'Step' : 'Task';
  for (const line of notes === undefined ? [] : notes.split('\n')) {
    const lost = LOST_NOTE.exec(line);
    const note = lost ?? IDLE_NOTE.exec(line);
    if (!note || note[1] !== expectedNoun || Number(note[3]) !== total) return null;
    for (const position of positionsOf(note[2])) {
      if (position < 1 || position > total || entries.has(position)) return null;
      entries.set(position, { position, kind: lost ? 'lost' : 'idle' });
    }
  }
  if (entries.size !== total) return null;
  return {
    kind: 'batch',
    noun,
    total,
    entries: Array.from({ length: total }, (_, index) => entries.get(index + 1)!),
  };
};

/** Parse native's cancel report from the parent call's result text; null when it is absent or not provably split. */
export const parseCancelReport = (output: string): CancelReport | null => {
  const frame = unfence(output);
  if (!frame) return null;
  const split = frame.body.indexOf('\n\n');
  const header = BATCH_HEADER.exec(split < 0 ? frame.body : frame.body.slice(0, split));
  if (header) return parseBatch(header, split < 0 ? '' : frame.body.slice(split + 2), frame.notes);
  // A single call's report has no position notes and no batch header.
  if (frame.notes !== undefined || !frame.body.trim()) return null;
  return { kind: 'single', text: frame.body };
};

export const isCancelReport = (output: string | undefined): boolean => output?.startsWith(HEAD) === true;

/**
 * The report section of a delegating call, from its final result text.
 * Only an ended (failed/cancelled) parent is read: a completed call's text can
 * begin with a child's own words. `pending` means the list row is a compact
 * preview and the full result has not been loaded yet.
 */
export const presentCancelReport = (
  presentation: SubagentPresentation,
  output: string | undefined,
  state: { pending: boolean; loadFailed: boolean }
): CancelReportView | null => {
  // The call's own status: a parent projected from stopped rows has not delivered its result yet.
  const ended = presentation.callStatus === 'error' || presentation.callStatus === 'canceled';
  if (!ended) return null;
  const stopped = presentation.progress.children.some((child) => child.state === 'stopped');
  if (state.loadFailed) return isCancelReport(output) || stopped ? { kind: 'loadFailed' } : null;
  if (state.pending) return null;
  if (!isCancelReport(output)) return stopped ? { kind: 'missing' } : null;
  const report = parseCancelReport(output!);
  if (!report) return { kind: 'unreadable' };
  const { children, hasDiscardedChildren } = presentation.progress;
  // Every reported member had a process, so it had a progress row; more blocks than rows is not this call.
  const ran = report.kind === 'single' ? 1 : report.entries.filter((entry) => entry.kind === 'ran').length;
  if (!hasDiscardedChildren && ran > children.length) return { kind: 'unreadable' };
  return report;
};
