// =====================================================================
// StockRidge — AUDIT LOG  +  HASH-CHAINED REGISTERS
// =====================================================================
//
// TWO DIFFERENT THINGS, BOTH CALLED "AUDIT", AND CONFLATING THEM IS THE
// MISTAKE THIS FILE EXISTS TO PREVENT:
//
//   audit_log        an OPERATIONAL trail: who changed what, when, from
//                    which branch and device. Editable by nobody through the
//                    app, but a plain table — someone with database access
//                    can rewrite it. Sufficient for "why is this price
//                    different?" and for the void-rate shrinkage signal.
//
//   compliance_register  an EVIDENTIARY trail: append-only and HASH-CHAINED.
//                    Each row stores the SHA-256 of the previous row, so
//                    editing or deleting any historical entry breaks the
//                    chain for everything after it. This is what you hand an
//                    auditor, a manufacturer settling a warranty dispute, or
//                    the police investigating a serialised item that walked
//                    out. Database-level tampering is DETECTABLE, which is
//                    the honest claim — no application-layer scheme can make
//                    it impossible.
//
// PharmaRidge used the chained register for controlled drugs. StockRidge
// generalises it, because for an electronics wholesaler the SERIAL CUSTODY
// CHAIN is a harder and more valuable problem than the pharmacy one it
// replaces: "this iPhone with IMEI X left the Ikeja branch on receipt
// SR-IKE-2026-000431, sold to a customer who gave NIN Y, and was returned
// on RT-IKE-2026-000012" is the difference between a warranty claim and a
// fraud investigation.
// =====================================================================

const { sha256Hex, watNowIso, newId } = require('../../shared/ids');

// ---------------------------------------------------------------------
// OPERATIONAL AUDIT LOG
// ---------------------------------------------------------------------
// Best-effort by design: a failed audit write must NEVER roll back the
// business event it describes. Losing an audit line is bad; refusing to
// complete a customer's sale because the audit table was locked is worse,
// and it would teach staff to distrust the system.
async function writeAudit(db, entry) {
  try {
    await db.prepare(`
      INSERT INTO audit_log (business_unit_id, branch_id, user_id, actor_role, action, entity_type, entity_id,
                             before_json, after_json, amount, reason, ip_address, user_agent, device_id, occurred_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    `).bind(
      entry.businessUnitId || null,
      entry.branchId || null,
      entry.userId || null,
      entry.actorRole || null,
      String(entry.action || 'UNKNOWN').slice(0, 80),
      entry.entityType ? String(entry.entityType).slice(0, 60) : null,
      entry.entityId ? String(entry.entityId).slice(0, 80) : null,
      entry.before == null ? null : safeJson(entry.before).slice(0, 20000),
      entry.after == null ? null : safeJson(entry.after).slice(0, 20000),
      Number.isFinite(Number(entry.amount)) ? Number(entry.amount) : null,
      entry.reason ? String(entry.reason).slice(0, 500) : null,
      entry.ipAddress ? String(entry.ipAddress).slice(0, 60) : null,
      entry.userAgent ? String(entry.userAgent).slice(0, 200) : null,
      entry.deviceId ? String(entry.deviceId).slice(0, 120) : null,
      watNowIso()
    ).run();
    return true;
  } catch (e) {
    console.error('[audit] write failed (business event NOT rolled back):', e && e.message);
    return false;
  }
}

function safeJson(value) {
  try {
    // Strip credentials before they can ever land in a log. A before/after
    // snapshot of a users row would otherwise carry pin_hash — which is a
    // hashed credential, but a log is the worst possible place for one.
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const clone = { ...value };
      for (const k of ['pin_hash', 'pin', 'token', 'password', 'logo_data_url', 'receipt_data_url', 'pod_signature_data_url', 'pod_photo_data_url']) {
        if (k in clone) clone[k] = '[redacted]';
      }
      return JSON.stringify(clone);
    }
    return JSON.stringify(value);
  } catch (_) {
    return String(value);
  }
}

