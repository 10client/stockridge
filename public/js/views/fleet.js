'use strict';
// A dispatch vehicle is its own record: who is driving it, what it sold,
// what it cost to keep on the road, and who bought from it.
(function (global) {
  const SR = global.SR;
  const ui = SR.ui;
  const U = SR.util;

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
  const PERIODS = [
    { value: 'DAY', label: 'Today' },
    { value: 'WEEK', label: 'This week' },
    { value: 'UNTIL_CHANGED', label: 'Until I change the driver' },
  ];
  const COST_CATEGORIES = [
    { value: 'DIESEL_FUEL', label: 'Fuel' },
    { value: 'REPAIRS_MAINTENANCE', label: 'Repair' },
    { value: 'MACHINERY_SERVICE', label: 'Service' },
    { value: 'DRIVER_WAGES', label: 'Driver wage' },
    { value: 'TRANSPORT_LOGISTICS', label: 'Transport' },
    { value: 'MISC', label: 'Other' },
  ];

  function manager() { return SR.state.atLeast && SR.state.atLeast('MANAGER'); }
  function owner() { return SR.state.atLeast && SR.state.atLeast('OWNER'); }

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

  function periodLabel(row) {
    if (!row) return 'Nobody assigned';
    if (row.period === 'UNTIL_CHANGED') return `Until a manager changes the driver · from ${U.date(row.starts_on)}`;
    if (row.period === 'WEEK') return `This week · ${U.date(row.starts_on)} to ${U.date(row.ends_on)}`;
    return `Today · ${U.date(row.starts_on)}`;
  }

  function editMix(setup, after) {
    const modes = setup.modes || [];
    const first = modes[0] || { vehicleClass: 'TRICYCLE', arrangement: 'OWNED', salesSharePct: 8 };
    const second = modes[1] || null;
    const wrapEl = ui.h('div', {});
    wrapEl.appendChild(ui.h('p', { class: 'hint' }, 'One type, or two. A vehicle you add has to be one of these.'));
    wrapEl.appendChild(ui.h('div', { class: 'form-grid' },
      ui.field({ label: 'First vehicle', name: 'dispatch_class_1', value: first.vehicleClass, options: DISPATCH_VEHICLES }),
      ui.field({ label: 'Who owns it', name: 'dispatch_arrangement_1', value: first.arrangement, options: DISPATCH_HOW }),
      ui.field({ label: 'Partner share %', name: 'dispatch_share_1', type: 'number', min: '1', max: '40', step: '0.5', value: first.salesSharePct || 8 }),
      ui.field({ label: 'Second vehicle', name: 'dispatch_class_2', value: second ? second.vehicleClass : '', options: [{ value: '', label: 'None — one is enough' }, ...DISPATCH_VEHICLES] }),
      ui.field({ label: 'Who owns the second', name: 'dispatch_arrangement_2', value: second ? second.arrangement : 'PARTNER', options: DISPATCH_HOW }),
      ui.field({ label: 'Second share %', name: 'dispatch_share_2', type: 'number', min: '1', max: '40', step: '0.5', value: (second && second.salesSharePct) || 8 })));
    const m = ui.openModal({
      title: 'Confirm the vehicles',
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
              ui.ok(res.message || 'Saved.');
              m.close();
              if (after) after();
            } catch (err) { ui.apiError(err); ev.currentTarget.disabled = false; }
          },
        }, 'Save'),
      ],
    });
  }

  function addVehicle(setup, after) {
    const modes = setup.modes || [];
    const wrapEl = ui.h('div', {});
    wrapEl.appendChild(ui.h('p', { class: 'hint' }, 'Name it so two kekes are not the same row. The usual driver here is not the person assigned for today — that assignment is separate.'));
    wrapEl.appendChild(ui.h('div', { class: 'form-grid' },
      ui.field({
        label: 'Type',
        name: 'mode',
        required: true,
        options: modes.map((mode, i) => ({
          value: String(i),
          label: `${U.humanise(String(mode.vehicleClass).toLowerCase())} · ${mode.arrangement === 'PARTNER' ? 'partner' : 'ours'}`,
        })),
      }),
      ui.field({ label: 'Name', name: 'name', required: true, placeholder: 'Keke 2' }),
      ui.field({ label: 'Plate', name: 'plate_no', placeholder: 'If it has one' })));
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
            if (!mode) { ui.warn('Confirm the mix first.'); return; }
            ev.currentTarget.disabled = true;
            try {
              const res = await SR.api.post('/api/dispatch/vehicles', {
                vehicle_class: mode.vehicleClass,
                arrangement: mode.arrangement,
                name: v.name,
                plate_no: v.plate_no,
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

  async function assignDuty(vehicle, after) {
    let users = [];
    try {
      const res = await SR.api.get('/api/users', { query: SR.state.query({ active: 1, limit: 200 }) });
      users = (res.data || []).filter((row) => row.role !== 'ADMIN');
    } catch (err) {
      ui.apiError(err);
      return;
    }
    if (!users.length) {
      ui.warn('Add a member of staff first. A vehicle is assigned to someone who can sign in and sell.');
      return;
    }
    const wrapEl = ui.h('div', {});
    wrapEl.appendChild(ui.h('p', { class: 'hint' }, 'Today, this week, or until you change it. Assigning someone else ends the open assignment on this vehicle, and ends any other vehicle that person still has.'));
    wrapEl.appendChild(ui.h('div', { class: 'form-grid' },
      ui.field({
        label: 'Staff',
        name: 'user_id',
        required: true,
        options: users.map((row) => ({ value: row.id, label: `${row.full_name || row.username} · ${row.role}` })),
      }),
      ui.field({ label: 'For how long', name: 'period', value: 'DAY', options: PERIODS }),
      ui.field({ label: 'Starts', name: 'starts_on', type: 'date', value: U.today ? U.today() : '' })));
    const m = ui.openModal({
      title: `Assign ${vehicle.name}`,
      body: wrapEl,
      footer: [
        ui.h('button', { class: 'btn', onClick: () => m.close() }, 'Cancel'),
        ui.h('button', {
          class: 'btn btn-primary',
          onClick: async (ev) => {
            const v = ui.readFormStrings(wrapEl);
            ev.currentTarget.disabled = true;
            try {
              const res = await SR.api.post('/api/dispatch/duties', {
                vehicle_id: vehicle.id,
                user_id: v.user_id,
                period: v.period,
                starts_on: v.starts_on || undefined,
              }, { query: SR.state.query({}) });
              ui.ok(res.message || 'Assigned.');
              m.close();
              if (after) after();
            } catch (err) { ui.apiError(err); ev.currentTarget.disabled = false; }
          },
        }, 'Assign'),
      ],
    });
  }

  function sellFrom(vehicle) {
    const cart = SR.state.loadCart() || { lines: [], saleType: 'RETAIL', settlement: 'SPOT', payments: [] };
    cart.salePlace = 'VEHICLE';
    cart.vehicleId = vehicle.id;
    SR.state.saveCart(cart);
    SR.app.navigate('/pos');
  }

  async function renderList(ctx) {
    ctx.setTitle('Vehicles');
    const wrap = ui.h('div', { class: 'stack' });
    const water = (SR.state.activeBusiness() || {}).profile_code === 'WATER_PACKING';
    wrap.appendChild(ui.h('div', { class: 'page-head' },
      ui.h('div', {},
        ui.h('h1', {}, 'Vehicles'),
        ui.h('p', { class: 'sub' }, water
          ? 'Each keke, bike or van is its own book. Assign who takes it out, then sell from it or from the plant floor.'
          : 'Each vehicle is its own book: sales, fuel, repairs, customers and the driver assigned for the day, the week, or until you change them.')),
      ui.h('div', { class: 'actions' },
        ui.h('button', { class: 'btn btn-sm', onClick: () => load() }, 'Refresh'))));
    const host = ui.h('div', { class: 'stack' });
    wrap.appendChild(host);

    async function load() {
      host.replaceChildren(ui.loading('Reading the fleet…'));
      let setup;
      try {
        setup = await SR.api.get('/api/dispatch', { query: SR.state.query({}) });
      } catch (err) {
        host.replaceChildren(ui.errorBlock(err, { retry: { label: 'Try again', run: load } }));
        return;
      }
      if (!setup.enabled) {
        host.replaceChildren(ui.empty({ title: 'No dispatch vehicles', message: 'This business does not sell from a vehicle.' }));
        return;
      }
      if (!manager()) {
        try {
          const dutyRes = await SR.api.get('/api/dispatch/duties', { query: SR.state.query({ mine: 1, active: 1 }) });
          const mine = new Set((dutyRes.data || []).map((row) => String(row.vehicle_id)));
          setup.vehicles = (setup.vehicles || []).filter((row) => mine.has(String(row.id)));
        } catch (e) {
          setup.vehicles = [];
        }
      }
      const actions = ui.h('div', { class: 'actions' });
      if (owner()) actions.appendChild(ui.h('button', { class: 'btn btn-sm', onClick: () => editMix(setup, load) }, setup.confirmed ? 'Change the mix' : 'Confirm the mix'));
      if (manager() && setup.confirmed) actions.appendChild(ui.h('button', { class: 'btn btn-primary btn-sm', onClick: () => addVehicle(setup, load) }, 'Add a vehicle'));
      const cards = (setup.vehicles || []).map((row) => ui.h('div', { class: 'card' },
        ui.h('div', { class: 'card-body' },
          ui.h('div', { class: 'card-head' },
            ui.h('h2', {}, row.name),
            Number(row.is_active) === 0 ? ui.badge('off', 'badge-mute') : null),
          ui.h('p', { class: 'hint' }, [U.humanise(String(row.vehicle_class || '').toLowerCase()), row.plate_no, row.arrangement === 'PARTNER' ? 'partner' : 'ours', row.driver_name ? `usual driver ${row.driver_name}` : null].filter(Boolean).join(' · ')),
          ui.h('div', { class: 'actions' },
            ui.h('button', { class: 'btn btn-sm btn-primary', onClick: () => SR.app.navigate(`/fleet/${encodeURIComponent(row.id)}`) }, 'Open'),
            manager() ? ui.h('button', { class: 'btn btn-sm', onClick: () => assignDuty(row, load) }, 'Assign') : null))));
      host.replaceChildren(
        actions,
        !setup.confirmed ? ui.h('div', { class: 'alert alert-warn' }, 'The owner confirms which vehicles this plant uses before anyone can be assigned.') : null,
        cards.length ? ui.h('div', { class: 'stack' }, ...cards) : ui.empty({ title: 'No vehicles yet', message: setup.confirmed ? 'Add the first one. A type saved with the business may already be here after a refresh.' : 'Confirm the mix first.' }));
    }
    await load();
    return wrap;
  }

  function moneyRow(label, value) {
    return ui.h('div', { class: 'totals-row' }, ui.h('span', {}, label), ui.h('span', {}, value));
  }

  function recordExpense(vehicle, after) {
    const wrapEl = ui.h('div', {});
    wrapEl.appendChild(ui.h('p', { class: 'hint' }, 'Fuel, a repair, or a wage sits on this vehicle. It is not a second stock book.'));
    wrapEl.appendChild(ui.h('div', { class: 'form-grid' },
      ui.field({ label: 'What', name: 'category', value: 'DIESEL_FUEL', options: COST_CATEGORIES }),
      ui.field({ label: 'Amount', name: 'amount', type: 'number', min: '0.01', step: '0.01', required: true }),
      ui.field({ label: 'Date', name: 'expense_date', type: 'date', value: U.todayWat() }),
      ui.field({ label: 'What it was for', name: 'description', required: true, placeholder: 'Diesel for the morning round', span: true })));
    const m = ui.openModal({
      title: `Cost on ${vehicle.name}`,
      body: wrapEl,
      footer: [
        ui.h('button', { class: 'btn', onClick: () => m.close() }, 'Cancel'),
        ui.h('button', {
          class: 'btn btn-primary',
          onClick: async (ev) => {
            const v = ui.readForm(wrapEl);
            if (!v.description || String(v.description).trim().length < 4) { ui.warn('Say what this was for.'); return; }
            ev.currentTarget.disabled = true;
            try {
              const res = await SR.api.post('/api/expenses', {
                category: v.category,
                amount: v.amount,
                description: v.description,
                expense_date: v.expense_date || undefined,
                vehicle_id: vehicle.id,
                branch_id: SR.state.activeBranchId,
                business_id: SR.state.activeBusinessId,
              }, { query: SR.state.query({}) });
              ui.ok(res.message || 'Recorded on this vehicle.');
              m.close();
              if (after) after();
            } catch (err) { ui.apiError(err); ev.currentTarget.disabled = false; }
          },
        }, 'Record'),
      ],
    });
  }

  async function renderRecord(ctx) {
    ctx.setTitle('Vehicle');
    const wrap = ui.h('div', { class: 'stack' });
    wrap.appendChild(ui.loading('Opening the vehicle…'));
    let data;
    try {
      data = await SR.api.get(`/api/dispatch/vehicles/${encodeURIComponent(ctx.params.id)}/record`, { query: SR.state.query({}) });
    } catch (err) {
      return ui.h('div', { class: 'stack' }, ui.errorBlock(err, { retry: { label: 'Back', run: () => SR.app.navigate('/fleet') } }));
    }
    const vehicle = data.vehicle || {};
    const driver = data.driver;
    const mine = driver && SR.state.user && String(driver.user_id) === String(SR.state.user.id);
    wrap.replaceChildren();
    wrap.appendChild(ui.h('div', { class: 'page-head' },
      ui.h('div', {},
        ui.h('h1', {}, vehicle.name || 'Vehicle'),
        ui.h('p', { class: 'sub' }, [vehicle.plate_no, U.humanise(String(vehicle.vehicle_class || '').toLowerCase()), vehicle.arrangement === 'PARTNER' ? 'partner' : 'ours'].filter(Boolean).join(' · '))),
      ui.h('div', { class: 'actions' },
        ui.h('button', { class: 'btn btn-sm', onClick: () => SR.app.navigate('/fleet') }, 'All vehicles'),
        mine ? ui.h('button', { class: 'btn btn-primary btn-sm', onClick: () => sellFrom(vehicle) }, 'Sell from this vehicle') : null,
        manager() ? ui.h('button', { class: 'btn btn-sm', onClick: () => assignDuty(vehicle, () => SR.app.navigate(`/fleet/${encodeURIComponent(vehicle.id)}`)) }, 'Assign') : null,
        manager() ? ui.h('button', { class: 'btn btn-sm', onClick: () => recordExpense(vehicle, () => SR.app.navigate(`/fleet/${encodeURIComponent(vehicle.id)}`)) }, 'Record a cost') : null)));

    wrap.appendChild(ui.h('div', { class: 'card' },
      ui.h('div', { class: 'card-body' },
        ui.h('h2', {}, 'Driver'),
        driver
          ? ui.h('div', {},
            ui.h('div', {}, driver.full_name || driver.username),
            ui.h('div', { class: 'hint' }, [periodLabel(driver), driver.phone].filter(Boolean).join(' · ')),
            manager() ? ui.h('button', {
              class: 'btn btn-sm',
              style: { marginTop: '10px' },
              onClick: async (ev) => {
                ev.currentTarget.disabled = true;
                try {
                  const res = await SR.api.post(`/api/dispatch/duties/${encodeURIComponent(driver.id)}/end`, {}, { query: SR.state.query({}) });
                  ui.ok(res.message || 'Assignment ended.');
                  SR.app.navigate(`/fleet/${encodeURIComponent(vehicle.id)}`);
                } catch (err) { ui.apiError(err); ev.currentTarget.disabled = false; }
              },
            }, 'End this assignment') : null)
          : ui.h('p', { class: 'hint' }, vehicle.driver_name
            ? `Nobody is assigned for a dated duty. The usual name on the vehicle is ${vehicle.driver_name}. A manager assigns a member of staff before they can sell from it.`
            : 'Nobody is assigned. A manager assigns a member of staff for today, this week, or until they change the driver.'))));

    const totals = data.totals || {};
    wrap.appendChild(ui.h('div', { class: 'card' },
      ui.h('div', { class: 'card-body' },
        ui.h('h2', {}, 'On this vehicle'),
        moneyRow('Sales', U.money(totals.salesTotal || 0)),
        moneyRow('Sales count', String(totals.salesCount || 0)),
        moneyRow('Costs recorded here', U.money(totals.expenseTotal || 0)))));

    wrap.appendChild(section('Sales', (data.sales || []).map((row) => ui.h('div', { class: 'totals-row' },
      ui.h('span', {}, `${row.receipt_no || 'Sale'} · ${row.customer_name || 'Walk-in'}`),
      ui.h('span', {}, `${U.money(row.total)} · ${U.date(row.sold_at)}`))), 'No sale has been recorded on this vehicle yet.'));

    wrap.appendChild(section('Customers', (data.customers || []).map((row) => ui.h('div', { class: 'totals-row' },
      ui.h('span', {}, row.customer_name || row.customer_phone || 'Walk-in'),
      ui.h('span', {}, `${row.sales_count} · ${U.money(row.spent)}`))), 'No named customer yet.'));

    wrap.appendChild(section('Maintenance and costs', (data.expenses || []).map((row) => ui.h('div', { class: 'totals-row' },
      ui.h('span', {}, `${U.humanise(String(row.category || '').toLowerCase())} · ${row.description || ''}`),
      ui.h('span', {}, `${U.money(row.amount)} · ${U.date(row.expense_date)}`))), 'No fuel, repair or wage has been recorded on this vehicle.'));

    if ((data.rounds || []).length) {
      wrap.appendChild(section('Rounds', data.rounds.map((row) => ui.h('div', { class: 'totals-row' },
        ui.h('span', {}, row.job_no || row.delivery_address || 'Round'),
        ui.h('span', {}, row.status))), ''));
    }

    if ((data.duties || []).length) {
      wrap.appendChild(section('Who has had it', data.duties.map((row) => ui.h('div', { class: 'totals-row' },
        ui.h('span', {}, row.full_name || row.username),
        ui.h('span', {}, row.ended_at ? `Ended ${U.date(row.ends_on || row.ended_at)}` : periodLabel(row)))), ''));
    }
    return wrap;
  }

  function section(title, rows, empty) {
    return ui.h('div', { class: 'card' },
      ui.h('div', { class: 'card-body stack' },
        ui.h('h2', {}, title),
        rows.length ? rows : ui.h('p', { class: 'hint' }, empty)));
  }

  async function render(ctx) {
    if (ctx.params && ctx.params.id) return renderRecord(ctx);
    return renderList(ctx);
  }

  SR.views = SR.views || {};
  SR.views.fleet = { render };
}(window));
