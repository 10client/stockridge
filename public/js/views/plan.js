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

  /** The rows out of a paged list response, whichever shape the server used. */
  function inRows(res) { return (res && (res.data || res.rows || res.cleanups)) || []; }

  /**
   * THE CLEANUP, SCREENED THE WAY A DESTRUCTIVE ACTION DESERVES.
   *
   * Three things stand between the button and the deletion, and each one exists
   * because the others can be got past by reflex:
   *
   *   a COUNT, so the operator agrees to a number rather than to prose;
   *   a TYPED PHRASE, because typing "CLEAR ALL BUSINESS DATA" cannot happen by
   *     accident the way a double-click can;
   *   two DECLARATIONS, which are not security — they are the two questions a
   *     person should have answered before they got this far, asked in writing.
   *
   * The request is sent with the default offline behaviour (`queue: false`), so a
   * cleanup is ONLINE ONLY: it fails loudly rather than sitting in the queue to be
   * replayed hours later against a database that has moved on. A queued deletion
   * is the one thing in this application that must never happen.
   */
  function openCleanupFlow(mode) {
    return new Promise((resolve) => {
      let settled = false;
      let busy = false;

      const body = ui.h('div', { class: 'stack' });
      body.appendChild(ui.h('p', {}, mode.description || ''));
      if (mode.keeps) body.appendChild(ui.h('p', { class: 'sub' }, `Kept: ${mode.keeps}`));

      const dates = {};
      if (mode.needs_dates) {
        const row = ui.h('div', { class: 'row' });
        for (const field of ['start_date', 'end_date']) {
          const input = ui.h('input', { type: 'date' });
          dates[field] = input;
          row.appendChild(ui.h('label', { class: 'ctl' }, field === 'start_date' ? 'First day' : 'Last day (included)'));
          row.appendChild(input);
        }
        body.appendChild(row);
      }

      const counts = ui.h('div', {});
      const previewBtn = ui.h('button', {
        class: 'btn btn-sm',
        onClick: async () => {
          if (busy) return;
          busy = true;
          counts.replaceChildren(ui.loading('Counting…'));
          try {
            const res = await SR.api.post('/api/data-management/purge/preview', {
              mode: mode.code,
              start_date: dates.start_date ? dates.start_date.value : null,
              end_date: dates.end_date ? dates.end_date.value : null,
            });
            const rows = Object.entries(res.would_remove || {}).map(([table, n]) => ({ table, n }));
            if (!rows.length) {
              counts.replaceChildren(ui.h('div', { class: 'alert' }, 'Nothing matches. This cleanup would remove no rows at all — check the period before running it.'));
            } else {
              counts.replaceChildren(ui.h('p', { class: 'sub' }, `${U.qty(res.total)} row(s) would be removed:`),
                ui.renderTable({
                  columns: [{ key: 'table', label: 'Record' }, { key: 'n', label: 'Rows', render: (r) => U.qty(r.n) }],
                  rows,
                }),
                ui.h('p', { class: 'hint' }, 'Counting follows the same plan the cleanup runs, against this database as it is now.'));
            }
          } catch (err) {
            counts.replaceChildren(ui.h('div', { class: 'alert alert-warn' }, (err && err.message) || 'The count could not be taken.'));
          } finally { busy = false; }
        },
      }, 'Count what would be removed');
      body.appendChild(ui.h('div', { class: 'row' }, previewBtn));
      body.appendChild(counts);

      body.appendChild(ui.h('hr'));
      body.appendChild(ui.h('p', {}, 'To continue, type this exactly:'));
      body.appendChild(ui.h('p', {}, ui.h('code', {}, mode.phrase)));
      const phrase = ui.h('input', { type: 'text', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false', placeholder: 'Type the phrase' });
      body.appendChild(phrase);

      const exportBox = ui.h('input', { type: 'checkbox' });
      const noticeBox = ui.h('input', { type: 'checkbox' });
      body.appendChild(ui.h('label', { class: 'ctl' }, exportBox, ' I have exported and verified every record I must keep, and I understand this cannot be undone.'));
      body.appendChild(ui.h('label', { class: 'ctl' }, noticeBox, ' I have read the notice below and checked my retention obligations.'));
      body.appendChild(ui.h('div', { class: 'alert alert-warn' }, mode.notice || 'Deleting a record is permanent from this application.'));

      const runBtn = ui.h('button', { class: 'btn btn-danger', onClick: run }, 'Run this cleanup');
      runBtn.disabled = true;
      const cancel = ui.h('button', { class: 'btn', onClick: () => finish(null) }, 'Cancel');

      function ready() {
        return phrase.value.trim() === mode.phrase && exportBox.checked && noticeBox.checked;
      }
      function refresh() { runBtn.disabled = !ready(); }
      phrase.addEventListener('input', refresh);
      exportBox.addEventListener('change', refresh);
      noticeBox.addEventListener('change', refresh);

      async function run() {
        if (busy || !ready()) return;
        busy = true;
        runBtn.disabled = true;
        runBtn.textContent = 'Running…';
        try {
          const res = await SR.api.post('/api/data-management/purge', {
            mode: mode.code,
            phrase: phrase.value.trim(),
            export_confirmed: true,
            retention_acknowledged: true,
            start_date: dates.start_date ? dates.start_date.value : null,
            end_date: dates.end_date ? dates.end_date.value : null,
          });
          const kept = res.continuity || {};
          ui.ok(`${res.label || mode.label}: ${U.qty(res.total)} row(s) removed. Still trading with ${U.qty(kept.stock_batches || 0)} batch(es) holding ${U.qty(kept.stock_base_units || 0)} unit(s).`);
          finish(res);
        } catch (err) {
          const message = (err && err.message) || 'The cleanup did not run.';
          body.appendChild(ui.h('div', { class: 'alert alert-warn' }, `Nothing was deleted: ${message}`));
          runBtn.disabled = false;
          runBtn.textContent = 'Try again';
        } finally { busy = false; }
      }

      const modal = ui.openModal({
        title: `Cleanup — ${mode.label}`,
        body,
        footer: [cancel, runBtn],
        size: 'lg',
        onClose: () => finish(null),
      });
      setTimeout(() => phrase.focus(), 40);

      function finish(value) { if (settled) return; settled = true; resolve(value); modal.close(value); }
    });
  }

  /** The five cleanups, offered only to the seat the endpoint will accept. */
  function cleanupCard(data, reload) {
    const dm = data.dataManagement || {};
    const modes = dm.modes || [];
    if (!modes.length) return null;
    const canRun = SR.state.atLeast('OWNER');

    const list = ui.h('div', { class: 'stack' });
    for (const m of modes) {
      list.appendChild(ui.h('div', { class: 'row' },
        ui.h('div', {},
          ui.h('strong', {}, m.label),
          ui.h('p', { class: 'sub' }, m.description || ''),
          m.keeps ? ui.h('p', { class: 'hint' }, `Kept: ${m.keeps}`) : null),
        ui.h('div', { class: 'spacer' }),
        canRun ? ui.h('button', {
          class: 'btn btn-sm btn-danger',
          onClick: async () => {
            const result = await openCleanupFlow({ ...m, notice: dm.retention_notice });
            if (result) reload();
          },
        }, 'Start') : null));
    }

    return ui.h('div', { class: 'card' }, ui.h('div', { class: 'card-body' },
      ui.h('h2', {}, 'Data cleanup'),
      ui.h('p', { class: 'sub' }, canRun
        ? 'These remove records permanently. Every one of them counts first, asks you to type a phrase, and writes what it removed to the cleanup log.'
        : 'Only the owner — or the platform administrator — can run a cleanup. You can see what each one does, and how much room the deployment has left.'),
      list));
  }

  async function render(ctx) {
    ctx.setTitle('Subscription');
    const wrap = ui.h('div', { class: 'stack' });
    wrap.appendChild(ui.h('div', { class: 'page-head' },
      ui.h('div', {},
        ui.h('h1', {}, 'Subscription'),
        ui.h('p', { class: 'sub' }, `${SR.state.activeBusinessName()} · the plan this deployment runs on, and what it allows`))));

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
      // THE CAPACITY AND RETENTION HALF, FETCHED SEPARATELY AND NEVER FATALLY.
      //
      // A STAFF or CASHIER seat may open this screen and will be refused with a
      // 403 by /api/data-management/status, because capacity is a manager's
      // business. A screen that threw on that refusal would show a shop's
      // subscription as broken for the person most likely to open it. So the
      // failure is caught, remembered as null, and the rest of the screen renders
      // exactly as before — the same choice PharmaRidge made, for the same reason:
      // a data-management problem must not take the plan screen down with it.
      try {
        data.dataManagement = await SR.api.get('/api/data-management/status', { query: SR.state.query({}) });
        // The cleanup runs are their own request: a shop that has never run one
        // gets an empty list from a cheap read rather than a bigger status body it
        // will not look at.
        data.dataCleanups = await SR.api.get('/api/data-management/history', { query: SR.state.query({ limit: 20 }) });
      } catch (err) {
        data.dataManagement = null;
        data.dataCleanups = null;
        data.dataManagementRefused = err && err.status === 403 ? 'role' : (err && err.message) || 'unavailable';
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

      // ---- RECORDS AND ROOM -------------------------------------------
      // What the shop keeps, how much room is left, and what the daily
      // housekeeping would let go. The message is deliberately in the
      // proprietor's words: "nearly full" is a fact about a business, not a
      // percentage about a database.
      const dm = data.dataManagement;
      if (dm && dm.storage) {
        const st = dm.storage;
        const tone = st.status === 'CRITICAL' ? 'alert-warn' : st.status === 'WARNING' ? 'alert-info' : 'alert-ok';
        const roomRows = (st.largest || []).map((t) => ({ table: U.humanise(String(t.table).replace(/_/g, ' ')), rows: t.rows, megabytes: `${t.megabytes} MB` }));
        const rules = ((dm.retention && dm.retention.rules) || []).map((r) => ({
          rule: r.name,
          window: `${r.retainDays} days`,
          removes_now: r.wouldRemove == null ? '—' : U.qty(r.wouldRemove),
        }));
        const card = ui.h('div', { class: 'card' },
          ui.h('div', { class: 'card-body' },
            ui.h('h2', {}, 'Records and room'),
            ui.h('div', { class: `alert ${tone}` },
              `${U.qty(st.megabytes)} MB of ${U.qty(st.limit_megabytes)} MB used (${st.percent_used}%). ${st.message || ''}`),
            st.assumption ? ui.h('p', { class: 'sub' }, st.assumption.note || '') : null,
            roomRows.length ? ui.dataCard({
              title: 'The largest records',
              rows: roomRows,
              columns: [
                { key: 'table', label: 'What' },
                { key: 'rows', label: 'Rows', render: (t) => U.qty(t.rows) },
                { key: 'megabytes', label: 'Estimated' },
              ],
            }) : null,
            ui.h('p', { class: 'sub' }, 'Housekeeping runs on the daily schedule. Nothing here removes a sale, a payment, the ledger, a stock movement or the audit log.'),
            rules.length ? ui.dataCard({
              title: 'What housekeeping lets go, and when',
              rows: rules,
              columns: [
                { key: 'rule', label: 'Record' },
                { key: 'window', label: 'Kept for' },
                { key: 'removes_now', label: 'Would remove now' },
              ],
            }) : null,
            ((data.dataCleanups && inRows(data.dataCleanups)) || []).length ? ui.dataCard({
              title: 'Past cleanups',
              rows: inRows(data.dataCleanups).map((c) => ({ when: U.date(c.created_at), mode: c.mode, by: c.by })),
              columns: [
                { key: 'when', label: 'When' },
                { key: 'mode', label: 'What was removed' },
                { key: 'by', label: 'By' },
              ],
            }) : ui.h('p', { class: 'sub' }, 'No cleanup has ever been run on this deployment.'),
            ui.h('p', { class: 'hint' }, dm.retention_notice || '')));
        stack.appendChild(card);
      } else if (data.dataManagementRefused === 'role') {
        stack.appendChild(ui.h('div', { class: 'card' }, ui.h('div', { class: 'card-body' },
          ui.h('h2', {}, 'Records and room'),
          ui.h('p', { class: 'sub' }, 'Ask a manager or the owner how much room this deployment has left. Capacity and retention are shown to managers and above.'))));
      }

      // THE CLEANUPS THEMSELVES, under the card that says how full the database is:
      // "there is no room left" and "here is how you make room" are the two halves of
      // one answer, and the second half is destructive enough to deserve its own card.
      const cleanup = cleanupCard(data, load);
      if (cleanup) stack.appendChild(cleanup);

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