// The shrinkage/fraud questions a manager actually asks. Kept as named
// queries rather than ad-hoc SQL in routes so the definitions cannot drift
// between the dashboard and the audit screen.
async function queryAudit(db, {
  businessUnitId, branchId, userId, action, entityType, entityId,
  from, to, limit = 200, offset = 0,
}) {
  const where = [];
  const params = [];
  if (businessUnitId) { where.push('business_unit_id = ?'); params.push(businessUnitId); }
  if (branchId) { where.push('branch_id = ?'); params.push(branchId); }
  if (userId) { where.push('user_id = ?'); params.push(userId); }
  if (action) { where.push('action = ?'); params.push(action); }
  if (entityType) { where.push('entity_type = ?'); params.push(entityType); }
  if (entityId) { where.push('entity_id = ?'); params.push(entityId); }
  if (from) { where.push("occurred_at >= ?"); params.push(`${String(from).slice(0, 10)} 00:00:00`); }
  if (to) { where.push("occurred_at <= ?"); params.push(`${String(to).slice(0, 10)} 23:59:59`); }
  const sql = `
    SELECT a.*, u.full_name AS user_name, u.role AS user_role, b.name AS branch_name
    FROM audit_log a
    LEFT JOIN users u ON u.id = a.user_id
    LEFT JOIN branches b ON b.id = a.branch_id
    ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
    ORDER BY a.occurred_at DESC, a.id DESC
    LIMIT ? OFFSET ?
  `;
  const rows = await db.prepare(sql).bind(...params, Math.min(1000, Number(limit) || 200), Number(offset) || 0).all();
  return rows.results;
}

// ---------------------------------------------------------------------
// HASH-CHAINED COMPLIANCE REGISTER
// ---------------------------------------------------------------------
// Canonical serialisation. The hash must be reproducible from the stored
// row alone, so field ORDER and NULL handling are fixed here and never
// derived from object key order (which JSON.stringify preserves as
// insertion order — a real source of "the chain verified yesterday" bugs).
function canonicalRow(r) {
  return [
    r.id, r.business_unit_id, r.branch_id, r.scheme_code, r.event_type,
    r.product_id || '', r.serial_id || '', r.stock_batch_id || '',
    r.sale_id || '', r.transfer_id || '',
    String(r.quantity == null ? '' : r.quantity),
    r.certificate_id || '',
    r.counterparty_name || '', r.counterparty_phone || '',
    r.counterparty_id_type || '', r.counterparty_id_no || '',
    r.counterparty_address || '',
    r.detail || '', r.performed_by || '', r.device_id || '', r.ip_address || '',
    r.occurred_at, r.prev_hash || 'GENESIS', String(r.chain_seq),
  ].join('|');
}

async function lastChainRow(db, { branchId, schemeCode }) {
  return db.prepare(`
    SELECT id, row_hash, chain_seq FROM compliance_register
    WHERE branch_id = ? AND scheme_code = ?
    ORDER BY chain_seq DESC LIMIT 1
  `).bind(branchId, schemeCode).first();
}

