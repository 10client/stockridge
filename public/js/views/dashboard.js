// =====================================================================
// public/js/views/dashboard.js — the screen a proprietor opens first
// =====================================================================
// Ordered by "what would make me act today", not by what is easy to compute:
// money in today, what is about to run out, what is owed to us, what is owed by
// us, and anything that needs a decision. A dashboard that leads with a pretty
// chart of last month is a dashboard nobody reads twice.

'use strict';

import { endpoints as api } from '../api.js';
import { state, activeBusiness, activeBranch, naira, canSeeMultipleBranches, atLeast } from '../state.js';
import { el, clear, icon, statCard, badge, toneForStatus, table, money, spinner, reportError, emptyState } from '../ui.js';
import { cachedFetch } from '../offline.js';

export default async function dashboardView(ctx) {
  const host = ctx.host;
  host.appendChild(spinner('Loading your day…'));

  const branchId = ctx.query.branch_id || (state.scope.pinned ? state.activeBranchId : (ctx.query.branch_id || undefined));
  let res;
  try {
    res = await cachedFetch(`dashboard:${state.activeBusinessId}:${branchId || 'all'}`, () => api.dashboard({ branch_id: branchId }));
  } catch (e) {
    clear(host);
    host.appendChild(emptyState('The dashboard could not load', e.message || 'Check the connection and try again.', 'Try again', () => ctx.rerender()));
    return {};
  }
  const d = res.data;
  clear(host);

  if (res.stale) {
    host.appendChild(el('div', { class: 'stale-banner' },
      icon('warn'),
      el('span', { text: `You are offline. These figures are from ${new Date(res.cached_at).toLocaleString('en-NG')} and do not include anything sold since.` })));
  }

  const biz = activeBusiness();
  const br = activeBranch();
  host.appendChild(el('header', { class: 'view-head' },
    el('div', {},
      el('h1', { text: `${biz ? biz.trading_name || biz.name : 'Dashboard'}` }),
      el('p', { class: 'muted', text: `${br && !state.scope.all_branches ? br.name : 'All branches you can see'} · ${d.as_at} · ${d.timezone}` })),
    el('div', { class: 'view-actions' },
      el('a', { class: 'btn btn-primary', href: '/pos', text: 'New sale' }))));

  // ---- today --------------------------------------------------------
  host.appendChild(el('section', { class: 'stat-grid' },
    statCard({ label: 'Sold today', value: money(d.today.revenue), sub: `${d.today.sales_count} sale${d.today.sales_count === 1 ? '' : 's'}`, icon: 'pos', tone: 'good' }),
    statCard({ label: 'Margin today', value: money(d.today.margin), sub: `${d.today.margin_percent}% of revenue`, icon: 'chart' }),
    statCard({ label: 'Stock at cost', value: money(d.stock.cost_value), sub: `${d.stock.units.toLocaleString('en-NG')} units · retail ${money(d.stock.retail_value)}`, icon: 'box' }),
    statCard({ label: 'Owed to us', value: money(d.receivables), sub: 'trade debtors', icon: 'users', tone: d.receivables > 0 ? 'warn' : null }),
    statCard({ label: 'We owe', value: money(d.payables), sub: 'suppliers', icon: 'ledger', tone: d.payables > 0 ? 'warn' : null }),
    statCard({ label: 'Instalments due this week', value: money(d.instalments_due_this_week.amount), sub: `${d.instalments_due_this_week.count} payment(s)`, icon: 'clock' }),
  ));

  // ---- things that need a decision, first ---------------------------
  const alerts = d.alerts || {};
  const actionItems = [];
  if (alerts.low_stock > 0) actionItems.push({ tone: 'bad', label: `${alerts.low_stock} line(s) out of stock or below reorder level`, href: '/stock?filter=low' });
  if (alerts.shelf_life > 0) actionItems.push({ tone: 'warn', label: `${alerts.shelf_life} batch(es) expired or within 7 days of best-before`, href: '/stock?filter=shelf' });
  if (alerts.compliance > 0) actionItems.push({ tone: alerts.compliance > 0 ? 'bad' : 'warn', label: `${alerts.compliance} certificate(s) expired or due for renewal`, href: '/admin?tab=compliance' });
  if (alerts.warranty_claims > 0) actionItems.push({ tone: 'warn', label: `${alerts.warranty_claims} warranty claim(s) open`, href: '/operations?tab=warranty' });
  if (alerts.change_owed > 0) actionItems.push({ tone: 'neutral', label: `${alerts.change_owed} customer(s) still owed change`, href: '/operations?tab=change' });
  if (alerts.attendance_flagged > 0 && atLeast('MANAGER')) actionItems.push({ tone: 'warn', label: `${alerts.attendance_flagged} clock-in(s) flagged for review`, href: '/operations?tab=attendance' });
  if (d.deliveries_due && d.deliveries_due.count > 0) actionItems.push({ tone: 'warn', label: `${d.deliveries_due.count} delivery job(s) due in the next 2 days`, href: '/operations?tab=delivery' });
  if (d.open_tills && d.open_tills.length) {
    actionItems.push({ tone: 'neutral', label: `${d.open_tills.length} till(s) still open`, href: '/operations?tab=till' });
  }

  if (actionItems.length) {
    host.appendChild(el('section', { class: 'card' },
      el('h2', { class: 'card-title', text: 'Needs attention' }),
      el('ul', { class: 'action-list' }, actionItems.map((a) => el('li', {},
        el('a', { href: a.href, class: `action-item action-${a.tone}` },
          el('span', { class: 'action-icon' }, icon(a.tone === 'bad' ? 'warn' : 'clock')),
          el('span', { text: a.label })))))));
  } else {
    host.appendChild(el('section', { class: 'card card-clear' },
      el('span', { class: 'action-icon' }, icon('check')),
      el('p', { text: 'Nothing needs a decision right now.' })));
  }

  // ---- 14-day shape -------------------------------------------------
  const series = d.last_14_days || [];
  host.appendChild(el('section', { class: 'card' },
    el('h2', { class: 'card-title', text: 'Last 14 days' }),
    series.length ? sparkline(series) : el('p', { class: 'muted', text: 'No sales recorded yet.' }),
    el('p', { class: 'hint', text: 'Bucketed by West Africa Time, so a sale at 00:30 in Lagos counts on the day the shop was trading — not the previous UTC day.' })));

  // ---- open tills ---------------------------------------------------
  if (d.open_tills && d.open_tills.length && atLeast('MANAGER')) {
    host.appendChild(el('section', { class: 'card' },
      el('h2', { class: 'card-title', text: 'Open tills' }),
      table([
        { key: 'branch_name', label: 'Branch' },
        { key: 'till_no', label: 'Till' },
        { key: 'opened_by_name', label: 'Opened by' },
        { key: 'opening_float', label: 'Float', align: 'right', render: (r) => money(r.opening_float) },
        { key: 'sales_count', label: 'Sales', align: 'right' },
        { key: 'opened_at', label: 'Opened', render: (r) => String(r.opened_at || '').slice(0, 16) },
      ], d.open_tills, { dense: true, rowKey: 'id' })));
  }

  return {};
}

