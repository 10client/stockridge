'use strict';
// =====================================================================
// public/js/views/admin.js — THE BUSINESS, ITS BRANCHES AND ITS CONTROLS
// =====================================================================
// One file, four screens, because they are four views of the same thing: how
// this deployment is set up. The router picks the section:
//
//   /branches    where the business trades, and each shop's geofence
//   /businesses  the legal entities — each with its own books
//   /settings    the controls, one tab at a time: staff, VAT, credit caps
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

  /**
   * THE SAME BRANCH FEATURES, in the same pairs, on every screen that writes a branch.
   *
   * Creating a business opens the first branch. Opening a branch later, and editing
   * one after that, must ask for the same things in the same places. A third column
   * that appears only when the modal is wide is how a field looked "out of line".
   */
  function appendBranchFeatures(parent, { prefix = '', values = {}, businessNode = null, lockIdentity = false, showActive = false } = {}) {
    const v = values || {};
    const n = (key) => (prefix ? `${prefix}${key}` : key);
    const note = ui.h('p', { class: 'sub' },
      'Name, code, type, address, phone, the opening float and the clock-in fence. The same details are here when the branch is opened with the business and when it is edited later.');
    parent.appendChild(note);
    if (businessNode) parent.appendChild(businessNode);
    const identity = ui.h('div', { class: 'form-pairs' });
    identity.appendChild(ui.field({ label: 'Branch name', name: n('name'), value: v.name || '', required: !prefix, placeholder: 'Ikeja Showroom', disabled: lockIdentity }));
    identity.appendChild(ui.field({ label: 'Code', name: n('code'), value: v.code || '', disabled: lockIdentity, hint: 'Printed beside the receipt number, and on delivery notes and stock counts. Leave it blank and it is taken from the branch name. It is not filled in as MAIN.' }));
    identity.appendChild(ui.field({ label: 'Type', name: n('branch_type'), options: BRANCH_TYPES.map((t) => ({ value: t, label: U.humanise(t) })), value: v.branch_type || 'RETAIL', disabled: lockIdentity }));
    identity.appendChild(ui.field({
      label: 'Opening float (₦)',
      name: n('opening_cash'),
      type: 'number', step: '0.01', min: '0',
      value: v.opening_cash == null || v.opening_cash === '' ? '' : String(v.opening_cash),
      disabled: lockIdentity,
      hint: 'Recorded as the safe\'s opening entry, so the safe balance is a real derivation rather than a number that appears the first time somebody deposits.',
    }));
    identity.appendChild(ui.field({ label: 'Address', name: n('address'), span: true, value: v.address || '', disabled: lockIdentity }));
    identity.appendChild(ui.field({ label: 'City', name: n('city'), value: v.city || '' }));
    identity.appendChild(ui.field({ label: 'State', name: n('state'), value: v.state || '', disabled: lockIdentity }));
    identity.appendChild(ui.field({ label: 'LGA', name: n('lga'), value: v.lga || '', disabled: lockIdentity }));
    identity.appendChild(ui.field({ label: 'Phone', name: n('phone'), value: v.phone || '' }));
    identity.appendChild(ui.field({ label: 'Email', name: n('email'), span: true, value: v.email || '' }));
    parent.appendChild(identity);

    parent.appendChild(ui.h('h2', {}, 'Clock-in fence'));
    parent.appendChild(ui.h('p', { class: 'sub' }, 'The fence does not block a clock-in. It records the distance and flags anything outside. Location is evidence for a manager to read, never a reason to stop somebody recording that they came to work.'));
    const fence = ui.h('div', { class: 'form-pairs' });
    fence.appendChild(ui.field({ label: 'Latitude', name: n('latitude'), value: v.latitude == null ? '' : String(v.latitude), disabled: lockIdentity, hint: 'Between -90 and 90.' }));
    fence.appendChild(ui.field({ label: 'Longitude', name: n('longitude'), value: v.longitude == null ? '' : String(v.longitude), disabled: lockIdentity, hint: 'Between -180 and 180. Swapping the two is the most common mistake and the server refuses it.' }));
    fence.appendChild(ui.field({ label: 'Fence radius (m)', name: n('geofence_radius_meters'), type: 'number', step: '1', min: '0', max: '50000', value: v.geofence_radius_meters == null ? '150' : String(v.geofence_radius_meters), disabled: lockIdentity, hint: 'Phone GPS is accurate to about 10–50m outdoors and much worse indoors. 150–300m is realistic for a shop.' }));
    fence.appendChild(ui.field({ label: 'Attendance mode', name: n('attendance_mode'), options: ATTENDANCE_MODES, value: v.attendance_mode || 'GEOLOCATION', disabled: lockIdentity }));
    const useHere = ui.h('button', { class: 'btn btn-sm', type: 'button', disabled: lockIdentity }, 'Use where I am now');
    useHere.addEventListener('click', () => {
      if (!global.navigator || !global.navigator.geolocation) { ui.warn('This device will not share a location.'); return; }
      useHere.disabled = true;
      useHere.textContent = 'Finding you…';
      global.navigator.geolocation.getCurrentPosition((pos) => {
        const lat = parent.querySelector(`[name="${n('latitude')}"]`);
        const lng = parent.querySelector(`[name="${n('longitude')}"]`);
        if (lat) lat.value = String(U.round2(pos.coords.latitude * 1000000) / 1000000);
        if (lng) lng.value = String(U.round2(pos.coords.longitude * 1000000) / 1000000);
        useHere.disabled = false;
        useHere.textContent = 'Use where I am now';
        ui.ok(`Set to within about ${U.numInput(pos.coords.accuracy || 0)}m of here. Step outside and try again if that looks too far out.`);
      }, (err) => {
        useHere.disabled = false;
        useHere.textContent = 'Use where I am now';
        ui.warn(err && err.message ? err.message : 'Could not get a location.');
      }, { enableHighAccuracy: true, timeout: 12000 });
    });
    fence.appendChild(ui.h('div', { class: 'span-all' }, useHere));
    parent.appendChild(fence);
    if (showActive) {
      parent.appendChild(ui.h('div', { class: 'form-pairs' }, ui.field({
        label: 'Branch is open',
        name: n('is_active'),
        type: 'checkbox',
        value: v.is_active == null ? 1 : (Number(v.is_active) ? 1 : 0),
        span: true,
        disabled: lockIdentity,
        hint: 'The branch list shows this as open or closed. Closing it stops new tills. Staff still assigned to it have to be confirmed.',
      })));
    }
  }

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
      id: 'modules',
      tab: 'Modules',
      title: 'Modules',
      blurb: 'What this deployment does. A module switched off is refused by the server, not merely hidden on the screen.',
      items: [
        { key: 'attendance_module_enabled', type: 'flag', label: 'Staff attendance and clock-in' },
        { key: 'warranty_module_enabled', type: 'flag', label: 'Warranty tracking' },
        { key: 'instalment_module_enabled', type: 'flag', label: 'Instalment plans (work and pay)' },
        { key: 'delivery_module_enabled', type: 'flag', label: 'Delivery and installation jobs' },
        { key: 'serial_tracking_enabled', type: 'flag', label: 'This business uses serial numbers', hint: 'Off unless you turn it on. Leave it off and a sale is the product, the quantity and the price — no serial box on the counter, on goods received, or on the receipt. Turn it on for phones, generators and appliances, where each unit has its own number and a warranty claim has to name that unit.' },
        { key: 'offline_sync_enabled', type: 'flag', label: 'Offline sync', hint: 'Sales taken while the network is down are queued and pushed when it returns.' },
        { key: 'multi_branch_enabled', type: 'flag', label: 'More than one branch' },
        { key: 'multi_business_enabled', type: 'flag', label: 'More than one business' },
      ],
    },
    {
      id: 'staff',
      tab: 'Staff',
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
      id: 'managers',
      tab: 'Managers',
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
      id: 'tax',
      tab: 'Tax',
      title: 'Tax',
      blurb: 'Nigeria: VAT 7.5%. Withholding tax rates are held as data, not code, so a change in the Finance Act is an update rather than a release.',
      items: [
        { key: 'vat_enabled', type: 'flag', label: 'The business is VAT-registered and charges VAT' },
        { key: 'vat_rate_percent', type: 'number', label: 'VAT rate (%)', min: 0, max: 100, hint: '7.5% is the standard Nigerian rate. The server warns if it is set to anything else.' },
        { type: 'fact', label: 'Why there is no VAT-inclusive switch', text: 'Prices in this system are always quoted VAT-inclusive, which is how Nigerian shops price and how the sales table stores a subtotal. The VAT is extracted from the quoted price for the return rather than added at the counter, so a shelf price is the price a customer pays. Setting the rate above is the whole of the control.' },
      ],
    },
    {
      id: 'credit',
      tab: 'Credit',
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
      id: 'stock',
      tab: 'Stock',
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
      id: 'cash',
      tab: 'Cash',
      title: 'Cash and banking',
      blurb: 'The drawer, the safe and the bank.',
      items: [
        { type: 'fact', label: 'Why a sale needs an open till', text: 'There is no switch. Cash taken with no till open is cash that cannot be reconciled, and the difference surfaces at the end of the month as a shortage the cashier cannot explain. Every sale is tied to a till session, so the count at close is the check.' },
        { type: 'fact', label: 'Banking a deposit', text: 'Every withdrawal, banking, expense and till funding has to name the reference it will appear under on the bank statement \u2014 the deposit slip, transfer number or cheque number. Without it the entry cannot be matched to the bank, which is the only proof the money arrived. There is nothing to switch off.' },
      ],
    },
    {
      id: 'notes',
      tab: 'Notes',
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
        ? ui.h('div', { class: 'form-pairs' }, ui.field({
          label: 'Business', name: 'business_id', required: true, span: true,
          options: reachableBusinesses.map((biz) => ({
            value: biz.id,
            label: biz.name + (String(biz.id) === String(SR.state.activeBusinessId) ? ' — the one you are in' : ''),
          })),
          value: SR.state.activeBusinessId || (reachableBusinesses[0] || {}).id || '',
          hint: 'Each business keeps its own books, catalogue and staff. A branch cannot be moved between businesses later.',
        }))
        : ui.h('div', { class: 'form-pairs' }, ui.field({
          label: 'Business', name: 'business_label', span: true, disabled: true,
          value: b.business_name || 'Its business',
          hint: 'This branch belongs to that business and cannot be moved to another one.',
        }));
      appendBranchFeatures(form, {
        values: b,
        businessNode: businessField,
        lockIdentity: !isNew && !SR.state.atLeast('OWNER'),
        showActive: !isNew,
      });

      const cancel = ui.h('button', { class: 'btn', onClick: () => m.close() }, 'Cancel');
      const go = ui.h('button', { class: 'btn btn-primary' }, isNew ? 'Open the branch' : 'Save changes');
      const m = ui.openModal({ title: isNew ? 'Open a branch' : b.name, body: form, footer: [cancel, go], size: 'wide' });

      go.addEventListener('click', async () => {
        const v = ui.readForm(form);
        const payload = {};
        for (const [k, val] of Object.entries(v)) {
          if (k === 'business_label') continue;
          if (k === 'code') { payload[k] = val === null || val === '' ? null : val; continue; }
          if (k === 'is_active') { payload[k] = Boolean(Number(val)); continue; }
          if (['latitude', 'longitude', 'geofence_radius_meters', 'opening_cash'].includes(k)) {
            payload[k] = val === null ? null : Number(val);
            continue;
          }
          payload[k] = val;
        }
        await ui.withBusy(form, async () => {
          try {
            let res;
            try {
              res = isNew
                ? await SR.api.post('/api/branches', payload)
                : await SR.api.put(`/api/branches/${encodeURIComponent(b.id)}`, payload);
            } catch (err) {
              if (!isNew && err && err.code === 'BRANCH_HAS_STAFF') {
                const ok = await ui.confirmDialog({
                  title: 'Close this branch?',
                  message: err.message || 'Staff are still assigned here.',
                  confirmLabel: 'Close the branch',
                  danger: true,
                });
                if (!ok) return;
                res = await SR.api.put(`/api/branches/${encodeURIComponent(b.id)}`, { ...payload, confirm_deactivate: true });
              } else {
                throw err;
              }
            }
            m.close();
            ui.ok(res.message || 'Saved.');
            // THE SHELL CACHES BRANCHES FOR FIVE MINUTES. Without this, Add someone — opened
            // straight after this — offered an empty branch chooser and then said add a branch.
            await SR.state.load({ force: true }).catch(() => {});
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
        SR.state.atLeast('OWNER') ? ui.h('button', { class: 'btn btn-sm', onClick: () => openProfiles() }, 'The verticals') : null)));

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
      form.appendChild(ui.h('div', { class: 'form-pairs' },
        ui.field({ label: 'Trading name', name: 'name', value: b.name || '', required: true, placeholder: 'Emeka Electronics' }),
        ui.field({ label: 'Registered (legal) name', name: 'legal_name', value: b.legal_name || '', hint: 'The name on the CAC certificate. Appears on invoices and returns.' }),
        ui.field({ label: 'CAC number', name: 'cac_reg_no', value: b.cac_reg_no || '', placeholder: 'RC 1234567' }),
        ui.field({ label: 'TIN', name: 'tin', value: b.tin || '', placeholder: '12345678-0001' }),
        ui.field({ label: 'VAT registered', name: 'vat_registered', type: 'checkbox', value: Number(b.vat_registered) ? 1 : 0, hint: 'Charging VAT without being registered is worse than not charging it.' }),
        ui.field({ label: 'Contact name', name: 'contact_name', value: b.contact_name || '' }),
        ui.field({ label: 'Contact phone', name: 'contact_phone', value: b.contact_phone || '' }),
        ui.field({ label: 'Contact email', name: 'contact_email', value: b.contact_email || '' }),
        ui.field({ label: 'Address', name: 'address', span: true, value: b.address || '' })));
      if (!isNew && b.profile && b.profile.dispatch) {
        const dispatchHost = ui.h('div', {});
        form.appendChild(dispatchHost);
        paintDispatch(dispatchHost, b.profile.dispatchModes, b.profile.dispatchConfirmed);
      }
      if (!isNew) {
        const billed = Boolean(b.profile && b.profile.features && b.profile.features.billBeforeReceipt);
        form.appendChild(ui.h('h2', {}, 'How goods leave'));
        form.appendChild(ui.h('div', { class: 'form-pairs' }, ui.field({
          label: 'Bill, then receipt, then release',
          name: 'bill_before_receipt',
          type: 'checkbox',
          value: billed ? 1 : 0,
          span: true,
          hint: 'On for a warehouse, a wholesale desk, a building-materials yard, a furniture showroom, an electronics plaza, a water-packing plant and a bakery. The desk prints a bill and holds the goods. The customer pays. The receipt prints, then a release note, and only then do the goods leave. A pharmacy counter, a supermarket and a general shop stay pay-and-receipt unless you turn this on.',
        }),
        ui.field({
          label: 'Hold the next batch until the last credit supply is paid',
          name: 'credit_until_paid',
          type: 'checkbox',
          value: b.profile && b.profile.creditUntilPaid ? 1 : 0,
          span: true,
          hint: 'On for a water plant and a bakery. A shop supplied on credit does not collect the next batch until that supply is paid. Cash is not held. An owner can release one batch and the reason is kept on the sale. Turn this on for any vertical that works the same way. It does not make the business a pharmacy.',
        }),
        ui.field({
          label: 'Count manufacturing inputs and machinery service',
          name: 'manufacturing',
          type: 'checkbox',
          value: b.profile && b.profile.manufacturing ? 1 : 0,
          span: true,
          hint: 'Chemicals, film, flour, leather and whatever else this plant uses are stock, not till goods, until you say an input is also sold. Machinery service is its own expense so the cost can be counted. The deliveries board shows the count.',
        }),
        ui.field({
          label: 'Sell on the spot, paid before the goods leave',
          name: 'sell_on_spot',
          type: 'checkbox',
          value: !b.profile || b.profile.sellOnSpot !== false ? 1 : 0,
          span: true,
          hint: 'Prints a receipt. A walk-in, a hawker, and a counter sale are this. Turn it off only if this business never takes payment before the goods leave.',
        }),
        ui.field({
          label: 'Sell on credit, payment after the goods leave',
          name: 'sell_on_credit',
          type: 'checkbox',
          value: b.profile && b.profile.sellOnCredit ? 1 : 0,
          span: true,
          hint: 'Prints an invoice, not a receipt. On for a bakery and a water plant: the cashier or the dispatch rider can choose credit or upfront for each sale, and that choice is kept from the till to the drop. A depot on credit does not get a receipt until the money is taken. Turn this on for any vertical that supplies on account. It does not make the business a pharmacy.',
        })));
      }

      if (isNew) {
        form.appendChild(ui.h('h2', {}, 'Vertical'));
        form.appendChild(ui.h('p', { class: 'sub' }, 'The vertical decides the categories, the unit ladders, the compliance records (SONCAP / SON) and the warranty rules the starter catalogue is built from. It cannot be changed once the business has products.'));
        form.appendChild(ui.h('div', { class: 'form-pairs' }, ui.field({
          label: 'What kind of business is it',
          span: true,
          name: 'profile_code',
          required: true,
          options: [{ value: '', label: 'Loading the verticals…' }],
        })));
        const dispatchHost = ui.h('div', {});
        form.appendChild(dispatchHost);
        form._paintDispatch = (row) => paintDispatch(dispatchHost, row && row.dispatchModes);
        form.appendChild(ui.h('h2', {}, 'First branch'));
        form.appendChild(ui.h('p', { class: 'sub' }, 'Left blank, the address, phone and email follow the business above. You can change any of them later, in the same places, when you edit the branch.'));
        appendBranchFeatures(form, { prefix: 'branch_', values: { name: '', geofence_radius_meters: 150, attendance_mode: 'GEOLOCATION', branch_type: 'RETAIL' } });
        form.appendChild(ui.h('div', { class: 'form-pairs' },
          ui.field({ label: 'Build the starter catalogue', name: 'seed_catalogue', type: 'checkbox', value: 1, span: true, hint: 'Takes the profile\'s sample products, ladders and barcodes. Turn it off for an empty catalogue you fill yourself.' })));
      }

      const cancel = ui.h('button', { class: 'btn', onClick: () => m.close() }, 'Cancel');
      const go = ui.h('button', { class: 'btn btn-primary', disabled: isNew }, isNew ? 'Create and provision' : 'Save changes');
      const m = ui.openModal({ title: isNew ? 'Create a business' : b.name, body: form, footer: [cancel, go], size: 'wide' });
      if (isNew) fillVerticalSelect(form, go, (row) => { if (form._paintDispatch) form._paintDispatch(row); });

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
                dispatch_modes: form.querySelector('[name="dispatch_class_1"]') ? readDispatch(v) : undefined,
                branch: {
                  name: v.branch_name || undefined,
                  code: v.branch_code || undefined,
                  branch_type: v.branch_branch_type || undefined,
                  address: v.branch_address || v.address || undefined,
                  city: v.branch_city || undefined,
                  state: v.branch_state || undefined,
                  lga: v.branch_lga || undefined,
                  phone: v.branch_phone || v.contact_phone || undefined,
                  email: v.branch_email || v.contact_email || undefined,
                  opening_cash: v.branch_opening_cash === null ? 0 : Number(v.branch_opening_cash),
                  latitude: v.branch_latitude,
                  longitude: v.branch_longitude,
                  geofence_radius_meters: v.branch_geofence_radius_meters === null ? 150 : Number(v.branch_geofence_radius_meters),
                  attendance_mode: v.branch_attendance_mode || undefined,
                },
              });
              m.close();
              ui.ok(res.message || 'Business created and provisioned.');
              await SR.state.load({ force: true }).catch(() => {});
              load();
            } else {
              if (form.querySelector('[name="dispatch_class_1"]')) payload.dispatch_modes = readDispatch(v);
              const res = await SR.api.put(`/api/businesses/${encodeURIComponent(b.id)}`, payload);
              m.close();
              ui.ok(res.message || 'Saved.');
              await SR.state.load({ force: true }).catch(() => {});
              load();
            }
          } catch (err) { ui.apiError(err); }
        });
      });
    }

    function verticalLabel(row) {
      return (row && ((row.profile && row.profile.label) || row.label || row.name)) || (row && (row.profile_code || row.code)) || '';
    }

    function verticalCode(row) {
      return String((row && (row.profile_code || row.code)) || '').trim();
    }

    async function loadVerticals() {
      const data = await SR.api.get('/api/catalogue/profiles', { query: SR.state.query({}) });
      const list = (data && (data.data || data.profiles)) || [];
      return list.slice().sort((a, b) => verticalLabel(a).localeCompare(verticalLabel(b)));
    }

    async function fillVerticalSelect(form, go, onPick) {
      const select = form.querySelector('select[name="profile_code"]');
      try {
        const list = await loadVerticals();
        if (!select) return;
        select.replaceChildren();
        const usable = list.filter((row) => verticalCode(row));
        if (!usable.length) {
          select.appendChild(ui.h('option', { value: '' }, 'No verticals are available'));
          return;
        }
        for (const row of usable) {
          select.appendChild(ui.h('option', { value: verticalCode(row) }, verticalLabel(row)));
        }
        const pick = () => {
          if (!onPick) return;
          const chosen = usable.find((row) => verticalCode(row) === select.value);
          onPick(chosen || null);
        };
        select.addEventListener('change', pick);
        pick();
        if (go) go.disabled = false;
      } catch (err) {
        if (select) select.replaceChildren(ui.h('option', { value: '' }, 'Could not load the verticals'));
        ui.apiError(err);
      }
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

    function paintDispatch(host, modes, confirmed) {
      host.replaceChildren();
      if (!modes) return;
      const first = modes[0] || { vehicleClass: 'PICKUP', arrangement: 'OWNED', salesSharePct: 6 };
      const second = modes[1] || null;
      host.appendChild(ui.h('h2', {}, 'Dispatch'));
      host.appendChild(ui.h('p', { class: 'sub' }, confirmed
        ? 'This mix is saved. One type, or two. A vehicle the business owns pays the driver a wage. A partner owns the vehicle and is paid a share of the sales they deliver. A driver is still Staff.'
        : 'Suggested for this trade. Save it to confirm — one type, or a mix of two. Owned vehicles pay a wage. Partner drivers own the vehicle and are paid on the sales they deliver. A bike is not a new login role.'));
      host.appendChild(ui.h('div', { class: 'form-grid' },
        ui.field({ label: 'First vehicle', name: 'dispatch_class_1', value: first.vehicleClass, options: DISPATCH_VEHICLES }),
        ui.field({ label: 'Who owns it', name: 'dispatch_arrangement_1', value: first.arrangement, options: DISPATCH_HOW }),
        ui.field({ label: 'Partner share %', name: 'dispatch_share_1', type: 'number', min: '1', max: '40', step: '0.5', value: first.salesSharePct || 8, hint: 'Used only when the driver owns the vehicle. Between 1 and 40.' }),
        ui.field({ label: 'Second vehicle', name: 'dispatch_class_2', value: second ? second.vehicleClass : '', options: [{ value: '', label: 'None — one is enough' }, ...DISPATCH_VEHICLES] }),
        ui.field({ label: 'Who owns the second', name: 'dispatch_arrangement_2', value: second ? second.arrangement : 'PARTNER', options: DISPATCH_HOW }),
        ui.field({ label: 'Second share %', name: 'dispatch_share_2', type: 'number', min: '1', max: '40', step: '0.5', value: (second && second.salesSharePct) || 8, hint: 'Ignored when there is no second vehicle, and when the business owns it.' })));
    }

    function readDispatch(v) {
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

    function verticalCard(p) {
      const features = p.enabledFeatures || [];
      return ui.h('article', { class: 'vertical-card' },
        ui.h('div', { class: 'vertical-card-head' },
          ui.h('h3', {}, verticalLabel(p) || 'Vertical'),
          ui.badge(verticalCode(p) || '—', 'badge-mute')),
        p.blurb ? ui.h('p', { class: 'hint' }, p.blurb) : null,
        ui.h('div', { class: 'vertical-meta' },
          ui.h('span', {}, `${U.qty(p.categoryCount || 0)} categories`),
          ui.h('span', {}, p.baseUnit ? `Base unit ${U.humanise(p.baseUnit)}` : 'No base unit')),
        ui.h('div', { class: 'vertical-note' },
          (p.complianceFields || []).length
            ? `Compliance: ${(p.complianceFields || []).join(', ')}`
            : 'No extra compliance fields'),
        p.dispatch ? ui.h('p', { class: 'hint' }, `Dispatch: ${p.dispatch}. The owner confirms one type, or a mix of two.`) : null,
        ui.h('div', { class: 'row vertical-flows' },
          features.slice(0, 6).map((f) => ui.badge(U.humanise(f), 'badge-info')),
          features.length > 6 ? ui.h('span', { class: 'hint' }, `+${features.length - 6} more`) : null));
    }

    async function openProfiles() {
      const body = ui.h('div', { class: 'vertical-pane' }, ui.loading('Opening the verticals…'));
      const m = ui.openModal({ title: 'The verticals', body, size: 'wide' });
      try {
        const list = await loadVerticals();
        body.replaceChildren(ui.h('div', { class: 'stack' },
          ui.h('p', { class: 'sub' }, 'Each vertical is data, not code: categories, unit ladders, measured axes, compliance records and warranty rules. A client on any of them gets a working catalogue on day one.'),
          list.length
            ? ui.h('div', { class: 'vertical-grid' }, list.map(verticalCard))
            : ui.empty({ title: 'No profiles loaded', message: 'Profiles ship with the deployment.' })));
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
    const canEdit = SR.state.canChangeDeployment && SR.state.canChangeDeployment();
    const tabs = [{ id: 'shop', label: 'Shop', find: 'shop branding logo trading name receipt footer contact' }]
      .concat(SETTING_GROUPS.map((group) => ({
        id: group.id,
        label: group.tab,
        find: `${group.tab} ${group.title} ${group.blurb}`.toLowerCase(),
      })));
    let active = ctx.query.tab || '';
    try { active = active || sessionStorage.getItem('sr.settingsTab') || ''; } catch (e) { /* private mode */ }
    if (!tabs.some((tab) => tab.id === active)) active = 'shop';

    const wrap = ui.h('div', { class: 'settings-page stack' });
    const unsaved = ui.h('span', { class: 'settings-unsaved', hidden: true });
    const saveBtn = ui.h('button', {
      class: 'btn btn-primary settings-save',
      hidden: !canEdit,
      onClick: () => save(),
    }, 'Save changes');
    const find = ui.h('input', {
      type: 'search',
      placeholder: 'Find a setting — discount, VAT, logo…',
      autocomplete: 'off',
      'aria-label': 'Find a setting',
    });
    const tabList = ui.h('div', { class: 'tabs', role: 'tablist', 'aria-label': 'Settings sections' });
    const tabButtons = new Map();
    for (const tab of tabs) {
      const btn = ui.h('button', {
        class: 'tab',
        type: 'button',
        role: 'tab',
        id: `settings-tab-${tab.id}`,
        'aria-controls': `settings-panel-${tab.id}`,
        'aria-selected': 'false',
        onClick: () => showTab(tab.id, { focus: false }),
      }, tab.label);
      tabButtons.set(tab.id, btn);
      tabList.appendChild(btn);
    }
    const dock = ui.h('div', { class: 'settings-dock' },
      ui.h('div', { class: 'settings-dock-head' },
        ui.h('div', { class: 'settings-dock-title' },
          ui.h('h1', {}, 'Settings'),
          ui.h('p', { class: 'sub' }, canEdit
            ? 'One section at a time. Save stays here, however far you scroll.'
            : (SR.state.isOwner()
              ? 'You can look through these. The proprietor saves a change that covers every business.'
              : 'You can look through these. An owner has to save a change.'))),
        ui.h('div', { class: 'settings-dock-actions' }, unsaved, saveBtn)),
      ui.h('div', { class: 'settings-find' }, find),
      tabList);
    wrap.appendChild(dock);

    const host = ui.h('div', { class: 'settings-host' });
    wrap.appendChild(host);
    const noMatch = ui.h('div', { class: 'alert', hidden: true }, 'Nothing matches that. Try “discount”, “VAT”, “till” or “logo”.');
    let form = null;
    let brandingBefore = null;
    // The values the form was filled with. Compared against the live inputs, not
    // against SR.state.settings: that object is the public subset from sign-in,
    // and it omits notes. A saved note then counted as one unsaved change on
    // every visit, and saving it did not clear the count.
    let settingsBefore = null;

    function onKey(ev) {
      if ((ev.ctrlKey || ev.metaKey) && String(ev.key).toLowerCase() === 's') {
        ev.preventDefault();
        if (canEdit) save();
      }
    }
    document.addEventListener('keydown', onKey);
    if (ctx.onCleanup) ctx.onCleanup(() => document.removeEventListener('keydown', onKey));

    function tagItem(node, text) {
      node.classList.add('setting-item');
      node.dataset.find = String(text || '').toLowerCase();
      return node;
    }

    function showTab(id, { focus = false } = {}) {
      if (!tabs.some((tab) => tab.id === id)) id = 'shop';
      active = id;
      try { sessionStorage.setItem('sr.settingsTab', id); } catch (e) { /* fine */ }
      try {
        const url = new URL(global.location.href);
        url.searchParams.set('tab', id);
        history.replaceState({}, '', url.pathname + url.search);
      } catch (e) { /* the tab still changes */ }
      for (const tab of tabs) {
        const btn = tabButtons.get(tab.id);
        const on = tab.id === id;
        if (btn) {
          btn.classList.toggle('is-active', on);
          btn.setAttribute('aria-selected', on ? 'true' : 'false');
          if (on && btn.parentElement) {
            const list = btn.parentElement;
            const left = btn.offsetLeft;
            const right = left + btn.offsetWidth;
            if (left < list.scrollLeft) list.scrollLeft = Math.max(0, left - 8);
            else if (right > list.scrollLeft + list.clientWidth) list.scrollLeft = right - list.clientWidth + 8;
          }
        }
      }
      if (form) {
        for (const panel of form.querySelectorAll('.settings-panel')) {
          panel.hidden = panel.dataset.tab !== id;
        }
      }
      if (focus) {
        const btn = tabButtons.get(id);
        if (btn) btn.focus();
      }
      const main = document.getElementById('main');
      const panel = form && form.querySelector(`.settings-panel[data-tab="${id}"]`);
      if (main && panel && !panel.hidden) {
        const gap = panel.getBoundingClientRect().top - dock.getBoundingClientRect().bottom;
        if (gap < -4) main.scrollTop += gap;
      }
      applySearch();
    }

    function sameSetting(saved, current) {
      if (saved === current) return true;
      const savedEmpty = saved == null || saved === '';
      const currentEmpty = current == null || current === '';
      if (savedEmpty && currentEmpty) return true;
      if (typeof saved === 'number' || typeof current === 'number') {
        const a = Number(saved);
        const b = Number(current);
        if (Number.isFinite(a) && Number.isFinite(b)) return a === b;
      }
      return String(saved == null ? '' : saved) === String(current == null ? '' : current);
    }

    function snapshotSettings() {
      settingsBefore = {};
      if (!form) return;
      const values = ui.readForm(form);
      for (const k of Object.keys(values)) {
        if (BRANDING_FIELDS.indexOf(k) !== -1) continue;
        settingsBefore[k] = values[k];
      }
    }

    function changedPayload() {
      const settings = {};
      const branding = {};
      if (!form || !settingsBefore) return { settings, branding };
      const values = ui.readForm(form);
      for (const [k, v] of Object.entries(values)) {
        if (BRANDING_FIELDS.indexOf(k) !== -1) continue;
        if (!Object.prototype.hasOwnProperty.call(settingsBefore, k)) continue;
        if (sameSetting(settingsBefore[k], v)) continue;
        settings[k] = v;
      }
      if (brandingBefore) {
        for (const k of BRANDING_FIELDS) {
          if (!Object.prototype.hasOwnProperty.call(values, k)) continue;
          const next = values[k] == null ? '' : String(values[k]);
          const prev = brandingBefore[k] == null ? '' : String(brandingBefore[k]);
          if (next !== prev) branding[k] = values[k] == null ? '' : values[k];
        }
      }
      return { settings, branding };
    }

    function paintDirty() {
      const { settings, branding } = changedPayload();
      const n = Object.keys(settings).length + Object.keys(branding).length;
      unsaved.hidden = !n || !canEdit;
      unsaved.textContent = n === 1 ? '1 unsaved change' : `${n} unsaved changes`;
      saveBtn.classList.toggle('is-attention', n > 0);
    }

    function applySearch({ jump = false } = {}) {
      const q = String(find.value || '').trim().toLowerCase();
      if (!form) return;
      let any = !q;
      for (const tab of tabs) {
        const panel = form.querySelector(`.settings-panel[data-tab="${tab.id}"]`);
        const btn = tabButtons.get(tab.id);
        if (!panel) continue;
        const tabHit = !q || String(panel.dataset.find || '').indexOf(q) !== -1;
        let hits = 0;
        for (const item of panel.querySelectorAll('.setting-item')) {
          const show = !q || tabHit || String(item.dataset.find || '').indexOf(q) !== -1;
          item.hidden = !show;
          if (show) hits += 1;
        }
        const none = panel.querySelector('.settings-none');
        if (none) none.hidden = !q || hits > 0 || panel.hidden;
        if (btn) btn.classList.toggle('is-dim', Boolean(q) && hits === 0);
        if (hits) any = true;
      }
      noMatch.hidden = any;
      const current = form.querySelector(`.settings-panel[data-tab="${active}"]`);
      const currentHits = current ? current.querySelectorAll('.setting-item:not([hidden])').length : 0;
      if (jump && q && !currentHits) {
        const next = tabs.find((tab) => {
          const btn = tabButtons.get(tab.id);
          return btn && !btn.classList.contains('is-dim');
        });
        if (next && next.id !== active) showTab(next.id);
      }
    }

    find.addEventListener('input', () => applySearch({ jump: true }));
    find.addEventListener('keydown', (ev) => {
      if (ev.key !== 'Enter') return;
      ev.preventDefault();
      const next = tabs.find((tab) => {
        const btn = tabButtons.get(tab.id);
        return btn && !btn.classList.contains('is-dim');
      });
      if (next) showTab(next.id);
    });

    async function load() {
      host.replaceChildren(ui.skeleton(6));
      let data;
      try {
        data = await SR.api.get('/api/settings', { query: SR.state.query({}) });
      } catch (err) {
        host.replaceChildren(ui.errorBlock(err, { retry: { label: 'Try again', run: load } }));
        return;
      }
      const s = data.settings || {};
      form = ui.h('div', { class: 'stack' });
      form.addEventListener('input', paintDirty);
      form.addEventListener('change', paintDirty);
      form.appendChild(renderBrandingCard());

      for (const group of SETTING_GROUPS) {
        const card = ui.h('div', {
          class: 'card settings-panel',
          'data-tab': group.id,
          'data-find': `${group.tab} ${group.title} ${group.blurb}`.toLowerCase(),
          role: 'tabpanel',
          id: `settings-panel-${group.id}`,
          'aria-labelledby': `settings-tab-${group.id}`,
          hidden: true,
        });
        const body = ui.h('div', { class: 'card-body' });
        body.appendChild(ui.h('h2', {}, group.title));
        body.appendChild(ui.h('p', { class: 'sub' }, group.blurb));
        const grid = ui.h('div', { class: 'form-grid' });
        for (const item of group.items) {
          if (item.type === 'fact') {
            grid.appendChild(tagItem(ui.h('div', { class: 'span-2 setting-fact' },
              ui.h('div', { class: 'ctl' }, item.label),
              ui.h('div', { class: 'hint' }, item.text)), `${item.label} ${item.text}`));
            continue;
          }
          if (!(item.key in s)) {
            grid.appendChild(tagItem(ui.h('div', { class: 'span-2' },
              ui.h('div', { class: 'ctl' }, item.label),
              ui.h('div', { class: 'err' }, `This control is not available on this deployment: the server has no “${item.key}” setting.`)), item.label));
            continue;
          }
          let field;
          if (item.type === 'flag') {
            field = ui.field({ label: item.label, name: item.key, type: 'checkbox', value: Number(s[item.key]) ? 1 : 0, disabled: !canEdit, hint: item.hint || null });
          } else if (item.type === 'number') {
            field = ui.field({ label: item.label, name: item.key, type: 'number', step: 'any', min: item.min == null ? null : String(item.min), max: item.max == null ? null : String(item.max), value: s[item.key] == null ? '' : String(s[item.key]), disabled: !canEdit, hint: item.hint || null });
          } else {
            field = ui.field({ label: item.label, name: item.key, value: s[item.key] == null ? '' : String(s[item.key]), disabled: !canEdit, hint: item.hint || null });
          }
          grid.appendChild(tagItem(field, `${item.label} ${item.hint || ''} ${item.key}`));
        }
        body.appendChild(grid);
        body.appendChild(ui.h('p', { class: 'hint settings-none', hidden: true }, 'Nothing in this section matches. Another tab may.'));
        card.appendChild(body);
        form.appendChild(card);
      }
      for (const el of form.querySelectorAll('input, textarea, select')) {
        if (!el.getAttribute('autocomplete')) el.setAttribute('autocomplete', 'off');
      }
      host.replaceChildren(noMatch, form);
      showTab(active);
      snapshotSettings();
      paintDirty();
    }

    function renderBrandingCard() {
      const card = ui.h('div', {
        class: 'card settings-panel',
        'data-tab': 'shop',
        'data-find': 'shop branding logo trading name receipt footer contact',
        role: 'tabpanel',
        id: 'settings-panel-shop',
        'aria-labelledby': 'settings-tab-shop',
        hidden: true,
      });
      const body = ui.h('div', { class: 'card-body' });
      body.appendChild(ui.h('h2', {}, 'The shop’s name, logo and receipts'));
      body.appendChild(ui.h('p', { class: 'sub' }, 'What customers see: the sign-in screen, the header, and the foot of every receipt. The logo saves as soon as you choose a file. The name and contact save with Save changes.'));
      const inner = ui.h('div', {});
      body.appendChild(inner);
      body.appendChild(ui.h('p', { class: 'hint settings-none', hidden: true }, 'Nothing in this section matches. Another tab may.'));
      card.appendChild(body);

      async function loadBranding() {
        inner.replaceChildren(ui.skeleton(4));
        let b;
        try {
          b = await SR.api.get('/api/branding/full');
        } catch (err) {
          inner.replaceChildren(ui.errorBlock(err, { retry: { label: 'Try again', run: loadBranding } }));
          return;
        }
        const admin = b.admin || {};
        const grid = ui.h('div', { class: 'form-grid' });
        const fields = [
          ['Trading name', 'business_name', b.name || '', 'Appears on the sign-in screen, the header and every receipt. Leave it unset and the name of your first business is used.'],
          ['Receipt footer', 'receipt_footer_text', admin.receiptFooter || b.receiptFooter || '', 'A thank-you, a returns policy, a phone number. Up to 500 characters.'],
          ['Contact name', 'admin_contact_name', admin.contactName || '', 'Who a customer or an auditor should ask for.'],
          ['Contact phone', 'admin_contact_phone', admin.contactPhone || '', ''],
          ['Contact email', 'admin_contact_email', admin.contactEmail || '', ''],
        ];
        for (const [label, name, value, hint] of fields) {
          grid.appendChild(tagItem(ui.field({ label, name, value, disabled: !canEdit, hint: hint || null }), `${label} ${hint} ${name}`));
        }

        const logoBox = tagItem(ui.h('div', { class: 'span-2' }), 'logo shop mark sign-in image');
        logoBox.appendChild(ui.h('div', { class: 'ctl' }, 'Logo'));
        const preview = ui.h('img', { alt: 'The current logo', class: 'brand-logo-preview' });
        const fallback = (b.defaultLogoUrl && String(b.defaultLogoUrl).indexOf('/brand/mark') === 0) ? b.defaultLogoUrl : '/brand/mark.svg';
        const fallbackSrc = SR.BUILD && fallback.indexOf('v=') < 0 ? fallback + '?v=' + SR.BUILD : fallback;
        preview.src = b.logoDataUrl || fallbackSrc;
        const file = ui.h('input', { type: 'file', accept: 'image/png,image/jpeg,image/webp,image/gif', disabled: !canEdit, class: 'brand-logo-input' });
        const hint = ui.h('div', { class: 'hint' }, b.logoDataUrl
          ? 'PNG, JPEG, WebP or GIF, up to 512 KB. SVG is refused: it can carry a script. Choosing a file saves the logo immediately.'
          : 'This is the StockRidge logo. Upload a PNG, JPEG, WebP or GIF to replace it. SVG is refused: it can carry a script. Choosing a file saves it immediately.');
        const remove = ui.h('button', { class: 'btn btn-sm', type: 'button', hidden: !b.logoDataUrl, disabled: !canEdit, onClick: async () => {
          if (!(await ui.confirmDialog({ title: 'Remove the logo', message: 'The StockRidge logo will be used instead.', confirmLabel: 'Remove', danger: true }))) return;
          try {
            const res = await SR.api.del('/api/branding/logo');
            ui.ok(res.message || 'Logo removed.');
            preview.src = fallbackSrc;
            remove.hidden = true;
            hint.textContent = 'This is the StockRidge logo. Upload a PNG, JPEG, WebP or GIF to replace it. Choosing a file saves it immediately.';
            await SR.state.load({ force: true }).catch(() => {});
            if (typeof SR.app.paintIdentity === 'function') SR.app.paintIdentity();
          } catch (err) { ui.apiError(err); }
        } }, 'Remove logo');
        file.addEventListener('change', async () => {
          const f = file.files && file.files[0];
          if (!f) return;
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
            preview.src = res.logoDataUrl || dataUrl;
            remove.hidden = false;
            hint.textContent = 'PNG, JPEG, WebP or GIF, up to 512 KB. Choosing a file saves the logo immediately.';
            await SR.state.load({ force: true }).catch(() => {});
            if (typeof SR.app.paintIdentity === 'function') SR.app.paintIdentity();
          } catch (err) { ui.apiError(err); } finally { file.value = ''; }
        });
        logoBox.appendChild(ui.h('div', { class: 'brand-logo-row' }, preview, ui.h('div', { class: 'stack' }, file, hint, remove)));

        brandingBefore = {
          business_name: b.name || '',
          receipt_footer_text: admin.receiptFooter || b.receiptFooter || '',
          admin_contact_name: admin.contactName || '',
          admin_contact_phone: admin.contactPhone || '',
          admin_contact_email: admin.contactEmail || '',
        };
        for (const el of grid.querySelectorAll('input, textarea, select')) {
          if (!el.getAttribute('autocomplete')) el.setAttribute('autocomplete', 'off');
        }
        inner.replaceChildren(ui.h('div', { class: 'stack' }, grid, logoBox));
        applySearch();
        paintDirty();
      }

      loadBranding();
      return card;
    }

    async function save() {
      if (!form || !canEdit) return;
      const { settings, branding } = changedPayload();
      if (!Object.keys(settings).length && !Object.keys(branding).length) {
        ui.info('Nothing has changed.');
        return;
      }
      saveBtn.disabled = true;
      const savedLabel = saveBtn.textContent;
      saveBtn.textContent = 'Saving…';
      try {
        await ui.withBusy(form, async () => {
          const messages = [];
          if (Object.keys(settings).length) {
            const res = await SR.api.put('/api/settings', settings);
            messages.push(res.message || 'Settings saved.');
          }
          if (Object.keys(branding).length) {
            const res = await SR.api.put('/api/branding', branding);
            messages.push(res.message || 'Branding updated.');
            if (typeof SR.app.paintIdentity === 'function') SR.app.paintIdentity();
          }
          ui.ok(messages.join(' '));
          await SR.state.load({ force: true });
          if (typeof SR.app.paintIdentity === 'function') SR.app.paintIdentity();
          await load();
        });
      } catch (err) {
        ui.apiError(err);
      } finally {
        saveBtn.textContent = savedLabel || 'Save changes';
        saveBtn.disabled = !canEdit;
        paintDirty();
      }
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
              { key: 'created_at', label: 'When', render: (a) => ui.h('div', {}, ui.h('div', {}, U.watClock(a.created_at)), ui.h('div', { class: 'hint' }, U.relTime(a.created_at))) },
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
        ['When', U.watClock(entry.created_at)],
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

    await load();
    return wrap;
  }

  SR.views = SR.views || {};
  SR.views.admin = { render };
}(window));
