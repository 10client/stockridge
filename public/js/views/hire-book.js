'use strict';
// The book of goods that are out and must come back. A hire for Saturday and
// a lease for a year sit in the same list, because both are promises, not sales.
(function (global) {
  const SR = global.SR;
  const ui = SR.ui;
  const U = SR.util;

  async function render(ctx) {
    ctx.setTitle('Hire book');
    const state = { status: ctx.query.status || 'OUT' };
    const wrap = ui.h('div', { class: 'stack' });
    wrap.appendChild(ui.h('div', { class: 'page-head' },
      ui.h('div', {},
        ui.h('h1', {}, 'Hire book'),
        ui.h('p', { class: 'sub' }, (SR.state.activeBranch() && String(SR.state.activeBranch().branch_type || '').toUpperCase() === 'RENTAL')
          ? 'This yard’s goods that are out. The fee is hire or lease income on the profit and loss. The deposit stays a liability until the goods come back.'
          : 'Goods that are out on hire or lease. The deposit is held here, not earned.')),
      ui.h('div', { class: 'actions' },
        ui.h('button', { class: 'btn btn-sm', onClick: () => load() }, 'Refresh'))));

    const tabs = ui.h('div', { class: 'tabs' });
    for (const [key, label] of [['OUT', 'Out'], ['RETURNED', 'Returned'], ['BOUGHT_OUT', 'Bought'], ['CANCELLED', 'Cancelled']]) {
      tabs.appendChild(ui.h('button', {
        class: `tab ${state.status === key ? 'is-active' : ''}`,
        onClick: () => { state.status = key; load(); },
      }, label));
    }
    wrap.appendChild(tabs);
    const host = ui.h('div', {});
    wrap.appendChild(host);

    async function load() {
      host.replaceChildren(ui.h('p', { class: 'hint' }, 'Loading…'));
      try {
        const result = await SR.api.get('/api/agreements', { query: SR.state.query({ status: state.status }) });
        const rows = result.data || [];
        if (!rows.length) {
          host.replaceChildren(ui.h('p', { class: 'hint' }, state.status === 'OUT' ? 'Nothing is out.' : 'None in this list.'));
          return;
        }
        host.replaceChildren(ui.renderTable({
          columns: [
            { key: 'kind', label: 'Kind' },
            { key: 'customer', label: 'Customer', render: (r) => r.customer_name || 'Walk-in' },
            { key: 'when', label: 'Window', render: (r) => `${r.starts_on} to ${r.ends_on}` },
            { key: 'deposit', label: 'Deposit held', align: 'right', render: (r) => U.money(r.deposit_held) },
            { key: 'state', label: 'State', render: (r) => r.overdue ? ui.badge('Overdue', 'badge-warn') : ui.badge(r.status, 'badge-info') },
          ],
          rows,
          onRowClick: (r) => openOne(r),
        }));
      } catch (err) {
        if (!(err && (err.isOffline || (err.isAuth && SR.state.user)))) { ui.apiError(err); return; }
        const saved = await SR.store.all('asset_agreements').catch(() => []);
        const wanted = String(state.status || '').toUpperCase();
        const rows = (saved || []).filter((row) => row && !Number(row.is_deleted) && (!wanted || String(row.status).toUpperCase() === wanted));
        host.replaceChildren(rows.length ? ui.renderTable({
          columns: [
            { key: 'kind', label: 'Kind' },
            { key: 'customer', label: 'Customer', render: (r) => r.customer_name || 'Walk-in' },
            { key: 'when', label: 'Window', render: (r) => `${r.starts_on || ''} to ${r.ends_on || ''}` },
            { key: 'state', label: 'State', render: (r) => r.status },
          ],
          rows,
        }) : ui.h('p', { class: 'hint' }, 'No hire or lease agreement is saved on this till yet.'));
      }
    }

    async function openOne(row) {
      let detail;
      try { detail = await SR.api.get(`/api/agreements/${encodeURIComponent(row.id)}`); }
      catch (err) {
        const lines = await SR.store.all('asset_agreement_lines').catch(() => []);
        detail = { agreement: row, lines: (lines || []).filter((line) => String(line.agreement_id) === String(row.id)), schedule: [] };
      }
      const a = detail.agreement;
      const body = ui.h('div', { class: 'stack' },
        ui.h('p', {}, `${a.kind} · ${a.starts_on} to ${a.ends_on}`),
        ui.h('p', {}, `${a.customer_name || 'Walk-in'}${a.customer_phone ? ` · ${a.customer_phone}` : ''}`),
        ui.h('p', {}, `Deposit held: ${U.money(a.deposit_held)}`),
        ui.h('ul', {}, (detail.lines || []).map((l) => ui.h('li', {}, `${l.quantity} × ${l.product_name}`))));
      const footer = [ui.h('button', { class: 'btn', onClick: () => m.close() }, 'Close')];
      if (a.status === 'OUT') {
        if (a.kind === 'LEASE') footer.push(ui.h('button', { class: 'btn', onClick: () => takeRent(a, detail, m) }, 'Take this month’s rent'));
        footer.push(ui.h('button', { class: 'btn', onClick: () => buyOut(a, detail, m) }, 'Customer is buying it'));
        footer.push(ui.h('button', { class: 'btn btn-primary', onClick: () => bringBack(a, m) }, 'Goods came back'));
      }
      const m = ui.openModal({ title: a.kind === 'LEASE' ? 'Lease' : 'Hire', body, footer, size: 'wide' });
    }

    async function askPay(title, amount) {
      const method = await ui.promptDialog({
        title,
        label: `Type CASH or TRANSFER. Amount due is ${U.money(amount)}`,
        value: 'CASH',
        required: true,
      });
      if (!method) return null;
      const word = String(method).trim().toUpperCase();
      const code = word.startsWith('T') ? 'BANK_TRANSFER' : 'CASH';
      let reference = null;
      if (code !== 'CASH') {
        reference = await ui.promptDialog({ title: 'Transfer reference', label: 'Alert code or reference', required: true });
        if (!reference) return null;
      }
      return { method: code, amount: Number(amount) || 0, reference };
    }

    async function takeRent(agreement, detail, modal) {
      const lines = detail.lines || [];
      if (!lines.length) { ui.warn('This agreement has no goods on it.'); return; }
      const amount = lines.reduce((sum, line) => sum + Number(line.rate || 0) * Number(line.quantity || 0), 0);
      if (!(amount > 0)) { ui.warn('This lease has no monthly rent on its lines.'); return; }
      const pay = await askPay('This month’s rent', amount);
      if (!pay) return;
      try {
        const result = await SR.api.post('/api/sales', {
          customer_id: agreement.customer_id || undefined,
          sale_type: 'RETAIL',
          lines: lines.map((line) => ({
            product_id: line.product_id,
            quantity: line.quantity,
            unit_code: line.unit_code || undefined,
            channel: 'LEASE',
            continuation: true,
            agreement_id: agreement.id,
            rate: line.rate,
            periods: 1,
          })),
          payments: amount > 0 ? [pay] : [],
        });
        ui.toast(result.message || 'Rent recorded.');
        modal.close();
        load();
      } catch (err) { ui.apiError(err); }
    }

    async function buyOut(agreement, detail, modal) {
      const lines = detail.lines || [];
      if (!lines.length) { ui.warn('This agreement has no goods on it.'); return; }
      const held = Number(agreement.deposit_held) || 0;
      const typed = await ui.promptDialog({
        title: 'Buyout price',
        label: held > 0
          ? `Price for the unit (₦). ${U.money(held)} of deposit is already held and comes off what you take now.`
          : 'Price for the unit (₦)',
        value: agreement.buyout_price != null ? String(agreement.buyout_price) : '',
        required: true,
      });
      if (typed == null) return;
      const price = Number(typed);
      if (!(price > 0)) { ui.warn('The buyout price has to be more than zero.'); return; }
      const due = Math.max(0, price - held);
      const pay = due > 0 ? await askPay('Buyout', due) : null;
      if (due > 0 && !pay) return;
      const units = lines.reduce((sum, line) => sum + Number(line.quantity || 0), 0) || 1;
      const each = price / units;
      try {
        const result = await SR.api.post('/api/sales', {
          customer_id: agreement.customer_id || undefined,
          sale_type: 'RETAIL',
          lines: lines.map((line) => ({
            product_id: line.product_id,
            quantity: line.quantity || 1,
            unit_code: line.unit_code || undefined,
            channel: 'RETAIL',
            buyout: true,
            agreement_id: agreement.id,
            manual_price: each,
          })),
          payments: due > 0 ? [pay] : [],
        });
        ui.toast(result.message || 'Buyout recorded. The unit has left the books.');
        modal.close();
        load();
      } catch (err) { ui.apiError(err); }
    }

    async function bringBack(agreement, modal) {
      const condition = await ui.promptDialog({
        title: 'How did they come back?',
        label: 'Type GOOD, DAMAGED, or MISSING',
        value: 'GOOD',
        required: true,
      });
      if (!condition) return;
      const late = await ui.promptDialog({ title: 'Late charge', label: 'Late charge (₦), or 0', value: '0' });
      const damage = String(condition).toUpperCase() === 'GOOD'
        ? '0'
        : await ui.promptDialog({ title: 'Damage', label: 'Damage or missing charge (₦)', value: '0' });
      if (late == null || damage == null) return;
      try {
        const result = await SR.api.post(`/api/agreements/${encodeURIComponent(agreement.id)}/return`, {
          condition: String(condition).toUpperCase(),
          late_charge: Number(late) || 0,
          damage_charge: Number(damage) || 0,
        });
        ui.toast(result.message || 'Recorded.');
        modal.close();
        load();
      } catch (err) { ui.apiError(err); }
    }

    await load();
    return wrap;
  }

  SR.views = SR.views || {};
  SR.views['hire-book'] = { render };
})(window);
