'use strict';
// =====================================================================
// public/js/views/admin.js — THE BUSINESS, ITS BRANCHES AND ITS CONTROLS
// =====================================================================
// One file, four screens, because they are four views of the same thing: how
// this deployment is set up. The router picks the section:
//
//   /branches    where the business trades, and each shop's geofence
//   /businesses  the legal entities — each with its own books
//   /settings    the controls: what staff may do, VAT, credit caps
//   /audit       what has happened, hash-chained so it cannot be edited
//
// The settings section is the one that decides what the rest of the system
// allows, so it is not a list of switches. Each flag is grouped with the cap
// that gives it meaning, and the server refuses contradictory combinations
// (a staff void window of zero minutes with staff voiding switched on, for
// example). Those refusals are surfaced here rather than being discovered at
// the counter on a busy Saturday.
// =====================================================================
(function (global) {
  const SR = global.SR;
  const ui = SR.ui;
  const U = SR.util;

  const BRANCH_TYPES = ['RETAIL', 'WHOLESALE', 'WAREHOUSE', 'SHOWROOM', 'MIXED'];
  const ATTENDANCE_MODES = [
    { value: 'GEOLOCATION', label: 'Geolocation — record where the phone was' },
    { value: 'REGISTERED_DEVICE', label: 'Registered device — only known devices' },
  ];

  // Which settings are switches, which are numbers, and how they pair up. The
  // grouping is the point: "staff may void sales" means nothing without the
  // window beside it.
  // =====================================================================
  // EVERY CONTROL HERE IS BACKED BY A COLUMN THE SERVER READS.
  // =====================================================================
  // This list is data, and it is checked rather than trusted:
  // `test/unit/settings-controls.test.js` fails the build if a control names a
  // key that is not in `DEFAULT_SETTINGS`, if two controls claim the same key, if
  // a writable column has neither a control nor a documented reason for being
  // hidden, or if a number control's range contradicts its default.
  //
  // WHAT WAS WRONG BEFORE. Fifteen of the thirty controls named keys that do not
  // exist in `client_settings` — `low_stock_alerts` where the column is
  // `low_stock_alert_enabled`, `receipt_footer` where it is `receipt_footer_text`,
  // `require_serial_capture` where the flag is the whole module. The renderer
  // skips a key the deployment does not have (`if (!(item.key in s)) continue`),
  // so those controls did not sit there failing to save: THEY NEVER DREW. An owner
  // could not switch on a stock warning, because the switch was not on the page
  // and nothing said why.
  //
  // The other half of the same defect: twenty-nine writable columns had no control
  // at all. A merchant could not set how long a customer has to pay, what deposit a
  // layaway needs, how many months an instalment plan may run, whether managers may
  // void, or whether the shop does deliveries. The columns existed, the server read
  // them, and the only way to change one was to ask us.
  //
  // AND THE SWITCHES THAT LIED. Some settings describe behaviour that has no
  // alternative — the app always treats quoted prices as VAT-inclusive, always
  // requires an open till to sell, always refuses credit above a customer's limit.
  // A switch for those promises a choice that does not exist, and the owner who
  // turns it off believes something changed. Those are `type: 'fact'` now: the
  // same place on the screen, the same font size, and they state what the system
  // does instead of pretending to be a preference.
  const SETTING_GROUPS = [
    {
      title: 'Modules',
      blurb: 'What this deployment does. A module switched off is refused by the server, not merely hidden on the screen.',
      items: [
        { key: 'attendance_module_enabled', type: 'flag', label: 'Staff attendance and clock-in' },
        { key: 'warranty_module_enabled', type: 'flag', label: 'Warranty tracking' },
        { key: 'instalment_module_enabled', type: 'flag', label: 'Instalment plans (work and pay)' },
        { key: 'delivery_module_enabled', type: 'flag', label: 'Delivery and installation jobs' },
        { key: 'serial_tracking_enabled', type: 'flag', label: 'Capture serial numbers for products that track them', hint: 'Serial numbers are what make a warranty claim provable two years later.' },
        { key: 'offline_sync_enabled', type: 'flag', label: 'Offline sync', hint: 'Sales taken while the network is down are queued and pushed when it returns.' },
        { key: 'multi_branch_enabled', type: 'flag', label: 'More than one branch' },
        { key: 'multi_business_enabled', type: 'flag', label: 'More than one business' },
      ],
    },
    {
      title: 'What staff may do without asking',
      blurb: 'Each of these is enforced by the server. A cashier who is not allowed to discount is refused, not just shown a hidden button.',
      items: [
        { key: 'staff_can_void_sales', type: 'flag', label: 'Staff may void a sale' },
        { key: 'staff_void_window_minutes', type: 'number', label: 'Void window (minutes)', min: 0, max: 1440, hint: 'Long enough to fix a mistyped sale, short enough that it is a correction rather than a habit. 0 with the permission on is refused by the server.' },
        { key: 'staff_discount_max_pct', type: 'number', label: 'Maximum discount a cashier may give (%)', min: 0, max: 100, hint: '0 means cashiers cannot discount at all — which is why there is no separate on/off switch for it.' },
        { key: 'staff_can_sell_on_credit', type: 'flag', label: 'Staff may sell on credit' },
        { key: 'staff_credit_max', type: 'number', label: 'Credit cap per sale (₦)', min: 0, hint: 'A cap of zero with the permission on means staff can never actually do it — the server refuses that combination.' },
        { key: 'staff_can_adjust_stock', type: 'flag', label: 'Staff may adjust stock' },
        { key: 'staff_adjustment_max_units', type: 'number', label: 'Adjustment cap (units)', min: 0, max: 1000000 },
        { key: 'staff_can_adjust_stock_value', type: 'number', label: 'Adjustment cap (₦ value)', min: 0, hint: 'Both caps apply: an adjustment larger than either one needs a manager.' },
        { key: 'staff_can_spend_from_safe', type: 'flag', label: 'Staff may take cash from the safe' },
        { key: 'staff_safe_spend_max', type: 'number', label: 'Safe withdrawal cap (₦)', min: 0, hint: '0 means no cap. Whether staff may draw at all is the switch above.' },
      ],
    },
    {
      title: 'What managers may do without asking',
      blurb: 'A manager is not the owner. Turn these off and the manager is refused on the server and told to ask you.',
      items: [
        { key: 'managers_can_void_sales', type: 'flag', label: 'Managers may void a sale' },
        { key: 'managers_can_approve_expenses', type: 'flag', label: 'Managers may approve an expense' },
        { key: 'managers_can_edit_prices', type: 'flag', label: 'Managers may change a price' },
        { key: 'managers_can_override_credit_limit', type: 'flag', label: 'Managers may take a customer over their credit limit' },
      ],
    },
    {
      title: 'Tax',
      blurb: 'Nigeria: VAT 7.5%. Withholding tax rates are held as data, not code, so a change in the Finance Act is an update rather than a release.',
      items: [
        { key: 'vat_enabled', type: 'flag', label: 'The business is VAT-registered and charges VAT' },
        { key: 'vat_rate_percent', type: 'number', label: 'VAT rate (%)', min: 0, max: 100, hint: '7.5% is the standard Nigerian rate. The server warns if it is set to anything else.' },
        { type: 'fact', label: 'Why there is no VAT-inclusive switch', text: 'Prices in this system are always quoted VAT-inclusive, which is how Nigerian shops price and how the sales table stores a subtotal. The VAT is extracted from the quoted price for the return rather than added at the counter, so a shelf price is the price a customer pays. Setting the rate above is the whole of the control.' },
      ],
    },
    {
      title: 'Credit, layaway and instalments',
      blurb: 'How long a customer has, and how much of a commitment you take before goods leave the shop.',
      items: [
        { key: 'credit_max_days', type: 'number', label: 'Credit must be settled within (days)', min: 1, max: 365 },
        { key: 'return_window_days_default', type: 'number', label: 'Return window (days)', min: 0, max: 365 },
        { key: 'change_owed_expiry_days', type: 'number', label: 'Change owed expires after (days)', min: 0, max: 365, hint: 'A customer who underpaid in cash can come back for it inside this window.' },
        { key: 'layaway_max_days', type: 'number', label: 'A layaway may run for (days)', min: 1, max: 730 },
        { key: 'layaway_min_deposit_pct', type: 'number', label: 'Layaway deposit (%)', min: 0, max: 100 },
        { key: 'instalment_max_tenure_months', type: 'number', label: 'Instalment plan, maximum (months)', min: 1, max: 60 },
        { key: 'instalment_min_deposit_pct', type: 'number', label: 'Instalment deposit (%)', min: 0, max: 100 },
        { key: 'instalment_max_interest_pct', type: 'number', label: 'Instalment, maximum interest (%)', min: 0, max: 100, hint: 'Flat interest over the whole plan, as it is normally quoted in the market.' },
        { key: 'instalment_default_after_days', type: 'number', label: 'An instalment plan has failed after (days of arrears)', min: 1, max: 365, hint: 'Surfaced on the plan, never acted on automatically: calling a guarantor or repossessing goods is your decision, not the system\'s.' },
        { key: 'instalment_default_after_missed', type: 'number', label: '\u2026or after this many missed instalments', min: 1, max: 60 },
        { key: 'credit_grace_days', type: 'number', label: 'Ignore a debtor being late for (days)', min: 0, max: 90, hint: 'A customer at their credit limit and 90 days overdue is a different risk from one who pays on time. This is the point where the counter starts warning.' },
        { type: 'fact', label: 'Why there is no credit-limit switch', text: 'A sale above a customer\u2019s credit limit is always refused, and the switch on this page decides whether a MANAGER may override that refusal. There is no way to turn the limit off entirely, because a limit that can be ignored is not a limit.' },
        { type: 'fact', label: 'Where the default credit limit lives', text: 'Not here. A credit limit belongs to a customer CLASS \u2014 Walk-in, Trade, Wholesale \u2014 and its default is set on the Customer classes screen, because a wholesaler and a walk-in customer should not share one number.' },
      ],
    },
    {
      title: 'Stock and expiry warnings',
      blurb: 'What the system tells you before it becomes a problem.',
      items: [
        { key: 'low_stock_alert_enabled', type: 'flag', label: 'Warn when stock falls below the reorder level', hint: 'The reorder level itself is set per product.' },
        { key: 'expiry_alert_days', type: 'number', label: 'Days of warning before stock expires', min: 1, max: 720 },
        { key: 'compliance_alert_days', type: 'number', label: 'Days of warning before a licence expires (90 maximum)', min: 1, max: 90 },
        { type: 'fact', label: 'Why expiry warnings have no on/off switch', text: 'The number above is the policy. Goods that expire are the one stock risk that becomes worthless rather than merely slow, and a shop that has switched the warning off will find the batch after the date has passed. Set the number to what you can act on; the warning stays on.' },
        { type: 'fact', label: 'Selling stock you do not have', text: 'Always refused. The sale path checks the branch\u2019s available quantity \u2014 on the shelf minus what is reserved \u2014 and will not post a line it cannot fulfil, because a negative stock figure makes every report, valuation and count wrong until somebody fixes it by hand.' },
      ],
    },
    {
      title: 'Cash and banking',
      blurb: 'The drawer, the safe and the bank.',
      items: [
        { type: 'fact', label: 'Why a sale needs an open till', text: 'There is no switch. Cash taken with no till open is cash that cannot be reconciled, and the difference surfaces at the end of the month as a shortage the cashier cannot explain. Every sale is tied to a till session, so the count at close is the check.' },
        { type: 'fact', label: 'Banking a deposit', text: 'Every withdrawal, banking, expense and till funding has to name the reference it will appear under on the bank statement \u2014 the deposit slip, transfer number or cheque number. Without it the entry cannot be matched to the bank, which is the only proof the money arrived. There is nothing to switch off.' },
      ],
    },
    {
      title: 'Business identity',
      blurb: 'Appears on receipts, labels and returns.',
      // THE TRADING NAME, THE RECEIPT FOOTER AND THE SUPPORT CONTACT ARE NOT HERE. They are
      // real settings keys and this route can write them — which is exactly why they must not
      // be here: the branding card above owns them, and two writable controls for one fact in
      // one screen means the second save silently undoes the first. The card writes them
      // through the branding route, which is the one that also carries the logo and records
      // the change as BRANDING_UPDATED. A test refuses to let the two lists overlap again.
      items: [
        { key: 'notes', type: 'text', label: 'Notes for whoever runs this account' },
        { type: 'fact', label: 'VAT on a receipt', text: 'A printed receipt shows the VAT breakdown whenever the business is VAT-registered. Suppressing it on a tax invoice is not a display preference \u2014 it is a document that cannot be used to claim input VAT.' },
      ],
    },
  ];

  async function render(ctx) {
    const section = (ctx.route && ctx.route.section) || 'settings';
    if (section === 'branches') return renderBranches(ctx);
    if (section === 'businesses') return renderBusinesses(ctx);
    if (section === 'audit') return renderAudit(ctx);
    return renderSettings(ctx);
  }

  // =====================================================================
  // BRANCHES
  // =====================================================================
  async function renderBranches(ctx) {
    ctx.setTitle('Branches');
    const wrap = ui.h('div', { class: 'stack' });
    wrap.appendChild(ui.h('div', { class: 'page-head' },
      ui.h('div', {},
        ui.h('h1', {}, 'Branches'),
        ui.h('p', { class: 'sub' }, 'Where the business trades. Each branch has its own stock, its own tills, its own staff and its own clock-in geofence.')),
      ui.h('div', { class: 'actions' },
        SR.state.atLeast('MANAGER') ? ui.h('button', { class: 'btn btn-sm btn-primary', onClick: () => openBranch() }, 'Open a branch') : null)));

    const host = ui.h('div', {});
    wrap.appendChild(host);

    async function load() {
      host.replaceChildren(ui.skeleton(6));
      let data;
      try {
        data = await SR.api.get('/api/branches', { query: SR.state.query({}) });
      } catch (err) {
        if (!err.isOffline) { host.replaceChildren(ui.errorBlock(err, { retry: { label: 'Try again', run: load } })); return; }
        const cached = await SR.store.all('branches', { where: (b) => !Number(b.is_deleted) });
        data = { data: cached };
      }
      const rows = data.data || data.records || [];
      host.replaceChildren(ui.h('div', { class: 'stack' },
        ui.h('div', { class: 'kpis' },
          ui.kpi({ label: 'Branches', value: U.qty(rows.length) }),
          ui.kpi({ label: 'Open now', value: U.qty(rows.filter((b) => Number(b.is_active)).length) }),
          ui.kpi({ label: 'With a geofence', value: U.qty(rows.filter((b) => b.latitude && b.longitude).length), tone: rows.every((b) => b.latitude) ? 'good' : 'warn' }),
          ui.kpi({ label: 'Stock at cost', value: U.money(U.sum(rows, (b) => b.stock_at_cost)) })),
        ui.dataCard({
          title: 'The network',
          table: ui.renderTable({
            columns: [
              { key: 'name', label: 'Branch', render: (b) => ui.h('div', {}, ui.h('div', {}, b.name), ui.h('div', { class: 'hint' }, [b.code, b.city, b.state].filter(Boolean).join(' · '))) },
              { key: 'business_name', label: 'Business', render: (b) => b.business_name || '—' },
              { key: 'branch_type', label: 'Type', render: (b) => ui.badge(U.humanise(b.branch_type || 'RETAIL'), 'badge-mute') },
              { key: 'active_staff', label: 'Staff', align: 'right', render: (b) => U.qty(b.active_staff || 0) },
              { key: 'stock_at_cost', label: 'Stock', align: 'right', render: (b) => U.money(b.stock_at_cost) },
              { key: 'sales_today', label: 'Sales today', align: 'right', render: (b) => U.qty(b.sales_today || 0) },
              {
                key: 'geofence',
                label: 'Clock-in fence',
                render: (b) => (b.latitude && b.longitude
                  ? ui.h('div', {}, ui.badge(`${U.numInput(b.geofence_radius_meters)}m`, 'badge-good'), ui.h('div', { class: 'hint' }, `${U.round2(b.latitude)}, ${U.round2(b.longitude)}`))
                  : ui.badge('not set', 'badge-warn')),
              },
              { key: 'attendance_mode', label: 'Mode', render: (b) => U.humanise(b.attendance_mode || 'GEOLOCATION') },
              {
                key: 'is_active',
                label: 'Status',
                render: (b) => (Number(b.is_active) ? ui.badge('open', 'badge-good') : ui.badge('closed', 'badge-mute')),
              },
            ],
            rows,
            onRowClick: (b) => openBranch(b),
            emptyTitle: 'No branches',
            emptyMessage: 'A branch is the unit everything hangs off: stock, tills, staff and the clock-in fence.',
          }),
        })));
    }

    async function openBranch(branch) {
      const isNew = !branch;
      const b = branch || {};
      const form = ui.h('div', {});
      // WHICH BUSINESS THIS BRANCH BELONGS TO — asked, not guessed.
      //
      // The route has always honoured a `business_id` in the body (`resolveBusiness`, precedence 2,
      // scope-checked), but this form never sent one, so an owner running several businesses got
      // whichever business the server resolved on its own: their own row, or the recorded primary,
      // or the oldest live business. A live walk opened a branch from an owner whose own branch is
      // "Ridge Building Supplies — Ibadan" and the answer was "opened under Ridge Electronics Ltd" —
      // a real branch in the wrong set of books, with nothing on the screen that had said so.
      const reachableBusinesses = SR.state.businesses() || [];
      const businessField = isNew
        ? (reachableBusinesses.length > 1
          ? ui.field({
            label: 'Business', name: 'business_id', required: true,
            options: reachableBusinesses.map((biz) => ({
              value: biz.id,
              label: biz.name + (String(biz.id) === String(SR.state.activeBusinessId) ? ' — the one you are in' : ''),
            })),
            value: SR.state.activeBusinessId || (reachableBusinesses[0] || {}).id || '',
            hint: 'Each business keeps its own books, catalogue and staff. A branch cannot be moved between businesses later.',
          })
          : ui.field({
            label: 'Business', name: 'business_id', required: true,
            options: reachableBusinesses.map((biz) => ({ value: biz.id, label: biz.name })),
            value: (reachableBusinesses[0] || {}).id || '',
            hint: 'The branch opens under this business. It cannot be moved to another one later.',
          }))
        : ui.h('div', {}, ui.h('label', { class: 'ctl' }, 'Business'),
          ui.h('div', { class: 'hint' }, `This branch belongs to ${b.business_name || 'its business'} and cannot be moved to another one.`));
      form.appendChild(ui.h('div', { class: 'form-grid' },
        businessField,
        ui.field({ label: 'Branch name', name: 'name', value: b.name || '', required: true, placeholder: 'Ikeja Showroom' }),
        ui.field({ label: 'Code', name: 'code', value: b.code || '', hint: 'Appears on receipt numbers and transfer references. Generated from the name if left blank.' }),
        ui.field({ label: 'Type', name: 'branch_type', options: BRANCH_TYPES.map((t) => ({ value: t, label: U.humanise(t) })), value: b.branch_type || 'RETAIL' }),
        ui.field({ label: 'Address', name: 'address', span: true, value: b.address || '' }),
        ui.field({ label: 'City', name: 'city', value: b.city || '' }),
        ui.field({ label: 'State', name: 'state', value: b.state || '' }),
        ui.field({ label: 'LGA', name: 'lga', value: b.lga || '' }),
        ui.field({ label: 'Phone', name: 'phone', value: b.phone || '' }),
        ui.field({ label: 'Email', name: 'email', value: b.email || '' }),
        ui.field({
          label: 'Opening float (₦)',
          name: 'opening_cash',
          type: 'number', step: '0.01', min: '0',
          value: b.opening_cash == null ? '' : String(b.opening_cash),
          hint: 'Recorded as the safe\'s opening entry, so the safe balance is a real derivation rather than a number that appears the first time somebody deposits.',
        })));

      form.appendChild(ui.h('h2', {}, 'Clock-in fence'));
      form.appendChild(ui.h('p', { class: 'sub' }, 'The fence does not BLOCK a clock-in — it records the distance and flags anything outside. Location is evidence for a manager to read, never a reason to stop somebody recording that they came to work.'));
      form.appendChild(ui.h('div', { class: 'form-grid' },
        ui.field({ label: 'Latitude', name: 'latitude', value: b.latitude == null ? '' : String(b.latitude), hint: 'Between -90 and 90.' }),
        ui.field({ label: 'Longitude', name: 'longitude', value: b.longitude == null ? '' : String(b.longitude), hint: 'Between -180 and 180. Swapping the two is the most common mistake and the server refuses it.' }),
        ui.field({ label: 'Fence radius (m)', name: 'geofence_radius_meters', type: 'number', step: '1', min: '0', max: '50000', value: b.geofence_radius_meters == null ? '150' : String(b.geofence_radius_meters), hint: 'Phone GPS is accurate to about 10–50m outdoors and much worse indoors. 150–300m is realistic for a shop.' }),
        ui.field({ label: 'Attendance mode', name: 'attendance_mode', options: ATTENDANCE_MODES, value: b.attendance_mode || 'GEOLOCATION' })));
      const useHere = ui.h('button', { class: 'btn btn-sm' }, 'Use where I am now');
      useHere.addEventListener('click', () => {
        if (!global.navigator || !global.navigator.geolocation) { ui.warn('This device will not share a location.'); return; }
        useHere.disabled = true;
        useHere.textContent = 'Finding you…';
        global.navigator.geolocation.getCurrentPosition((pos) => {
          form.querySelector('[name="latitude"]').value = String(U.round2(pos.coords.latitude * 1000000) / 1000000);
          form.querySelector('[name="longitude"]').value = String(U.round2(pos.coords.longitude * 1000000) / 1000000);
          useHere.disabled = false;
          useHere.textContent = 'Use where I am now';
          ui.ok(`Set to within about ${U.numInput(pos.coords.accuracy || 0)}m of here. Step outside and try again if that looks too far out.`);
        }, (err) => {
          useHere.disabled = false;
          useHere.textContent = 'Use where I am now';
          ui.warn(err && err.message ? err.message : 'Could not get a location.');
        }, { enableHighAccuracy: true, timeout: 12000 });
      });
      form.appendChild(useHere);

      const cancel = ui.h('button', { class: 'btn', onClick: () => m.close() }, 'Cancel');
      const go = ui.h('button', { class: 'btn btn-primary' }, isNew ? 'Open the branch' : 'Save changes');
      const m = ui.openModal({ title: isNew ? 'Open a branch' : b.name, body: form, footer: [cancel, go], size: 'wide' });

      go.addEventListener('click', async () => {
        const v = ui.readFormStrings(form);
        const payload = {};
        for (const [k, val] of Object.entries(v)) {
          if (val === null) continue;
          if (['latitude', 'longitude'].includes(k)) { payload[k] = Number(val); continue; }
          if (['geofence_radius_meters', 'opening_cash'].includes(k)) { payload[k] = Number(val); continue; }
          payload[k] = val;
        }
        await ui.withBusy(form, async () => {
          try {
            const res = isNew
              ? await SR.api.post('/api/branches', payload)
              : await SR.api.put(`/api/branches/${encodeURIComponent(b.id)}`, payload);
            m.close();
            ui.ok(res.message || 'Saved.');
            load();
          } catch (err) { ui.apiError(err); }
        });
      });
    }

    await load();
    return wrap;
  }

  // =====================================================================
  // BUSINESSES
  // =====================================================================
  async function renderBusinesses(ctx) {
    ctx.setTitle('Businesses');
    const wrap = ui.h('div', { class: 'stack' });
    wrap.appendChild(ui.h('div', { class: 'page-head' },
      ui.h('div', {},
        ui.h('h1', {}, 'Businesses'),
        ui.h('p', { class: 'sub' }, 'Each business is a separate legal entity with its own books, its own catalogue and its own staff. One deployment can hold several.')),
      ui.h('div', { class: 'actions' },
        SR.state.atLeast('ADMIN') ? ui.h('button', { class: 'btn btn-sm btn-primary', onClick: () => openBusiness() }, 'Create a business') : null,
        SR.state.atLeast('OWNER') ? ui.h('button', { class: 'btn btn-sm', onClick: () => openProfiles() }, 'The four verticals') : null)));

    const host = ui.h('div', {});
    wrap.appendChild(host);

    async function load() {
      host.replaceChildren(ui.skeleton(6));
      let data;
      try {
        data = await SR.api.get('/api/businesses', { query: SR.state.query({}) });
      } catch (err) {
        if (!err.isOffline) { host.replaceChildren(ui.errorBlock(err, { retry: { label: 'Try again', run: load } })); return; }
        const cached = await SR.store.all('businesses', { where: (b) => !Number(b.is_deleted) });
        data = { data: cached };
      }
      const rows = data.data || data.records || [];
      host.replaceChildren(ui.h('div', { class: 'stack' },
        ui.h('div', { class: 'kpis' },
          ui.kpi({ label: 'Businesses', value: U.qty(rows.length) }),
          ui.kpi({ label: 'Branches in total', value: U.qty(U.sum(rows, (b) => b.active_branches)) }),
          ui.kpi({ label: 'Staff in total', value: U.qty(U.sum(rows, (b) => b.active_staff)) }),
          ui.kpi({ label: 'Lifetime revenue', value: U.money(U.sum(rows, (b) => b.lifetime_revenue)) })),
        ui.dataCard({
          title: 'The group',
          table: ui.renderTable({
            columns: [
              { key: 'name', label: 'Business', render: (b) => ui.h('div', {}, ui.h('div', {}, b.name), ui.h('div', { class: 'hint' }, [b.legal_name, b.tin ? `TIN ${b.tin}` : null].filter(Boolean).join(' · '))) },
              { key: 'profile', label: 'Vertical', render: (b) => ui.badge((b.profile && b.profile.label) || U.humanise(b.profile_code || ''), 'badge-info') },
              { key: 'active_branches', label: 'Branches', align: 'right', render: (b) => U.qty(b.active_branches || 0) },
              { key: 'active_staff', label: 'Staff', align: 'right', render: (b) => U.qty(b.active_staff || 0) },
              { key: 'products', label: 'Products', align: 'right', render: (b) => U.qty(b.products || 0) },
              { key: 'lifetime_revenue', label: 'Lifetime revenue', align: 'right', render: (b) => U.money(b.lifetime_revenue) },
              { key: 'vat_registered', label: 'VAT', render: (b) => (Number(b.vat_registered) ? ui.badge('registered', 'badge-good') : ui.badge('not registered', 'badge-mute')) },
            ],
            rows,
            onRowClick: (b) => { if (SR.state.atLeast('OWNER')) openBusiness(b); },
            emptyTitle: 'No businesses',
            emptyMessage: 'Provision a business to get its catalogue, chart of accounts, customer classes and price lists built from the vertical profile in one step.',
          }),
        })));
    }

    function openBusiness(business) {
      const isNew = !business;
      const b = business || {};
      const form = ui.h('div', {});
      form.appendChild(ui.h('div', { class: 'form-grid' },
        ui.field({ label: 'Trading name', name: 'name', value: b.name || '', required: true, placeholder: 'Emeka Electronics' }),
        ui.field({ label: 'Registered (legal) name', name: 'legal_name', value: b.legal_name || '', hint: 'The name on the CAC certificate. Appears on invoices and returns.' }),
        ui.field({ label: 'CAC number', name: 'cac_reg_no', value: b.cac_reg_no || '', placeholder: 'RC 1234567' }),
        ui.field({ label: 'TIN', name: 'tin', value: b.tin || '', placeholder: '12345678-0001' }),
        ui.field({ label: 'VAT registered', name: 'vat_registered', type: 'checkbox', value: Number(b.vat_registered) ? 1 : 0, hint: 'Charging VAT without being registered is worse than not charging it.' }),
        ui.field({ label: 'Contact name', name: 'contact_name', value: b.contact_name || '' }),
        ui.field({ label: 'Contact phone', name: 'contact_phone', value: b.contact_phone || '' }),
        ui.field({ label: 'Contact email', name: 'contact_email', value: b.contact_email || '' }),
        ui.field({ label: 'Address', name: 'address', span: true, value: b.address || '' })));

      if (isNew) {
        form.appendChild(ui.h('h2', {}, 'Vertical'));
        form.appendChild(ui.h('p', { class: 'sub' }, 'The vertical decides the categories, the unit ladders, the compliance records (SONCAP / SON) and the warranty rules the starter catalogue is built from. It cannot be changed once the business has products.'));
        const profileSel = ui.field({
          label: 'What kind of business is it',
          name: 'profile_code',
          options: [
            { value: 'ELECTRONICS', label: 'Electronics, appliances & gadgets' },
            { value: 'FURNITURE', label: 'Furniture & home' },
            { value: 'GENERAL_RETAIL', label: 'Wholesale & general merchandise' },
            { value: 'BUILDING_MATERIALS', label: 'Building materials & hardware' },
          ],
        });
        form.appendChild(ui.h('div', { class: 'form-grid' }, profileSel));
        form.appendChild(ui.h('h2', {}, 'First branch'));
        form.appendChild(ui.h('div', { class: 'form-grid' },
          ui.field({ label: 'Branch name', name: 'branch_name', placeholder: 'Main shop' }),
          ui.field({ label: 'City', name: 'branch_city' }),
          ui.field({ label: 'State', name: 'branch_state' }),
          ui.field({ label: 'Opening float (₦)', name: 'opening_cash', type: 'number', step: '0.01', min: '0' }),
          ui.field({ label: 'Build the starter catalogue', name: 'seed_catalogue', type: 'checkbox', value: 1, span: true, hint: 'Takes the profile\'s sample products, ladders and barcodes. Turn it off for an empty catalogue you fill yourself.' })));
      }

      const cancel = ui.h('button', { class: 'btn', onClick: () => m.close() }, 'Cancel');
      const go = ui.h('button', { class: 'btn btn-primary' }, isNew ? 'Create and provision' : 'Save changes');
      const m = ui.openModal({ title: isNew ? 'Create a business' : b.name, body: form, footer: [cancel, go], size: 'wide' });

      go.addEventListener('click', async () => {
        const v = ui.readForm(form);
        const payload = {};
        for (const [k, val] of Object.entries(v)) {
          if (val === null) continue;
          if (k.startsWith('branch_')) payload[`branch_${k.slice(7)}`] = val;
          else payload[k] = val;
        }
        await ui.withBusy(form, async () => {
          try {
            if (isNew) {
              const res = await SR.api.post('/api/businesses', {
                name: v.name,
                legal_name: v.legal_name || undefined,
                profile_code: v.profile_code,
                cac_reg_no: v.cac_reg_no || undefined,
                tin: v.tin || undefined,
                vat_registered: Number(v.vat_registered) ? true : false,
                contact_name: v.contact_name || undefined,
                contact_phone: v.contact_phone || undefined,
                contact_email: v.contact_email || undefined,
                address: v.address || undefined,
                seed_catalogue: Number(v.seed_catalogue) ? true : false,
                branch: {
                  name: v.branch_name || undefined,
                  city: v.branch_city || undefined,
                  state: v.branch_state || undefined,
                  opening_cash: v.opening_cash === null ? 0 : Number(v.opening_cash),
                },
              });
              m.close();
              ui.ok(res.message || 'Business created and provisioned.');
              load();
            } else {
              const res = await SR.api.put(`/api/businesses/${encodeURIComponent(b.id)}`, payload);
              m.close();
              ui.ok(res.message || 'Saved.');
              load();
            }
          } catch (err) { ui.apiError(err); }
        });
      });
    }

    async function openProfiles() {
      const body = ui.h('div', {}, ui.skeleton(4));
      const m = ui.openModal({ title: 'The four verticals', body, size: 'wide' });
      try {
        const data = await SR.api.get('/api/catalogue/profiles', { query: SR.state.query({}) });
        const list = data.data || data.profiles || [];
        body.replaceChildren(ui.h('div', { class: 'stack' },
          ui.h('p', { class: 'sub' }, 'Each vertical is data, not code: categories, unit ladders, measured axes, compliance records and warranty rules. A client on any of them gets a working catalogue on day one.'),
          ui.renderTable({
            columns: [
              { key: 'label', label: 'Vertical', render: (p) => ui.h('div', {},
                ui.h('div', {}, p.label || p.code),
                ui.h('div', { class: 'hint' }, p.blurb || '')) },
              { key: 'code', label: 'Code', render: (p) => ui.badge(p.code, 'badge-mute') },
              { key: 'categoryCount', label: 'Categories', align: 'right', render: (p) => U.qty(p.categoryCount || 0) },
              { key: 'baseUnit', label: 'Base unit', render: (p) => (p.baseUnit ? U.humanise(p.baseUnit) : '—') },
              {
                key: 'complianceFields',
                label: 'Compliance captured',
                render: (p) => ((p.complianceFields || []).length
                  ? p.complianceFields.join(', ')
                  : ui.h('span', { class: 'hint' }, 'none beyond the standard fields')),
              },
              {
                key: 'enabledFeatures',
                label: 'Flows switched on',
                render: (p) => ui.h('div', { class: 'row' },
                  (p.enabledFeatures || []).slice(0, 6).map((f) => ui.badge(U.humanise(f), 'badge-info')),
                  (p.enabledFeatures || []).length > 6 ? ui.h('span', { class: 'hint' }, `+${(p.enabledFeatures || []).length - 6} more`) : null),
              },
            ],
            rows: list,
            emptyTitle: 'No profiles loaded',
            emptyMessage: 'Profiles ship with the deployment.',
          })));
      } catch (err) {
        body.replaceChildren(ui.h('div', { class: 'alert alert-danger' }, err.message || 'Could not load the profiles.'));
      }
      return m;
    }

    await load();
    return wrap;
  }

  /**
   * THE FIELDS THIS SCREEN SENDS TO `PUT /api/branding`, and the whole list of them.
   *
   * It is the route's own allow-list (`server/routes/branding.js`, the `allow` object), written
   * here so the form, the dirty-check and a reader all agree on one list. The audit compares
   * the two lists in BOTH directions: a field the form offers that the route ignores is a form
   * that lies, and a field the route accepts that no form sends is a control nobody can reach.
   */
  const BRANDING_FIELDS = ['business_name', 'receipt_footer_text', 'admin_contact_name', 'admin_contact_phone', 'admin_contact_email'];

  // =====================================================================
  // SETTINGS
  // =====================================================================
  async function renderSettings(ctx) {
    ctx.setTitle('Settings');
    const wrap = ui.h('div', { class: 'stack' });
    const canEdit = SR.state.atLeast('OWNER');
    wrap.appendChild(ui.h('div', { class: 'page-head' },
      ui.h('div', {},
        ui.h('h1', {}, 'Settings'),
        ui.h('p', { class: 'sub' }, 'The controls. Every change here is audited with its previous value — "who allowed staff to write off stock?" has an answer in this system.')),
      ui.h('div', { class: 'actions' },
        canEdit ? ui.h('button', { class: 'btn btn-sm btn-primary', onClick: () => save() }, 'Save changes') : null)));

    const host = ui.h('div', {});
    wrap.appendChild(host);
    let form = null;

    async function load() {
      host.replaceChildren(ui.skeleton(8));
      let data;
      try {
        data = await SR.api.get('/api/settings', { query: SR.state.query({}) });
      } catch (err) {
        host.replaceChildren(ui.errorBlock(err, { retry: { label: 'Try again', run: load } }));
        return;
      }
      const s = data.settings || {};
      form = ui.h('div', { class: 'stack' });

      if (!canEdit) {
        form.appendChild(ui.h('div', { class: 'alert alert-info' }, 'Settings are read-only for your role. Ask an owner to change anything here.'));
      }

      for (const group of SETTING_GROUPS) {
        const card = ui.h('div', { class: 'card' });
        const body = ui.h('div', { class: 'card-body' });
        body.appendChild(ui.h('h2', {}, group.title));
        body.appendChild(ui.h('p', { class: 'sub' }, group.blurb));
        const grid = ui.h('div', { class: 'form-grid' });
        for (const item of group.items) {
          // A FACT has no key and no input — see the note above the list. It sits in
          // the same grid, at the same size, and says what the system does where a
          // switch used to promise a choice that was never there.
          if (item.type === 'fact') {
            grid.appendChild(ui.h('div', { class: 'span-2' },
              ui.h('div', { class: 'ctl' }, item.label),
              ui.h('div', { class: 'hint' }, item.text)));
            continue;
          }
          // A KEY THE DEPLOYMENT DOES NOT HAVE IS NOT SILENTLY DROPPED.
          //
          // This line used to read `if (!(item.key in s)) continue;` — so a control
          // whose key was missing simply did not appear, and nothing anywhere said
          // so. A test now refuses to let the two lists disagree, and this branch
          // reports the disagreement on the page if one ever slips through.
          if (!(item.key in s)) {
            grid.appendChild(ui.h('div', { class: 'span-2' },
              ui.h('div', { class: 'ctl' }, item.label),
              ui.h('div', { class: 'err' }, `This control is not available on this deployment: the server has no "${item.key}" setting. Support has been told by this message; nothing you do here can change it.`)));
            continue;
          }
          if (item.type === 'flag') {
            grid.appendChild(ui.field({ label: item.label, name: item.key, type: 'checkbox', value: Number(s[item.key]) ? 1 : 0, disabled: !canEdit, hint: item.hint || null }));
          } else if (item.type === 'number') {
            grid.appendChild(ui.field({ label: item.label, name: item.key, type: 'number', step: 'any', min: item.min == null ? null : String(item.min), max: item.max == null ? null : String(item.max), value: s[item.key] == null ? '' : String(s[item.key]), disabled: !canEdit, hint: item.hint || null }));
          } else {
            grid.appendChild(ui.field({ label: item.label, name: item.key, value: s[item.key] == null ? '' : String(s[item.key]), disabled: !canEdit, hint: item.hint || null }));
          }
        }
        body.appendChild(grid);
        card.appendChild(body);
        form.appendChild(card);
      }
      // THE BRANDING CARD GOES FIRST — before the feature switches — because it is the one
      // thing here that changes what a customer sees. It is loaded separately from
      // `GET /api/branding/full`: the settings payload does not carry the logo (hundreds of
      // KB) and reading it through the settings endpoint would put it in every boot.
      form.insertBefore(renderBrandingCard(), form.firstChild);
      host.replaceChildren(form);
    }

    /**
     * THE SIGN-IN SCREEN, THE RECEIPTS AND THE HEADER, IN ONE CARD.
     *
     * `server/routes/branding.js` has five routes and a careful set of rules — GET is public
     * so the sign-in screen can be branded, PUT and the logo are OWNER-only because renaming
     * the shop renames it for every branch and every receipt, the logo is validated by magic
     * bytes rather than the claimed MIME type — and NO SCREEN CALLED ANY OF THEM. Every one of
     * the five read "not reached by any screen" in the coverage report: a complete backend
     * with no way to use it. This is that way.
     *
     * The fields are the fields the route accepts, no more and no fewer: `business_name`,
     * `receipt_footer_text`, `admin_contact_name`, `admin_contact_phone`, `admin_contact_email`
     * go to PUT, and the logo goes to POST/DELETE `/api/branding/logo`. The audit checks that
     * agreement in both directions, because a form field the server ignores is a form that
     * lies, and a server field no form sends is a feature nobody can reach.
     */
    function renderBrandingCard() {
      const card = ui.h('div', { class: 'card' });
      const body = ui.h('div', { class: 'card-body' });
      body.appendChild(ui.h('h2', {}, 'Branding — the shop’s name, logo and receipts'));
      body.appendChild(ui.h('p', { class: 'sub' }, 'What your customers see: the sign-in screen, the header, and the foot of every receipt.'));
      const host = ui.h('div', {});
      body.appendChild(host);
      card.appendChild(body);

      async function loadBranding() {
        host.replaceChildren(ui.skeleton(4));
        let b;
        try {
          b = await SR.api.get('/api/branding/full');
        } catch (err) {
          host.replaceChildren(ui.errorBlock(err, { retry: { label: 'Try again', run: loadBranding } }));
          return;
        }
        const admin = b.admin || {};
        const grid = ui.h('div', { class: 'form-grid' },
          ui.field({ label: 'Trading name', name: 'business_name', value: b.name || '', disabled: !canEdit, hint: 'Appears on the sign-in screen, the header and every receipt. Leave it unset and the name of your first business is used.' }),
          ui.field({ label: 'Receipt footer', name: 'receipt_footer_text', value: (admin.receiptFooter || b.receiptFooter || ''), disabled: !canEdit, hint: 'A thank-you, a returns policy, a phone number. Up to 500 characters.' }),
          ui.field({ label: 'Contact name', name: 'admin_contact_name', value: admin.contactName || '', disabled: !canEdit, hint: 'Who a customer or an auditor should ask for.' }),
          ui.field({ label: 'Contact phone', name: 'admin_contact_phone', value: admin.contactPhone || '', disabled: !canEdit }),
          ui.field({ label: 'Contact email', name: 'admin_contact_email', value: admin.contactEmail || '', disabled: !canEdit }));

        // THE LOGO IS ITS OWN CONTROL, because it is its own route and its own decision:
        // uploading a file and saving a name are not the same edit, and the logo posts bytes.
        const logoBox = ui.h('div', { class: 'ctl' }, 'Logo');
        const preview = ui.h('img', { alt: 'The current logo', class: 'brand-logo-preview' });
        if (b.logoDataUrl) { preview.src = b.logoDataUrl; } else { preview.hidden = true; }
        const file = ui.h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', disabled: !canEdit, class: 'brand-logo-input' });
        const remove = ui.h('button', { class: 'btn btn-sm', disabled: !canEdit, onClick: async () => {
          if (!(await ui.confirmDialog({ title: 'Remove the logo', message: 'The wordmark will be used instead.', confirmLabel: 'Remove', danger: true }))) return;
          try { const res = await SR.api.del('/api/branding/logo'); ui.ok(res.message || 'Logo removed.'); loadBranding(); }
          catch (err) { ui.apiError(err); }
        } }, 'Remove logo');
        file.addEventListener('change', async () => {
          const f = file.files && file.files[0];
          if (!f) return;
          // The server sniffs the magic bytes; this check exists to give a person a sentence
          // instead of a 400, and it is deliberately permissive — the server is the authority.
          if (f.size > 512 * 1024) { ui.warn('That image is larger than 512 KB. Use a smaller one — it is loaded on the sign-in screen.'); file.value = ''; return; }
          try {
            const dataUrl = await new Promise((resolve, reject) => {
              const r = new FileReader();
              r.onload = () => resolve(String(r.result));
              r.onerror = () => reject(new Error('That file could not be read.'));
              r.readAsDataURL(f);
            });
            const res = await SR.api.post('/api/branding/logo', { logoDataUrl: dataUrl });
            ui.ok(res.message || 'Logo updated.');
            loadBranding();
          } catch (err) { ui.apiError(err); } finally { file.value = ''; }
        });
        logoBox.appendChild(ui.h('div', { class: 'brand-logo-row' }, preview, ui.h('div', { class: 'stack' }, file, ui.h('div', { class: 'hint' }, 'PNG, JPEG, WebP or GIF. SVG is refused on purpose: it can carry a script, and this image is shown on the sign-in screen.'), remove)));

        // ONLY WHAT CHANGED IS SENT. The route audits every field it receives, and a trail full
        // of unchanged rows is a trail nobody reads — the same rule the feature switches above
        // follow. `before` is built from the fields `GET /api/branding/full` actually answers.
        const before = {
          business_name: b.name || '',
          receipt_footer_text: admin.receiptFooter || b.receiptFooter || '',
          admin_contact_name: admin.contactName || '',
          admin_contact_phone: admin.contactPhone || '',
          admin_contact_email: admin.contactEmail || '',
        };
        const saveBtn = ui.h('button', { class: 'btn btn-sm btn-primary', disabled: !canEdit, onClick: async () => {
          const values = ui.readForm(grid);
          const sent = {};
          for (const k of BRANDING_FIELDS) {
            if (String(values[k] == null ? '' : values[k]) !== String(before[k] == null ? '' : before[k])) sent[k] = values[k];
          }
          if (!Object.keys(sent).length) { ui.info('Nothing has changed.'); return; }
          await ui.withBusy(saveBtn, async () => {
            try {
              const res = await SR.api.put('/api/branding', sent);
              ui.ok(res.message || 'Branding updated.');
              await SR.state.load({ force: true });   // the header and the chrome repaint
              if (typeof SR.app.paintIdentity === 'function') SR.app.paintIdentity();
              loadBranding();
            } catch (err) { ui.apiError(err); }
          });
        } }, 'Save branding');

        host.replaceChildren(ui.h('div', { class: 'stack' }, grid, ui.h('div', { class: 'span-2' }, logoBox),
          ui.h('div', { class: 'card-foot' }, saveBtn,
            ui.h('span', { class: 'hint' }, 'Every change here is audited with the previous value.'))));
      }

      loadBranding();
      return card;
    }

    async function save() {
      if (!form) return;
      const values = ui.readForm(form);
      // Only send what changed: the server audits each field it receives, and an
      // audit trail full of "unchanged" rows is a trail nobody reads.
      const body = {};
      const s = SR.state.settings || {};
      for (const [k, v] of Object.entries(values)) {
        if (v === null && String(s[k] || '') === '') continue;
        if (typeof v === 'number' && Number(s[k]) === Number(v)) continue;
        if (typeof v === 'string' && String(s[k] || '') === v) continue;
        body[k] = v;
      }
      if (!Object.keys(body).length) { ui.info('Nothing has changed.'); return; }
      await ui.withBusy(form, async () => {
        try {
          // THE PAYLOAD IS THE SECOND ARGUMENT. `SR.api.put(path, body, opts)`.
          // This said `{ body }` — an object whose only key is `body` — so the
          // request carried `{ body: {...} }` and the server saw one key named
          // "body". Saving from this screen has therefore never worked: the settings
          // route ignored the unknown key and answered "Nothing to change", and the
          // owner concluded that the system had quietly disagreed with them. The
          // Stage-10 sweep for this defect looked for `{ body:` WITH A COLON and
          // this is the shorthand form, which is why it survived. The contract test
          // now catches both.
          const res = await SR.api.put('/api/settings', body);
          ui.ok(res.message || 'Settings saved.');
          await SR.state.load({ force: true });
          load();
        } catch (err) { ui.apiError(err); }
      });
    }

    await load();
    return wrap;
  }

  // =====================================================================
  // AUDIT
  // =====================================================================
  async function renderAudit(ctx) {
    ctx.setTitle('Audit trail');
    const state = { page: 0, pageSize: 50, days: 7, action: '', q: '' };

    const wrap = ui.h('div', { class: 'stack' });
    wrap.appendChild(ui.h('div', { class: 'page-head' },
      ui.h('div', {},
        ui.h('h1', {}, 'Audit trail'),
        ui.h('p', { class: 'sub' }, 'Every change, hash-chained. Rows cannot be edited or deleted through the API, and removing one breaks every link after it — which is exactly how a break becomes visible.')),
      ui.h('div', { class: 'actions' },
        // BOTH BUTTONS ARE THE OWNER'S, because both ROUTES are (`atLeast(user.role, 'OWNER')`
        // in `server/routes/admin.js`). A manager may read the trail — the screen is offered
        // to managers and the read route allows them — but a button that always answers 403
        // is a button that teaches people to ignore refusals. Hiding a control the API
        // refuses is not a permission; showing one it refuses is a lie with extra steps.
        SR.state.atLeast('OWNER') ? ui.h('button', { class: 'btn btn-sm', onClick: () => verifyChain() }, 'Verify the chain') : null,
        SR.state.atLeast('OWNER') ? ui.h('button', { class: 'btn btn-sm', onClick: () => anchorChain() }, 'Anchor the head hash') : null)));

    const toolbar = ui.h('div', { class: 'card' }, ui.h('div', { class: 'card-body row' }));
    const daysSel = ui.h('select', { onchange: (e) => { state.days = Number(e.target.value); state.page = 0; load(); } });
    for (const [v, l] of [[1, 'Today'], [7, 'Last 7 days'], [30, 'Last 30 days'], [365, 'Last year']]) {
      daysSel.appendChild(ui.h('option', { value: v, selected: v === state.days }, l));
    }
    const search = ui.h('input', { type: 'search', placeholder: 'User, action or entity', value: state.q, style: { maxWidth: '260px' } });
    search.addEventListener('input', ui.debounceInput(search, (v) => { state.q = v; state.page = 0; load(); }, 320));
    toolbar.firstElementChild.appendChild(ui.h('div', {}, ui.h('label', { class: 'ctl' }, 'Period'), daysSel));
    toolbar.firstElementChild.appendChild(ui.h('div', {}, ui.h('label', { class: 'ctl' }, 'Search'), search));
    wrap.appendChild(toolbar);

    const host = ui.h('div', {});
    wrap.appendChild(host);

    async function load() {
      host.replaceChildren(ui.skeleton(8));
      try {
        const data = await SR.api.get('/api/audit', {
          query: SR.state.query({
            from: U.addDays(U.todayWat(), -state.days), to: U.todayWat(),
            action: state.action || undefined, q: state.q || undefined,
            limit: state.pageSize, offset: state.page * state.pageSize,
          }),
        });
        render(data);
      } catch (err) {
        host.replaceChildren(ui.errorBlock(err, { retry: { label: 'Try again', run: load } }));
      }
    }

    function render(data) {
      const rows = data.data || data.records || [];
      const total = (data.paging && data.paging.total != null) ? data.paging.total : rows.length;
      const actions = data.actions || [];

      const actionSel = ui.h('select', { onchange: (e) => { state.action = e.target.value; state.page = 0; load(); } });
      actionSel.appendChild(ui.h('option', { value: '' }, 'Every action'));
      for (const a of actions) actionSel.appendChild(ui.h('option', { value: a.action, selected: a.action === state.action }, `${U.humanise(a.action)} (${a.count})`));

      host.replaceChildren(ui.h('div', { class: 'stack' },
        ui.h('div', { class: 'alert alert-info' }, data.note),
        ui.dataCard({
          title: `${U.qty(total)} entries`,
          toolbar: ui.h('div', { class: 'row' }, actionSel),
          table: ui.renderTable({
            columns: [
              { key: 'created_at', label: 'When', render: (a) => ui.h('div', {}, ui.h('div', {}, U.dateTime(a.created_at)), ui.h('div', { class: 'hint' }, U.relTime(a.created_at))) },
              { key: 'username', label: 'Who', render: (a) => ui.h('div', {}, ui.h('div', {}, a.username || 'system'), ui.h('div', { class: 'hint' }, a.ip_address || 'no address recorded')) },
              { key: 'action', label: 'What', render: (a) => ui.badge(U.humanise(a.action), actionTone(a.action)) },
              { key: 'entity_type', label: 'On', render: (a) => ui.h('div', {}, ui.h('div', {}, U.humanise(a.entity_type || '—')), ui.h('div', { class: 'hint' }, String(a.entity_id || '').slice(0, 10))) },
              { key: 'branch_name', label: 'Branch', render: (a) => a.branch_name || '—' },
              {
                // THE ONE DEAD READ A FALLBACK WAS HIDING. `a.summary` and `a.description`
                // are not columns and never were; the row rendered correctly only because
                // the third name in the chain exists. Off by a hidden fallback is still off —
                // and a DECISION shows what was there before, so `before_json` is not a
                // second choice here, it is the only field a deletion has to show.
                key: 'detail',
                label: 'Detail',
                render: (a) => (a.after_json ? String(a.after_json).slice(0, 70)
                  : (a.before_json ? String(a.before_json).slice(0, 70) : '—')),
              },
              {
                // THE COLUMN IS `row_hash`. It was read as `a.hash`, which does not exist on
                // `audit_log`, so the Chain column of every row on every deployment said "—":
                // the one field on the screen whose job is to prove the row is chained was
                // silently blank, on the screen whose whole argument is that the chain is real.
                key: 'chain',
                label: 'Chain',
                render: (a) => ui.h('span', { class: 'hint mono', title: a.row_hash || '' },
                  a.row_hash ? `${String(a.row_hash).slice(0, 8)}…` : '—'),
              },
            ],
            rows,
            onRowClick: (a) => showEntry(a),
            emptyTitle: 'Nothing recorded in this period',
            emptyMessage: 'Every change through the app is recorded here as it happens.',
          }),
          pager: total > state.pageSize ? ui.pager({
            page: state.page, pageSize: state.pageSize, total,
            onPage: (p) => { state.page = p; load(); },
            onSize: (s) => { state.pageSize = s; state.page = 0; load(); },
          }) : null,
        })));
    }

    function actionTone(action) {
      const a = String(action || '');
      if (/DELETE|VOID|REJECT|DEACTIVAT|BLOCK/.test(a)) return 'badge-bad';
      if (/CREATE|ADD|POST|RECEIVE|APPROVE|ACTIVAT/.test(a)) return 'badge-good';
      if (/UPDATE|CHANGE|EDIT|REVIEW|RESOLVE/.test(a)) return 'badge-info';
      return 'badge-mute';
    }

    function showEntry(entry) {
      const body = ui.h('div', { class: 'stack' });
      // THE FIELDS ARE THE COLUMNS. `reason` and `device_id` are not columns of `audit_log`
      // and `role` is not one either, so three lines of this dialog could only ever read
      // "—" while the two facts the trail DOES carry — the address it came from and the
      // agent it claimed to be — were not shown at all.
      body.appendChild(ui.kv([
        ['When', U.dateTime(entry.created_at)],
        ['Who', entry.username || 'system'],
        ['Action', U.humanise(entry.action)],
        ['Entity', `${U.humanise(entry.entity_type || '—')} ${String(entry.entity_id || '').slice(0, 12)}`],
        ['Branch', entry.branch_name || '—'],
        ['From', entry.ip_address || '—'],
        ['Device', entry.user_agent || '—'],
      ]));
      for (const [label, raw] of [['Before', entry.before_json], ['After', entry.after_json]]) {
        if (!raw) continue;
        let pretty = raw;
        try { pretty = JSON.stringify(JSON.parse(raw), null, 2); } catch (e) { /* leave as stored */ }
        body.appendChild(ui.h('h3', {}, label));
        body.appendChild(ui.h('pre', { class: 'pre-block' }, String(pretty).slice(0, 4000)));
      }
      body.appendChild(ui.h('h3', {}, 'Hash chain'));
      body.appendChild(ui.h('pre', { class: 'pre-block' }, `previous: ${entry.prev_hash || '—'}\nhash:     ${entry.row_hash || '—'}`));
      ui.openModal({ title: 'Audit entry', body, size: 'wide' });
    }

    async function verifyChain() {
      const body = ui.h('div', {}, ui.skeleton(3));
      const m = ui.openModal({ title: 'Verifying the audit chain', body, size: 'narrow' });
      try {
        const res = await SR.api.get('/api/audit/verify', { query: SR.state.query({ full: '1' }) });
        body.replaceChildren(ui.h('div', { class: `alert ${res.ok ? 'alert-ok' : 'alert-danger'}` }, res.message || (res.ok ? 'Intact.' : 'Broken.')));
      } catch (err) {
        body.replaceChildren(ui.h('div', { class: 'alert alert-danger' }, err.message || 'Could not verify the chain.'));
      }
      return m;
    }

    async function anchorChain() {
      const confirmed = await ui.confirmDialog({
        title: 'Anchor the chain',
        message: 'Publish the current head hash of the audit chain?',
        confirmLabel: 'Anchor',
        detail: 'An anchor is a signed statement of the chain as it stands today. If a row is later removed or edited, the chain will no longer reproduce this hash — so the break is provable rather than arguable.',
      });
      if (!confirmed) return;
      try {
        const res = await SR.api.post('/api/audit/anchor', {});
        ui.ok(res.message || `Anchored at ${String(res.hash || '').slice(0, 12)}…`);
      } catch (err) { ui.apiError(err); }
    }

    wrap.appendChild(ui.html('<style>' +
      '.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(160px,1fr));gap:10px}' +
      '.kpi-label{font-size:11px;text-transform:uppercase;letter-spacing:.06em;opacity:.65;margin-bottom:2px}' +
      '.kpi-value{font-size:19px;font-weight:650}' +
      '.kpi-foot{font-size:11px;opacity:.62;margin-top:2px}' +
      '.pre-block{background:var(--line);border-radius:10px;padding:10px;font-size:12px;overflow:auto;max-height:280px;white-space:pre-wrap;word-break:break-word}' +
      '.mono{font-family:var(--mono,monospace)}' +
      '</style>'));

    await load();
    return wrap;
  }

  SR.views = SR.views || {};
  SR.views.admin = { render };
}(window));
