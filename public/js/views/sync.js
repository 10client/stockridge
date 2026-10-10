'use strict';
// =====================================================================
// public/js/views/sync.js — WHAT IS ON THIS DEVICE, AND WHERE IT HAS GOT TO
// =====================================================================
// This screen answers the question a shopkeeper actually asks when the network
// has been unreliable: "is my work safe?"
//
// So it leads with the OUTBOX — the queue of things this device has recorded
// that the server has not yet seen — and only then talks about the server's view
// of things. The order matters: the queue is the part that is at risk, and the
// server's view is the part that is already safe.
//
// Three states a queued item can be in, and only three:
//
//   PENDING   waiting for a connection. Nothing to do.
//   RETRY     the line dropped mid-send. It will go again.
//   FAILED    the server REFUSED it, with a reason. This is the one that needs a
//             human: it will retry forever and never succeed until somebody
//             reads the reason and fixes the entry or discards it. Showing the
//             reason next to the item is the whole point of the screen.
//
// Conflicts are shown side by side — losing value against winning value — for
// the same reason. A conflict nobody can read is a conflict nobody resolves.
// =====================================================================
(function (global) {
  const SR = global.SR;
  const ui = SR.ui;
  const U = SR.util;

  async function render(ctx) {
    ctx.setTitle('Sync & offline');
    const state = { tab: 'queue', queue: null, status: null, remote: null, conflicts: null };
    const wrap = ui.h('div', { class: 'stack' });

    // ------------------------------------------------------------- header
    const netLine = ui.h('div', { class: 'row' });
    wrap.appendChild(ui.h('div', { class: 'page-head' },
      ui.h('div', {},
        ui.h('h1', {}, 'Sync & offline'),
        ui.h('p', { class: 'sub' }, 'What this device has recorded, what has reached the server, and anything the server refused')),
      ui.h('div', { class: 'actions' },
        ui.h('button', { class: 'btn btn-sm btn-primary', onClick: () => runNow() }, 'Sync now'),
        ui.h('button', { class: 'btn btn-sm', onClick: () => backupDevice() }, 'Back up this device'))));

    const statusCard = ui.h('div', {});
    wrap.appendChild(statusCard);

    const tabs = ui.h('div', { class: 'tabs' });
    for (const [key, label] of [['queue', 'Waiting to upload'], ['conflicts', 'Conflicts'], ['devices', 'Devices'], ['storage', 'This device']]) {
      tabs.appendChild(ui.h('button', {
        class: `tab ${state.tab === key ? 'is-active' : ''}`,
        onClick: (ev) => {
          state.tab = key;
          for (const b of ev.currentTarget.parentElement.children) b.classList.remove('is-active');
          ev.currentTarget.classList.add('is-active');
          load();
        },
      }, label));
    }
    wrap.appendChild(tabs);
    void netLine;

    const host = ui.h('div', {});
    wrap.appendChild(host);

    // Re-render the queue whenever the sync engine reports a change, so a device
    // that comes back online shows its queue draining without the user reloading.
    SR.sync.on('change', () => { if (state.tab === 'queue') load({ quiet: true }).catch(() => {}); });

    async function load({ quiet = false } = {}) {
      if (!quiet) host.replaceChildren(ui.skeleton(7));
      renderStatus();
      if (state.tab === 'queue') return renderQueue();
      if (state.tab === 'conflicts') return renderConflicts();
      if (state.tab === 'devices') return renderDevices();
      return renderStorage();
    }

    // ------------------------------------------------------------- status
    function renderStatus() {
      const s = SR.sync.status();
      const online = s.online;
      const card = ui.h('div', { class: 'card' }, ui.h('div', { class: 'card-body' }));
      const body = card.firstElementChild;
      body.appendChild(ui.h('div', { class: 'row' },
        ui.h('div', { class: 'grow' },
          ui.h('h2', {}, online ? 'Connected' : 'Offline'),
          ui.h('p', { class: 'sub' }, online
            ? 'Sales, payments and stock movements go to the server as they happen. Anything queued is sent within seconds.'
            : 'You can keep working. Everything is written to this device first and uploads itself the moment the line returns — which is what makes the till usable on a bad MTN day.')),
        ui.h('div', { class: 'actions' },
          ui.badge(s.running ? 'auto-sync on' : 'auto-sync paused', s.running ? 'badge-good' : 'badge-warn'))));
      body.appendChild(ui.h('div', { class: 'kpis' },
        ui.kpi({ label: 'Last upload', value: s.lastPushAt ? U.relTime(s.lastPushAt) : 'never', small: true }),
        ui.kpi({ label: 'Last download', value: s.lastPullAt ? U.relTime(s.lastPullAt) : 'never', small: true }),
        ui.kpi({ label: 'Last error', value: s.lastError ? String(s.lastError.message || s.lastError).slice(0, 60) : 'none', tone: s.lastError ? 'bad' : 'good', small: true })));
      statusCard.replaceChildren(card);
    }

    // -------------------------------------------------------------- queue
    async function renderQueue() {
      const stats = await SR.sync.queueStats();
      state.queue = stats;
      const items = stats.items || [];
      const stack = ui.h('div', { class: 'stack' });

      stack.appendChild(ui.h('div', { class: 'kpis' },
        ui.kpi({ label: 'Waiting', value: U.qty(stats.pending || 0), tone: stats.pending ? 'warn' : 'good', foot: stats.pending ? 'will upload by itself' : 'nothing outstanding' }),
        ui.kpi({ label: 'Refused', value: U.qty(stats.failed || 0), tone: stats.failed ? 'bad' : 'good', foot: stats.failed ? 'the server will not accept these until they are fixed' : 'nothing needs attention' }),
        ui.kpi({ label: 'Uploaded', value: U.qty(stats.synced || 0), foot: 'kept for 48 hours as a receipt' }),
        ui.kpi({ label: 'Device', value: (SR.device.current() || {}).label || 'this device', small: true, foot: (SR.device.current() || {}).id })));

      if (stats.failed) {
        stack.appendChild(ui.h('div', { class: 'alert alert-danger' },
          ui.h('div', {}, `${stats.failed} item(s) were refused by the server. They will keep retrying and keep failing until somebody reads the reason below. A refused sale is not a lost sale — but it is not in the books either.`),
          ui.h('button', { class: 'btn btn-sm', onClick: () => retryAllFailed() }, 'Retry all of them')));
      }

      const failed = items.filter((i) => i.status === 'FAILED');
      const waiting = items.filter((i) => i.status !== 'FAILED' && i.status !== 'SYNCED');
      const synced = items.filter((i) => i.status === 'SYNCED');

      const queueTable = (rows, { emptyTitle, emptyMessage, showReason }) => ui.renderTable({
        columns: [
          { key: 'type', label: 'What', render: (i) => ui.h('div', {}, ui.h('div', {}, i.label || U.humanise(i.type)), ui.h('div', { class: 'hint' }, U.humanise(i.type))) },
          { key: 'occurred_at', label: 'Recorded', render: (i) => U.dateTime(i.occurred_at || i.created_at) },
          { key: 'ref', label: 'Reference', render: (i) => i.ref || '—' },
          { key: 'status', label: 'State', render: (i) => ui.statusBadge(i.status, i.status === 'SYNCED' ? 'badge-mute' : null) },
          showReason ? {
            key: 'error_message',
            label: 'Why it was refused',
            render: (i) => ui.h('div', {}, ui.h('div', {}, i.error_message || 'No reason given.'),
              ui.h('div', { class: 'hint' }, i.error_code || '')),
          } : { key: 'attempts', label: 'Tries', align: 'right', render: (i) => U.qty(i.attempts || 0) },
          {
            key: 'actions',
            label: '',
            render: (i) => ui.h('div', { class: 'row' },
              i.status === 'FAILED' ? ui.h('button', { class: 'btn btn-xs', onClick: (ev) => { ev.stopPropagation(); retryItem(i); } }, 'Try again') : null,
              i.status !== 'SYNCED' ? ui.h('button', {
                class: 'btn btn-xs btn-danger',
                onClick: (ev) => { ev.stopPropagation(); discardItem(i); },
              }, 'Discard') : null),
          },
        ],
        rows,
        emptyTitle,
        emptyMessage,
        onRowClick: (i) => showItem(i),
      });

      if (failed.length) {
        stack.appendChild(ui.dataCard({ title: 'Refused by the server', table: queueTable(failed, { emptyTitle: '', emptyMessage: '', showReason: true }) }));
      }
      stack.appendChild(ui.dataCard({
        title: 'Waiting to upload',
        table: queueTable(waiting, {
          emptyTitle: 'Everything has been uploaded',
          emptyMessage: 'Nothing is waiting on this device. Sales recorded here reach the server within seconds of the line coming back.',
          showReason: false,
        }),
      }));
      if (synced.length) {
        stack.appendChild(ui.dataCard({
          title: 'Uploaded recently',
          table: ui.renderTable({
            columns: [
              { key: 'label', label: 'What', render: (i) => i.label || U.humanise(i.type) },
              { key: 'ref', label: 'Reference', render: (i) => i.ref || '—' },
              { key: 'synced_at', label: 'Uploaded', render: (i) => U.relTime(i.synced_at || i.updated_at) },
              { key: 'status', label: 'State', render: () => ui.badge('safe on the server', 'badge-good') },
            ],
            rows: synced.slice(0, 40),
            emptyTitle: 'Nothing uploaded yet',
            emptyMessage: '',
          }),
        }));
      }
      host.replaceChildren(stack);
    }

    function showItem(item) {
      let pretty = item.payload;
      try { pretty = JSON.stringify(typeof item.payload === 'string' ? JSON.parse(item.payload) : item.payload, null, 2); } catch (e) { /* leave */ }
      const body = ui.h('div', { class: 'stack' });
      body.appendChild(ui.kv([
        ['Type', U.humanise(item.type)],
        ['State', item.status],
        ['Recorded', U.dateTime(item.occurred_at || item.created_at)],
        ['Attempts', String(item.attempts || 0)],
        ['Idempotency key', item.client_id],
        ['Refused because', item.error_message || '—'],
      ]));
      body.appendChild(ui.h('p', { class: 'sub' }, 'The idempotency key is generated once and reused on every retry. The server keeps the first result against it, so a sale that is retried five times over a bad line is still one sale.'));
      body.appendChild(ui.h('pre', { class: 'pre-block' }, String(pretty).slice(0, 6000)));
      ui.openModal({ title: 'Queued item', body, size: 'wide' });
    }

    async function retryItem(item) {
      try {
        await SR.store.requeue(item.client_id);
        ui.ok('It will be tried again on the next sync.');
        await SR.sync.runOnce({ silent: true });
        load({ quiet: true });
      } catch (err) { ui.apiError(err); }
    }

    async function retryAllFailed() {
      try {
        const n = await SR.sync.retryFailed();
        ui.ok(`${n && n.retried != null ? n.retried : (state.queue ? state.queue.failed : 0)} item(s) queued for another try.`);
        await SR.sync.runOnce({ silent: true });
        load();
      } catch (err) { ui.apiError(err); }
    }

    async function discardItem(item) {
      const confirmed = await ui.confirmDialog({
        title: 'Discard this queued item',
        message: `Throw away ${item.label || U.humanise(item.type)}?`,
        confirmLabel: 'Discard it',
        danger: true,
        detail: 'Discarding removes it from this device only. If the server already accepted it, the record is safe there and this does nothing; if it never reached the server, the record is gone for good.',
      });
      if (!confirmed) return;
      try {
        await SR.sync.discard(item.client_id);
        ui.warn('Discarded from this device.');
        load();
      } catch (err) { ui.apiError(err); }
    }

    // ---------------------------------------------------------- conflicts
    async function renderConflicts() {
      let data;
      try {
        data = await SR.api.get('/api/sync/conflicts', { query: SR.state.query({ include_resolved: '1', limit: 100 }) });
      } catch (err) {
        host.replaceChildren(err.isOffline
          ? ui.h('div', { class: 'alert alert-warn' }, 'Offline — conflicts are held on the server. Try again once you are connected.')
          : ui.errorBlock(err, { retry: { label: 'Try again', run: load } }));
        return;
      }
      const rows = data.data || data.records || [];
      const open = rows.filter((c) => !c.reviewed_at);
      const resolved = rows.filter((c) => c.reviewed_at);

      const stack = ui.h('div', { class: 'stack' });
      stack.appendChild(ui.h('div', { class: 'alert alert-info' },
        'A conflict is two devices editing the same row before either had seen the other. The server keeps the LATER change and stores the earlier one here rather than silently overwriting it — so nothing is lost, and a human decides what was meant.'));
      stack.appendChild(ui.dataCard({
        title: `${open.length} unresolved`,
        table: ui.renderTable({
          columns: [
            { key: 'table_name', label: 'Record', render: (c) => ui.h('div', {}, ui.h('div', {}, U.humanise(c.table_name || c.entity_type || '—')), ui.h('div', { class: 'hint' }, String(c.row_id || c.entity_id || '').slice(0, 12))) },
            { key: 'detected_at', label: 'Detected', render: (c) => U.dateTime(c.detected_at) },
            { key: 'branch_name', label: 'Branch', render: (c) => c.branch_name || '—' },
            { key: 'summary', label: 'What differed', render: (c) => conflictSummary(c) },
            { key: 'resolution', label: 'State', render: (c) => (c.reviewed_at ? ui.badge('resolved', 'badge-good') : ui.badge('needs a look', 'badge-warn')) },
          ],
          rows: open,
          onRowClick: (c) => resolveConflict(c),
          emptyTitle: 'No unresolved conflicts',
          emptyMessage: 'Two devices disagreeing about the same record is rare, and it is recorded here when it happens rather than being silently overwritten.',
        }),
      }));
      if (resolved.length) {
        stack.appendChild(ui.dataCard({
          title: 'Already resolved',
          table: ui.renderTable({
            columns: [
              { key: 'table_name', label: 'Record', render: (c) => U.humanise(c.table_name || c.entity_type || '—') },
              { key: 'detected_at', label: 'Detected', render: (c) => U.date(U.dateTime(c.detected_at)) },
              { key: 'reviewer_name', label: 'Decided by', render: (c) => c.reviewer_name || '—' },
              { key: 'note', label: 'Decision', render: (c) => c.note || '—' },
            ],
            rows: resolved,
            emptyTitle: '', emptyMessage: '',
          }),
        }));
      }
      host.replaceChildren(stack);
    }

    function conflictSummary(c) {
      const losing = c.losing || {};
      const winning = c.winning || {};
      const keys = U.uniq([...Object.keys(losing), ...Object.keys(winning)])
        .filter((k) => !['id', 'updated_at', 'created_at', 'is_deleted'].includes(k)
          && String(losing[k]) !== String(winning[k]));
      if (!keys.length) return '—';
      return ui.h('div', {}, ui.h('div', {}, keys.slice(0, 3).map((k) => U.humanise(k)).join(', ')),
        ui.h('div', { class: 'hint' }, `${keys.length} field(s) differ`));
    }

    function resolveConflict(c) {
      const losing = c.losing || {};
      const winning = c.winning || {};
      const keys = U.uniq([...Object.keys(losing), ...Object.keys(winning)])
        .filter((k) => !['updated_at', 'created_at', 'is_deleted'].includes(k));

      const body = ui.h('div', { class: 'stack' });
      body.appendChild(ui.kv([
        ['Record', U.humanise(c.table_name || c.entity_type || '—')],
        ['Detected', U.dateTime(c.detected_at)],
        ['Branch', c.branch_name || '—'],
      ]));
      body.appendChild(ui.h('p', { class: 'sub' }, 'The server kept the winning value. Every field that differed is listed — pick the version you want for each, and the decision is recorded against your name.'));

      const choices = [];
      const table = ui.h('div', { class: 'table-wrap' });
      const tbl = ui.h('table', { class: 'data' });
      tbl.appendChild(ui.h('thead', {}, ui.h('tr', {},
        ui.h('th', {}, 'Field'), ui.h('th', {}, 'Kept (winning)'), ui.h('th', {}, 'Replaced (losing)'), ui.h('th', {}, 'Use'))));
      const tbody = ui.h('tbody');
      for (const key of keys) {
        const sel = ui.h('select', { style: { minHeight: '30px' } });
        sel.appendChild(ui.h('option', { value: 'winning' }, 'Keep the server value'));
        sel.appendChild(ui.h('option', { value: 'losing' }, 'Restore the other value'));
        choices.push({ key, sel });
        tbody.appendChild(ui.h('tr', {},
          ui.h('td', {}, U.humanise(key)),
          ui.h('td', {}, String(winning[key] === undefined || winning[key] === null ? '—' : winning[key])),
          ui.h('td', {}, String(losing[key] === undefined || losing[key] === null ? '—' : losing[key])),
          ui.h('td', {}, sel)));
      }
      tbl.appendChild(tbody);
      table.appendChild(tbl);
      body.appendChild(table);

      const note = ui.h('textarea', { rows: 2, placeholder: 'What was decided, and why' });
      body.appendChild(ui.h('div', {}, ui.h('label', { class: 'ctl' }, 'Note'), note));

      const close = ui.h('button', { class: 'btn', onClick: () => m.close() }, 'Close');
      const mark = ui.h('button', { class: 'btn' }, 'Mark as reviewed, keep the server value');
      const apply = ui.h('button', { class: 'btn btn-primary' }, 'Apply my choices');
      const m = ui.openModal({ title: 'Resolve a conflict', body, footer: [close, mark, apply], size: 'wide' });

      // The server accepts three decisions and a written resolution, and stores
      // both against the reviewer's name. It deliberately does NOT patch the row
      // from here: letting a conflict screen write arbitrary columns into any
      // table would be a hole in every scope rule in the app. So the decision is
      // recorded as a statement of what was chosen, and the value that was NOT
      // kept stays in this record as the evidence for it.
      mark.addEventListener('click', async () => {
        await ui.withBusy(body, async () => {
          try {
            await SR.api.post(`/api/sync/conflicts/${encodeURIComponent(c.id)}/resolve`, {
              decision: 'SERVER_KEPT',
              resolution: note.value || 'Reviewed: the value the server kept is the correct one.',
            });
            m.close();
            ui.ok('Conflict closed with the server\'s value.');
            load();
          } catch (err) { ui.apiError(err); }
        });
      });

      apply.addEventListener('click', async () => {
        const restored = [];
        for (const { key, sel } of choices) {
          if (sel.value === 'losing') restored.push(key);
        }
        if (!restored.length) { ui.info('Every field is set to keep the server value — nothing to restore. Use “Mark as reviewed” instead.'); return; }
        const summary = `Merged by hand. Re-take from the device\'s version: ${restored.map((k) => U.humanise(k)).join(', ')}.${note.value ? ` ${note.value}` : ''}`;
        await ui.withBusy(body, async () => {
          try {
            await SR.api.post(`/api/sync/conflicts/${encodeURIComponent(c.id)}/resolve`, { decision: 'MERGED', resolution: summary.slice(0, 500) });
            m.close();
            ui.ok('Recorded as merged. Re-enter the fields you chose on the record itself, then sync — the device will refetch the row either way.');
            load();
          } catch (err) { ui.apiError(err); }
        });
      });
    }

    // ------------------------------------------------------------ devices
    async function renderDevices() {
      let data;
      try {
        data = await SR.api.get('/api/sync/status', { query: SR.state.query({}) });
      } catch (err) {
        host.replaceChildren(err.isOffline
          ? ui.h('div', { class: 'alert alert-warn' }, 'Offline — the device list comes from the server.')
          : ui.errorBlock(err, { retry: { label: 'Try again', run: load } }));
        return;
      }
      state.remote = data;
      const s = data.summary || {};
      host.replaceChildren(ui.h('div', { class: 'stack' },
        ui.h('div', { class: 'kpis' },
          ui.kpi({ label: 'Devices', value: U.qty(s.devices || 0) }),
          ui.kpi({ label: 'Not seen for a day', value: U.qty(s.stale || 0), tone: Number(s.stale) ? 'warn' : 'good', foot: 'a till that stopped reporting' }),
          ui.kpi({ label: 'Reporting an error', value: U.qty(s.withErrors || 0), tone: Number(s.withErrors) ? 'bad' : 'good' }),
          ui.kpi({ label: 'Items waiting across the group', value: U.qty(s.pendingPush || 0) }),
          ui.kpi({ label: 'Open conflicts', value: U.qty(data.openConflicts || 0), tone: Number(data.openConflicts) ? 'warn' : 'good' })),
        ui.dataCard({
          title: 'Devices that have synced',
          table: ui.renderTable({
            columns: [
              { key: 'device_id', label: 'Device' },
              { key: 'branch_name', label: 'Branch', render: (d) => d.branch_name || '—' },
              { key: 'app_version', label: 'Version', render: (d) => d.app_version || '—' },
              { key: 'last_heartbeat_at', label: 'Last seen', render: (d) => (d.last_heartbeat_at ? U.relTime(d.last_heartbeat_at) : 'never') },
              { key: 'pending_push_count', label: 'Waiting', align: 'right', render: (d) => U.qty(d.pending_push_count || 0) },
              { key: 'last_sync_error', label: 'Last error', render: (d) => (d.last_sync_error ? ui.badge(String(d.last_sync_error).slice(0, 40), 'badge-bad') : ui.badge('none', 'badge-good')) },
            ],
            rows: data.devices || [],
            emptyTitle: 'No device has reported yet',
            emptyMessage: 'Each till and phone appears here the first time it syncs, with what it is still holding.',
          }),
        }),
        ui.dataCard({
          title: 'Recent changes seen by the server',
          table: ui.renderTable({
            columns: [
              { key: 'table_name', label: 'Record', render: (c) => U.humanise(c.table_name || '—') },
              { key: 'row_id', label: 'Row', render: (c) => String(c.row_id || '').slice(0, 12) },
              { key: 'operation', label: 'Operation', render: (c) => ui.badge(U.humanise(c.operation || '—'), 'badge-mute') },
              { key: 'branch_name', label: 'Branch', render: (c) => c.branch_name || '—' },
              { key: 'synced_at', label: 'When', render: (c) => U.relTime(c.synced_at) },
            ],
            rows: data.recentChanges || [],
            emptyTitle: 'Nothing recent',
            emptyMessage: 'Changes appear here as devices upload them.',
          }),
        })));
    }

    // ------------------------------------------------------------ storage
    async function renderStorage() {
      const [tables, outboxCount, meta, log, est] = await Promise.all([
        SR.store.tableStats(),
        SR.store.outboxCount(),
        SR.store.metaAll(),
        SR.store.logAll({ limit: 40 }),
        SR.store.estimate(),
      ]);
      const device = SR.device.current() || {};
      const quotaMb = est.quota ? Math.round(est.quota / 1048576) : 0;
      const usedMb = est.usage ? Math.round((est.usage / 1048576) * 10) / 10 : 0;

      const stack = ui.h('div', { class: 'stack' });
      stack.appendChild(ui.h('div', { class: 'card' }, ui.h('div', { class: 'card-body' },
        ui.h('h2', {}, 'This device'),
        ui.kv([
          ['Device id', device.id],
          ['Installed as', device.label || 'browser'],
          ['Records held locally', U.qty(tables.total)],
          ['Newest local record', tables.latestUpdatedAt ? U.dateTime(tables.latestUpdatedAt) : '—'],
          ['Waiting to upload', U.qty(outboxCount)],
          ['Storage used', quotaMb ? `${usedMb} MB of about ${quotaMb} MB` : 'unknown'],
        ]),
        ui.h('p', { class: 'sub' }, 'StockRidge keeps a copy of the tables it needs on this device so the till keeps working when the line drops. The server is still the system of record: this copy exists to survive the outage, not to replace it.'))));

      stack.appendChild(ui.h('div', { class: 'card' }, ui.h('div', { class: 'card-body' },
        ui.h('h2', {}, 'What is stored here'),
        ui.bars((tables.tables || []).map((t) => ({ label: U.humanise(t.table), value: t.count })), { format: (v) => U.qty(v) }))));

      stack.appendChild(ui.h('div', { class: 'card' }, ui.h('div', { class: 'card-body' },
        ui.h('h2', {}, 'Housekeeping'),
        ui.h('p', { class: 'sub' }, 'Uploaded items are kept on the device for 48 hours, so a mistake can be seen and explained, and then removed to keep the device light.'),
        ui.h('div', { class: 'row' },
          ui.h('button', { class: 'btn btn-sm', onClick: () => purge() }, 'Clear uploaded items now'),
          ui.h('button', { class: 'btn btn-sm', onClick: () => requestPersist() }, 'Ask the browser to keep this data'),
          ui.h('button', { class: 'btn btn-sm', onClick: () => clearLog() }, 'Clear the activity log'),
          ui.h('button', { class: 'btn btn-sm', onClick: () => restoreDevice() }, 'Restore from a backup')))));

      if ((log || []).length) {
        stack.appendChild(ui.dataCard({
          title: 'Activity on this device',
          table: ui.renderTable({
            columns: [
              { key: 'at', label: 'When', render: (l) => U.dateTime(l.at) },
              { key: 'kind', label: 'What', render: (l) => ui.badge(U.humanise(l.kind || l.event || 'event'), 'badge-mute') },
              { key: 'message', label: 'Detail', render: (l) => l.message || l.detail || '—' },
            ],
            rows: log,
            emptyTitle: 'Nothing logged yet',
            emptyMessage: 'Sync attempts and refusals are logged here so a device can be diagnosed without a developer.',
          }),
        }));
      }

      stack.appendChild(ui.dataCard({
        title: 'Settings held on this device',
        table: ui.renderTable({
          columns: [
            { key: 'key', label: 'Key' },
            { key: 'value', label: 'Value', render: (m) => String(typeof m.value === 'object' ? JSON.stringify(m.value) : m.value).slice(0, 120) },
          ],
          rows: (meta || []).map((m) => ({ key: m.key, value: m.value, updated_at: m.updated_at })),
          emptyTitle: 'Nothing cached',
          emptyMessage: 'The app caches the settings and catalogue it needs to open without a connection.',
        }),
      }));

      host.replaceChildren(stack);
    }

    async function purge() {
      try {
        const n = await SR.store.purgeSynced({ olderThanHours: 48 });
        ui.ok(`${n && n.removed != null ? n.removed : 0} uploaded item(s) cleared.`);
        load();
      } catch (err) { ui.apiError(err); }
    }

    async function clearLog() {
      try { await SR.store.logClear(); ui.ok('Activity log cleared.'); load(); } catch (err) { ui.apiError(err); }
    }

    async function requestPersist() {
      try {
        const granted = await SR.store.requestPersistence();
        if (granted) ui.ok('The browser will keep this data rather than clearing it when space runs short.');
        else ui.warn('The browser declined. Data can still be cleared if the device runs out of space — a nightly backup is the real protection.');
      } catch (err) { ui.apiError(err); }
    }

    // -------------------------------------------------------- backup/restore
    async function backupDevice() {
      try {
        const backup = await SR.store.exportAll();
        const name = `stockridge-device-${(SR.device.current() || {}).id || 'device'}-${U.todayWat()}.json`;
        U.download(name, JSON.stringify(backup, null, 2), 'application/json');
        ui.ok('Backup downloaded.');
      } catch (err) { ui.apiError(err); }
    }

    function restoreDevice() {
      const input = ui.h('input', { type: 'file', accept: '.json,application/json' });
      const form = ui.h('div', {});
      form.appendChild(ui.h('p', {}, 'Restoring adds everything in the file to this device. Nothing already here is removed unless you choose to replace.'));
      form.appendChild(input);
      const replace = ui.field({ label: 'Replace what is on this device instead of merging', name: 'replace', type: 'checkbox', value: 0, span: true });
      form.appendChild(replace);

      const cancel = ui.h('button', { class: 'btn', onClick: () => m.close() }, 'Cancel');
      const go = ui.h('button', { class: 'btn btn-primary' }, 'Restore');
      const m = ui.openModal({ title: 'Restore from a backup', body: form, footer: [cancel, go], size: 'narrow' });

      go.addEventListener('click', async () => {
        const file = input.files && input.files[0];
        if (!file) { ui.warn('Choose the backup file first.'); return; }
        await ui.withBusy(form, async () => {
          try {
            const text = await file.text();
            const parsed = JSON.parse(text);
            const result = await SR.store.importAll(parsed, { replace: Number(replace.querySelector('input').checked) > 0 });
            m.close();
            ui.ok(`Restored ${result.rows} record(s) and ${result.outbox} queued item(s).`);
            load();
          } catch (err) { ui.apiError(err); }
        });
      });
    }

    async function runNow() {
      try {
        ui.info('Syncing…');
        const result = await SR.sync.runOnce({});
        if (result && result.offline) ui.warn('Still offline — nothing was sent. The queue keeps its place and will go the moment the line returns.');
        else ui.ok('Sync finished.');
        load();
      } catch (err) { ui.apiError(err); }
    }

    await load();
    return wrap;
  }

  SR.views = SR.views || {};
  SR.views.sync = { render };
}(window));
