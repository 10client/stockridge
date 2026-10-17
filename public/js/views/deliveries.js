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
        ? `This business releases goods on ${sentence || 'a confirmed mix'}. A driver is Staff. The share is of the goods, not of the delivery fee.`
        : 'The mix is only a suggestion until an owner saves it. A drop cannot leave, and a partner cannot be paid, on a suggestion.');
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
      const add = setup.confirmed && SR.state.atLeast('MANAGER')
        ? ui.h('button', { class: 'btn btn-sm', onClick: () => addVehicle(setup, after) }, 'Add a vehicle')
        : null;
      const table = ui.renderTable({
        columns: [
          { key: 'name', label: 'Vehicle' },
          { key: 'vehicle_class', label: 'Type', render: (row) => U.humanise(String(row.vehicle_class || '').toLowerCase()) },
          { key: 'arrangement', label: 'Pay', render: (row) => (row.arrangement === 'PARTNER' ? `Partner · ${row.sales_share_pct}% of sales` : 'Ours · wage') },
          { key: 'plate_no', label: 'Plate', render: (row) => row.plate_no || '—' },
          { key: 'driver_name', label: 'Usual driver', render: (row) => row.driver_name || '—' },
        ],
        rows: setup.vehicles || [],
        emptyTitle: 'No vehicles yet',
        emptyMessage: setup.confirmed
          ? 'Add the pickup, the keke or the bike that actually leaves the gate. The type has to be one of the mix above.'
          : 'Confirm the mix, then add the vehicles.',
      });
      const card = ui.h('div', { class: 'card' },
        ui.h('div', { class: 'card-head' }, ui.h('h2', {}, 'Dispatch'), add || confirm),
        ui.h('div', { class: 'card-body' }, note, confirm && add ? confirm : null, table));
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

  // -------------------------------------------------------------------
  // ONE JOB
  function paintPlant(host, after) {
    if (!SR.state.moduleOn('manufacturing') && !SR.state.moduleOn('creditUntilPaid')) {
      host.replaceChildren();
      return;
    }
    host.replaceChildren(ui.loading('Reading the plant…'));
    SR.api.get('/api/plant', { query: SR.state.query({}) }).then((plant) => {
      const card = ui.h('div', { class: 'card' });
      card.appendChild(ui.h('div', { class: 'card-head' },
        ui.h('h2', {}, 'The plant'),
        ui.h('div', { class: 'actions' },
          SR.state.atLeast('MANAGER') && plant.missing && plant.missing.length
            ? ui.h('button', { class: 'btn btn-sm', onClick: () => ensureInputs(after) }, 'Add the usual inputs')
            : null,
          SR.state.atLeast('MANAGER') && plant.manufacturing
            ? ui.h('button', { class: 'btn btn-sm', onClick: () => addInput(after) }, 'Add an input')
            : null,
          SR.state.atLeast('MANAGER') && plant.manufacturing
            ? ui.h('button', { class: 'btn btn-sm', onClick: () => addAsset(after) }, 'Add a machine or tool')
            : null)));
      const body = ui.h('div', { class: 'card-body stack' });
      body.appendChild(ui.h('div', { class: 'grid grid-3' },
        ui.kpi({
          label: 'Unpaid supplies',
          value: String((plant.openCredit || []).length),
          foot: plant.creditUntilPaid ? 'Next batch held until paid' : 'Credit hold is off',
          tone: (plant.openCredit || []).length ? 'warn' : 'good',
          small: true,
        }),
        ui.kpi({
          label: 'Manufacturing stock',
          value: U.money(plant.inputValue || 0),
          foot: `${(plant.inputs || []).length} input${(plant.inputs || []).length === 1 ? '' : 's'}`,
          small: true,
        }),
        ui.kpi({
          label: 'Machinery service, 30 days',
          value: U.money(plant.machinery && plant.machinery.days30),
          foot: plant.machinery && plant.machinery.allTime ? `${U.money(plant.machinery.allTime)} in all` : 'Record a service when a machine is worked on',
          small: true,
        })));
      if (plant.creditUntilPaid) {
        body.appendChild(ui.h('p', { class: 'hint' }, 'A shop supplied on credit does not collect the next batch until that supply is paid. A cash sale is not held. An owner can release one batch, and the reason stays on the sale.'));
      }
      if ((plant.openCredit || []).length) {
        body.appendChild(ui.h('div', { class: 'stack' }, (plant.openCredit || []).slice(0, 8).map((row) => ui.h('div', {},
          ui.h('strong', {}, row.name),
          ` · ${U.money(row.balance)} unpaid`,
          row.phone ? ` · ${row.phone}` : ''))));
      }
      if (plant.manufacturing) {
        body.appendChild(ui.h('h3', {}, 'Machines and tools'));
        body.appendChild(ui.h('p', { class: 'hint' }, 'A filler, an oven, a UV lamp, a mixer, a generator, a sealing jaw, a scale. Record the day it was gotten and what it cost. Each repair adds to the maintenance that machine has taken. When it stops working, the date stays. It is not deleted.'));
        if ((plant.assets || []).length) {
          body.appendChild(ui.h('div', { class: 'stack' }, (plant.assets || []).map((asset) => {
            const line = ui.h('div', { class: 'row', style: { justifyContent: 'space-between', gap: '8px', alignItems: 'flex-start' } });
            const stopped = asset.status === 'STOPPED';
            line.appendChild(ui.h('div', {},
              ui.h('strong', {}, asset.name),
              ` · ${asset.kind === 'TOOL' ? 'Tool' : 'Machine'}`,
              stopped ? ui.badge('stopped', 'badge-bad') : ui.badge('working', 'badge-good'),
              ui.h('div', { class: 'hint' }, [
                `Gotten ${asset.acquiredAt} · ${U.money(asset.purchasePrice)}`,
                `Maintenance ${U.money(asset.maintenanceTotal)}${asset.maintenanceCount ? ` across ${asset.maintenanceCount}` : ''}`,
                stopped ? `Stopped ${asset.stoppedAt}${asset.stoppedReason ? ` — ${asset.stoppedReason}` : ''}` : null,
              ].filter(Boolean).join(' · '))));
            if (SR.state.atLeast('MANAGER')) {
              const actions = ui.h('div', { class: 'btn-row' });
              actions.appendChild(ui.h('button', { class: 'btn btn-sm', onClick: () => serviceAsset(asset, after) }, 'Maintenance'));
              actions.appendChild(stopped
                ? ui.h('button', { class: 'btn btn-sm', onClick: () => restartAsset(asset, after) }, 'Back in use')
                : ui.h('button', { class: 'btn btn-sm', onClick: () => stopAsset(asset, after) }, 'Stopped working'));
              line.appendChild(actions);
            }
            return line;
          })));
        } else {
          body.appendChild(ui.h('p', { class: 'hint' }, 'No machine or tool recorded yet. Add the ones this plant actually has. Do not invent a price — put what was paid when it was gotten.'));
        }
        body.appendChild(ui.h('h3', {}, 'Production stock'));
        body.appendChild(ui.h('p', { class: 'hint' }, 'Film rolls, flour, sugar, yeast, alum, chlorine, filter cartridges — whatever this plant uses to produce. Record each delivery: the day it was gotten, the price, and the amount. It sits on the same stock as the rest of the plant. It is not a second list, and it is not a recipe.'));
      }
      if ((plant.inputs || []).length) {
        body.appendChild(ui.h('div', { class: 'stack' }, (plant.inputs || []).map((row) => {
          const line = ui.h('div', { class: 'row', style: { justifyContent: 'space-between', gap: '8px' } });
          const last = (plant.receipts || []).find((receipt) => receipt.productId === row.id);
          line.appendChild(ui.h('div', {},
            ui.h('strong', {}, row.name),
            ui.h('div', { class: 'hint' }, `${U.qty(row.onHand)} ${row.unit || ''} on hand · ${U.money(row.value)}${row.offersSale ? ' · also sold at the till' : ' · not sold at the till'}`),
            ui.h('div', { class: 'hint' }, last
              ? `Last gotten ${String(last.receivedAt || '').slice(0, 10)} · ${U.qty(last.quantity)} at ${U.money(last.price)} each`
              : 'Not received yet. Record the day, the price and the amount.')));
          if (SR.state.atLeast('MANAGER')) {
            const actions = ui.h('div', { class: 'btn-row' });
            actions.appendChild(ui.h('button', { class: 'btn btn-sm btn-primary', onClick: () => receiveInput(row, after) }, 'Receive'));
            actions.appendChild(ui.h('button', { class: 'btn btn-sm', onClick: () => toggleSale(row, after) }, row.offersSale ? 'Stop selling' : 'Also sell'));
            line.appendChild(actions);
          }
          return line;
        })));
      } else if (plant.manufacturing) {
        body.appendChild(ui.h('p', { class: 'hint' }, 'No manufacturing inputs yet. Add treatment chemical, film, flour, leather or whatever this plant uses. They are counted as stock and stay off the till unless you also sell them.'));
      }
      card.appendChild(body);
      host.replaceChildren(card);
    }).catch((err) => {
      host.replaceChildren(ui.h('div', { class: 'alert alert-warn' }, (err && err.message) || 'The plant count could not be read.'));
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
    wrapEl.appendChild(ui.h('p', { class: 'hint' }, 'Name what this plant actually uses. Chemicals, film, flour, yeast, leather — the name is yours. It is counted as stock and is not sold at the till unless you tick that.'));
    wrapEl.appendChild(ui.h('div', { class: 'form-grid' },
      ui.field({ label: 'Name', name: 'name', required: true, placeholder: 'Alum, nylon, leather, yeast' }),
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
                cost: v.cost === '' ? 0 : Number(v.cost),
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
    wrapEl.appendChild(ui.h('p', { class: 'hint' }, 'Name the machine or tool this plant has. A sachet filler, a UV sterilizer, an oven, a spiral mixer, a generator, a sealing jaw, a scale. The date and the price are what was paid when it was gotten. Do not guess a market price.'));
    wrapEl.appendChild(ui.h('div', { class: 'form-grid' },
      ui.field({ label: 'Name', name: 'name', required: true, placeholder: 'Sachet filling machine' }),
      ui.field({ label: 'Kind', name: 'kind', value: 'MACHINE', options: [
        { value: 'MACHINE', label: 'Machine' },
        { value: 'TOOL', label: 'Tool' },
      ] }),
      ui.field({ label: 'Date gotten', name: 'acquired_at', type: 'date', required: true }),
      ui.field({ label: 'Price paid (₦)', name: 'purchase_price', type: 'number', step: '0.01', min: '0', required: true }),
      ui.field({ label: 'Where it was gotten', name: 'supplier_name', placeholder: 'Optional' }),
      ui.field({ label: 'Serial number', name: 'serial_no', placeholder: 'If it has one' })));
    const m = ui.openModal({
      title: 'Add a machine or tool',
      body: wrapEl,
      footer: [
        ui.h('button', { class: 'btn', onClick: () => m.close() }, 'Cancel'),
        ui.h('button', {
          class: 'btn btn-primary',
          onClick: async (ev) => {
            const v = ui.readFormStrings(wrapEl);
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
    wrapEl.appendChild(ui.h('p', { class: 'hint' }, `This adds to the maintenance ${asset.name} has taken. The money is an expense on the same books, pointed at this machine.`));
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
            const v = ui.readFormStrings(wrapEl);
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
    wrapEl.appendChild(ui.h('p', { class: 'hint' }, `${asset.name} stays on the register. Stopping it records the day and why. It does not remove the price or the maintenance already taken.`));
    wrapEl.appendChild(ui.h('div', { class: 'form-grid' },
      ui.field({ label: 'Date it stopped', name: 'stopped_at', type: 'date', required: true }),
      ui.field({ label: 'Why it stopped', name: 'reason', required: true, span: true, placeholder: 'Burnt element, seized gearbox, cracked jaw' })));
    const m = ui.openModal({
      title: `Stopped working · ${asset.name}`,
      body: wrapEl,
      footer: [
        ui.h('button', { class: 'btn', onClick: () => m.close() }, 'Cancel'),
        ui.h('button', {
          class: 'btn btn-primary',
          onClick: async (ev) => {
            const v = ui.readFormStrings(wrapEl);
            if (!v.stopped_at) { ui.warn('Enter the day it stopped.'); return; }
            if (!v.reason || String(v.reason).trim().length < 4) { ui.warn('Say why it stopped.'); return; }
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
        }, 'Record that it stopped'),
      ],
    });
  }

  function restartAsset(asset, after) {
    SR.api.post(`/api/plant/assets/${encodeURIComponent(asset.id)}/stop`, { status: 'WORKING' }, { query: SR.state.query({}) }).then((res) => {
      ui.ok(res.message || `${asset.name} is back in use.`);
      if (after) after();
    }).catch((err) => ui.apiError(err));
  }

  function receiveInput(row, after) {
    const wrapEl = ui.h('div', {});
    wrapEl.appendChild(ui.h('p', { class: 'hint' }, `Record this delivery of ${row.name}. The day, the price and the amount go onto the plant stock. The payment is recorded as paid on delivery, the same way any other goods receipt is.`));
    wrapEl.appendChild(ui.h('div', { class: 'form-grid' },
      ui.field({ label: 'Date gotten', name: 'received_on', type: 'date', required: true, value: U.todayWat() }),
      ui.field({ label: `Amount (${row.unit || 'units'})`, name: 'quantity', type: 'number', step: '0.001', min: '0', required: true }),
      ui.field({ label: 'Price each (₦)', name: 'price', type: 'number', step: '0.01', min: '0', required: true }),
      ui.field({ label: 'Supplier', name: 'supplier_name', placeholder: 'Optional' })));
    const m = ui.openModal({
      title: `Receive ${row.name}`,
      body: wrapEl,
      footer: [
        ui.h('button', { class: 'btn', onClick: () => m.close() }, 'Cancel'),
        ui.h('button', {
          class: 'btn btn-primary',
          onClick: async (ev) => {
            const v = ui.readFormStrings(wrapEl);
            if (!v.received_on) { ui.warn('Enter the day it was gotten.'); return; }
            if (!(Number(v.quantity) > 0)) { ui.warn('Enter the amount gotten.'); return; }
            if (!(Number(v.price) > 0)) { ui.warn('Enter the price paid for each.'); return; }
            ev.currentTarget.disabled = true;
            try {
              const res = await SR.api.post(`/api/plant/inputs/${encodeURIComponent(row.id)}/receive`, {
                received_on: v.received_on,
                quantity: Number(v.quantity),
                price: Number(v.price),
                supplier_name: v.supplier_name || null,
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
    SR.api.put(`/api/products/${encodeURIComponent(row.id)}`, { offers_sale: row.offersSale ? 0 : 1 }).then(() => {
      ui.ok(row.offersSale ? `${row.name} stays on the plant stock and is off the till.` : `${row.name} is still counted as an input, and the till can sell it.`);
      if (after) after();
    }).catch((err) => ui.apiError(err));
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
