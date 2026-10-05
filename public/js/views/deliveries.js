'use strict';
// =====================================================================
// public/js/views/deliveries.js — GETTING IT TO THE CUSTOMER, AND FITTING IT
// =====================================================================
// A fridge is not a bag of rice. It leaves the shop on a truck, with a mattress
// strapped to the roof, a driver who has the customer's number, and — often — a
// technician who has to come back and fit it because the wall bracket was not
// bought yet.
//
// Two kinds of job, one board:
//
//   DELIVERY      where the goods are. PENDING → SCHEDULED → PICKED → IN_TRANSIT
//                 → DELIVERED, with FAILED and RETURNED for the days that go
//                 wrong. A failed drop REQUIRES a note, because a failed drop
//                 with no reason cannot be chased up or charged back to the
//                 transporter.
//   INSTALLATION  the technician's work, often on a second visit. Finishing it
//                 can START THE WARRANTY — which is the right trigger for a
//                 split air conditioner whose cover should begin when the unit
//                 is actually commissioned, not when the box left the shelf.
//
// The status moves forward only. A manager can walk one back; nobody else can,
// because un-recording a failed delivery is how a failed delivery disappears.
// =====================================================================
(function (global) {
  const SR = global.SR;
  const ui = SR.ui;
  const U = SR.util;

  const DELIVERY_STATUSES = ['PENDING', 'SCHEDULED', 'PICKED', 'IN_TRANSIT', 'DELIVERED', 'FAILED', 'RETURNED', 'CANCELLED'];
  const BOARD = ['PENDING', 'SCHEDULED', 'PICKED', 'IN_TRANSIT'];

  async function render(ctx) {
    if (ctx.params.id) return renderJob(ctx);
    ctx.setTitle('Deliveries');
    const state = { status: ctx.query.status || '', page: 0, pageSize: 50 };

    const wrap = ui.h('div', { class: 'stack' });
    wrap.appendChild(ui.h('div', { class: 'page-head' },
      ui.h('div', {},
        ui.h('h1', {}, 'Deliveries & installation'),
        ui.h('p', { class: 'sub' }, `${SR.state.activeBranchName()} · what is going out, who is carrying it, and what still needs fitting`)),
      ui.h('div', { class: 'actions' },
        ui.h('button', { class: 'btn btn-sm', onClick: () => load() }, 'Refresh'),
        ui.h('button', { class: 'btn btn-sm', onClick: () => exportList() }, 'Export'))));

    const tabs = ui.h('div', { class: 'tabs' });
    const TABS = [['', 'Out for delivery'], ['DELIVERED', 'Delivered'], ['FAILED', 'Failed'], ['RETURNED', 'Returned'], ['CANCELLED', 'Cancelled']];
    for (const [key, label] of TABS) {
      tabs.appendChild(ui.h('button', {
        class: `tab ${state.status === key ? 'is-active' : ''}`,
        onClick: () => {
          state.status = key; state.page = 0;
          for (const b of tabs.children) b.classList.toggle('is-active', b.textContent === label);
          load();
        },
      }, label));
    }
    wrap.appendChild(tabs);
    const summaryHost = ui.h('div', {});
    wrap.appendChild(summaryHost);
    const host = ui.h('div', {});
    wrap.appendChild(host);

    async function exportList() {
      try {
        await SR.exporter.list({
          filename: 'deliveries',
          path: '/api/deliveries',
          query: SR.state.query({ status: state.status || undefined }),
          mirrorTable: 'delivery_jobs',
          columns: [
            { key: 'job_no', label: 'Job' }, { key: 'receipt_no', label: 'Receipt' },
            { key: 'customer_name', label: 'Customer' }, { key: 'customer_phone', label: 'Phone' },
            { key: 'address', label: 'Address' }, { key: 'status', label: 'Status' },
            { key: 'driver_name', label: 'Driver' }, { key: 'delivery_fee', label: 'Fee' },
            { key: 'scheduled_for', label: 'Scheduled' }, { key: 'delivered_at', label: 'Delivered' },
          ],
        });
      } catch (err) { ui.apiError(err); }
    }

    async function load() {
      host.replaceChildren(ui.skeleton(6));
      summaryHost.replaceChildren();
      let data; let offline = false;
      try {
        data = await SR.api.get('/api/deliveries', { query: SR.state.query({ status: state.status || undefined, limit: state.pageSize, offset: state.page * state.pageSize }) });
      } catch (err) {
        if (!err.isOffline) { host.replaceChildren(ui.errorBlock(err, { retry: { label: 'Try again', run: load } })); return; }
        offline = true;
        let rows = await SR.store.all('delivery_jobs', { where: (d) => !Number(d.is_deleted) });
        if (state.status) rows = rows.filter((d) => String(d.status).toUpperCase() === state.status);
        else rows = rows.filter((d) => BOARD.includes(String(d.status).toUpperCase()));
        data = { data: rows, paging: { total: rows.length, limit: rows.length, offset: 0 } };
      }
      const rows = data.data || [];
      const paging = data.paging || {};
      const byStatus = U.groupBy(rows, (r) => String(r.status).toUpperCase());

      const today = U.todayWat();
      const dueToday = rows.filter((r) => r.scheduled_for && String(r.scheduled_for).slice(0, 10) === today);
      const late = rows.filter((r) => r.scheduled_for && String(r.scheduled_for).slice(0, 10) < today && BOARD.includes(String(r.status).toUpperCase()));
      const unassigned = rows.filter((r) => BOARD.includes(String(r.status).toUpperCase()) && !r.driver_name);

      summaryHost.appendChild(ui.h('div', { class: 'grid grid-4' },
        ui.kpi({ label: 'On the board', value: String(rows.filter((r) => BOARD.includes(String(r.status).toUpperCase())).length), foot: 'not yet delivered', small: true }),
        ui.kpi({ label: 'Scheduled today', value: String(dueToday.length), tone: dueToday.length ? 'warn' : null, small: true }),
        ui.kpi({ label: 'Past their date', value: String(late.length), tone: late.length ? 'bad' : 'good', foot: late.length ? 'call the customer before they call you' : 'nothing overdue', small: true }),
        ui.kpi({ label: 'No driver yet', value: String(unassigned.length), tone: unassigned.length ? 'warn' : 'good', small: true })));

      if (BOARD.some((s) => byStatus.has(s))) {
        const strip = ui.h('div', { class: 'grid grid-4' });
        for (const s of BOARD) {
          const list = byStatus.get(s) || [];
          strip.appendChild(ui.kpi({ label: U.humanise(s), value: String(list.length), foot: list.length ? U.money(U.sum(list, (r) => r.delivery_fee)) + ' in fees' : null, small: true }));
        }
        summaryHost.appendChild(strip);
      }

      host.replaceChildren();
      if (offline) host.appendChild(ui.h('div', { class: 'alert alert-warn' }, 'Offline — from this device\'s last sync. Updating a job\'s status needs a connection: it is the record of what the driver actually did.'));

      host.appendChild(ui.dataCard({
        title: state.status ? `${U.humanise(state.status)} jobs` : 'Out for delivery',
        table: ui.renderTable({
          columns: [
            { key: 'job_no', label: 'Job', render: (d) => ui.h('span', { class: 'mono' }, d.job_no || String(d.id).slice(0, 8)) },
            { key: 'customer_name', label: 'Customer', className: 'wrap', render: (d) => {
              const cell = ui.h('div', {});
              cell.appendChild(ui.h('div', { style: { fontWeight: '600' } }, d.customer_name || 'Walk-in'));
              cell.appendChild(ui.h('div', { class: 'hint' }, [d.customer_phone, d.receipt_no].filter(Boolean).join(' · ')));
              return cell;
            } },
            { key: 'address', label: 'Going to', className: 'wrap', render: (d) => {
              const cell = ui.h('div', {});
              cell.appendChild(ui.h('div', {}, d.delivery_address || d.address || '—'));
              if (d.landmark) cell.appendChild(ui.h('div', { class: 'hint' }, `near ${d.landmark}`));
              return cell;
            } },
            { key: 'item_count', label: 'Items', align: 'right' },
            { key: 'scheduled_for', label: 'Scheduled', render: (d) => {
              if (!d.scheduled_for) return ui.badge('not scheduled', 'badge-warn');
              const day = String(d.scheduled_for).slice(0, 10);
              if (day === today) return ui.badge('today', 'badge-warn');
              if (day < today && BOARD.includes(String(d.status).toUpperCase())) return ui.badge(U.date(day) + ' · late', 'badge-bad');
              return U.date(day);
            } },
            { key: 'driver_name', label: 'Driver', render: (d) => (d.driver_name ? ui.h('div', {}, ui.h('div', {}, d.driver_name), ui.h('div', { class: 'hint' }, d.driver_phone || '')) : ui.badge('unassigned', 'badge-mute')) },
            { key: 'delivery_fee', label: 'Fee', align: 'right', render: (d) => (Number(d.delivery_fee) ? U.money(d.delivery_fee) : '—') },
            { key: 'status', label: '', render: (d) => ui.statusBadge(d.status) },
            { key: 'x', label: '', render: (d) => ui.h('button', { class: 'btn btn-sm btn-primary', onClick: (ev) => { ev.stopPropagation(); SR.app.navigate(`/deliveries/${d.id}`); } }, 'Open') },
          ],
          rows,
          onRowClick: (d) => SR.app.navigate(`/deliveries/${d.id}`),
          emptyTitle: state.status ? `No ${U.humanise(state.status).toLowerCase()} deliveries` : 'Nothing is waiting to go out',
          emptyMessage: state.status
            ? 'Try the Out for delivery tab. Older jobs are kept for the record but do not clutter the board.'
            : 'A delivery job is created automatically when a sale is marked as needing delivery, or from the POS order screen.',
        }),
        pager: ui.pager({
          page: state.page, pageSize: paging.limit || state.pageSize, total: paging.total != null ? paging.total : rows.length,
          onPage: (p) => { state.page = p; load(); },
          onSize: (n) => { state.pageSize = n; state.page = 0; load(); },
        }),
      }));
    }

    await load();
    return wrap;
  }

  // -------------------------------------------------------------------
  // ONE JOB
  // -------------------------------------------------------------------
  async function renderJob(ctx) {
    ctx.setTitle('Delivery');
    const wrap = ui.h('div', { class: 'stack' });
    const host = ui.h('div', { class: 'stack' });
    wrap.appendChild(host);
    await load();

    async function load() {
      host.replaceChildren(ui.skeleton(7));
      let data;
      try {
        data = await SR.api.get(`/api/deliveries/${encodeURIComponent(ctx.params.id)}`);
      } catch (err) {
        if (!err.isOffline) { host.replaceChildren(ui.errorBlock(err, { retry: { label: 'Try again', run: load } })); return; }
        const job = await SR.store.get('delivery_jobs', ctx.params.id);
        if (!job) { host.replaceChildren(ui.empty({ title: 'Not on this device', message: 'Job details live on the server, including the items and any installation work.' })); return; }
        data = { job, items: [], installations: [] };
      }
      const job = data.job;
      const items = data.items || [];
      const installations = data.installations || [];
      const currentIndex = DELIVERY_STATUSES.indexOf(String(job.status).toUpperCase());
      const nextStatus = BOARD.includes(String(job.status).toUpperCase())
        ? DELIVERY_STATUSES[Math.min(currentIndex + 1, 4)]
        : null;

      host.appendChild(ui.h('div', { class: 'page-head' },
        ui.h('div', {},
          ui.h('h1', {}, job.job_no || 'Delivery job'),
          ui.h('p', { class: 'sub' }, [job.customer_name, job.customer_phone, job.receipt_no, job.branch_name].filter(Boolean).join(' · '))),
        ui.h('div', { class: 'actions' },
          ui.h('button', { class: 'btn btn-sm', onClick: () => SR.app.navigate('/deliveries') }, 'Back'),
          job.sale_id ? ui.h('button', { class: 'btn btn-sm', onClick: () => SR.app.navigate(`/sales/${job.sale_id}`) }, 'The sale') : null,
          nextStatus ? ui.h('button', { class: 'btn btn-sm btn-primary', onClick: () => move(job, nextStatus, load) }, `Mark ${U.humanise(nextStatus).toLowerCase()}`) : null,
          ui.h('button', { class: 'btn btn-sm', onClick: () => move(job, null, load) }, 'Change status'),
          SR.state.atLeast('MANAGER') ? ui.h('button', { class: 'btn btn-sm', onClick: () => addInstallation(job, items, load) }, 'Add installation') : null)));

      host.appendChild(ui.h('div', { class: 'grid grid-4' },
        ui.kpi({ label: 'Status', value: U.humanise(job.status), tone: job.status === 'DELIVERED' ? 'good' : (['FAILED', 'RETURNED', 'CANCELLED'].includes(job.status) ? 'bad' : 'warn'), small: true }),
        ui.kpi({ label: 'Scheduled', value: job.scheduled_for ? U.date(job.scheduled_for) : 'not set', small: true }),
        ui.kpi({ label: 'Driver', value: job.driver_name || 'unassigned', foot: job.driver_phone || null, small: true }),
        ui.kpi({ label: 'Delivery fee', value: Number(job.delivery_fee) ? U.money(job.delivery_fee) : 'no charge', small: true })));

      const cols = ui.h('div', { class: 'grid grid-2' });
      cols.appendChild(ui.dataCard({
        title: 'Where it is going',
        table: ui.kv([
          ['Customer', job.customer_name], ['Phone', job.customer_phone],
          ['Address', job.delivery_address || job.address], ['Landmark', job.landmark],
          ['City', job.city], ['State', job.state],
          ['Scheduled for', job.scheduled_for ? U.dateTime(job.scheduled_for) : null],
          ['Delivered at', job.delivered_at ? U.dateTime(job.delivered_at) : null],
          ['Received by', job.delivered_to],
          ['Proof', job.proof_of_delivery],
          ['Notes', job.notes],
        ]),
      }));
      cols.appendChild(ui.dataCard({
        title: 'Contact and carrier',
        table: ui.kv([
          ['Driver', job.driver_name],
          ['Driver phone', job.driver_phone],
          ['Vehicle', job.vehicle_no],
          ['Transporter', job.transporter_name],
          ['Transport cost', Number(job.transport_cost) ? U.money(job.transport_cost) : null],
          ['Fee charged', Number(job.delivery_fee) ? U.money(job.delivery_fee) : null],
          ['Fee collected', job.fee_collected != null ? (Number(job.fee_collected) ? 'yes' : 'no — still to collect') : null],
          ['Requires installation', Number(job.requires_installation) ? 'yes' : 'no'],
        ]),
      }));
      host.appendChild(cols);

      host.appendChild(ui.dataCard({
        title: 'What is on the truck',
        table: ui.renderTable({
          columns: [
            { key: 'product_name', label: 'Item', className: 'wrap', render: (i) => ui.h('div', {},
              ui.h('div', { style: { fontWeight: '600' } }, i.product_name),
              ui.h('div', { class: 'hint' }, [i.sku, i.variant_name, i.serial_no ? `serial ${i.serial_no}` : null].filter(Boolean).join(' · '))) },
            { key: 'quantity', label: 'Quantity', align: 'right', render: (i) => U.qty(i.quantity) },
            { key: 'quantity_in_base', label: 'Base units', align: 'right', render: (i) => U.qty(i.quantity_in_base) },
            { key: 'checked', label: 'Loaded', render: (i) => (i.loaded_at ? ui.badge('loaded', 'badge-good') : ui.badge('not loaded', 'badge-mute')) },
          ],
          rows: items,
          emptyMessage: 'No items recorded on this job.',
        }),
      }));

      host.appendChild(ui.dataCard({
        title: 'Installation',
        actions: SR.state.atLeast('MANAGER') ? [ui.h('button', { class: 'btn btn-sm', onClick: () => addInstallation(job, items, load) }, 'Add a job')] : [],
        table: ui.renderTable({
          columns: [
            { key: 'product_name', label: 'Item', className: 'wrap' },
            { key: 'technician_name', label: 'Technician', render: (i) => i.technician_name || ui.badge('unassigned', 'badge-mute') },
            { key: 'scheduled_for', label: 'Scheduled', render: (i) => (i.scheduled_for ? U.dateTime(i.scheduled_for) : '—') },
            { key: 'fee', label: 'Fee', align: 'right', render: (i) => U.money(i.fee) },
            { key: 'status', label: '', render: (i) => ui.statusBadge(i.status) },
            { key: 'x', label: '', render: (i) => (i.status === 'COMPLETED' ? '—' : ui.h('button', { class: 'btn btn-sm btn-primary', onClick: () => completeInstallation(i, load) }, 'Complete')) },
          ],
          rows: installations,
          emptyTitle: 'No installation work',
          emptyMessage: 'A split air conditioner, a wall bracket, a bed frame — anything that needs fitting gets a job here. Completing it is what starts the warranty.',
        }),
      }));

      if (String(job.notes || '').includes('|')) {
        const history = String(job.notes).split('\n').filter((l) => l.includes('|'));
        if (history.length) {
          host.appendChild(ui.dataCard({
            title: 'What happened',
            table: ui.renderTable({
              columns: [{ key: 'line', label: 'Entry', className: 'wrap' }],
              rows: history.map((line) => ({ line })),
            }),
          }));
        }
      }
    }

    function move(job, preset, after) {
      const wrapEl = ui.h('div', {});
      wrapEl.appendChild(ui.h('p', { class: 'hint' }, 'The board only moves forward. Walking a job backwards hides a failed drop unless a manager does it deliberately.'));
      wrapEl.appendChild(ui.h('div', { class: 'form-grid' },
        ui.field({ label: 'New status', name: 'status', value: preset || job.status, options: DELIVERY_STATUSES.map((s) => ({ value: s, label: U.humanise(s) })), required: true }),
        ui.field({ label: 'Driver', name: 'driver_name', value: job.driver_name || '', placeholder: 'Who is carrying it' }),
        ui.field({ label: 'Driver phone', name: 'driver_phone', value: job.driver_phone || '' }),
        ui.field({ label: 'Vehicle', name: 'vehicle_no', value: job.vehicle_no || '' }),
        ui.field({ label: 'Received by', name: 'delivered_to', placeholder: 'Name of the person who took delivery', hint: 'For a delivered job, this is the name a dispute is settled against.' }),
        ui.field({ label: 'Proof of delivery', name: 'proof_of_delivery', placeholder: 'Waybill number, or a note of the photo taken' }),
        ui.field({ label: 'Note', name: 'note', type: 'textarea', span: true, hint: 'Required for FAILED, RETURNED and CANCELLED. A failed drop with no reason cannot be chased up or charged back to the transporter.' })));
      const m = ui.openModal({
        title: 'Update this delivery',
        body: wrapEl,
        size: 'wide',
        footer: [
          ui.h('button', { class: 'btn', onClick: () => m.close() }, 'Cancel'),
          ui.h('button', {
            class: 'btn btn-primary',
            onClick: async (ev) => {
              const v = ui.readFormStrings(wrapEl);
              ev.currentTarget.disabled = true;
              try {
                const result = await SR.api.post(`/api/deliveries/${encodeURIComponent(job.id)}/status`, {
                  status: v.status,
                  driver_name: v.driver_name || null,
                  driver_phone: v.driver_phone || null,
                  vehicle_no: v.vehicle_no || null,
                  delivered_to: v.delivered_to || null,
                  proof_of_delivery: v.proof_of_delivery || null,
                  note: v.note || null,
                });
                ui.ok(result.message || `Marked ${U.humanise(v.status).toLowerCase()}.`);
                m.close();
                if (after) after();
              } catch (err) {
                ui.apiError(err);
                ev.currentTarget.disabled = false;
              }
            },
          }, 'Save'),
        ],
      });
    }

    function addInstallation(job, items, after) {
      const wrapEl = ui.h('div', {});
      wrapEl.appendChild(ui.h('p', { class: 'hint' }, 'Installation work is usually a second visit. Completing it can start the warranty, which is the right trigger for anything commissioned on site.'));
      const options = items.length
        ? items.map((i) => ({ value: String(i.product_id), label: `${i.product_name}${i.serial_no ? ` (${i.serial_no})` : ''}` }))
        : [{ value: '', label: 'No items on this job — add the product on the sale instead' }];
      wrapEl.appendChild(ui.h('div', { class: 'form-grid' },
        ui.field({ label: 'Product to install', name: 'product_id', options, required: true }),
        ui.field({ label: 'Technician', name: 'technician_name' }),
        ui.field({ label: 'Scheduled for', name: 'scheduled_for', type: 'datetime-local' }),
        ui.field({ label: 'Installation fee (₦)', name: 'fee', type: 'number', step: '0.01', min: '0', value: '0' }),
        ui.field({ label: 'Fee collected (₦)', name: 'fee_collected', type: 'number', step: '0.01', min: '0', value: '0', hint: 'Leave at zero if the fee is still to be collected on site.' }),
        ui.field({ label: 'Notes', name: 'notes', type: 'textarea', span: true })));
      wrapEl.appendChild(ui.h('label', { class: 'check' },
        ui.h('input', { type: 'checkbox', name: 'starts_warranty', checked: true }),
        ui.h('div', {}, ui.h('strong', {}, 'Warranty starts when this is completed'),
          ui.h('div', { class: 'hint' }, 'For an appliance that is commissioned on site, the cover should begin at commissioning, not at the till. Untick only if the manufacturer\'s terms say otherwise.'))));
      const m = ui.openModal({
        title: 'Add installation work',
        body: wrapEl,
        size: 'wide',
        footer: [
          ui.h('button', { class: 'btn', onClick: () => m.close() }, 'Cancel'),
          ui.h('button', {
            class: 'btn btn-primary',
            onClick: async (ev) => {
              const v = ui.readFormStrings(wrapEl);
              if (!v.product_id) { ui.warn('Pick which product is being installed.'); return; }
              ev.currentTarget.disabled = true;
              try {
                await SR.api.post(`/api/deliveries/${encodeURIComponent(job.id)}/installation`, {
                  product_id: v.product_id,
                  technician_name: v.technician_name || null,
                  scheduled_for: v.scheduled_for || null,
                  fee: Number(v.fee) || 0,
                  fee_collected: Number(v.fee_collected) || 0,
                  notes: v.notes || null,
                  starts_warranty: wrapEl.querySelector('[name="starts_warranty"]').checked,
                });
                ui.ok('Installation job created.');
                m.close();
                if (after) after();
              } catch (err) {
                ui.apiError(err);
                ev.currentTarget.disabled = false;
              }
            },
          }, 'Create the job'),
        ],
      });
    }

    function completeInstallation(installation, after) {
      const wrapEl = ui.h('div', {});
      wrapEl.appendChild(ui.h('p', { class: 'hint' }, `Completing ${U.humanise(String(installation.status).toLowerCase())} work on ${installation.product_name}.`));
      wrapEl.appendChild(ui.h('div', { class: 'form-grid' },
        ui.field({ label: 'Completed at', name: 'completed_at', type: 'datetime-local', value: U.nowIso().slice(0, 16) }),
        ui.field({ label: 'Technician', name: 'technician_name', value: installation.technician_name || '' }),
        ui.field({ label: 'Warranty months', name: 'warranty_months', type: 'number', step: '1', min: '0', value: installation.warranty_months != null ? String(installation.warranty_months) : '12', hint: 'How much cover this product carries. Starting it here is what makes a claim later provable.' }),
        ui.field({ label: 'Parts used, cost (₦)', name: 'parts_cost', type: 'number', step: '0.01', min: '0', value: U.numInput(installation.parts_cost) }),
        ui.field({ label: 'Fee collected (₦)', name: 'fee_collected', type: 'number', step: '0.01', min: '0', value: U.numInput(installation.fee_collected) }),
        ui.field({ label: 'Note', name: 'note', type: 'textarea', span: true, placeholder: 'e.g. fitted on the wall bracket supplied by the customer; gas topped up' })));
      wrapEl.appendChild(ui.h('label', { class: 'check' },
        ui.h('input', { type: 'checkbox', name: 'starts_warranty', checked: true }),
        ui.h('div', {}, ui.h('strong', {}, 'Start the warranty from today'))));
      const m = ui.openModal({
        title: 'Complete the installation',
        body: wrapEl,
        size: 'wide',
        footer: [
          ui.h('button', { class: 'btn', onClick: () => m.close() }, 'Cancel'),
          ui.h('button', {
            class: 'btn btn-primary',
            onClick: async (ev) => {
              const v = ui.readFormStrings(wrapEl);
              ev.currentTarget.disabled = true;
              try {
                const result = await SR.api.post(`/api/installations/${encodeURIComponent(installation.id)}/complete`, {
                  completed_at: v.completed_at ? new Date(v.completed_at).toISOString() : null,
                  technician_name: v.technician_name || null,
                  warranty_months: v.warranty_months == null ? null : Number(v.warranty_months),
                  parts_cost: Number(v.parts_cost) || 0,
                  fee_collected: Number(v.fee_collected) || 0,
                  note: v.note || null,
                  starts_warranty: wrapEl.querySelector('[name="starts_warranty"]').checked,
                });
                ui.ok(result.message || 'Installation completed.');
                m.close();
                if (after) after();
              } catch (err) {
                ui.apiError(err);
                ev.currentTarget.disabled = false;
              }
            },
          }, 'Complete'),
        ],
      });
    }

    return wrap;
  }

  SR.views = SR.views || {};
  SR.views.deliveries = { render, DELIVERY_STATUSES };
}(window));
