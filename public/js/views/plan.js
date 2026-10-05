'use strict';
// =====================================================================
// public/js/views/plan.js — THE SUBSCRIPTION, AND WHAT IT ALLOWS
// =====================================================================
// A plan is a set of LIMITS (how many businesses, branches and staff) and a set
// of FEATURES (instalments, deliveries, attendance, multi-currency and so on).
//
// Two rules make this screen honest rather than decorative:
//
//   * Usage is counted LIVE and counts only ACTIVE rows. Counting deactivated
//     staff would charge a shop for people who have left and block them from
//     hiring a replacement — the same limit punishing them twice.
//   * A limit that is reached stops the thing from being created, at the point
//     of creation, with a message that says which limit and what to do. It does
//     not silently fail somewhere else later.
// =====================================================================
(function (global) {
  const SR = global.SR;
  const ui = SR.ui;
  const U = SR.util;

  async function render(ctx) {
    ctx.setTitle('Subscription');
    const wrap = ui.h('div', { class: 'stack' });
    wrap.appendChild(ui.h('div', { class: 'page-head' },
      ui.h('div', {},
        ui.h('h1', {}, 'Subscription'),
        ui.h('p', { class: 'sub' }, `${SR.state.activeBusiness().name} · the plan this deployment runs on, and what it allows`))));

    const host = ui.h('div', {});
    wrap.appendChild(host);

    async function load() {
      host.replaceChildren(ui.skeleton(7));
      let data;
      try {
        data = await SR.api.get('/api/plan', { query: SR.state.query({}) });
      } catch (err) {
        if (err.isOffline) {
          const cached = await SR.store.metaGet('plan');
          if (!cached) {
            host.replaceChildren(ui.h('div', { class: 'alert alert-warn' }, 'Offline — the plan details come from the server and are not mirrored on this device.'));
            return;
          }
          data = cached;
        } else {
          host.replaceChildren(ui.errorBlock(err, { retry: { label: 'Try again', run: load } }));
          return;
        }
      }
      await SR.store.metaSet('plan', data);
      render(data);
    }

    function render(data) {
      const s = data.settings || {};
      const usage = data.usage || {};
      const counts = data.counts || {};
      const features = data.features || {};
      const contact = usage.contact || {};

      const limitBar = (label, used, allowed) => {
        const pct = Number(allowed) > 0 ? (Number(used) / Number(allowed)) * 100 : 0;
        const full = Number(allowed) > 0 && Number(used) >= Number(allowed);
        const bar = ui.h('div', { class: 'progress' });
        bar.appendChild(ui.h('div', {
          class: `progress-fill ${full ? 'is-full' : (pct >= 80 ? 'is-warn' : '')}`,
          style: { width: `${U.clamp(pct, 0, 100)}%` },
        }));
        return ui.h('div', { class: 'limit-row' },
          ui.h('div', { class: 'row' },
            ui.h('div', { class: 'grow' }, ui.h('div', {}, label)),
            ui.h('div', { class: 'hint' }, allowed === 0 ? 'unlimited' : `${U.qty(used)} of ${U.qty(allowed)}`)),
          bar,
          full ? ui.h('div', { class: 'hint', style: { color: 'var(--warn,#a15c00)' } }, `The ${label.toLowerCase()} limit is reached. Raise the limit or deactivate something you no longer use.`) : null);
      };

      const statusTone = String(s.status || '').toUpperCase() === 'ACTIVE' ? 'alert-ok'
        : String(s.status || '').toUpperCase() === 'TRIAL' ? 'alert-info' : 'alert-warn';

      const stack = ui.h('div', { class: 'stack' });
      stack.appendChild(ui.h('div', { class: `alert ${statusTone}` },
        `Plan: ${s.plan || 'Standard'} · status ${U.humanise(s.status || 'TRIAL')}${s.renewalDate ? ` · renews ${U.date(s.renewalDate)}` : ''}.`));

      stack.appendChild(ui.h('div', { class: 'kpis' },
        ui.kpi({ label: 'Businesses allowed', value: Number(s.maxBusinesses) === 0 ? 'Unlimited' : U.qty(s.maxBusinesses), foot: `${U.qty(counts.businesses || usage.businesses && usage.businesses.used || 0)} in use` }),
        ui.kpi({ label: 'Branches allowed', value: Number(s.maxBranches) === 0 ? 'Unlimited' : U.qty(s.maxBranches), foot: `${U.qty(counts.branches || 0)} in use` }),
        ui.kpi({ label: 'Staff allowed', value: Number(s.maxStaff) === 0 ? 'Unlimited' : U.qty(s.maxStaff), foot: `${U.qty(counts.staff || 0)} active` }),
        ui.kpi({ label: 'Features on', value: `${Object.values(features).filter((f) => f.enabled).length} / ${Object.keys(features).length}` })));

      stack.appendChild(ui.h('div', { class: 'card' }, ui.h('div', { class: 'card-body' },
        ui.h('h2', {}, 'What is in use'),
        ui.h('p', { class: 'sub' }, 'Counted live, and only counting rows that are active. A deactivated member of staff does not consume a seat — otherwise a limit would punish a shop twice for somebody leaving.'),
        limitBar('Businesses', counts.businesses || 0, Number(s.maxBusinesses) || 0),
        limitBar('Branches', counts.branches || 0, Number(s.maxBranches) || 0),
        limitBar('Staff', counts.staff || 0, Number(s.maxStaff) || 0))));

      const featureRows = Object.entries(features).map(([key, f]) => ({ key, label: f.label || U.humanise(key), enabled: f.enabled }));
      stack.appendChild(ui.dataCard({
        title: 'Features',
        table: ui.renderTable({
          columns: [
            { key: 'label', label: 'Feature' },
            { key: 'enabled', label: 'On this plan', render: (f) => (f.enabled ? ui.badge('included', 'badge-good') : ui.badge('not included', 'badge-mute')) },
            {
              key: 'where',
              label: 'Where you would notice it',
              render: (f) => ui.h('span', { class: 'hint' }, whereFeature(f.key)),
            },
          ],
          rows: featureRows,
          emptyTitle: 'No features listed',
          emptyMessage: 'Features come from the plan attached to this deployment.',
        }),
      }));

      if (contact.name || contact.phone || contact.email) {
        stack.appendChild(ui.h('div', { class: 'card' }, ui.h('div', { class: 'card-body' },
          ui.h('h2', {}, 'Who to call'),
          ui.kv([
            ['Contact', contact.name],
            ['Phone', contact.phone],
            ['Email', contact.email],
          ]),
          ui.h('p', { class: 'sub' }, 'Raising a limit, turning a feature on or getting help with a return — this is the number to use.'))));
      }

      stack.appendChild(ui.h('div', { class: 'card' }, ui.h('div', { class: 'card-body' },
        ui.h('h2', {}, 'How the limits are enforced'),
        ui.h('p', { class: 'sub' }, 'At the moment of creation, with a message that names the limit. A branch that cannot be opened tells you it is the branch limit and what to do about it — it does not fail later, somewhere else, with a stack trace. No existing data is ever hidden or locked when a plan changes; nothing you have already recorded disappears.'))));

      host.replaceChildren(stack);
    }

    function whereFeature(key) {
      const map = {
        instalments: 'Selling on an instalment plan, and the schedule of payments that comes with it',
        layaway: 'Holding an item for a customer against a deposit',
        deliveries: 'Delivery and installation jobs after a sale',
        attendance: 'Clock-in, the geofence, and the review of flagged clock-ins',
        warranty: 'Serial numbers, warranty cover and claims',
        credit_sales: 'Selling on account, and the debtor ledger',
        multi_business: 'More than one legal entity in one deployment',
        wholesale_pricing: 'Trade price lists and quantity breaks',
        stocktake: 'Counting the shelf and posting the variances',
        intercompany: 'Moving stock between two different businesses',
        bank_reconciliation: 'Matching bankings to the bank statement',
        vat_returns: 'The VAT position and the return figures',
        wht_returns: 'Withholding, and what has been remitted',
        commission: 'Sales commission per salesperson',
        targets: 'Sales targets per branch and period',
        api_access: 'Connecting another system to this one',
      };
      return map[key] || 'Part of how the app behaves.';
    }

    wrap.appendChild(ui.html('<style>' +
      '.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:10px}' +
      '.kpi-label{font-size:11px;text-transform:uppercase;letter-spacing:.06em;opacity:.65;margin-bottom:2px}' +
      '.kpi-value{font-size:19px;font-weight:650}' +
      '.kpi-foot{font-size:11px;opacity:.62;margin-top:2px}' +
      '.limit-row{margin:14px 0}.limit-row .row{align-items:baseline}' +
      '.progress{height:8px;border-radius:5px;background:var(--line);overflow:hidden;margin:5px 0}' +
      '.progress-fill{height:100%;background:var(--accent);border-radius:5px}' +
      '.progress-fill.is-warn{background:#a15c00}.progress-fill.is-full{background:#b42318}' +
      '</style>'));

    await load();
    return wrap;
  }

  SR.views = SR.views || {};
  SR.views.plan = { render };
}(window));
