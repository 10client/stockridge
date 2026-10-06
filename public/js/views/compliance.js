'use strict';
// =====================================================================
// public/js/views/compliance.js — THE LICENCES, AND WHAT IS ABOUT TO LAPSE
// =====================================================================
// A Nigerian shop holds paperwork it can be closed for not having: a CAC
// registration, a TIN, a state or LGA trading permit, a fire service certificate,
// and — depending on what it sells — a SONCAP dealer registration, an NCC type
// approval, a quarry permit, a forestry permit. Every one of them expires, and
// nothing about a busy trading week reminds anybody.
//
// THREE TABS, because they answer three different questions:
//
//   CHECKLIST   "what is this branch SUPPOSED to hold?" — the vertical's own
//               compliance fields (`profile.complianceFields`), matched against
//               what is actually on file. Missing ones are named, not merely
//               absent from a list.
//   REGISTER    "what do we hold, and until when?" — the records themselves, with
//               the dates, the numbers and who issued them.
//   ALERTS      "what is about to lapse?" — straight from the schema's own view,
//               windowed by the owner's setting, and with a button to raise the
//               notifications so the alert also exists for people who never open
//               this screen.
//
// NOTHING HERE BLOCKS TRADING. A permit the vertical expects but the branch does
// not hold is shown as missing; a permit of a type the vertical does not list is
// kept and shown as extra. The server refuses only what has no reading at all —
// two live records of one type on one branch.
// =====================================================================
(function (global) {
  const SR = global.SR;
  const ui = SR.ui;
  const U = SR.util;

  const TONE = {
    MISSING: 'red', EXPIRED: 'red', EXPIRING: 'amber', VALID: 'green', NO_EXPIRY: 'grey', UNKNOWN_DATE: 'grey',
  };

  /** The label and hint for a record type, from the server's own library. */
  function describeType(library, type) {
    const key = String(type || '').toUpperCase();
    const lib = (library || {})[key];
    return lib ? { label: lib.label || key, hint: lib.hint || null, expires: lib.expires === true } : { label: U.humanise(key), hint: null, expires: null };
  }

  function statusText(row) {
    const days = row.daysToExpiry;
    if (row.status === 'EXPIRED') return days === null ? 'Expired' : `Expired ${Math.abs(days)} day(s) ago`;
    if (row.status === 'EXPIRING') return days === 0 ? 'Expires today' : `Expires in ${days} day(s)`;
    if (row.status === 'NO_EXPIRY') return 'Does not expire';
    if (row.status === 'VALID') return days === null ? 'Valid' : `Valid for ${days} day(s)`;
    return row.status;
  }

  async function render(ctx) {
    ctx.setTitle('Compliance & licences');
    const state = { tab: ctx.query.tab || 'checklist', library: {}, alerts: null, checklist: [], records: [] };

    const wrap = ui.h('div', { class: 'stack' });
    wrap.appendChild(ui.h('div', { class: 'page-head' },
      ui.h('div', {},
        ui.h('h1', {}, 'Compliance & licences'),
        ui.h('p', { class: 'sub' }, `${SR.state.activeBranchName()} · the registrations and permits this branch holds, and what is about to lapse`)),
      ui.h('div', { class: 'actions' },
        ui.h('button', { class: 'btn btn-sm btn-primary', onClick: () => openRecordForm(null) }, 'Record a licence'),
        ui.h('button', { class: 'btn btn-sm', onClick: () => raiseAlerts() }, 'Raise alerts now'),
        ui.h('button', { class: 'btn btn-sm', onClick: () => SR.app.navigate('/settings') }, 'Alert window'))));

    const kpis = ui.h('div', { class: 'grid' });
    const tabs = ui.h('div', { class: 'tabs' });
    const body = ui.h('div', { class: 'stack' });
    wrap.appendChild(kpis);
    wrap.appendChild(tabs);
    wrap.appendChild(body);

    for (const [key, label] of [['checklist', 'Checklist'], ['register', 'Register'], ['alerts', 'Expiry alerts']]) {
      tabs.appendChild(ui.h('button', {
        class: `tab ${state.tab === key ? 'is-active' : ''}`,
        onClick: () => { state.tab = key; draw(); },
      }, label));
    }

    function draw() {
      for (const t of [...tabs.children]) {
        const key = t.textContent === 'Checklist' ? 'checklist' : (t.textContent === 'Register' ? 'register' : 'alerts');
        t.className = `tab ${state.tab === key ? 'is-active' : ''}`;
      }
      body.replaceChildren(state.tab === 'checklist' ? checklistPanel() : state.tab === 'register' ? registerPanel() : alertsPanel());
    }

    // ---- CHECKLIST ----------------------------------------------------
    function checklistPanel() {
      const box = ui.h('div', { class: 'stack' });
      if (!state.checklist.length) {
        box.appendChild(ui.empty({ title: 'No branch to check', message: 'Create a branch first — a licence belongs to a premises.', action: ui.h('button', { class: 'btn btn-sm', onClick: () => SR.app.navigate('/branches') }, 'Branches') }));
        return box;
      }
      for (const row of state.checklist) {
        const card = ui.h('div', { class: 'card' });
        card.appendChild(ui.h('div', { class: 'card-head' },
          ui.h('h2', {}, row.branch_name),
          ui.h('div', { class: 'actions' },
            ui.h('span', { class: 'hint' }, `${U.titleCase(String(row.profile_code || '').replace(/_/g, ' '))}`),
            ui.badge(row.counts.ok ? 'Everything on file' : `${row.counts.missing} missing · ${row.counts.alerting} need renewal`,
              row.counts.ok ? 'green' : (row.counts.expired ? 'red' : 'amber')))));

        const rows = row.expected.map((e) => ({
          ...e,
          _type: e.type,
          _label: e.label,
          _status: e.status,
          _detail: e.record
            ? [e.record.record_number, e.record.issued_by, e.record.expiry_date ? `expires ${e.record.expiry_date}` : 'no expiry date'].filter(Boolean).join(' · ')
            : 'Not recorded',
        }));
        card.appendChild(ui.renderTable({
          columns: [
            { key: '_label', label: 'Record', render: (r) => ui.h('div', {}, ui.h('strong', {}, r._label), r.hint ? ui.h('div', { class: 'hint' }, r.hint) : null) },
            { key: '_detail', label: 'On file' },
            { key: '_status', label: 'State', render: (r) => ui.badge(statusText({ status: r.status, daysToExpiry: r.daysToExpiry }), TONE[r.status] || 'grey') },
            {
              key: '_act',
              label: '',
              render: (r) => {
                const cell = ui.h('div', { class: 'actions' });
                if (r.record) {
                  cell.appendChild(ui.h('button', { class: 'btn btn-sm', onClick: () => openRecordForm(r.record) }, 'Edit'));
                } else {
                  cell.appendChild(ui.h('button', { class: 'btn btn-sm btn-primary', onClick: () => openRecordForm(null, { record_type: r.type, branch_id: row.branch_id }) }, 'Record it'));
                }
                return cell;
              },
            },
          ],
          rows,
          emptyMessage: 'This vertical lists no compliance records.',
        }));

        if (row.extra.length) {
          card.appendChild(ui.h('p', { class: 'hint' },
            `${row.extra.length} record(s) held that this vertical does not list: ${row.extra.map((x) => x.type).join(', ')}. They are kept and tracked — the vertical decides what is offered, never what is allowed.`));
        }
        box.appendChild(card);
      }
      return box;
    }

    // ---- REGISTER -----------------------------------------------------
    function registerPanel() {
      const box = ui.h('div', { class: 'stack' });
      box.appendChild(ui.dataCard({
        title: 'What this branch holds',
        actions: [ui.h('button', { class: 'btn btn-sm', onClick: () => load() }, 'Refresh')],
        table: ui.renderTable({
          columns: [
            { key: 'record_type', label: 'Record', render: (r) => ui.h('div', {}, ui.h('strong', {}, describeType(state.library, r.record_type).label), ui.h('div', { class: 'hint' }, r.knownType ? r.record_type : `${r.record_type} — not in this vertical's list`)) },
            { key: 'record_number', label: 'Number', render: (r) => r.record_number || '—' },
            { key: 'issued_by', label: 'Issued by', render: (r) => r.issued_by || '—' },
            { key: 'expiry_date', label: 'Expires', render: (r) => (r.expiry_date ? ui.h('div', {}, r.expiry_date, ui.h('div', { class: 'hint' }, statusText(r))) : ui.h('span', { class: 'hint' }, 'Never')) },
            { key: 'status', label: 'State', render: (r) => ui.badge(r.status, TONE[r.status] || 'grey') },
            {
              key: '_act',
              label: '',
              render: (r) => ui.h('div', { class: 'actions' },
                ui.h('button', { class: 'btn btn-sm', onClick: () => openRecordForm(r) }, 'Edit'),
                ui.h('button', { class: 'btn btn-sm btn-danger', onClick: () => removeRecord(r) }, 'Remove')),
            },
          ],
          rows: state.records,
          emptyTitle: 'No licence recorded yet',
          emptyMessage: 'Record the CAC number, the TIN, the trading permit and the fire certificate — then this screen can warn you before any of them lapse.',
          emptyAction: ui.h('button', { class: 'btn btn-primary btn-sm', onClick: () => openRecordForm(null) }, 'Record the first one'),
        }),
      }));
      return box;
    }

    // ---- ALERTS -------------------------------------------------------
    function alertsPanel() {
      const box = ui.h('div', { class: 'stack' });
      const a = state.alerts || { data: [], counts: {}, windowDays: null, horizonDays: null, note: null };
      box.appendChild(ui.h('p', { class: 'sub' },
        `Warning ${a.windowDays} day(s) ahead${a.horizonDays ? ` (the register can look ${a.horizonDays} days ahead at most — change the window under Settings)` : ''}.`));
      if (a.note) box.appendChild(ui.h('div', { class: 'alert alert-warn' }, a.note));
      box.appendChild(ui.dataCard({
        title: `${(a.data || []).length} licence(s) need attention`,
        actions: [ui.h('button', { class: 'btn btn-sm btn-primary', onClick: () => raiseAlerts() }, 'Raise alerts now')],
        table: ui.renderTable({
          columns: [
            { key: 'branch_name', label: 'Branch' },
            { key: 'record_type', label: 'Record', render: (r) => describeType(state.library, r.record_type).label },
            { key: 'record_number', label: 'Number', render: (r) => r.record_number || '—' },
            { key: 'expiry_date', label: 'Expires', render: (r) => ui.h('div', {}, r.expiry_date, ui.h('div', { class: 'hint' }, statusText(r))) },
            { key: 'severity', label: 'Severity', render: (r) => ui.badge(r.severity, r.severity === 'CRITICAL' ? 'red' : 'amber') },
            { key: '_act', label: '', render: (r) => ui.h('button', { class: 'btn btn-sm', onClick: () => openRecordForm(r) }, 'Update') },
          ],
          rows: a.data || [],
          emptyTitle: 'Nothing is about to lapse',
          emptyMessage: `No licence held by these branches expires within ${a.windowDays || 30} days. This is the tab to check with an inspector outside.`,
        }),
      }));
      return box;
    }

    // ---- ACTIONS ------------------------------------------------------
    function paintKpis() {
      const t = (state.checklist.reduce((acc, r) => ({
        expected: acc.expected + r.counts.expected,
        held: acc.held + r.counts.held,
        missing: acc.missing + r.counts.missing,
        expired: acc.expired + r.counts.expired,
        expiring: acc.expiring + r.counts.expiring,
      }), { expected: 0, held: 0, missing: 0, expired: 0, expiring: 0 }));
      const alerts = state.alerts && state.alerts.counts ? state.alerts.counts : { total: 0, expired: 0, expiring: 0 };
      kpis.replaceChildren(
        ui.kpi({ label: 'On file', value: `${t.held} of ${t.expected}`, small: true }),
        ui.kpi({ label: 'Never recorded', value: U.qty(t.missing), tone: t.missing ? 'red' : null, small: true }),
        ui.kpi({ label: 'Expired', value: U.qty(t.expired), tone: t.expired ? 'red' : null, small: true }),
        ui.kpi({ label: 'Expiring soon', value: U.qty(t.expiring), tone: t.expiring ? 'amber' : null, small: true }),
        ui.kpi({ label: 'In the alert window', value: U.qty(alerts.total || 0), small: true }));
    }

    async function load() {
      const branchId = SR.state.activeBranchId;
      const branchQuery = branchId ? `&branch_id=${encodeURIComponent(branchId)}` : '';
      const [checklist, alerts, records] = await Promise.all([
        SR.api.get(`/api/compliance/checklist${branchId ? `?branch_id=${encodeURIComponent(branchId)}` : ''}`),
        SR.api.get(`/api/compliance/alerts${branchId ? `?branch_id=${encodeURIComponent(branchId)}` : ''}`),
        SR.api.get(`/api/compliance/records?limit=200${branchQuery}`),
      ]);
      state.checklist = checklist.data || [];
      state.alerts = alerts;
      state.records = records.data || [];
      state.library = checklist.library || {};
      paintKpis();
      draw();
    }

    function openRecordForm(record, preset = {}) {
      const isNew = !record;
      const value = record || {
        record_type: preset.record_type || 'CAC',
        branch_id: preset.branch_id || SR.state.activeBranchId,
        record_number: '', issued_by: '', issued_date: '', expiry_date: '', document_url: '', notes: '',
      };
      const branches = state.checklist.map((r) => ({ value: r.branch_id, label: r.branch_name }));
      const typeOptions = Object.entries(state.library)
        .map(([code, lib]) => ({ value: code, label: `${lib.label || code}${lib.expires ? '' : ' (no expiry)'}` }))
        .sort((a, b) => a.label.localeCompare(b.label));
      // A record whose type the vertical does not list must still be editable, so
      // its own code is offered as an option rather than being silently replaced
      // by the first entry in the list.
      if (value.record_type && !typeOptions.some((o) => o.value === value.record_type)) {
        typeOptions.unshift({ value: value.record_type, label: `${value.record_type} (not in this vertical's list)` });
      }

      const form = ui.h('form', { class: 'form' });
      form.appendChild(ui.field({ label: 'Record', name: 'record_type', value: value.record_type, options: typeOptions, required: true, hint: 'Anything can be recorded — the vertical decides what is offered, not what is allowed.' }));
      form.appendChild(ui.field({ label: 'Branch', name: 'branch_id', value: value.branch_id, options: branches, required: true, disabled: true, hint: 'A permit names a premises, so it belongs to one branch.' }));
      form.appendChild(ui.field({ label: 'Number or reference', name: 'record_number', value: value.record_number || '', placeholder: 'RC-1234567' }));
      form.appendChild(ui.field({ label: 'Issued by', name: 'issued_by', value: value.issued_by || '', placeholder: 'Corporate Affairs Commission' }));
      form.appendChild(ui.field({ label: 'Issued on', name: 'issued_date', value: value.issued_date || '', type: 'date' }));
      form.appendChild(ui.field({ label: 'Expires on', name: 'expiry_date', value: value.expiry_date || '', type: 'date', hint: 'Leave blank for a registration that does not expire, like a TIN — it then never raises an alert.' }));
      form.appendChild(ui.field({ label: 'Document link', name: 'document_url', value: value.document_url || '', placeholder: 'Where the scanned copy lives' }));
      form.appendChild(ui.field({ label: 'Notes', name: 'notes', value: value.notes || '', type: 'textarea', rows: 2 }));

      const save = ui.h('button', { class: 'btn btn-primary' }, isNew ? 'Record it' : 'Save changes');
      const modal = ui.openModal({
        title: isNew ? 'Record a licence' : `Edit ${describeType(state.library, value.record_type).label}`,
        body: form,
        footer: [ui.h('button', { class: 'btn', onClick: () => modal.close() }, 'Cancel'), save],
        size: 'wide',
      });

      save.addEventListener('click', async (ev) => {
        ev.preventDefault();
        const v = ui.readFormStrings(form);
        const payload = {
          record_type: v.record_type,
          record_number: v.record_number || undefined,
          issued_by: v.issued_by || undefined,
          issued_date: v.issued_date || undefined,
          expiry_date: v.expiry_date || undefined,
          document_url: v.document_url || undefined,
          notes: v.notes || undefined,
        };
        if (isNew) payload.branch_id = value.branch_id;
        await ui.withBusy(form, async () => {
          try {
            // `SR.api.post(path, payload)` — the payload is the SECOND argument.
            // Wrapping it as `{ body: { … } }` sends an object with no fields in
            // it, and the server answers "record type is required" about a request
            // that carried one.
            const res = isNew
              ? await SR.api.post('/api/compliance/records', payload)
              : await SR.api.put(`/api/compliance/records/${encodeURIComponent(record.id)}`, payload);
            ui.ok(res.message || 'Saved.');
            if (res.unrecognisedType) ui.warn(res.unrecognisedType);
            modal.close();
            await load();
          } catch (err) { ui.apiError(err, 'That licence could not be saved.'); }
        });
      });
    }

    async function removeRecord(record) {
      const label = describeType(state.library, record.record_type).label;
      const confirmed = await ui.confirmDialog({
        title: `Remove ${label}?`,
        message: `${label}${record.record_number ? ` (${record.record_number})` : ''} comes off this branch's register. It is kept in the history rather than deleted, and it stops raising alerts.`,
        confirmLabel: 'Remove it',
        danger: true,
      });
      if (!confirmed) return;
      try {
        const res = await SR.api.del(`/api/compliance/records/${encodeURIComponent(record.id)}`);
        ui.ok(res.message || 'Removed.');
        await load();
      } catch (err) { ui.apiError(err, 'That licence could not be removed.'); }
    }

    async function raiseAlerts() {
      try {
        const res = await SR.api.post('/api/compliance/notify', {});
        ui.ok(res.message || 'Alerts raised.');
        await load();
      } catch (err) { ui.apiError(err, 'Alerts could not be raised.'); }
    }

    await load();
    return wrap;
  }

  SR.views = SR.views || {};
  SR.views.compliance = { render };
})(window);
