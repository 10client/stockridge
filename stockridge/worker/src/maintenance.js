// =====================================================================
// worker/src/maintenance.js — scheduled housekeeping
// =====================================================================
// Triggered by the Worker's cron handler. The Node backend runs the same jobs
// from server/lib/scheduler.js on a timer; both call the SAME functions in
// shared/services, so there is one definition of what "nightly maintenance"
// means and it cannot drift between backends.
//
// WHY THESE JOBS EXIST AT ALL:
//
//   releaseExpiredHolds    a hold with no expiry is a stock report that lies.
//                          Three abandoned holds on the only generator in a
//                          branch mean it shows zero available for a month while
//                          the generator sits in the corner.
//   refreshInstalments     an instalment that went past due + grace must become
//                          MISSED, or a plan shows "up to date" while the customer
//                          is three weeks late and nobody chases.
//   ageDebtors             a debtor past the policy threshold gets suspended from
//                          further credit. Without this the gate exists but never
//                          fires, because nothing updates the overdue figure.
//   verifyRegisters        a tamper-evident chain nobody ever verifies is a chain
//                          whose break will be found by whoever benefits from it,
//                          or by nobody.
//   checkCompliance        a lapsed SONCAP certificate stops goods clearing at the
//                          port. That is discovered at the port unless it is
//                          surfaced here first.
//   accrueWarranty         claims WILL arrive. Accruing monthly stops one month
//                          looking catastrophic and the rest artificially
//                          profitable.
//   pruneRetention         sync_change_log, idempotency_keys and login_attempts
//                          grow without bound. THIS IS THE JOB THE PHARMACY
//                          PRODUCT RAN ON ONE BACKEND AND NOT THE OTHER — a
//                          documented parity gap found only because somebody went
//                          looking. With one implementation called from both
//                          schedulers there is nothing to keep in step.

'use strict';

import core from '../../shared/services/coreService.js';
import HASHCHAIN from '../../shared/lib/hashchain.js';
import LAYAWAY from '../../shared/lib/layaway.js';
import INSTAL from '../../shared/lib/instalments.js';
import WARRANTY from '../../shared/lib/warranty.js';
import { todayWat } from '../../shared/lib/timegeo.js';
import { newId } from '../../shared/lib/ids.js';

/** Run every maintenance job. Each is independent: one failing must not stop the
 *  others, because a broken hold-release should not also mean retention never
 *  runs again. */
export async function runScheduledJobs(db, config) {
  const results = {};
  const jobs = [
    ['releaseExpiredHolds', () => releaseExpiredHolds(db)],
    ['refreshInstalments', () => refreshInstalments(db)],
    ['ageDebtors', () => ageDebtors(db)],
    ['verifyRegisters', () => verifyRegisters(db)],
    ['checkCompliance', () => checkCompliance(db)],
    ['accrueWarranty', () => accrueWarranty(db)],
    ['pruneRetention', () => pruneRetention(db, config)],
  ];
  for (const [name, fn] of jobs) {
    const started = Date.now();
    try {
      const r = await fn();
      results[name] = { ok: true, ...(r || {}), duration_ms: Date.now() - started };
    } catch (err) {
      results[name] = { ok: false, error: String(err && err.message || err), duration_ms: Date.now() - started };
      console.error(`[maintenance] ${name} failed:`, err && err.stack || err);
    }
    await recordRun(db, name, results[name]);
  }
  return results;
}

async function recordRun(db, jobName, result) {
  try {
    await db.prepare(`INSERT INTO scheduler_runs (id, job_name, business_id, status, started_at, finished_at,
        duration_ms, rows_affected, result_json, error_message, triggered_by)
      VALUES (?,?,'',?,?, datetime('now'), ?,?,?, 'SCHEDULE')`)
      .bind(newId(), jobName, new Date().toISOString().slice(0, 19).replace('T', ' '),
        result.ok ? 'SUCCESS' : 'FAILED', result.duration_ms || 0,
        Number(result.rows_affected) || 0,
        JSON.stringify(result).slice(0, 4000),
        result.ok ? null : String(result.error || '').slice(0, 500)).run();
  } catch (e) {
    console.error('[maintenance] could not record the run:', e && e.message);
  }
}

