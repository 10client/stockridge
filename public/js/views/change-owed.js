'use strict';
// =====================================================================
// public/js/views/change-owed.js — CHANGE THE SHOP OWES, AT THE COUNTER
// =====================================================================
// The screen exists for ONE moment: a customer walks in holding a receipt and says
// "you people owed me ₦300". Everything here is arranged around making that moment
// thirty seconds long instead of five minutes:
//
//   1. THE CODE BOX IS FIRST, and it is focused when the screen opens. The cashier
//      types the eight characters off the receipt, and — this is the part that saves
//      the time — the screen says whether it can be paid BEFORE the cashier commits
//      to anything: already collected, expired, or payable. Every one of those
//      answers comes from the server, which is the only place that knows.
//   2. THE LIST IS SECOND, filterable by name or phone, for the customer who has lost
//      the receipt. It shows how long each claim has left, because the expiry is the
//      thing nobody remembers until it has passed.
//   3. WRITE-OFF IS NOT ON THIS SCREEN for a cashier: it is offered only where a
//      manager will look for it, and it always asks for the reason in writing.
// =====================================================================

(function (global) {
  const SR = global.SR = global.SR || {};
  const ui = SR.ui;
  const U = SR.util;
  const NO_BRANCH = 'All branches';

  function statusBadge(row) {
    if (row.status === 'OUTSTANDING') {
      if (Number(row.expired)) return ui.badge('expired', 'badge-warn');
      const days = row.days_left == null ? null : Number(row.days_left);
      if (days != null && days <= 3) return ui.badge(`${days} day(s) left`, 'badge-warn');
      return ui.badge('outstanding', 'badge-good');
    }
    return ui.badge(String(row.status).toLowerCase().replace(/_/g, ' '), 'badge-mute');
  }

  /**
   * THE CLAIM BOX — the counter's half of the screen.
   *
   * The server answers the whole question (`settlable`, and `why_not` in words), so
   * this function never decides whether money may be paid out. A screen that decided
   * for itself would drift from the rule, and the drift would show up as a claim paid
   * twice or a customer turned away who should have been paid.
   */
  function openClaimBox(onDone) {
    let settled = false;
    const body = ui.h('div', { class: 'stack' });
    body.appendChild(ui.h('p', { class: 'sub' }, 'Type the code printed on the customer’s receipt.'));

    const input = ui.h('input', { type: 'text', autocomplete: 'off', spellcheck: 'false', placeholder: 'AB12CD34', style: { textTransform: 'uppercase' } });
    const findBtn = ui.h('button', { class: 'btn btn-primary', onClick: find }, 'Find the claim');
    body.appendChild(ui.h('div', { class: 'row' }, input, findBtn));
    const result = ui.h('div', {});
    body.appendChild(result);

    async function find() {
      const code = String(input.value || '').trim();
      if (!code) return;
      findBtn.disabled = true;
      result.replaceChildren(ui.loading('Looking up the claim…'));
      try {
        const res = await SR.api.get(`/api/change-owed/code/${encodeURIComponent(code)}`);
        const claim = res.claim || {};
        result.replaceChildren(ui.kv([
          ['Customer', claim.customer_name],
          ['Amount', U.money(claim.amount)],
          ['Branch', claim.branch_name],
          ['Taken', claim.created_at ? U.date(claim.created_at) : ''],
          ['Expires', claim.expires_at ? U.date(claim.expires_at) : 'no expiry'],
        ]));
        if (!res.settlable) {
          result.appendChild(ui.h('div', { class: 'alert alert-warn' }, res.why_not || 'This claim cannot be paid.'));
          return;
        }
        const method = ui.h('select', {},
          ['CASH', 'BANK_TRANSFER', 'POS_TERMINAL', 'MOBILE_MONEY', 'USSD', 'CHEQUE'].map((m) => ui.h('option', { value: m }, U.humanise(m))));
        const reference = ui.h('input', { type: 'text', placeholder: 'Reference (optional)', autocomplete: 'off' });
        const expired = Number(claim.expired) === 1;
        let acceptExpired = null;
        if (expired) {
          acceptExpired = ui.h('input', { type: 'checkbox' });
          result.appendChild(ui.h('label', { class: 'ctl' }, acceptExpired,
            ' This claim is past its window — I am a manager authorising the payment anyway.'));
        }
        const pay = ui.h('button', { class: 'btn btn-primary', onClick: async () => {
          pay.disabled = true;
          try {
            const done = await SR.api.post(`/api/change-owed/${claim.id}/settle`, {
              method: method.value,
              reference: reference.value || null,
              accept_expired: expired ? !!(acceptExpired && acceptExpired.checked) : undefined,
            });
            ui.ok(done.message || 'Paid.');
            if (onDone) onDone();
            finish();
          } catch (err) {
            // THE REFUSAL IS THE POINT, so it is shown where the cashier is looking —
            // next to the claim, not in a toast that disappears. A second settlement
            // and an expired claim both land here with the server's own sentence.
            result.appendChild(ui.h('div', { class: 'alert alert-warn' }, (err && err.message) || 'That payment was refused.'));
            pay.disabled = false;
          }
        } }, `Pay ${U.money(claim.amount)}`);
        result.appendChild(ui.h('div', { class: 'row' }, method, reference, pay));
      } catch (err) {
        result.replaceChildren(ui.h('div', { class: 'alert alert-warn' }, (err && err.message) || 'That code could not be looked up.'));
      } finally { findBtn.disabled = false; }
    }

    input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); find(); } });
    const modal = ui.openModal({ title: 'A customer is collecting change', body, size: 'narrow', onClose: () => finish() });
    setTimeout(() => input.focus(), 40);
    function finish() { if (settled) return; settled = true; modal.close(); }
  }

  /** The reason, asked for in a form that will not submit without one. */
  function openWriteOff(row, onDone) {
    let settled = false;
    const body = ui.h('div', { class: 'stack' });
    body.appendChild(ui.h('p', {}, `${U.money(row.amount)} owed to ${row.customer_name} (claim ${row.claim_code}).`));
    body.appendChild(ui.h('p', { class: 'sub' }, 'Writing this off keeps the money with the shop and closes the claim. The reason is recorded against your name and shown to the owner.'));
    const reason = ui.h('input', { type: 'text', placeholder: 'Why is this being written off?', autocomplete: 'off' });
    const go = ui.h('button', { class: 'btn btn-danger', onClick: async () => {
      go.disabled = true;
      try {
        const done = await SR.api.post(`/api/change-owed/${row.id}/write-off`, { reason: String(reason.value || '').trim() });
        ui.ok(done.message || 'Written off.');
        if (onDone) onDone();
        finish();
      } catch (err) {
        body.appendChild(ui.h('div', { class: 'alert alert-warn' }, (err && err.message) || 'That write-off was refused.'));
        go.disabled = false;
      }
    } }, 'Write it off');
    go.disabled = true;
    // THE SAME FLOOR THE SERVER ENFORCES (`MIN_REASON` in server/routes/changeOwed.js,
    // 12 characters). A screen that lets a person type "gone" and then refuses it has
    // taught them the button is broken; the count is shown so they know what is missing.
    const MIN_REASON = 12;
    const count = ui.h('p', { class: 'hint' }, `At least ${MIN_REASON} characters — ${MIN_REASON} to go.`);
    reason.addEventListener('input', () => {
      const len = String(reason.value || '').trim().length;
      go.disabled = len < MIN_REASON;
      count.textContent = len < MIN_REASON
        ? `At least ${MIN_REASON} characters — ${MIN_REASON - len} to go.`
        : 'Long enough. Say what happened, not just that it is gone.';
    });
    body.appendChild(reason);
    body.appendChild(count);
    const cancel = ui.h('button', { class: 'btn', onClick: () => finish() }, 'Cancel');
    const modal = ui.openModal({ title: 'Write off change owed', body, footer: [cancel, go], size: 'narrow', onClose: () => finish() });
    setTimeout(() => reason.focus(), 40);
    function finish() { if (settled) return; settled = true; modal.close(); }
  }

  async function render(ctx) {
    ctx.setTitle('Change owed');
    const wrap = ui.h('div', { class: 'stack' });
    wrap.appendChild(ui.h('div', { class: 'page-head' },
      ui.h('div', {},
        ui.h('h1', {}, 'Change owed'),
        ui.h('p', { class: 'sub' }, `${SR.state.activeBusinessName()} · money the shop is holding for customers`)),
      ui.h('button', { class: 'btn btn-primary', onClick: () => openClaimBox(load) }, 'A customer is collecting')));

    const filters = ui.h('div', { class: 'row' });
    const q = ui.h('input', { type: 'search', placeholder: 'Name, phone or claim code', autocomplete: 'off' });
    const status = ui.h('select', {},
      [['OUTSTANDING', 'Still owed'], ['REDEEMED', 'Paid out'], ['WRITTEN_OFF', 'Written off'], ['ALL', 'Everything']]
        .map(([v, label]) => ui.h('option', { value: v }, label)));
    filters.appendChild(q); filters.appendChild(status);
    wrap.appendChild(ui.h('div', { class: 'card' }, ui.h('div', { class: 'card-body' }, filters)));

    const host = ui.h('div', {});
    wrap.appendChild(host);

    async function load() {
      host.replaceChildren(ui.skeleton(5));
      try {
        const res = await SR.api.get('/api/change-owed', {
          query: SR.state.query({ status: status.value, q: q.value || undefined, limit: 50 }),
        });
        const rows = (res.data || res.rows || []).map((r) => ({
          id: r.id,
          code: r.claim_code,
          customer: r.customer_name,
          phone: r.customer_phone || '',
          amount: Number(r.amount),
          branch: r.branch_name || '',
          taken: r.created_at ? U.date(r.created_at) : '',
          status: statusBadge(r),
          raw: r,
        }));
        if (!rows.length) {
          host.replaceChildren(ui.empty({
            title: status.value === 'OUTSTANDING' ? 'No customer is owed change' : 'Nothing to show',
            message: status.value === 'OUTSTANDING'
              ? 'When a sale leaves change outstanding, the customer gets a code and it appears here until it is collected.'
              : 'Try another filter.',
          }));
          return;
        }
        const canWriteOff = SR.state.atLeast('MANAGER');
        host.replaceChildren(ui.dataCard({
          title: `${rows.length} claim(s)`,
          table: ui.renderTable({
            columns: [
              { key: 'code', label: 'Code' },
              { key: 'customer', label: 'Customer' },
              { key: 'amount', label: 'Amount', render: (r) => U.money(r.amount) },
              { key: 'branch', label: 'Branch' },
              { key: 'taken', label: 'Taken' },
              { key: 'status', label: 'State', render: (r) => r.status },
            ],
            rows,
            onRowClick: (r) => {
              const body = ui.h('div', { class: 'stack' },
                ui.h('p', {}, `${U.money(r.amount)} owed to ${r.customer}${r.phone ? ` (${r.phone})` : ''}.`),
                ui.kv([
                  ['Claim code', r.raw.claim_code],
                  ['Taken', r.taken],
                  ['Expires', r.raw.expires_at ? U.date(r.raw.expires_at) : 'no expiry'],
                  ['Receipt', r.raw.sale_receipt_no || '—'],
                  ['Paid out by', r.raw.redeemed_by_name || '—'],
                ]),
                r.raw.notes ? ui.h('p', { class: 'hint' }, String(r.raw.notes).trim()) : null);
              const actions = [];
              if (r.raw.status === 'OUTSTANDING') {
                actions.push(ui.h('button', { class: 'btn btn-primary', onClick: async (ev) => {
                  ev.currentTarget.disabled = true;
                  try {
                    const done = await SR.api.post(`/api/change-owed/${r.id}/settle`, { method: 'CASH' });
                    ui.ok(done.message || 'Paid.');
                    close();
                    load();
                  } catch (err) { ui.apiError(err); ev.currentTarget.disabled = false; }
                } }, 'Pay in cash'));
                if (canWriteOff) {
                  actions.push(ui.h('button', { class: 'btn btn-danger', onClick: () => { close(); openWriteOff(r.raw, load); } }, 'Write off'));
                }
              }
              actions.push(ui.h('button', { class: 'btn', onClick: () => close() }, 'Close'));
              const modal = ui.openModal({ title: `Claim ${r.code}`, body, footer: actions, size: 'narrow' });
              function close() { modal.close(); }
            },
          }),
        }));
      } catch (err) {
        if (err && err.isOffline) {
          // A CASHIER OFFLINE CANNOT PAY OUT — and must be told why rather than shown
          // a cached figure that may already have been collected at another branch.
          host.replaceChildren(ui.h('div', { class: 'alert alert-warn' },
            'Offline — change owed is deliberately not mirrored on this device. A claim may already have been paid at another branch, so paying it out from a stale copy would hand over money twice.'));
          return;
        }
        host.replaceChildren(ui.errorBlock(err));
      }
    }

    q.addEventListener('change', load);
    status.addEventListener('change', load);
    q.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') { ev.preventDefault(); load(); } });
    await load();
    return wrap;
  }

  SR.views = SR.views || {};
  SR.views['change-owed'] = { render };
}(window));
