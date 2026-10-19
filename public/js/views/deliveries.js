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

  async function loadDispatch() {
    try {
      return await SR.api.get('/api/dispatch', { query: SR.state.query({}) });
    } catch (e) {
      return null;
    }
  }

  function vehicleChoices(setup) {
    const rows = ((setup && setup.vehicles) || []).filter((row) => Number(row.is_active) !== 0);
    const opts = [{ value: '', label: rows.length ? 'Choose a vehicle' : 'No vehicles on the fleet yet' }];
    for (const row of rows) {
      const how = row.arrangement === 'PARTNER' ? 'partner, paid on sales' : 'ours, driver on a wage';
      opts.push({ value: row.id, label: `${row.name} · ${U.humanise(String(row.vehicle_class || '').toLowerCase())} · ${how}` });
    }
    return opts;
  }

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
        SR.exporter.buttons((format) => exportList(format)))));

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
    const dispatchHost = ui.h('div', {});
    wrap.appendChild(dispatchHost);
    const plantHost = ui.h('div', {});
    wrap.appendChild(plantHost);
    const summaryHost = ui.h('div', {});
    wrap.appendChild(summaryHost);
    const host = ui.h('div', {});
    wrap.appendChild(host);

    async function exportList(format) {
      try {
        await SR.exporter.list({
          format,
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
          exportable: false,
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
            { key: 'supply_terms', label: 'This drop', render: (d) => {
              const due = d.balance_due != null ? Number(d.balance_due) : Number(d.sale_balance);
              const terms = d.supply_terms || (due > 0.009 ? 'CREDIT' : (d.sale_type === 'CREDIT' ? 'CREDIT' : (d.sale_total != null ? 'CASH' : '')));
              if (!terms) return '—';
              const goods = d.goods_value != null ? d.goods_value : null;
              const bits = [];
              const chosen = d.settlement || d.sale_settlement;
              if (chosen === 'CREDIT') bits.push('Invoice');
              else if (chosen === 'SPOT') bits.push('Receipt');
              bits.push(U.humanise(String(terms).toLowerCase()));
              if (goods != null) bits.push(U.money(goods));
              if (due > 0.009) bits.push(`${U.money(due)} still owed`);
              return bits.join(' · ');
            } },
            { key: 'item_count', label: 'Items', align: 'right' },
            { key: 'scheduled_for', label: 'Scheduled', render: (d) => {
              if (!d.scheduled_for) return ui.badge('not scheduled', 'badge-warn');
              const day = String(d.scheduled_for).slice(0, 10);
              if (day === today) return ui.badge('today', 'badge-warn');
              if (day < today && BOARD.includes(String(d.status).toUpperCase())) return ui.badge(U.date(day) + ' · late', 'badge-bad');
              return U.date(day);
            } },
            { key: 'driver_name', label: 'Driver', render: (d) => (d.driver_name ? ui.h('div', {}, ui.h('div', {}, d.driver_name), ui.h('div', { class: 'hint' }, [d.vehicle_class ? U.humanise(String(d.vehicle_class).toLowerCase()) : null, d.arrangement === 'PARTNER' ? 'partner' : (d.arrangement === 'OWNED' ? 'our vehicle' : null), d.driver_phone].filter(Boolean).join(' · '))) : ui.badge('unassigned', 'badge-mute')) },
            { key: 'delivery_fee', label: 'Fee', align: 'right', render: (d) => (Number(d.delivery_fee) ? U.money(d.delivery_fee) : '—') },
            { key: 'status', label: '', render: (d) => ui.statusBadge(d.status) },
            { key: 'x', label: '', render: (d) => ui.h('div', { class: 'btn-row' },
              SR.state.atLeast('MANAGER') && !['DELIVERED', 'CANCELLED', 'RETURNED'].includes(String(d.status).toUpperCase())
                ? ui.h('button', { class: 'btn btn-sm', onClick: (ev) => { ev.stopPropagation(); attachLoad(d, load); } }, 'Attach')
                : null,
              ui.h('button', { class: 'btn btn-sm btn-primary', onClick: (ev) => { ev.stopPropagation(); SR.app.navigate(`/deliveries/${d.id}`); } }, 'Open')) },
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

    function refreshFleet() {
      paintFleet(dispatchHost, loadDispatch(), refreshFleet);
    }
    function refreshPlant() {
      paintPlant(plantHost, refreshPlant);
    }
    await load();
    refreshFleet();
    refreshPlant();
    return wrap;
  }

  function paintFleet(host, setupPromise, after) {
    host.replaceChildren(ui.loading('Checking the dispatch mix…'));
    Promise.resolve(setupPromise).then((setup) => {
      if (!setup || !setup.enabled) { host.replaceChildren(); return; }
      const modes = setup.modes || [];
      const sentence = modes.map((mode) => {
        const name = U.humanise(String(mode.vehicleClass || '').toLowerCase());
        return mode.arrangement === 'PARTNER'
          ? `partner ${name} at ${mode.salesSharePct}% of the sales they deliver`
          : `owned ${name}, driver on a wage`;
      }).join('; ');
      const note = ui.h('p', { class: 'sub' }, setup.confirmed
        ? `This business releases goods on ${sentence || 'a confirmed mix'}. Those types are on the fleet below. A driver is Staff. The share is of the goods, not of the delivery fee.`
        : 'The mix is only a suggestion until an owner saves it. A drop cannot leave, and a partner cannot be paid, on a suggestion.');
      const bare = (setup.vehicles || []).some((row) => !row.plate_no);
      const confirm = SR.state.atLeast('OWNER') && !setup.confirmed && modes.length
        ? ui.h('button', {
          class: 'btn btn-sm btn-primary',
          onClick: async (ev) => {
            ev.currentTarget.disabled = true;
            try {
              const res = await SR.api.put('/api/dispatch', { modes }, { query: SR.state.query({}) });
              ui.ok(res.message || 'Dispatch mix saved.');
              if (after) after();
            } catch (err) { ui.apiError(err); ev.currentTarget.disabled = false; }
          },
        }, 'Confirm this mix')
        : null;
      const owner = SR.state.atLeast('OWNER');
      const add = setup.confirmed && SR.state.atLeast('MANAGER')
        ? ui.h('button', { class: 'btn btn-sm', onClick: () => addVehicle(setup, after) }, 'Add a vehicle')
        : null;
      const editMixBtn = owner
        ? ui.h('button', { class: 'btn btn-sm', onClick: () => editMix(setup, after) }, 'Edit the mix')
        : null;
      const fleetActions = ui.h('div', { class: 'actions' }, editMixBtn, add || confirm);
      const table = ui.renderTable({
        columns: [
          { key: 'name', label: 'Vehicle', render: (row) => ui.h('div', {},
            ui.h('div', {}, row.name),
            Number(row.is_active) === 0 ? ui.badge('off the fleet', 'badge-mute') : null,
            setup.confirmed && !vehicleInMix(setup, row) ? ui.badge('not in the mix', 'badge-warn') : null) },
          { key: 'vehicle_class', label: 'Type', render: (row) => U.humanise(String(row.vehicle_class || '').toLowerCase()) },
          { key: 'arrangement', label: 'Pay', render: (row) => (row.arrangement === 'PARTNER' ? `Partner · ${row.sales_share_pct}% of sales` : 'Ours · wage') },
          { key: 'plate_no', label: 'Plate', render: (row) => row.plate_no || '—' },
          { key: 'driver_name', label: 'Usual driver', render: (row) => [row.driver_name, row.driver_phone].filter(Boolean).join(' · ') || '—' },
          { key: 'edit', label: '', render: (row) => (owner ? ui.h('button', { class: 'btn btn-sm', onClick: () => editVehicle(row, setup, after) }, 'Edit') : null) },
        ],
        rows: setup.vehicles || [],
        emptyTitle: 'No vehicles yet',
        emptyMessage: setup.confirmed
          ? 'Add the pickup, the keke or the bike that actually leaves the gate. The type has to be one of the mix above.'
          : 'Confirm the mix, then add the vehicles.',
      });
      const card = ui.h('div', { class: 'card' },
        ui.h('div', { class: 'card-head' }, ui.h('h2', {}, 'Dispatch'), fleetActions),
        ui.h('div', { class: 'card-body' }, note,
          bare ? ui.h('p', { class: 'hint' }, 'A type saved when the business was created is already listed. Add a plate and a usual driver on it, or add a named vehicle of the same type. Neither replaces the mix.') : null,
          confirm && add ? confirm : null, table));
      host.replaceChildren(card);
    }).catch(() => host.replaceChildren());
  }

  function addVehicle(setup, after) {
    const modes = setup.modes || [];
    const wrapEl = ui.h('div', {});
    wrapEl.appendChild(ui.h('p', { class: 'hint' }, 'The type has to be one the owner confirmed. A partner’s share comes from that mix, not from this form.'));
    wrapEl.appendChild(ui.h('div', { class: 'form-grid' },
      ui.field({
        label: 'Which confirmed type',
        name: 'mode',
        required: true,
        options: modes.map((mode, i) => ({
          value: String(i),
          label: `${U.humanise(String(mode.vehicleClass).toLowerCase())} · ${mode.arrangement === 'PARTNER' ? 'partner' : 'ours'}`,
        })),
      }),
      ui.field({ label: 'Name', name: 'name', required: true, placeholder: 'Keke 2 — Musa' }),
      ui.field({ label: 'Plate', name: 'plate_no', placeholder: 'If it has one' }),
      ui.field({ label: 'Usual driver', name: 'driver_name', placeholder: 'The person who takes it out' }),
      ui.field({ label: 'Driver phone', name: 'driver_phone' })));
    const m = ui.openModal({
      title: 'Add a vehicle',
      body: wrapEl,
      footer: [
        ui.h('button', { class: 'btn', onClick: () => m.close() }, 'Cancel'),
        ui.h('button', {
          class: 'btn btn-primary',
          onClick: async (ev) => {
            const v = ui.readFormStrings(wrapEl);
            const mode = modes[Number(v.mode)] || modes[0];
            ev.currentTarget.disabled = true;
            try {
              const res = await SR.api.post('/api/dispatch/vehicles', {
                vehicle_class: mode.vehicleClass,
                arrangement: mode.arrangement,
                name: v.name,
                plate_no: v.plate_no,
                driver_name: v.driver_name,
                driver_phone: v.driver_phone,
              }, { query: SR.state.query({}) });
              ui.ok(res.message || 'Vehicle added.');
              m.close();
              if (after) after();
            } catch (err) { ui.apiError(err); ev.currentTarget.disabled = false; }
          },
        }, 'Add'),
      ],
    });
  }

  const DISPATCH_VEHICLES = [
    { value: 'BIKE', label: 'Motorcycle' },
    { value: 'TRICYCLE', label: 'Tricycle (keke)' },
    { value: 'CAR', label: 'Car' },
    { value: 'PICKUP', label: 'Pickup' },
    { value: 'VAN', label: 'Van' },
  ];
  const DISPATCH_HOW = [
    { value: 'OWNED', label: 'Ours — driver on a wage' },
    { value: 'PARTNER', label: 'Partner — paid on sales' },
  ];

  function vehicleInMix(setup, row) {
    return (setup.modes || []).some((mode) => mode.vehicleClass === row.vehicle_class && mode.arrangement === row.arrangement);
  }

  function modesFromForm(v) {
    const modes = [{
      vehicleClass: v.dispatch_class_1,
      arrangement: v.dispatch_arrangement_1,
      salesSharePct: v.dispatch_arrangement_1 === 'PARTNER' ? v.dispatch_share_1 : null,
    }];
    if (v.dispatch_class_2) {
      modes.push({
        vehicleClass: v.dispatch_class_2,
        arrangement: v.dispatch_arrangement_2,
        salesSharePct: v.dispatch_arrangement_2 === 'PARTNER' ? v.dispatch_share_2 : null,
      });
    }
    return modes;
  }

  function editMix(setup, after) {
    const modes = setup.modes || [];
    const first = modes[0] || { vehicleClass: 'PICKUP', arrangement: 'OWNED', salesSharePct: 8 };
    const second = modes[1] || null;
    const wrapEl = ui.h('div', {});
    wrapEl.appendChild(ui.h('p', { class: 'hint' }, 'One type, or two. Saving this replaces the mix. A vehicle already on the fleet stays. If its type is no longer in the mix, take it off or edit it onto a type that is. A drop already sent is not rewritten.'));
    wrapEl.appendChild(ui.h('div', { class: 'form-grid' },
      ui.field({ label: 'First vehicle', name: 'dispatch_class_1', value: first.vehicleClass, options: DISPATCH_VEHICLES }),
      ui.field({ label: 'Who owns it', name: 'dispatch_arrangement_1', value: first.arrangement, options: DISPATCH_HOW }),
      ui.field({ label: 'Partner share %', name: 'dispatch_share_1', type: 'number', min: '1', max: '40', step: '0.5', value: first.salesSharePct || 8 }),
      ui.field({ label: 'Second vehicle', name: 'dispatch_class_2', value: second ? second.vehicleClass : '', options: [{ value: '', label: 'None — one is enough' }, ...DISPATCH_VEHICLES] }),
      ui.field({ label: 'Who owns the second', name: 'dispatch_arrangement_2', value: second ? second.arrangement : 'PARTNER', options: DISPATCH_HOW }),
      ui.field({ label: 'Second share %', name: 'dispatch_share_2', type: 'number', min: '1', max: '40', step: '0.5', value: (second && second.salesSharePct) || 8 })));
    const m = ui.openModal({
      title: 'Edit the dispatch mix',
      body: wrapEl,
      footer: [
        ui.h('button', { class: 'btn', onClick: () => m.close() }, 'Cancel'),
        ui.h('button', {
          class: 'btn btn-primary',
          onClick: async (ev) => {
            const v = ui.readForm(wrapEl);
            if (!v.dispatch_class_1) { ui.warn('Choose the first vehicle.'); return; }
            ev.currentTarget.disabled = true;
            try {
              const res = await SR.api.put('/api/dispatch', { modes: modesFromForm(v) }, { query: SR.state.query({}) });
              ui.ok(res.message || 'Dispatch mix saved.');
              m.close();
              if (after) after();
            } catch (err) { ui.apiError(err); ev.currentTarget.disabled = false; }
          },
        }, 'Save the mix'),
      ],
    });
  }

  function editVehicle(row, setup, after) {
    const modes = setup.modes || [];
    const options = modes.map((mode, i) => ({
      value: String(i),
      label: `${U.humanise(String(mode.vehicleClass).toLowerCase())} · ${mode.arrangement === 'PARTNER' ? 'partner' : 'ours'}`,
    }));
    const current = modes.findIndex((mode) => mode.vehicleClass === row.vehicle_class && mode.arrangement === row.arrangement);
    const wrapEl = ui.h('div', {});
    wrapEl.appendChild(ui.h('p', { class: 'hint' }, 'Change the name, the plate, the usual driver, or the type. Taking it off the fleet does not delete a drop that already used it. A partner share here is the share on the mix, so every vehicle of that type uses it.'));
    wrapEl.appendChild(ui.h('div', { class: 'form-grid' },
      ui.field({ label: 'Name', name: 'name', required: true, value: row.name }),
      ui.field({ label: 'Plate', name: 'plate_no', value: row.plate_no || '' }),
      ui.field({ label: 'Usual driver', name: 'driver_name', value: row.driver_name || '' }),
      ui.field({ label: 'Driver phone', name: 'driver_phone', value: row.driver_phone || '' }),
      options.length ? ui.field({ label: 'Type in the mix', name: 'mode', value: current >= 0 ? String(current) : '0', options }) : null,
      ui.field({ label: 'On the fleet', name: 'is_active', type: 'checkbox', value: Number(row.is_active) === 0 ? 0 : 1, span: true, hint: 'Off: it cannot be chosen for a new load. It stays on the record.' })));
    const m = ui.openModal({
      title: `Edit ${row.name}`,
      body: wrapEl,
      footer: [
        ui.h('button', { class: 'btn', onClick: () => m.close() }, 'Cancel'),
        ui.h('button', {
          class: 'btn btn-primary',
          onClick: async (ev) => {
            const v = ui.readForm(wrapEl);
            if (!v.name || String(v.name).trim().length < 2) { ui.warn('Name the vehicle.'); return; }
            const mode = modes[Number(v.mode)] || { vehicleClass: row.vehicle_class, arrangement: row.arrangement, salesSharePct: row.sales_share_pct };
            ev.currentTarget.disabled = true;
            try {
              const res = await SR.api.put(`/api/dispatch/vehicles/${encodeURIComponent(row.id)}`, {
                name: v.name,
                plate_no: v.plate_no || null,
                driver_name: v.driver_name || null,
                driver_phone: v.driver_phone || null,
                vehicle_class: mode.vehicleClass,
                arrangement: mode.arrangement,
                sales_share_pct: mode.arrangement === 'PARTNER' ? mode.salesSharePct : null,
                is_active: Number(v.is_active) ? 1 : 0,
              }, { query: SR.state.query({}) });
              ui.ok(res.message || 'Vehicle updated.');
              m.close();
              if (after) after();
            } catch (err) { ui.apiError(err); ev.currentTarget.disabled = false; }
          },
        }, 'Save'),
      ],
    });
  }

  // -------------------------------------------------------------------
  // ONE JOB
  function paintPlant(host, after) {
    if (!SR.state.moduleOn('manufacturing') && !SR.state.moduleOn('creditUntilPaid')) {
      host.replaceChildren();
      return;
    }
    host.replaceChildren(ui.loading('Reading the plant…'));
    SR.api.get('/api/plant', { query: SR.state.query({}) }).then((plant) => {
      const canOwn = SR.state.atLeast('OWNER');
      const canManage = SR.state.atLeast('MANAGER');
      const head = ui.h('div', {},
        ui.h('h2', {}, 'The plant'),
        ui.h('p', { class: 'hint' }, canOwn
          ? 'You can edit the dispatch mix, each vehicle, and every machine and input. Changing a register fact does not rewrite money already posted. A manager still records a delivery, a use, a service and a stop. A cashier can see this and report a fault.'
          : canManage
            ? 'You can receive stock, record what was used, maintain a machine, stop it, and correct a wrong date or price. The owner edits the register itself. A cashier can see this and report a fault.'
            : 'You can see the plant and report a fault. Receiving stock, using it in production, maintenance, a stop, and a correction are for a manager or above. The owner edits the register.'));
      host.replaceChildren(ui.sectionTabs({
        head,
        remember: 'sr.plantTab',
        sections: [
          { id: 'owed', label: 'Supplies owed', nodes: owedNodes(plant) },
          { id: 'machines', label: 'Machines', nodes: machineNodes(plant, canManage, canOwn, after) },
          { id: 'stock', label: 'Production stock', nodes: stockNodes(plant, canManage, canOwn, after) },
        ],
      }));
    }).catch((err) => {
      host.replaceChildren(ui.h('div', { class: 'alert alert-warn' }, (err && err.message) || 'The plant count could not be read.'));
    });
  }

  function owedNodes(plant) {
    const customers = plant.openCredit || [];
    const owedIn = (plant.receipts || []).filter((row) => row.stillOwed);
    const card = ui.h('div', { class: 'card' });
    card.appendChild(ui.h('div', { class: 'card-head' }, ui.h('h2', {}, 'Supplies owed')));
    const body = ui.h('div', { class: 'card-body stack' });
    body.appendChild(ui.h('div', { class: 'grid grid-3' },
      ui.kpi({
        label: 'Customers still owing',
        value: String(customers.length),
        foot: plant.creditUntilPaid ? 'Next batch held until paid' : 'Credit hold is off',
        tone: customers.length ? 'warn' : 'good',
        small: true,
      }),
      ui.kpi({
        label: 'Inputs not yet paid',
        value: String(owedIn.length),
        foot: 'A delivery recorded as still owed',
        tone: owedIn.length ? 'warn' : 'good',
        small: true,
      }),
      ui.kpi({
        label: 'Who can change this',
        value: SR.state.atLeast('MANAGER') ? 'Manager' : 'View',
        foot: 'A cashier sees the balance. A manager records the delivery.',
        small: true,
      })));
    body.appendChild(ui.h('p', { class: 'hint' }, plant.creditUntilPaid
      ? 'A shop supplied on credit does not collect the next batch until that supply is paid. A cash sale is not held. An owner can release one batch, and the reason stays on the sale.'
      : 'Credit hold is off for this business. Customer balances below are still owed, but the next batch is not blocked by them.'));
    if (customers.length) {
      body.appendChild(ui.h('h3', {}, 'Customers'));
      body.appendChild(ui.h('div', { class: 'stack' }, customers.slice(0, 12).map((row) => ui.h('div', {},
        ui.h('strong', {}, row.name),
        ` · ${U.money(row.balance)} unpaid`,
        row.phone ? ` · ${row.phone}` : ''))));
      if (customers.length > 12) body.appendChild(ui.h('p', { class: 'hint' }, `${customers.length - 12} more are on the customer list.`));
    } else {
      body.appendChild(ui.h('p', { class: 'hint' }, 'No customer is sitting on an unpaid supply.'));
    }
    body.appendChild(ui.h('h3', {}, 'Production stock still owed to a supplier'));
    if (owedIn.length) {
      body.appendChild(ui.h('div', { class: 'stack' }, owedIn.slice(0, 8).map((row) => ui.h('div', {},
        ui.h('strong', {}, row.name),
        ui.h('div', { class: 'hint' }, `${U.qty(row.quantity)} ${row.unit || ''} gotten ${String(row.receivedAt || '').slice(0, 10)} at ${U.money(row.price)} each. ${row.notes || 'Still owed.'}`)))));
    } else {
      body.appendChild(ui.h('p', { class: 'hint' }, 'No production delivery is waiting to be paid. A manager chooses Paid now or Still owed when the goods arrive.'));
    }
    card.appendChild(body);
    return [card];
  }

  function machineNodes(plant, canManage, canOwn, after) {
    const assets = (plant.assets || []).filter((row) => canOwn || !row.retired);
    const live = assets.filter((row) => !row.retired);
    const working = live.filter((row) => row.status !== 'STOPPED').length;
    const card = ui.h('div', { class: 'card' });
    const actions = ui.h('div', { class: 'actions' });
    if (canManage && plant.manufacturing) {
      actions.appendChild(ui.h('button', { class: 'btn btn-sm', onClick: () => addAsset(after) }, 'Add a machine or tool'));
    }
    card.appendChild(ui.h('div', { class: 'card-head' }, ui.h('h2', {}, 'Machines and tools'), actions));
    const body = ui.h('div', { class: 'card-body stack' });
    body.appendChild(ui.h('div', { class: 'grid grid-3' },
      ui.kpi({ label: 'Working', value: String(working), foot: `${live.length - working} stopped${assets.length - live.length ? ` · ${assets.length - live.length} off the register` : ''}`, small: true, tone: live.length - working ? 'warn' : 'good' }),
      ui.kpi({
        label: 'Service, 30 days',
        value: U.money(plant.machinery && plant.machinery.days30),
        foot: plant.machinery && plant.machinery.allTime ? `${U.money(plant.machinery.allTime)} in all` : 'No service recorded yet',
        small: true,
      }),
      ui.kpi({
        label: 'A cashier can',
        value: 'Report',
        foot: 'A fault is a note. It does not stop the machine.',
        small: true,
      })));
    if (!plant.manufacturing) {
      body.appendChild(ui.h('p', { class: 'hint' }, 'This business is not set up to manufacture. Machines and tools stay off until it is.'));
      card.appendChild(body);
      return [card];
    }
    body.appendChild(ui.h('p', { class: 'hint' }, 'A filler, an oven, a UV lamp, a mixer, a generator, a sealing jaw, a scale. The day and the price are what was paid when it was gotten. A repair adds to the maintenance that machine has taken. Stopping it keeps the date. It is not deleted.'));
    if (!assets.length) {
      body.appendChild(ui.h('p', { class: 'hint' }, 'No machine or tool recorded yet. Add the ones this plant actually has. Do not invent a price.'));
    }
    for (const asset of assets) body.appendChild(assetBlock(asset, canManage, canOwn, after));
    card.appendChild(body);
    return [card];
  }

  function lastMarked(notes, marker) {
    const lines = String(notes || '').split('\n').map((line) => line.trim()).filter((line) => line.includes(marker));
    return lines.length ? lines[lines.length - 1] : null;
  }

  function assetBlock(asset, canManage, canOwn, after) {
    const stopped = asset.status === 'STOPPED';
    const retired = Boolean(asset.retired);
    const block = ui.h('div', { class: 'stack', style: { paddingTop: '8px', borderTop: '1px solid var(--line, rgba(0,0,0,0.08))' } });
    const line = ui.h('div', { class: 'row', style: { justifyContent: 'space-between', gap: '8px', alignItems: 'flex-start' } });
    line.appendChild(ui.h('div', {},
      ui.h('strong', {}, asset.name),
      ` · ${asset.kind === 'TOOL' ? 'Tool' : 'Machine'}`,
      retired ? ui.badge('off the register', 'badge-mute') : (stopped ? ui.badge('stopped', 'badge-bad') : ui.badge('working', 'badge-good')),
      ui.h('div', { class: 'hint' }, [
        `Gotten ${asset.acquiredAt} · ${U.money(asset.purchasePrice)}`,
        asset.supplierName ? `from ${asset.supplierName}` : null,
        asset.serialNo ? `serial ${asset.serialNo}` : null,
      ].filter(Boolean).join(' · ')),
      ui.h('div', { class: 'hint' }, `Maintenance ${U.money(asset.maintenanceTotal)}${asset.maintenanceCount ? ` across ${asset.maintenanceCount}` : ''}`),
      stopped ? ui.h('div', { class: 'hint' }, `Stopped ${asset.stoppedAt}${asset.stoppedReason ? ` — ${asset.stoppedReason}` : ''}`) : null));
    const buttons = ui.h('div', { class: 'btn-row' });
    if (!retired) buttons.appendChild(ui.h('button', { class: 'btn btn-sm', onClick: () => reportAsset(asset, after) }, 'Report a fault'));
    if (canOwn) buttons.appendChild(ui.h('button', { class: 'btn btn-sm', onClick: () => correctAsset(asset, after) }, 'Edit'));
    if (canOwn) buttons.appendChild(ui.h('button', { class: 'btn btn-sm', onClick: () => setAssetRegister(asset, !retired, after) }, retired ? 'Put back' : 'Take off register'));
    if (canManage && !retired && !canOwn) {
      buttons.appendChild(ui.h('button', { class: 'btn btn-sm', onClick: () => correctAsset(asset, after) }, 'Correct'));
    }
    if (canManage && !retired) {
      buttons.appendChild(ui.h('button', { class: 'btn btn-sm', onClick: () => serviceAsset(asset, after) }, 'Maintenance'));
      buttons.appendChild(stopped
        ? ui.h('button', { class: 'btn btn-sm', onClick: () => restartAsset(asset, after) }, 'Back in use')
        : ui.h('button', { class: 'btn btn-sm', onClick: () => stopAsset(asset, after) }, 'Stopped working'));
    }
    line.appendChild(buttons);
    block.appendChild(line);
    const report = lastMarked(asset.notes, 'Reported by');
    if (report) block.appendChild(ui.h('div', { class: 'hint' }, report));
    const services = asset.services || [];
    if (services.length) {
      block.appendChild(ui.h('div', { class: 'hint' }, 'Last services'));
      block.appendChild(ui.h('div', { class: 'stack' }, services.map((item) => ui.h('div', { class: 'hint' },
        `${item.date || ''} · ${U.money(item.amount)} · ${item.description || 'Service'}`))));
    } else {
      block.appendChild(ui.h('div', { class: 'hint' }, 'No service recorded on this machine yet.'));
    }
    return block;
  }

  function stockNodes(plant, canManage, canOwn, after) {
    const inputs = (plant.inputs || []).filter((row) => canOwn || !row.retired);
    const low = inputs.filter((row) => row.low && !row.retired);
    const card = ui.h('div', { class: 'card' });
    const actions = ui.h('div', { class: 'actions' });
    if (canManage && plant.manufacturing && plant.missing && plant.missing.length) {
      actions.appendChild(ui.h('button', { class: 'btn btn-sm', onClick: () => ensureInputs(after) }, 'Add the usual inputs'));
    }
    if (canManage && plant.manufacturing) {
      actions.appendChild(ui.h('button', { class: 'btn btn-sm', onClick: () => addInput(after) }, 'Add an input'));
    }
    card.appendChild(ui.h('div', { class: 'card-head' }, ui.h('h2', {}, 'Production stock'), actions));
    const body = ui.h('div', { class: 'card-body stack' });
    const branchName = plant.viewer && plant.viewer.branchName;
    body.appendChild(ui.h('div', { class: 'grid grid-3' },
      ui.kpi({
        label: 'On the plant',
        value: U.money(plant.inputValue || 0),
        foot: `${inputs.length} input${inputs.length === 1 ? '' : 's'}`,
        small: true,
      }),
      ui.kpi({
        label: 'Low',
        value: String(low.length),
        foot: branchName ? `At ${branchName}, against the line a manager set` : 'Set a line and this counts what is left',
        tone: low.length ? 'warn' : 'good',
        small: true,
      }),
      ui.kpi({
        label: 'Used lately',
        value: String((plant.uses || []).length),
        foot: 'Oldest stock first. Not a recipe.',
        small: true,
      })));
    if (!plant.manufacturing) {
      body.appendChild(ui.h('p', { class: 'hint' }, 'This business is not set up to manufacture. Production stock stays off until it is.'));
      card.appendChild(body);
      return [card];
    }
    body.appendChild(ui.h('p', { class: 'hint' }, 'Film rolls, flour, sugar, yeast, alum, chlorine, filter cartridges. Each delivery records the day, the price, and the amount on the same stock as the rest of the plant. Using it in a bake or a sachet run takes the oldest stock first. It is not a second list, and it is not a recipe.'));
    if (!inputs.length) {
      body.appendChild(ui.h('p', { class: 'hint' }, 'No manufacturing inputs yet. Add treatment chemical, film, flour, or whatever this plant uses. They stay off the till unless a manager also sells them.'));
    }
    for (const row of inputs) body.appendChild(inputBlock(row, plant, canManage, canOwn, after, branchName));
    const uses = plant.uses || [];
    if (uses.length) {
      body.appendChild(ui.h('h3', {}, 'Recently used in production'));
      body.appendChild(ui.h('div', { class: 'stack' }, uses.slice(0, 8).map((row) => {
        const named = inputs.find((item) => item.id === row.productId);
        return ui.h('div', { class: 'hint' }, `${String(row.at || '').slice(0, 16).replace('T', ' ')} · ${U.qty(row.quantity)} ${named ? named.name : 'input'} · ${row.reason || 'used'}`);
      })));
    }
    card.appendChild(body);
    return [card];
  }

  function inputBlock(row, plant, canManage, canOwn, after, branchName) {
    const last = (plant.receipts || []).find((receipt) => receipt.productId === row.id);
    const here = row.branchOnHand != null ? row.branchOnHand : row.onHand;
    const split = branchName && Number(here) !== Number(row.onHand);
    const block = ui.h('div', { class: 'stack', style: { paddingTop: '8px', borderTop: '1px solid var(--line, rgba(0,0,0,0.08))' } });
    const line = ui.h('div', { class: 'row', style: { justifyContent: 'space-between', gap: '8px', alignItems: 'flex-start' } });
    line.appendChild(ui.h('div', {},
      ui.h('strong', {}, row.name),
      row.retired ? ui.badge('off the plant', 'badge-mute') : null,
      row.low && !row.retired ? ui.badge('low', 'badge-warn') : null,
      row.offersSale ? ui.badge('also sold', 'badge-mute') : ui.badge('not on the till', 'badge-mute'),
      ui.h('div', { class: 'hint' }, split
        ? `${U.qty(here)} ${row.unit || ''} at ${branchName} · ${U.qty(row.onHand)} across the plant · ${U.money(row.value)}`
        : `${U.qty(row.onHand)} ${row.unit || ''} on hand · ${U.money(row.value)}`),
      ui.h('div', { class: 'hint' }, row.reorder > 0
        ? `Low when ${branchName || 'the branch'} has ${U.qty(row.reorder)} ${row.unit || ''} or less.`
        : 'No low-stock line yet. A manager can set one.'),
      ui.h('div', { class: 'hint' }, last
        ? `Last gotten ${String(last.receivedAt || '').slice(0, 10)} · ${U.qty(last.quantity)} at ${U.money(last.price)} each${last.stillOwed ? ' · still owed' : ''}${last.expiry ? ` · expires ${last.expiry}` : ''}`
        : 'Not received yet. Record the day, the price and the amount.')));
    const buttons = ui.h('div', { class: 'btn-row' });
    if (canOwn) buttons.appendChild(ui.h('button', { class: 'btn btn-sm', onClick: () => editInput(row, after) }, 'Edit'));
    if (canManage && !row.retired) {
      buttons.appendChild(ui.h('button', { class: 'btn btn-sm btn-primary', onClick: () => receiveInput(row, after) }, 'Receive'));
      buttons.appendChild(ui.h('button', { class: 'btn btn-sm', onClick: () => useInput(row, after, branchName) }, 'Used'));
      if (!canOwn) buttons.appendChild(ui.h('button', { class: 'btn btn-sm', onClick: () => setReorder(row, after) }, 'Low-stock line'));
      if (!canOwn) buttons.appendChild(ui.h('button', { class: 'btn btn-sm', onClick: () => toggleSale(row, after) }, row.offersSale ? 'Stop selling' : 'Also sell'));
    }
    if (buttons.childNodes.length) line.appendChild(buttons);
    block.appendChild(line);
    return block;
  }

  function setAssetRegister(asset, onRegister, after) {
    ui.confirmDialog({
      title: onRegister ? `Put ${asset.name} back` : `Take ${asset.name} off the register`,
      message: onRegister
        ? `${asset.name} goes back on the plant. Maintenance already posted is not changed.`
        : `${asset.name} leaves the working list. The price and any maintenance already posted stay on the books. It is not erased.`,
      confirmLabel: onRegister ? 'Put it back' : 'Take it off',
      danger: !onRegister,
    }).then((yes) => {
      if (!yes) return;
      SR.api.post(`/api/plant/assets/${encodeURIComponent(asset.id)}/register`, { on_register: onRegister ? 1 : 0 }, { query: SR.state.query({}) }).then((res) => {
        ui.ok(res.message || 'Saved.');
        if (after) after();
      }).catch((err) => ui.apiError(err));
    });
  }

  function editInput(row, after) {
    const wrapEl = ui.h('div', {});
    wrapEl.appendChild(ui.h('p', { class: 'hint' }, 'This edits the register. It does not rewrite a delivery already saved, and it does not convert quantity already counted. Take it off the plant only when nothing is on hand.'));
    wrapEl.appendChild(ui.h('div', { class: 'form-grid' },
      ui.field({ label: 'Name', name: 'name', required: true, value: row.name }),
      ui.field({ label: 'Category', name: 'category_name', value: row.categoryName || '' }),
      ui.field({ label: 'Unit', name: 'unit', value: row.unit || '' }),
      ui.field({ label: 'Catalogue cost (₦)', name: 'cost', type: 'number', step: '0.01', min: '0', value: row.cost || 0, hint: 'The figure on the product. A delivery already saved keeps its own price.' }),
      ui.field({ label: `Low when at or under (${row.unit || 'units'})`, name: 'reorder_level', type: 'number', step: '0.001', min: '0', value: row.reorder || 0 }),
      ui.field({ label: 'Also sell this at the till', name: 'offers_sale', type: 'checkbox', value: row.offersSale ? 1 : 0, span: true }),
      ui.field({ label: 'Keep it on the plant', name: 'on_plant', type: 'checkbox', value: row.retired ? 0 : 1, span: true, hint: 'Off only when nothing is on hand. Stock that is still counted cannot be hidden.' })));
    const m = ui.openModal({
      title: `Edit ${row.name}`,
      body: wrapEl,
      footer: [
        ui.h('button', { class: 'btn', onClick: () => m.close() }, 'Cancel'),
        ui.h('button', {
          class: 'btn btn-primary',
          onClick: async (ev) => {
            const v = ui.readForm(wrapEl);
            if (!v.name || String(v.name).trim().length < 2) { ui.warn('Name the input.'); return; }
            ev.currentTarget.disabled = true;
            try {
              const res = await SR.api.post(`/api/plant/inputs/${encodeURIComponent(row.id)}/correct`, {
                name: v.name,
                category_name: v.category_name || null,
                unit: v.unit || null,
                cost: v.cost == null ? 0 : Number(v.cost),
                reorder_level: v.reorder_level == null ? 0 : Number(v.reorder_level),
                offers_sale: Number(v.offers_sale) ? 1 : 0,
                on_plant: Number(v.on_plant) ? 1 : 0,
              }, { query: SR.state.query({}) });
              ui.ok(res.message || 'Updated.');
              m.close();
              if (after) after();
            } catch (err) { ui.apiError(err); ev.currentTarget.disabled = false; }
          },
        }, 'Save'),
      ],
    });
  }

  function ensureInputs(after) {
    SR.api.post('/api/plant/inputs/ensure', {}, { query: SR.state.query({}) }).then((res) => {
      ui.ok(res.message || 'Inputs added.');
      if (after) after();
    }).catch((err) => ui.apiError(err));
  }

  function addInput(after) {
    const wrapEl = ui.h('div', {});
    wrapEl.appendChild(ui.h('p', { class: 'hint' }, 'Name what this plant actually uses. Chemicals, film, flour, yeast — the name is yours. It is counted as stock and is not sold at the till unless you tick that. Do not guess a market price. Leave the cost at 0 and set it when the goods arrive.'));
    wrapEl.appendChild(ui.h('div', { class: 'form-grid' },
      ui.field({ label: 'Name', name: 'name', required: true, placeholder: 'Alum, nylon, yeast' }),
      ui.field({ label: 'Category', name: 'category_name', placeholder: 'Treatment chemicals' }),
      ui.field({ label: 'Unit', name: 'unit', placeholder: 'bag' }),
      ui.field({ label: 'Cost (₦)', name: 'cost', type: 'number', step: '0.01', min: '0', hint: 'What you last paid. Leave 0 and set it when the goods are received.' }),
      ui.field({ label: 'Also sell this at the till', name: 'offers_sale', type: 'checkbox', value: 0, span: true })));
    const m = ui.openModal({
      title: 'Add a manufacturing input',
      body: wrapEl,
      footer: [
        ui.h('button', { class: 'btn', onClick: () => m.close() }, 'Cancel'),
        ui.h('button', {
          class: 'btn btn-primary',
          onClick: async (ev) => {
            const v = ui.readForm(wrapEl);
            if (!v.name || String(v.name).trim().length < 2) { ui.warn('Name the input.'); return; }
            ev.currentTarget.disabled = true;
            try {
              const res = await SR.api.post('/api/plant/inputs', {
                name: v.name,
                category_name: v.category_name || null,
                unit: v.unit || null,
                cost: v.cost == null ? 0 : Number(v.cost),
                offers_sale: Number(v.offers_sale) ? 1 : 0,
              }, { query: SR.state.query({}) });
              ui.ok(res.message || 'Added.');
              m.close();
              if (after) after();
            } catch (err) { ui.apiError(err); ev.currentTarget.disabled = false; }
          },
        }, 'Add it'),
      ],
    });
  }

  function addAsset(after) {
    const wrapEl = ui.h('div', {});
    wrapEl.appendChild(ui.h('p', { class: 'hint' }, 'Name the machine or tool. The date and the price are what was paid when it was gotten. Do not guess a market price. Tick the money only if it is leaving today — an old machine stays on the register and is not posted again into this month.'));
    wrapEl.appendChild(ui.h('div', { class: 'form-grid' },
      ui.field({ label: 'Name', name: 'name', required: true, placeholder: 'Sachet filler, oven, UV lamp' }),
      ui.field({ label: 'Kind', name: 'kind', value: 'MACHINE', options: [{ value: 'MACHINE', label: 'Machine' }, { value: 'TOOL', label: 'Tool' }] }),
      ui.field({ label: 'Date gotten', name: 'acquired_at', type: 'date', required: true }),
      ui.field({ label: 'Price paid (₦)', name: 'purchase_price', type: 'number', step: '0.01', min: '0', required: true }),
      ui.field({ label: 'Where it was gotten', name: 'supplier_name', placeholder: 'Optional' }),
      ui.field({ label: 'Serial number', name: 'serial_no', placeholder: 'Optional' }),
      ui.field({ label: 'The money is leaving today', name: 'paid_now', type: 'checkbox', value: 0, hint: 'Posts the price to equipment on these books. Leave it off for a machine gotten earlier.' }),
      ui.field({ label: 'Paid from', name: 'payment_method', value: 'BANK_TRANSFER', options: [
        { value: 'BANK_TRANSFER', label: 'Bank' },
        { value: 'CASH', label: 'Cash' },
        { value: 'POS_TERMINAL', label: 'POS' },
        { value: 'MOBILE_MONEY', label: 'Mobile money' },
      ] })));
    const m = ui.openModal({
      title: 'Add a machine or tool',
      body: wrapEl,
      footer: [
        ui.h('button', { class: 'btn', onClick: () => m.close() }, 'Cancel'),
        ui.h('button', {
          class: 'btn btn-primary',
          onClick: async (ev) => {
            const v = ui.readForm(wrapEl);
            if (!v.name || String(v.name).trim().length < 2) { ui.warn('Name the machine or the tool.'); return; }
            if (!v.acquired_at) { ui.warn('Enter the day it was gotten.'); return; }
            if (!(Number(v.purchase_price) >= 0)) { ui.warn('Enter the price that was paid.'); return; }
            ev.currentTarget.disabled = true;
            try {
              const res = await SR.api.post('/api/plant/assets', {
                name: v.name,
                kind: v.kind,
                acquired_at: v.acquired_at,
                purchase_price: Number(v.purchase_price),
                supplier_name: v.supplier_name || null,
                serial_no: v.serial_no || null,
                paid_now: Number(v.paid_now) ? true : false,
                payment_method: v.payment_method || 'BANK_TRANSFER',
                branch_id: SR.state.activeBranchId,
              }, { query: SR.state.query({}) });
              ui.ok(res.message || 'Recorded.');
              m.close();
              if (after) after();
            } catch (err) { ui.apiError(err); ev.currentTarget.disabled = false; }
          },
        }, 'Record it'),
      ],
    });
  }

  function serviceAsset(asset, after) {
    const wrapEl = ui.h('div', {});
    wrapEl.appendChild(ui.h('p', { class: 'hint' }, `This adds to the maintenance ${asset.name} has taken. The money is an expense on the same books, pointed at this machine. It does not change the price paid when it was gotten.`));
    wrapEl.appendChild(ui.h('div', { class: 'form-grid' },
      ui.field({ label: 'What was done', name: 'description', required: true, span: true, placeholder: 'New heating element, gearbox service, jaw replacement' }),
      ui.field({ label: 'Amount (₦)', name: 'amount', type: 'number', step: '0.01', min: '0', required: true }),
      ui.field({ label: 'Date', name: 'expense_date', type: 'date', value: U.todayWat() }),
      ui.field({ label: 'Paid by', name: 'payment_method', value: 'BANK_TRANSFER', options: ['CASH', 'BANK_TRANSFER', 'POS_TERMINAL', 'MOBILE_MONEY'] })));
    const m = ui.openModal({
      title: `Maintenance · ${asset.name}`,
      body: wrapEl,
      footer: [
        ui.h('button', { class: 'btn', onClick: () => m.close() }, 'Cancel'),
        ui.h('button', {
          class: 'btn btn-primary',
          onClick: async (ev) => {
            const v = ui.readForm(wrapEl);
            if (!v.description || String(v.description).trim().length < 4) { ui.warn('Say what was done.'); return; }
            if (!(Number(v.amount) > 0)) { ui.warn('Enter the amount.'); return; }
            ev.currentTarget.disabled = true;
            try {
              const res = await SR.api.post(`/api/plant/assets/${encodeURIComponent(asset.id)}/service`, {
                description: v.description,
                amount: Number(v.amount),
                expense_date: v.expense_date || U.todayWat(),
                payment_method: v.payment_method || 'BANK_TRANSFER',
                branch_id: SR.state.activeBranchId,
              }, { query: SR.state.query({}) });
              ui.ok(res.message || 'Maintenance recorded.');
              m.close();
              if (after) after();
            } catch (err) { ui.apiError(err); ev.currentTarget.disabled = false; }
          },
        }, 'Record it'),
      ],
    });
  }

  function stopAsset(asset, after) {
    const wrapEl = ui.h('div', {});
    wrapEl.appendChild(ui.h('p', { class: 'hint' }, `${asset.name} stays on the register. Confirming the stop records the day and why. It does not remove the price or the maintenance already taken. A fault report is not a stop — this is.`));
    wrapEl.appendChild(ui.h('div', { class: 'form-grid' },
      ui.field({ label: 'Date it stopped', name: 'stopped_at', type: 'date', required: true, value: U.todayWat() }),
      ui.field({ label: 'Why it stopped', name: 'reason', required: true, span: true, placeholder: 'Burnt element, seized gearbox, cracked jaw' }),
      ui.field({ label: 'I confirm this has stopped', name: 'confirm_stop', type: 'checkbox', value: 0, span: true, hint: 'The date and the reason stay. Putting it back in use later does not erase them.' })));
    const m = ui.openModal({
      title: `Stopped working · ${asset.name}`,
      body: wrapEl,
      footer: [
        ui.h('button', { class: 'btn', onClick: () => m.close() }, 'Cancel'),
        ui.h('button', {
          class: 'btn btn-primary',
          onClick: async (ev) => {
            const v = ui.readForm(wrapEl);
            if (!v.stopped_at) { ui.warn('Enter the day it stopped.'); return; }
            if (!v.reason || String(v.reason).trim().length < 4) { ui.warn('Say why it stopped.'); return; }
            if (!Number(v.confirm_stop)) { ui.warn('Confirm the stop before it is recorded.'); return; }
            ev.currentTarget.disabled = true;
            try {
              const res = await SR.api.post(`/api/plant/assets/${encodeURIComponent(asset.id)}/stop`, {
                stopped_at: v.stopped_at,
                reason: v.reason,
              }, { query: SR.state.query({}) });
              ui.ok(res.message || 'Recorded.');
              m.close();
              if (after) after();
            } catch (err) { ui.apiError(err); ev.currentTarget.disabled = false; }
          },
        }, 'Confirm it stopped'),
      ],
    });
  }

  function restartAsset(asset, after) {
    ui.confirmDialog({
      title: `Back in use · ${asset.name}`,
      message: `${asset.name} goes back to working. The day it stopped stays in the notes. This does not spend money.`,
      confirmLabel: 'Put it back in use',
    }).then((yes) => {
      if (!yes) return;
      SR.api.post(`/api/plant/assets/${encodeURIComponent(asset.id)}/stop`, { status: 'WORKING' }, { query: SR.state.query({}) }).then((res) => {
        ui.ok(res.message || `${asset.name} is back in use.`);
        if (after) after();
      }).catch((err) => ui.apiError(err));
    });
  }

  function correctAsset(asset, after) {
    const wrapEl = ui.h('div', {});
    wrapEl.appendChild(ui.h('p', { class: 'hint' }, 'Use this when the name, the day, the price, the supplier, or the serial was written down wrong. Changing the price here does not post the purchase a second time.'));
    wrapEl.appendChild(ui.h('div', { class: 'form-grid' },
      ui.field({ label: 'Name', name: 'name', required: true, value: asset.name }),
      ui.field({ label: 'Kind', name: 'kind', value: asset.kind || 'MACHINE', options: [{ value: 'MACHINE', label: 'Machine' }, { value: 'TOOL', label: 'Tool' }] }),
      ui.field({ label: 'Date gotten', name: 'acquired_at', type: 'date', required: true, value: asset.acquiredAt }),
      ui.field({ label: 'Price paid (₦)', name: 'purchase_price', type: 'number', step: '0.01', min: '0', required: true, value: asset.purchasePrice }),
      ui.field({ label: 'Where it was gotten', name: 'supplier_name', value: asset.supplierName || '' }),
      ui.field({ label: 'Serial number', name: 'serial_no', value: asset.serialNo || '' })));
    const m = ui.openModal({
      title: `Correct · ${asset.name}`,
      body: wrapEl,
      footer: [
        ui.h('button', { class: 'btn', onClick: () => m.close() }, 'Cancel'),
        ui.h('button', {
          class: 'btn btn-primary',
          onClick: async (ev) => {
            const v = ui.readForm(wrapEl);
            if (!v.name || String(v.name).trim().length < 2) { ui.warn('Name the machine or the tool.'); return; }
            if (!v.acquired_at) { ui.warn('Enter the day it was gotten.'); return; }
            if (!(Number(v.purchase_price) >= 0)) { ui.warn('Enter the price that was paid.'); return; }
            ev.currentTarget.disabled = true;
            try {
              const res = await SR.api.post(`/api/plant/assets/${encodeURIComponent(asset.id)}/correct`, {
                name: v.name,
                kind: v.kind,
                acquired_at: v.acquired_at,
                purchase_price: Number(v.purchase_price),
                supplier_name: v.supplier_name || null,
                serial_no: v.serial_no || null,
              }, { query: SR.state.query({}) });
              ui.ok(res.message || 'Corrected.');
              m.close();
              if (after) after();
            } catch (err) { ui.apiError(err); ev.currentTarget.disabled = false; }
          },
        }, 'Save the correction'),
      ],
    });
  }

  function reportAsset(asset, after) {
    const wrapEl = ui.h('div', {});
    wrapEl.appendChild(ui.h('p', { class: 'hint' }, `This notes what is wrong with ${asset.name}. It does not stop the machine, and it does not spend money. A manager records the stop and any repair.`));
    wrapEl.appendChild(ui.h('div', { class: 'form-grid' },
      ui.field({ label: 'What is wrong', name: 'reason', required: true, span: true, placeholder: 'Heating element smoking, jaw not sealing, pump noisy' })));
    const m = ui.openModal({
      title: `Report a fault · ${asset.name}`,
      body: wrapEl,
      footer: [
        ui.h('button', { class: 'btn', onClick: () => m.close() }, 'Cancel'),
        ui.h('button', {
          class: 'btn btn-primary',
          onClick: async (ev) => {
            const v = ui.readForm(wrapEl);
            if (!v.reason || String(v.reason).trim().length < 4) { ui.warn('Say what is wrong.'); return; }
            ev.currentTarget.disabled = true;
            try {
              const res = await SR.api.post(`/api/plant/assets/${encodeURIComponent(asset.id)}/report`, {
                reason: v.reason,
              }, { query: SR.state.query({}) });
              ui.ok(res.message || 'Noted.');
              m.close();
              if (after) after();
            } catch (err) { ui.apiError(err); ev.currentTarget.disabled = false; }
          },
        }, 'Send the note'),
      ],
    });
  }

  function receiveInput(row, after) {
    const wrapEl = ui.h('div', {});
    wrapEl.appendChild(ui.h('p', { class: 'hint' }, `Record this delivery of ${row.name}. Paid now takes the money from the bank, the same way any other goods receipt does. Still owed needs the supplier’s name and does not take cash today. The price has to be what was paid. A zero is not a delivery. Receiving again adds more stock. It does not fix a delivery already saved.`));
    const totalLine = ui.h('p', { style: { fontWeight: '600' } }, 'Enter the amount and the price. The line total shows here before you save.');
    wrapEl.appendChild(ui.h('div', { class: 'form-grid' },
      ui.field({ label: 'Date gotten', name: 'received_on', type: 'date', required: true, value: U.todayWat() }),
      ui.field({ label: `Amount (${row.unit || 'units'})`, name: 'quantity', type: 'number', step: '0.001', min: '0', required: true }),
      ui.field({ label: 'Price each (₦)', name: 'price', type: 'number', step: '0.01', min: '0', required: true }),
      ui.field({ label: 'Supplier', name: 'supplier_name', placeholder: 'Required if this is still owed' }),
      ui.field({ label: 'Paid now', name: 'paid_now', type: 'checkbox', value: 1, span: true, hint: 'On: the bank pays today. Off: the amount stays owed to the supplier.' }),
      ui.field({ label: 'Expiry', name: 'expiry_date', type: 'date', hint: 'Optional. Leave it empty if this input is not dated.' }),
      ui.field({ label: 'Note', name: 'notes', placeholder: 'Optional', span: true })));
    wrapEl.appendChild(totalLine);
    function showTotal() {
      const v = ui.readForm(wrapEl);
      const quantity = Number(v.quantity);
      const price = Number(v.price);
      if (!(quantity > 0) || !(price > 0)) {
        totalLine.textContent = 'Enter the amount and the price. The line total shows here before you save.';
        return;
      }
      const gross = Math.round(quantity * price * 100) / 100;
      totalLine.textContent = Number(v.paid_now)
        ? `Line total ${U.money(gross)}. Paid now, from the bank.`
        : `Line total ${U.money(gross)}. Still owed. Name the supplier before you save.`;
    }
    wrapEl.addEventListener('input', showTotal);
    wrapEl.addEventListener('change', showTotal);
    const m = ui.openModal({
      title: `Receive ${row.name}`,
      body: wrapEl,
      footer: [
        ui.h('button', { class: 'btn', onClick: () => m.close() }, 'Cancel'),
        ui.h('button', {
          class: 'btn btn-primary',
          onClick: async (ev) => {
            const v = ui.readForm(wrapEl);
            if (!v.received_on) { ui.warn('Enter the day it was gotten.'); return; }
            if (!(Number(v.quantity) > 0)) { ui.warn('Enter the amount gotten.'); return; }
            if (!(Number(v.price) > 0)) { ui.warn('Enter the price paid for each.'); return; }
            if (!Number(v.paid_now) && !v.supplier_name) { ui.warn('Name the supplier if this delivery is not paid yet.'); return; }
            ev.currentTarget.disabled = true;
            try {
              const res = await SR.api.post(`/api/plant/inputs/${encodeURIComponent(row.id)}/receive`, {
                received_on: v.received_on,
                quantity: Number(v.quantity),
                price: Number(v.price),
                supplier_name: v.supplier_name || null,
                paid_now: Number(v.paid_now) ? 1 : 0,
                expiry_date: v.expiry_date || null,
                notes: v.notes || null,
                branch_id: SR.state.activeBranchId,
              }, { query: SR.state.query({}) });
              ui.ok(res.message || 'Received.');
              m.close();
              if (after) after();
            } catch (err) { ui.apiError(err); ev.currentTarget.disabled = false; }
          },
        }, 'Record the delivery'),
      ],
    });
  }

  function useInput(row, after, branchName) {
    const here = row.branchOnHand != null ? row.branchOnHand : row.onHand;
    const wrapEl = ui.h('div', {});
    wrapEl.appendChild(ui.h('p', { class: 'hint' }, `${U.qty(here)} ${row.unit || ''} of ${row.name} can be used${branchName ? ` at ${branchName}` : ''}. The oldest stock goes first, across more than one delivery if it has to. This is not a recipe, and it does not sell the goods.`));
    wrapEl.appendChild(ui.h('div', { class: 'form-grid' },
      ui.field({ label: `Amount used (${row.unit || 'units'})`, name: 'quantity', type: 'number', step: '0.001', min: '0', required: true }),
      ui.field({ label: 'What it was used for', name: 'reason', required: true, span: true, placeholder: 'Morning bake, sachet run, filter change' })));
    const m = ui.openModal({
      title: `Used in production · ${row.name}`,
      body: wrapEl,
      footer: [
        ui.h('button', { class: 'btn', onClick: () => m.close() }, 'Cancel'),
        ui.h('button', {
          class: 'btn btn-primary',
          onClick: async (ev) => {
            const v = ui.readForm(wrapEl);
            if (!(Number(v.quantity) > 0)) { ui.warn('Enter the amount used.'); return; }
            if (!v.reason || String(v.reason).trim().length < 4) { ui.warn('Say what it was used for.'); return; }
            ev.currentTarget.disabled = true;
            try {
              const res = await SR.api.post(`/api/plant/inputs/${encodeURIComponent(row.id)}/use`, {
                quantity: Number(v.quantity),
                reason: v.reason,
                branch_id: SR.state.activeBranchId,
              }, { query: SR.state.query({}) });
              ui.ok(res.message || 'Recorded.');
              m.close();
              if (after) after();
            } catch (err) { ui.apiError(err); ev.currentTarget.disabled = false; }
          },
        }, 'Take it for production'),
      ],
    });
  }

  function setReorder(row, after) {
    const wrapEl = ui.h('div', {});
    wrapEl.appendChild(ui.h('p', { class: 'hint' }, `When ${row.name} at this branch is at or under this line, it shows as low. Leave 0 if you do not want a warning. This does not order anything.`));
    wrapEl.appendChild(ui.h('div', { class: 'form-grid' },
      ui.field({ label: `Low when at or under (${row.unit || 'units'})`, name: 'reorder_level', type: 'number', step: '0.001', min: '0', value: row.reorder || 0 })));
    const m = ui.openModal({
      title: `Low-stock line · ${row.name}`,
      body: wrapEl,
      footer: [
        ui.h('button', { class: 'btn', onClick: () => m.close() }, 'Cancel'),
        ui.h('button', {
          class: 'btn btn-primary',
          onClick: async (ev) => {
            const v = ui.readForm(wrapEl);
            if (v.reorder_level == null || Number(v.reorder_level) < 0) { ui.warn('Enter the line, or 0 to clear it.'); return; }
            ev.currentTarget.disabled = true;
            try {
              const res = await SR.api.post(`/api/plant/inputs/${encodeURIComponent(row.id)}/reorder`, {
                reorder_level: Number(v.reorder_level),
              }, { query: SR.state.query({}) });
              ui.ok(res.message || 'Saved.');
              m.close();
              if (after) after();
            } catch (err) { ui.apiError(err); ev.currentTarget.disabled = false; }
          },
        }, 'Save the line'),
      ],
    });
  }


  function recordService(after) {
    const wrapEl = ui.h('div', {});
    wrapEl.appendChild(ui.h('p', { class: 'hint' }, 'A filling line, an oven, a generator, a sealing machine. This is the cost of the service, not the stock of spare parts.'));
    wrapEl.appendChild(ui.h('div', { class: 'form-grid' },
      ui.field({ label: 'What was serviced', name: 'description', required: true, span: true, placeholder: 'Sachet filling machine service' }),
      ui.field({ label: 'Amount (₦)', name: 'amount', type: 'number', step: '0.01', min: '0', required: true }),
      ui.field({ label: 'Paid by', name: 'payment_method', value: 'BANK_TRANSFER', options: ['CASH', 'BANK_TRANSFER', 'POS_TERMINAL', 'MOBILE_MONEY'] })));
    const m = ui.openModal({
      title: 'Machinery service',
      body: wrapEl,
      footer: [
        ui.h('button', { class: 'btn', onClick: () => m.close() }, 'Cancel'),
        ui.h('button', {
          class: 'btn btn-primary',
          onClick: async (ev) => {
            const v = ui.readFormStrings(wrapEl);
            if (!v.description || String(v.description).trim().length < 4) { ui.warn('Say which machine was serviced.'); return; }
            if (!(Number(v.amount) > 0)) { ui.warn('Enter the amount.'); return; }
            ev.currentTarget.disabled = true;
            try {
              const res = await SR.api.post('/api/expenses', {
                branch_id: SR.state.activeBranchId,
                business_id: SR.state.activeBusinessId,
                category: 'MACHINERY_SERVICE',
                description: v.description,
                amount: Number(v.amount),
                payment_method: v.payment_method || 'BANK_TRANSFER',
                expense_date: U.todayWat(),
              }, { query: SR.state.query({}) });
              ui.ok((res && res.message) || 'Service cost recorded.');
              m.close();
              if (after) after();
            } catch (err) { ui.apiError(err); ev.currentTarget.disabled = false; }
          },
        }, 'Record it'),
      ],
    });
  }

  function toggleSale(row, after) {
    const turningOn = !row.offersSale;
    ui.confirmDialog({
      title: turningOn ? `Also sell ${row.name}` : `Stop selling ${row.name}`,
      message: turningOn
        ? `${row.name} stays an input, and the till can sell it too. Stock already counted is not changed.`
        : `${row.name} stays on the plant stock and comes off the till. Stock already counted is not removed.`,
      confirmLabel: turningOn ? 'Allow the till to sell it' : 'Take it off the till',
    }).then((yes) => {
      if (!yes) return;
      SR.api.put(`/api/products/${encodeURIComponent(row.id)}`, { offers_sale: turningOn ? 1 : 0 }).then(() => {
        ui.ok(turningOn ? `${row.name} is still counted as an input, and the till can sell it.` : `${row.name} stays on the plant stock and is off the till.`);
        if (after) after();
      }).catch((err) => ui.apiError(err));
    });
  }

  // -------------------------------------------------------------------
  async function renderJob(ctx) {
    ctx.setTitle('Delivery');
    const wrap = ui.h('div', { class: 'stack' });
    const host = ui.h('div', { class: 'stack' });
    wrap.appendChild(host);
    let dispatchSetup = null;
    await load();

    async function load() {
      host.replaceChildren(ui.skeleton(7));
      dispatchSetup = await loadDispatch();
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

      host.replaceChildren();
      const head = ui.h('div', { class: 'page-head' },
        ui.h('div', {},
          ui.h('h1', {}, job.job_no || 'Delivery job'),
          ui.h('p', { class: 'sub' }, [job.customer_name, job.customer_phone, job.receipt_no, job.branch_name].filter(Boolean).join(' · '))),
        ui.h('div', { class: 'actions' },
          ui.h('button', { class: 'btn btn-sm', onClick: () => SR.app.navigate('/deliveries') }, 'Back'),
          job.sale_id ? ui.h('button', { class: 'btn btn-sm', onClick: () => SR.app.navigate(`/sales/${job.sale_id}`) }, 'The sale') : null,
          job.sale_id ? ui.h('button', { class: 'btn btn-sm', onClick: () => printDropPaper(job) }, 'Print the paper') : null,
          SR.state.atLeast('MANAGER') && !['DELIVERED', 'CANCELLED', 'RETURNED'].includes(String(job.status).toUpperCase())
            ? ui.h('button', { class: 'btn btn-sm btn-primary', onClick: () => attachLoad(job, load) }, 'Attach the load')
            : null,
          nextStatus ? ui.h('button', { class: 'btn btn-sm btn-primary', onClick: () => move(job, nextStatus, load) }, `Mark ${U.humanise(nextStatus).toLowerCase()}`) : null,
          ui.h('button', { class: 'btn btn-sm', onClick: () => move(job, null, load) }, 'Change status'),
          job.arrangement === 'PARTNER' && job.status === 'DELIVERED' && Number(job.driver_pay) > 0 && !job.partner_expense_id
            ? ui.h('button', { class: 'btn btn-sm btn-primary', onClick: () => recordPartnerPay(job, load) }, `Pay partner ${U.money(job.driver_pay)}`)
            : null,
          SR.state.atLeast('MANAGER') ? ui.h('button', { class: 'btn btn-sm', onClick: () => addInstallation(job, items, load) }, 'Add installation') : null));

      const jobNodes = [];
      jobNodes.push(ui.h('div', { class: 'grid grid-4' },
        ui.kpi({ label: 'Status', value: U.humanise(job.status), tone: job.status === 'DELIVERED' ? 'good' : (['FAILED', 'RETURNED', 'CANCELLED'].includes(job.status) ? 'bad' : 'warn'), small: true }),
        ui.kpi({ label: 'Scheduled', value: job.scheduled_for ? U.date(job.scheduled_for) : 'not set', small: true }),
        ui.kpi({ label: 'Driver', value: job.driver_name || 'unassigned', foot: job.driver_phone || null, small: true }),
        ui.kpi({ label: 'Delivery fee', value: Number(job.delivery_fee) ? U.money(job.delivery_fee) : 'no charge', small: true })));
      if ((items || []).some((item) => Number(item.is_fragile) === 1)) {
        jobNodes.push(ui.h('div', { class: 'alert alert-warn' }, 'Fragile goods are on this drop. They do not ride loose. The person who loads them has to know before the vehicle leaves.'));
      }

      const cols = ui.h('div', { class: 'grid grid-2' });
      cols.appendChild(ui.dataCard({
        title: 'Where it is going',
        table: ui.kv([
          ['Customer', job.customer_name], ['Phone', job.customer_phone],
          ['Address', job.delivery_address || job.address], ['Landmark', job.landmark],
          ['City', job.city], ['State', job.state],
          ['Scheduled for', job.scheduled_for ? U.dateTime(job.scheduled_for) : null],
          ['Delivered at', job.delivered_at ? U.watClock(job.delivered_at) : null],
          ['How it was sold', job.settlement === 'CREDIT' || job.sale_settlement === 'CREDIT' ? 'On credit — invoice' : (job.settlement === 'SPOT' || job.sale_settlement === 'SPOT' ? 'Paid on the spot — receipt' : 'Not recorded yet')],
          ['This drop', [job.supply_terms ? U.humanise(String(job.supply_terms).toLowerCase()) : (job.sale_type ? U.humanise(String(job.sale_type).toLowerCase()) : null), job.goods_value != null ? U.money(job.goods_value) : (job.sale_total != null ? U.money(job.sale_total) : null)].filter(Boolean).join(' · ') || null],
          ['Paid', job.amount_paid != null ? U.money(job.amount_paid) : (job.sale_paid != null ? U.money(job.sale_paid) : null)],
          ['Still owed', job.balance_due != null ? U.money(job.balance_due) : (job.sale_balance != null ? U.money(job.sale_balance) : null)],
          ['Drop note', job.transaction_note],
          ['GPS', job.latitude != null && job.longitude != null ? `${job.latitude}, ${job.longitude}` : null],
          ['Received by', job.delivered_to],
          ['Proof', job.proof_of_delivery],
          ['Notes', job.notes],
        ]),
      }));
      cols.appendChild(ui.dataCard({
        title: 'Contact and carrier',
        table: ui.kv([
          ['Staff', job.driver_name],
          ['Staff phone', job.driver_phone],
          ['Vehicle', job.vehicle_no || job.vehicle_class],
          ['Load attached', job.load_attached_at ? 'Yes — by a manager or above' : 'Not yet'],
          ['Arrangement', job.arrangement === 'PARTNER' ? `Partner · ${job.sales_share_pct || 0}% of the goods` : (job.arrangement === 'OWNED' ? 'Ours · driver on a wage' : null)],
          ['Partner share', job.arrangement === 'PARTNER' ? (Number(job.driver_pay) ? U.money(job.driver_pay) : 'Calculated when the drop is delivered') : null],
          ['Payout', job.partner_expense_id ? 'Recorded' : (job.arrangement === 'PARTNER' && job.status === 'DELIVERED' ? 'Not recorded yet' : null)],
          ['Transporter', job.transporter_name],
          ['Transport cost', Number(job.transport_cost) ? U.money(job.transport_cost) : null],
          ['Fee charged', Number(job.delivery_fee) ? U.money(job.delivery_fee) : null],
          ['Fee collected', job.fee_collected != null ? (Number(job.fee_collected) ? 'yes' : 'no — still to collect') : null],
          ['Requires installation', Number(job.requires_installation) ? 'yes' : 'no'],
        ]),
      }));
      jobNodes.push(cols);

      const loadCard = ui.dataCard({
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
      });

      const installCard = ui.dataCard({
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
      });

      let historyCard = null;
      if (String(job.notes || '').includes('|')) {
        const history = String(job.notes).split('\n').filter((l) => l.includes('|'));
        if (history.length) {
          historyCard = ui.dataCard({
            title: 'What happened',
            table: ui.renderTable({
              columns: [{ key: 'line', label: 'Entry', className: 'wrap' }],
              rows: history.map((line) => ({ line })),
            }),
          });
        }
      }
      if (historyCard) jobNodes.push(historyCard);
      host.replaceChildren(ui.sectionTabs({
        head,
        remember: 'sr.deliveryTab',
        sections: [
          { id: 'job', label: 'Job', nodes: jobNodes },
          { id: 'load', label: 'Load', nodes: [loadCard] },
          { id: 'installation', label: 'Installation', nodes: [installCard] },
        ],
      }));
    }

    function recordPartnerPay(job, after) {
      const wrapEl = ui.h('div', {});
      wrapEl.appendChild(ui.h('p', { class: 'hint' }, `${U.money(job.driver_pay)} is ${job.sales_share_pct || 0}% of the goods on this drop, not of the delivery fee. Recording it pays the partner once. A wage driver is not paid here.`));
      wrapEl.appendChild(ui.h('div', { class: 'form-grid' },
        ui.field({ label: 'How it is paid', name: 'payment_method', value: 'BANK_TRANSFER', options: [
          { value: 'BANK_TRANSFER', label: 'Transfer' },
          { value: 'CASH', label: 'Cash from the till' },
        ] })));
      const m = ui.openModal({
        title: `Pay ${job.driver_name || 'the partner'}`,
        body: wrapEl,
        footer: [
          ui.h('button', { class: 'btn', onClick: () => m.close() }, 'Cancel'),
          ui.h('button', {
            class: 'btn btn-primary',
            onClick: async (ev) => {
              const v = ui.readFormStrings(wrapEl);
              ev.currentTarget.disabled = true;
              try {
                const res = await SR.api.post(`/api/deliveries/${encodeURIComponent(job.id)}/partner-pay`, {
                  payment_method: v.payment_method || 'BANK_TRANSFER',
                });
                ui.ok(res.message || 'Payout recorded.');
                m.close();
                if (after) after();
              } catch (err) { ui.apiError(err); ev.currentTarget.disabled = false; }
            },
          }, 'Record the payout'),
        ],
      });
    }

    function termsField(job) {
      const recorded = job.settlement || job.sale_settlement;
      if (recorded) {
        return ui.h('p', { class: 'hint span-2' }, recorded === 'CREDIT'
          ? 'Recorded on credit when the sale started. The paper with the goods is an invoice, not a receipt.'
          : 'Recorded as paid on the spot. The paper with the goods is a receipt.');
      }
      const biz = SR.state.activeBusiness && SR.state.activeBusiness();
      const mods = biz && biz.modules;
      if (!mods || !mods.dispatchChoosesTerms) return null;
      return ui.field({
        label: 'How was this drop sold?',
        name: 'settlement',
        value: '',
        span: true,
        options: [
          { value: '', label: 'Choose how this drop was sold' },
          { value: 'SPOT', label: 'Paid on the spot — receipt' },
          { value: 'CREDIT', label: 'On credit — invoice, not a receipt' },
        ],
        hint: 'The cashier or the rider chooses. It is kept from this drop to the sale, and it is the paper the customer is given.',
      });
    }

    async function printDropPaper(job) {
      if (!job.sale_id) { ui.warn('This drop has no sale to print.'); return; }
      try {
        const res = await SR.api.get(`/api/sales/${encodeURIComponent(job.sale_id)}`);
        const sale = res.sale || res;
        sale.items = res.items || sale.items || [];
        sale.payments = res.payments || sale.payments || [];
        if (!sale.settlement) sale.settlement = job.settlement || job.sale_settlement || null;
        SR.print.previewSale(sale, {
          brand: (SR.state.settings || {}).business_name || 'StockRidge',
          footer: (SR.state.settings || {}).receipt_footer_text || '',
        });
      } catch (err) { ui.apiError(err); }
    }

    function loadClosed(job) {
      return ['DELIVERED', 'CANCELLED', 'RETURNED'].includes(String(job.status || '').toUpperCase());
    }

    async function attachLoad(job, after) {
      if (!SR.state.atLeast('MANAGER')) {
        ui.warn('Only a manager or above can attach the staff, the vehicle and the product amounts.');
        return;
      }
      if (loadClosed(job)) {
        ui.warn('This drop is already closed. The load stays as it was when it left.');
        return;
      }
      let items = job.items || null;
      let current = job;
      try {
        const detail = await SR.api.get(`/api/deliveries/${encodeURIComponent(job.id)}`);
        current = Object.assign({}, job, detail.job || {});
        items = detail.items || [];
      } catch (err) {
        ui.apiError(err);
        return;
      }
      let setup = null;
      let people = [];
      try {
        const [fleet, users] = await Promise.all([
          loadDispatch(),
          SR.api.get('/api/users?active=1&limit=200'),
        ]);
        setup = fleet;
        people = (users && users.data) || [];
      } catch (err) {
        ui.apiError(err);
        return;
      }
      const staff = people.filter((row) => row && Number(row.is_active) !== 0 && row.role !== 'ADMIN');
      const staffOpts = [{ value: '', label: staff.length ? 'Choose the staff member' : 'No active staff on this business' }]
        .concat(staff.map((row) => ({
          value: row.id,
          label: `${row.full_name}${row.job_title ? ` · ${row.job_title}` : ''} · ${U.humanise(String(row.role || '').toLowerCase())}`,
        })));
      const wrapEl = ui.h('div', {});
      wrapEl.appendChild(ui.h('p', { class: 'hint' }, 'A manager or above attaches who is carrying this, which vehicle, and how much of each product. The phone, the plate and whether they are on a wage or a share follow those records. A driver cannot change them while marking the drop.'));
      const fleetField = setup && setup.enabled
        ? ui.field({
          label: 'Vehicle',
          name: 'vehicle_id',
          value: current.vehicle_id || '',
          options: vehicleChoices(setup),
          required: Boolean(setup.confirmed),
          hint: setup.confirmed ? 'Has to be one of the mix the owner confirmed.' : 'No mix is confirmed, so a vehicle is optional.',
        })
        : null;
      wrapEl.appendChild(ui.h('div', { class: 'form-grid' },
        fleetField,
        ui.field({
          label: 'Staff on this dispatch',
          name: 'driver_user_id',
          value: current.driver_user_id || '',
          options: staffOpts,
          hint: 'Required when the vehicle is owned. A partner vehicle already names the person the share is paid to.',
        })));
      if (items.length) {
        wrapEl.appendChild(ui.h('p', { class: 'hint', style: { marginTop: '12px' } }, 'Amount on this vehicle. It cannot be more than the sale. A smaller amount does not put the rest back on the shelf.'));
        wrapEl.appendChild(ui.h('div', { class: 'form-grid' },
          items.map((item) => ui.field({
            label: item.product_name || 'Product',
            name: `qty_${item.id}`,
            type: 'number',
            step: '0.001',
            min: '0.001',
            value: String(item.quantity),
            hint: item.unit_code ? `Unit: ${item.unit_code}` : 'How many go on this load',
          }))));
      } else {
        wrapEl.appendChild(ui.h('p', { class: 'hint' }, 'This dispatch has no products on it yet.'));
      }
      const m = ui.openModal({
        title: `Attach the load · ${current.job_no || ''}`.trim(),
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
                const result = await SR.api.post(`/api/deliveries/${encodeURIComponent(current.id)}/assignment`, {
                  vehicle_id: v.vehicle_id || null,
                  driver_user_id: v.driver_user_id || null,
                  items: items.map((item) => ({ id: item.id, quantity: Number(v[`qty_${item.id}`]) })),
                });
                ui.ok(result.message || 'Load attached.');
                m.close();
                if (after) after();
              } catch (err) {
                ui.apiError(err);
                ev.currentTarget.disabled = false;
              }
            },
          }, 'Attach the load'),
        ],
      });
    }

    function move(job, preset, after) {
      const wrapEl = ui.h('div', {});
      wrapEl.appendChild(ui.h('p', { class: 'hint' }, 'This records what happened on the drop. The staff, the vehicle and the product amounts are attached by a manager or above, not here.'));
      if (!job.load_attached_at) {
        wrapEl.appendChild(ui.h('div', { class: 'alert alert-warn' }, 'This load has not been attached yet. A manager has to put the staff, the vehicle and the amounts on it before it leaves.'));
      } else {
        wrapEl.appendChild(ui.h('p', { class: 'hint' }, [job.driver_name || 'No staff', job.vehicle_no || job.vehicle_class].filter(Boolean).join(' · ')));
      }
      wrapEl.appendChild(ui.h('div', { class: 'form-grid' },
        ui.field({ label: 'New status', name: 'status', value: preset || job.status, options: DELIVERY_STATUSES.map((s) => ({ value: s, label: U.humanise(s) })), required: true }),
        ui.field({ label: 'Received by', name: 'delivered_to', placeholder: 'Name of the person who took delivery', hint: 'For a delivered job, this is the name a dispute is settled against.' }),
        ui.field({ label: 'Proof of delivery', name: 'proof_of_delivery', placeholder: 'Waybill number, or a note of the photo taken' }),
        ui.field({ label: 'Note', name: 'note', type: 'textarea', span: true, hint: 'Required for FAILED, RETURNED and CANCELLED. A failed drop with no reason cannot be chased up or charged back to the transporter.' }),
        ui.field({ label: 'Latitude (optional)', name: 'latitude', value: job.latitude != null ? String(job.latitude) : '', placeholder: 'Shop pin, if you have one' }),
        ui.field({ label: 'Longitude (optional)', name: 'longitude', value: job.longitude != null ? String(job.longitude) : '' }),
        ui.field({ label: 'What happened on this drop', name: 'transaction_note', type: 'textarea', span: true, value: job.transaction_note || '', placeholder: 'Paid cash at the shop, or still owing for this batch' }),
        termsField(job)));
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
              if (String(v.status || '').toUpperCase() === 'DELIVERED' && wrapEl.querySelector('[name="settlement"]') && !v.settlement) {
                ui.warn('Say whether this drop was paid on the spot or supplied on credit. The paper the customer is given depends on it.');
                return;
              }
              ev.currentTarget.disabled = true;
              try {
                const result = await SR.api.post(`/api/deliveries/${encodeURIComponent(job.id)}/status`, {
                  status: v.status,
                  delivered_to: v.delivered_to || null,
                  proof_of_delivery: v.proof_of_delivery || null,
                  note: v.note || null,
                  latitude: v.latitude || null,
                  longitude: v.longitude || null,
                  transaction_note: v.transaction_note || null,
                  settlement: v.settlement || null,
                });
                ui.ok(result.message || `Marked ${U.humanise(v.status).toLowerCase()}.`);
                m.close();
                if (after) after();
                if (String(v.status).toUpperCase() === 'DELIVERED' && job.sale_id) {
                  printDropPaper(Object.assign({}, job, { settlement: result.settlement || v.settlement || job.settlement }));
                }
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
        ui.field({ label: 'Fee collected (₦)', name: 'fee_collected', type: 'number', step: '0.01', min: '0', value: '0', hint: 'What was taken now. It posts as installation income. Leave at zero if it is still to be collected.' }),
        ui.field({ label: 'Taken from', name: 'payment_method', value: 'CASH', options: [
          { value: 'CASH', label: 'Cash' },
          { value: 'BANK_TRANSFER', label: 'Bank' },
          { value: 'POS_TERMINAL', label: 'POS' },
          { value: 'MOBILE_MONEY', label: 'Mobile money' },
        ] }),
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
                  payment_method: v.payment_method || 'CASH',
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
        ui.field({ label: 'Parts used, cost (₦)', name: 'parts_cost', type: 'number', step: '0.01', min: '0', value: U.numInput(installation.parts_cost), hint: 'Posts as a repair cost. It does not take a spare off the shelf.' }),
        ui.field({ label: 'Fee collected so far (₦)', name: 'fee_collected', type: 'number', step: '0.01', min: '0', value: U.numInput(installation.fee_collected), hint: 'The total taken, including what was taken when the job was booked. Only the extra posts now.' }),
        ui.field({ label: 'Taken from', name: 'payment_method', value: 'CASH', options: [
          { value: 'CASH', label: 'Cash' },
          { value: 'BANK_TRANSFER', label: 'Bank' },
          { value: 'POS_TERMINAL', label: 'POS' },
          { value: 'MOBILE_MONEY', label: 'Mobile money' },
        ] }),
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
                  payment_method: v.payment_method || 'CASH',
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