// ---------------------------------------------------------------------
// holds
// ---------------------------------------------------------------------
export async function releaseExpiredHolds(db) {
  const today = todayWat();
  const expired = await db.prepare(`
    SELECT * FROM layaway_holds
     WHERE status = 'ACTIVE' AND is_deleted = 0 AND expires_on < ?
  `).bind(today).all();

  let released = 0; let unitsFreed = 0;
  for (const hold of expired) {
    const rel = LAYAWAY.releaseHold({ hold, reason: 'EXPIRED', refundDeposit: true, forfeitPercent: 0 });
    const items = await db.prepare('SELECT * FROM layaway_hold_items WHERE hold_id = ? AND reserved = 1 AND is_deleted = 0').bind(hold.id).all();
    await db.transaction(async (tx) => {
      await tx.prepare(`UPDATE layaway_holds SET status='EXPIRED', released_at=datetime('now'), release_reason='EXPIRED',
          updated_at=datetime('now') WHERE id=?`).bind(hold.id).run();
      for (const it of items) {
        await tx.prepare("UPDATE stock_batches SET quantity_reserved = MAX(0, quantity_reserved - ?), updated_at=datetime('now') WHERE id=?")
          .bind(Number(it.quantity), it.stock_batch_id).run();
        await tx.prepare("UPDATE layaway_hold_items SET reserved=0, released_at=datetime('now'), updated_at=datetime('now') WHERE id=?").bind(it.id).run();
        await tx.prepare(`INSERT INTO stock_movements (id, business_id, branch_id, product_id, stock_batch_id,
            movement_type, direction, quantity, value_kobo, unit_cost, reservation_delta, source_type, source_id, notes, moved_at)
          VALUES (?,?,?,?,?, 'LAYAWAY_RELEASE', 0, 0, 0, 0, ?, 'HOLD', ?, ?, datetime('now'))`)
          .bind(newId(), hold.business_id, hold.branch_id, it.product_id, it.stock_batch_id,
            -Number(it.quantity), hold.id, `Hold ${hold.hold_number} expired`).run();
        unitsFreed += Number(it.quantity);
      }
      await tx.prepare("UPDATE serial_numbers SET status='IN_STOCK', updated_at=datetime('now') WHERE status='RESERVED' AND id IN (SELECT serial_id FROM layaway_hold_items WHERE hold_id=?)").bind(hold.id).run();
    });
    released += 1;
  }
  return { rows_affected: released, holds_released: released, units_freed: unitsFreed };
}

// ---------------------------------------------------------------------
// instalments
// ---------------------------------------------------------------------
export async function refreshInstalments(db) {
  const today = todayWat();
  const plans = await db.prepare(`SELECT * FROM instalment_plans WHERE status IN ('ACTIVE','DEFAULTED') AND is_deleted = 0`).all();
  let markedMissed = 0; let defaulted = 0;

  for (const plan of plans) {
    const schedule = await db.prepare(`SELECT * FROM instalment_schedule WHERE plan_id = ? AND is_deleted = 0 ORDER BY seq`).bind(plan.id).all();
    const planObj = {
      ...plan, graceDays: Number(plan.grace_days), missedBeforeDefault: Number(plan.missed_before_default),
    };
    const res = INSTAL.refreshOverdue({ plan: planObj, schedule, todayIso: today });
    if (!res.changed && res.status === plan.status) continue;

    await db.transaction(async (tx) => {
      for (const inst of res.schedule) {
        await tx.prepare("UPDATE instalment_schedule SET status=?, updated_at=datetime('now') WHERE id=? AND status != ?")
          .bind(inst.status, inst.id, inst.status).run();
      }
      await tx.prepare(`UPDATE instalment_plans SET missed_count=?, status=?,
          defaulted_at = CASE WHEN ? = 'DEFAULTED' AND defaulted_at IS NULL THEN datetime('now') ELSE defaulted_at END,
          updated_at=datetime('now') WHERE id=?`)
        .bind(res.missedCount, res.status, res.status, plan.id).run();
    });
    if (res.missedCount > Number(plan.missed_count)) markedMissed += 1;
    if (res.status === 'DEFAULTED' && plan.status !== 'DEFAULTED') defaulted += 1;
  }
  return { rows_affected: markedMissed + defaulted, plans_with_new_misses: markedMissed, newly_defaulted: defaulted };
}