// Append one register entry. Returns the row including its hash so the
// caller can show it on the receipt/document.
async function appendRegister(db, entry) {
  const id = entry.id || newId();
  const occurredAt = entry.occurred_at || watNowIso();
  const prev = await lastChainRow(db, { branchId: entry.branch_id, schemeCode: entry.scheme_code });
  const prevHash = prev ? prev.row_hash : null;
  const chainSeq = prev ? Number(prev.chain_seq) + 1 : 1;

  const row = {
    id,
    business_unit_id: entry.business_unit_id,
    branch_id: entry.branch_id,
    scheme_code: entry.scheme_code,
    event_type: entry.event_type,
    product_id: entry.product_id || null,
    serial_id: entry.serial_id || null,
    stock_batch_id: entry.stock_batch_id || null,
    sale_id: entry.sale_id || null,
    transfer_id: entry.transfer_id || null,
    quantity: entry.quantity == null ? 1 : Number(entry.quantity),
    certificate_id: entry.certificate_id || null,
    counterparty_name: entry.counterparty_name || null,
    counterparty_phone: entry.counterparty_phone || null,
    counterparty_id_type: entry.counterparty_id_type || null,
    counterparty_id_no: entry.counterparty_id_no || null,
    counterparty_address: entry.counterparty_address || null,
    detail: entry.detail || null,
    performed_by: entry.performed_by || null,
    device_id: entry.device_id || null,
    ip_address: entry.ip_address || null,
    occurred_at: occurredAt,
    prev_hash: prevHash,
    chain_seq: chainSeq,
  };
  row.row_hash = await sha256Hex(canonicalRow(row));

  await db.prepare(`
    INSERT INTO compliance_register (
      id, business_unit_id, branch_id, scheme_code, event_type, product_id, serial_id, stock_batch_id,
      sale_id, transfer_id, quantity, certificate_id, counterparty_name, counterparty_phone,
      counterparty_id_type, counterparty_id_no, counterparty_address, detail, performed_by,
      device_id, ip_address, occurred_at, created_at, prev_hash, row_hash, chain_seq
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `).bind(
    row.id, row.business_unit_id, row.branch_id, row.scheme_code, row.event_type, row.product_id,
    row.serial_id, row.stock_batch_id, row.sale_id, row.transfer_id, row.quantity, row.certificate_id,
    row.counterparty_name, row.counterparty_phone, row.counterparty_id_type, row.counterparty_id_no,
    row.counterparty_address, row.detail, row.performed_by, row.device_id, row.ip_address,
    row.occurred_at, watNowIso(), row.prev_hash, row.row_hash, row.chain_seq
  ).run();

  return row;
}

// Verify a chain end to end. Returns the first break it finds, or
// { verified: true, entries: n }. Recomputes every hash from the stored
// columns, so it detects an UPDATE, a DELETE and a re-ordered insert alike.
async function verifyChain(db, { branchId, schemeCode, limit = 100000 }) {
  const rows = await db.prepare(`
    SELECT * FROM compliance_register
    WHERE branch_id = ? AND scheme_code = ?
    ORDER BY chain_seq ASC LIMIT ?
  `).bind(branchId, schemeCode, limit).all();

  let expectedPrev = null;
  let expectedSeq = 1;
  for (const r of rows.results) {
    if (Number(r.chain_seq) !== expectedSeq) {
      return { verified: false, entries: rows.results.length, break_at_seq: Number(r.chain_seq), expected_seq: expectedSeq, reason: 'SEQUENCE_GAP', row_id: r.id };
    }
    if ((r.prev_hash || null) !== expectedPrev) {
      return { verified: false, entries: rows.results.length, break_at_seq: Number(r.chain_seq), reason: 'PREV_HASH_MISMATCH', row_id: r.id };
    }
    const recomputed = await sha256Hex(canonicalRow(r));
    if (recomputed !== r.row_hash) {
      return { verified: false, entries: rows.results.length, break_at_seq: Number(r.chain_seq), reason: 'ROW_HASH_MISMATCH', row_id: r.id, expected_hash: recomputed, stored_hash: r.row_hash };
    }
    expectedPrev = r.row_hash;
    expectedSeq += 1;
  }
  return { verified: true, entries: rows.results.length, head_hash: expectedPrev, tail_seq: expectedSeq - 1 };
}

// Every chain in the deployment, for the ADMIN integrity screen.
async function verifyAllChains(db, { businessUnitId = null } = {}) {
  const rows = await db.prepare(`
    SELECT DISTINCT branch_id, scheme_code FROM compliance_register
    WHERE (? IS NULL OR business_unit_id = ?)
  `).bind(businessUnitId || null, businessUnitId || null).all();
  const out = [];
  for (const r of rows.results) {
    const v = await verifyChain(db, { branchId: r.branch_id, schemeCode: r.scheme_code });
    out.push({ branch_id: r.branch_id, scheme_code: r.scheme_code, ...v });
  }
  return out;
}

module.exports = {
  writeAudit, safeJson, queryAudit,
  canonicalRow, lastChainRow, appendRegister, verifyChain, verifyAllChains,
};
