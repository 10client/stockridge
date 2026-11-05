'use strict';
// The pull watermark. A timestamp alone skips every other row that shares
// that second. The page cursor is the pair (updated_at, id). The lower bound
// sits two minutes behind the stored cursor so a write that landed while the
// previous read was in flight is asked again. The merge is idempotent, so
// that overlap is not a second copy.

const OVERLAP_MS = 2 * 60 * 1000;

function overlapBound(sinceSql, overlapMs = OVERLAP_MS) {
  const raw = String(sinceSql || '').trim();
  if (!raw) return null;
  const iso = raw.includes('T') ? raw : raw.replace(' ', 'T');
  const withZone = /Z$|[+-]\d{2}:?\d{2}$/.test(iso) ? iso : `${iso}Z`;
  const ms = Date.parse(withZone);
  if (!Number.isFinite(ms)) return raw.slice(0, 19).replace('T', ' ');
  return new Date(ms - overlapMs).toISOString().slice(0, 19).replace('T', ' ');
}

/**
 * The WHERE fragment for one watermark page.
 * `column` must already be a safe identifier. `afterAt` is UTC SQL datetime.
 * Returns null when there is no usable bound — the caller keeps the id walk.
 */
function watermarkPage({ since, afterAt, afterId, column }) {
  const bound = overlapBound(since);
  if (!bound) return null;
  const col = column || 'updated_at';
  const params = [bound];
  let sql = `${col} >= ?`;
  if (afterAt && afterId) {
    sql += ` AND (${col}, id) > (?, ?)`;
    params.push(String(afterAt), String(afterId));
  }
  return { sql, params, order: `${col}, id` };
}

module.exports = { OVERLAP_MS, overlapBound, watermarkPage };