// ---------------------------------------------------------------------
// debtors
// ---------------------------------------------------------------------
export async function ageDebtors(db) {
  const settings = await core.getSettings(db);
  const threshold = Number(settings.credit_max_overdue_days) || 30;
  // Suspending credit on an overdue account is the gate that saves the most
  // money and the one shops most often forget, because a POS that only checks the
  // LIMIT will happily sell more to a customer who is already 60 days late.
  // It is applied to account_status = 'SUSPENDED' rather than by deleting the
  // limit, so the limit is still there when the debt is cleared.
  const rows = await db.prepare(`
    UPDATE customers SET account_status = 'SUSPENDED', updated_at = datetime('now')
     WHERE is_deleted = 0 AND account_status = 'ACTIVE' AND credit_limit IS NOT NULL
       AND id IN (
         SELECT d.customer_id FROM debtor_ledger d
          WHERE d.is_deleted = 0 AND d.due_date IS NOT NULL
            AND d.entry_type IN ('SALE','DEBIT_NOTE','INSTALLMENT_DUE','OPENING_BALANCE')
            AND CAST(julianday(date('now','+1 hours')) - julianday(d.due_date) AS INTEGER) > ?
          GROUP BY d.customer_id
          HAVING SUM(CASE WHEN d.direction='DEBIT' THEN d.amount_kobo ELSE -d.amount_kobo END) > 0
       )
  `).bind(threshold).run();
  return { rows_affected: Number(rows.changes) || 0, threshold_days: threshold };
}

// ---------------------------------------------------------------------
// registers
// ---------------------------------------------------------------------
export async function verifyRegisters(db) {
  const types = HASHCHAIN.REGISTERS;
  let chains = 0; let broken = 0;
  for (const type of types) {
    const rows = await db.prepare(
      'SELECT * FROM hash_chained_registers WHERE register_type = ? ORDER BY chain_key, seq'
    ).bind(type).all();
    const byChain = new Map();
    for (const r of rows) {
      if (!byChain.has(r.chain_key)) byChain.set(r.chain_key, []);
      byChain.get(r.chain_key).push(r);
    }
    for (const [key, chain] of byChain) {
      const v = HASHCHAIN.verifyChain(chain, { register: type, branchId: chain[0].branch_id, dayIso: chain[0].chain_day });
      chains += 1;
      if (!v.ok) broken += 1;
      await db.prepare(`INSERT INTO hash_chain_verifications (id, register_type, business_id, branch_id, chain_key,
          rows_checked, is_intact, break_count, first_break_index, breaks_json, verified_by, verified_at, notes)
        VALUES (?,?,?,?,?,?,?,?,?,?, NULL, datetime('now'), 'Scheduled verification')`)
        .bind(newId(), type, chain[0].business_id, chain[0].branch_id, key, v.rows, v.ok ? 1 : 0,
          v.breaks.length, v.firstBreakIndex, v.breaks.length ? JSON.stringify(v.breaks).slice(0, 8000) : null).run();
    }
  }
  return { rows_affected: chains, chains_checked: chains, chains_broken: broken, alert: broken > 0 };
}

// ---------------------------------------------------------------------
// compliance
// ---------------------------------------------------------------------
export async function checkCompliance(db) {
  // The view already computes alert_level from each certificate's own
  // alert_days_before, so this job only has to record that a reminder was due and
  // bump the counter — the visible outcome is the alert screen, and the counter
  // is what stops the same certificate being "new" every day forever.
  const due = await db.prepare(`
    SELECT * FROM v_compliance_expiry_alerts WHERE last_reminded_at IS NULL OR last_reminded_at < date('now','-7 days')
  `).all();
  for (const c of due) {
    await db.prepare(`UPDATE compliance_certificates SET last_reminded_at = date('now'), reminder_count = reminder_count + 1,
        status = ?, updated_at = datetime('now') WHERE id = ?`)
      .bind(c.alert_level, c.certificate_id).run();
  }
  return { rows_affected: due.length, expiring: due.filter((c) => c.alert_level === 'EXPIRING_SOON').length, expired: due.filter((c) => c.alert_level === 'EXPIRED').length };
}

