// Stage buttons for a tracked job: Received · Design · Review · Print · Frame · Final. Tapping one moves the job there.
// Earlier stages show as done (✓), the current one is solid, and a job at Final is complete (all green).
// readOnly draws the same chain to look at only (the team's view), with nothing to tap.
import { html } from '../lib/dom.js';
import { icon } from '../lib/icons.js';
import { WORK_STAGES, stageIndex } from '/shared/tracking.js';

export function stageButtons(current, { readOnly = false } = {}) {
  const ci = stageIndex(current);
  const complete = current === 'final';
  return html`<div class="stages${complete ? ' is-complete' : ''}${readOnly ? ' is-static' : ''}" role="${readOnly ? 'list' : 'group'}"
    aria-label="Work stage">${WORK_STAGES.map((s, i) => {
    const done = i < ci || (complete && i === ci);
    const cls = `st${i < ci ? ' st-done' : ''}${i === ci ? ' st-current' : ''}`;
    if (readOnly) {
      return html`<span class="${cls}" role="listitem" aria-current="${i === ci ? 'step' : 'false'}">${done ? icon('check', 'sm') : ''}${s.label}</span>`;
    }
    const title = i < ci ? `Back to ${s.label}` : i === ci ? `Now at ${s.label}` : `Move to ${s.label}`;
    return html`<button type="button" class="${cls}" data-set-stage="${s.key}"
      title="${title}" aria-pressed="${i === ci}">${done ? icon('check', 'sm') : ''}${s.label}</button>`;
  })}</div>`;
}