/**
 * A bar chart drawn with divs, not a charting library.
 *
 * The data is fourteen numbers. A library would cost more to download than the
 * entire rest of this screen, would need a CSP exception or an inline style
 * allowance, and would still be a bar chart. What matters is that a proprietor
 * can see the shape of the fortnight — which day the generator died, whether
 * Saturday is really the best day — and eleven divs show that.
 */
function sparkline(series) {
  const max = Math.max(1, ...series.map((s) => Number(s.revenue) || 0));
  const bars = el('div', { class: 'spark' }, series.map((s) => {
    const pct = Math.max(2, Math.round(((Number(s.revenue) || 0) / max) * 100));
    const day = new Date(`${s.day}T00:00:00Z`);
    const label = day.toLocaleDateString('en-NG', { weekday: 'short' });
    return el('div', { class: 'spark-col', title: `${s.day}: ${money(s.revenue)} across ${s.count} sale(s), margin ${money(s.margin)}` },
      el('div', { class: 'spark-bar', style: { height: `${pct}%` } }),
      el('span', { class: 'spark-label', text: label.slice(0, 2) }));
  }));
  return el('div', {},
    bars,
    el('div', { class: 'spark-axis muted' },
      el('span', { text: `${series[0] ? series[0].day : ''}` }),
      el('span', { text: `peak ${money(max)}` }),
      el('span', { text: `${series[series.length - 1] ? series[series.length - 1].day : ''}` })));
}
