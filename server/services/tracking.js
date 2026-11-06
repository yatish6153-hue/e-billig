// Job tracking: move a created bill through Design -> Review -> Print -> Frame -> Final.
import { get, all, run, tx, nowIso } from '../db.js';
import { STAGE_KEYS } from '../../shared/tracking.js';
import * as v from '../util.js';

/** Set the job's stage (null stops tracking). Every change is kept in the stage history. */
export function setStage(businessId, userId, billId, stage, { note = '', at = null } = {}) {
  const value = stage === null || stage === undefined || stage === '' ? null : v.oneOf(stage, STAGE_KEYS, 'stage', 'Stage');
  const cleanNote = v.text(note, 'note', 'Note', { max: 200 });
  return tx(() => {
    const bill = get('SELECT status, work_stage FROM bills WHERE id = ? AND business_id = ?', billId, businessId);
    if (!bill) throw v.notFound('Bill');
    if (value && bill.status === 'draft') throw v.conflict('Create the bill first, then track its work.');
    if (value && bill.status === 'cancelled') throw v.conflict('Cancelled bills can’t be tracked.');
    const when = at || nowIso();
    run('UPDATE bills SET work_stage = ?, work_updated_at = ? WHERE id = ?', value, when, billId);
    if (value && (value !== bill.work_stage || cleanNote)) {
      run('INSERT INTO bill_stages (business_id, bill_id, stage, note, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)',
        businessId, billId, value, cleanNote, userId, when);
    }
  });
}

export function stageHistory(billId) {
  return all(
    `SELECT s.stage, s.note, s.created_at, u.name AS user_name
       FROM bill_stages s LEFT JOIN users u ON u.id = s.user_id
      WHERE s.bill_id = ? ORDER BY s.created_at, s.id`,
    billId,
  );
}

/** Number of tracked jobs in each stage (cancelled bills excluded). */
export function stageCounts(businessId) {
  const counts = Object.fromEntries(STAGE_KEYS.map((k) => [k, 0]));
  for (const r of all(
    `SELECT work_stage, COUNT(*) AS n FROM bills
      WHERE business_id = ? AND status = 'finalized' AND work_stage IS NOT NULL GROUP BY work_stage`,
    businessId,
  )) counts[r.work_stage] = r.n;
  return counts;
}