// ---------------------------------------------------------------------
// warranty provision
// ---------------------------------------------------------------------
export async function accrueWarranty(db) {
  const settings = await core.getSettings(db);
  const pct = Number(settings.warranty_provision_percent) || 0;
  if (pct <= 0) return { rows_affected: 0, skipped: 'provision percent is zero' };
  const period = todayWat().slice(0, 7);
  const businesses = await db.prepare('SELECT * FROM businesses WHERE is_deleted = 0 AND is_active = 1 AND uses_warranty = 1').all();
  let accrued = 0;
  for (const b of businesses) {
    // Warrantied revenue this month: sales of products that carry a warranty.
    const rev = await db.prepare(`
      SELECT COALESCE(SUM(si.line_net_kobo - si.line_vat_kobo),0) AS k
        FROM sale_items si JOIN sales s ON s.id = si.sale_id
        JOIN products p ON p.id = si.product_id
       WHERE s.business_id = ? AND s.is_deleted = 0 AND si.is_deleted = 0
         AND s.status NOT IN ('QUOTE','VOIDED') AND substr(s.sale_date,1,7) = ?
         AND p.warranty_months > 0
    `).bind(b.id, period).first();
    const revenueKobo = Number(rev ? rev.k : 0);
    if (revenueKobo <= 0) continue;
    const already = await db.prepare(`
      SELECT COALESCE(SUM(gl.amount_kobo),0) AS k FROM gl_journal_lines gl
        JOIN gl_journal_entries je ON je.id = gl.journal_entry_id
       WHERE je.business_id = ? AND je.source_type = 'PROVISION' AND je.period = ? AND gl.account_code = '2280'
    `).bind(b.id, period).first();
    const target = Math.round((revenueKobo * pct) / 100);
    const existing = Number(already ? already.k : 0);
    const delta = target - existing;
    if (delta <= 0) continue;
    const gl = (await import('../../shared/services/glService.js')).default;
    await gl.postWarrantyProvision(db, {
      business: b, branchId: null, entryDate: todayWat(), accrualKobo: delta, period, userId: null,
    });
    accrued += delta;
  }
  return { rows_affected: businesses.length, accrued_kobo: accrued, period };
}

// ---------------------------------------------------------------------
// retention
// ---------------------------------------------------------------------
export async function pruneRetention(db, config) {
  const r = (config && config.app && config.app.retention) || {};
  const jobs = [
    // sync_change_log is an operational trace, not a record of money. 90 days is
    // enough to answer "why did Kano not sync last Tuesday" and not enough to
    // grow the file forever. THIS IS THE JOB THAT RAN ON THE NODE BACKEND AND
    // NEVER ON THE WORKER in the product this was decoupled from.
    ['sync_change_log', `DELETE FROM sync_change_log WHERE synced_at < datetime('now', ?)`, `-${Number(r.syncLogDays || 90)} days`],
    // An idempotency key only has to outlive the retries a client will make. 72h
    // is generous; keeping them forever means the table's primary key grows with
    // every sale ever made.
    ['idempotency_keys', `DELETE FROM idempotency_keys WHERE created_at < datetime('now', ?)`, `-${Number(r.idempotencyHours || 72)} hours`],
    ['login_attempts', `DELETE FROM login_attempts WHERE attempted_at < datetime('now', ?)`, `-${Number(r.loginAttemptsDays || 30)} days`],
    // Audit log is kept for TWO YEARS. A tax audit can reach back that far, and
    // the audit log is the only record of who voided what — pruning it early
    // would remove exactly the evidence that makes it worth having.
    ['audit_log', `DELETE FROM audit_log WHERE occurred_at < datetime('now', ?) AND severity NOT IN ('WARNING','CRITICAL')`, `-${Number(r.auditLogDays || 730)} days`],
    ['scheduler_runs', `DELETE FROM scheduler_runs WHERE started_at < datetime('now', '-90 days')`, null],
    ['hash_chain_verifications', `DELETE FROM hash_chain_verifications WHERE verified_at < datetime('now','-180 days') AND is_intact = 1`, null],
  ];
  const out = {};
  let total = 0;
  for (const [name, sql, arg] of jobs) {
    try {
      const res = arg ? await db.prepare(sql).bind(arg).run() : await db.prepare(sql).run();
      const n = Number(res && res.changes) || 0;
      out[name] = n;
      total += n;
    } catch (e) {
      // A retention failure is not worth failing the whole run over, but it must
      // not be silent either: a job that quietly stops running is how a table
      // grows until the database will not back up.
      out[name] = `error: ${e && e.message}`;
    }
  }
  return { rows_affected: total, pruned: out };
}

export default runScheduledJobs;
