// Work tracking for a job (bill): Received -> Design -> Review -> Print -> Frame -> Final.
// Shared by the server (public bill page) and the app (tracking page, bill view).
import { escapeHtml as e } from './format.js';

export const WORK_STAGES = [
  { key: 'received', label: 'Received', customer: 'We have received your order.' },
  { key: 'design', label: 'Design', customer: 'We have started designing your order.' },
  { key: 'review', label: 'Review', customer: 'Your design is ready for review. Please check it and share your feedback.' },
  { key: 'print', label: 'Print', customer: 'Your order has gone for printing.' },
  { key: 'frame', label: 'Frame', customer: 'Your prints are being framed.' },
  { key: 'final', label: 'Final', customer: 'Your order is ready.' },
];

export const STAGE_KEYS = WORK_STAGES.map((s) => s.key);

// How the customer's photo came in, kept on the bill and shown with the job.
export const PHOTO_SOURCES = {
  whatsapp: 'WhatsApp',
  photo: 'Photo to photo',
  studio: 'In studio',
  other: 'Other',
};

export const stageInfo = (key) => WORK_STAGES.find((s) => s.key === key) || null;
export const stageLabel = (key) => stageInfo(key)?.label || '';
export const stageIndex = (key) => STAGE_KEYS.indexOf(key);

const CHECK = '<svg class="c-check" viewBox="0 0 24 24" aria-hidden="true"><path d="M20 6 9 17l-5-5"/></svg>';

/** One line, one stage after another: ✓ Design › [Review] › Print › Frame › Final. */
export function renderChain(current) {
  const ci = stageIndex(current);
  const complete = current === 'final';
  return `<ol class="chain${complete ? ' chain-complete' : ''}" aria-label="Stage ${ci + 1} of ${WORK_STAGES.length}: ${e(stageLabel(current))}">${WORK_STAGES.map((s, i) => {
    if (i < ci) return `<li class="c-done">${CHECK}${e(s.label)}</li>`;
    if (i === ci) return `<li class="c-current" aria-current="step"><span>${e(s.label)}</span></li>`;
    return `<li class="c-todo">${e(s.label)}</li>`;
  }).join('')}</ol>`;
}
