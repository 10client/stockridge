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
        ui.h('p', { class: 'sub' }, 'Goods that are out on hire or lease. The deposit is held here, not earned.')),
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
      } catch (err) { ui.apiError(err); }
    }

    async function openOne(row) {
      let detail;
      try { detail = await SR.api.get(`/api/agreements/${encodeURIComponent(row.id)}`); }
      catch (err) { ui.apiError(err); return; }
      const a = detail.agreement;
      const body = ui.h('div', { class: 'stack' },
        ui.h('p', {}, `${a.kind} · ${a.starts_on} to ${a.ends_on}`),
        ui.h('p', {}, `${a.customer_name || 'Walk-in'}${a.customer_phone ? ` · ${a.customer_phone}` : ''}`),
        ui.h('p', {}, `Deposit held: ${U.money(a.deposit_held)}`),
        ui.h('ul', {}, (detail.lines || []).map((l) => ui.h('li', {}, `${l.quantity} × ${l.product_name}`))));
      const footer = [ui.h('button', { class: 'btn', onClick: () => m.close() }, 'Close')];
      if (a.status === 'OUT') {
        footer.push(ui.h('button', { class: 'btn btn-primary', onClick: () => bringBack(a, m) }, 'Goods came back'));
      }
      const m = ui.openModal({ title: a.kind === 'LEASE' ? 'Lease' : 'Hire', body, footer, size: 'wide' });
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
