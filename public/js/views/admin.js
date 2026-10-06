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
  const SETTING_GROUPS = [
    {
      title: 'Sales floor controls',
      blurb: 'What a member of staff may do without asking a manager.',
      items: [
        { key: 'staff_can_void_sales', type: 'flag', label: 'Staff may void a sale' },
        { key: 'staff_void_window_minutes', type: 'number', label: 'Void window (minutes)', min: 0, max: 1440, hint: 'Long enough to fix a mistyped sale, short enough that it is a correction rather than a habit.' },
        { key: 'staff_can_discount', type: 'flag', label: 'Staff may give a discount' },
        { key: 'staff_discount_max_pct', type: 'number', label: 'Maximum discount (%)', min: 0, max: 100 },
        { key: 'staff_can_sell_on_credit', type: 'flag', label: 'Staff may sell on credit' },
        { key: 'staff_credit_max', type: 'number', label: 'Credit cap per sale (₦)', min: 0, hint: 'A cap of zero with the permission on means staff can never actually do it — the server refuses that combination.' },
        { key: 'staff_can_adjust_stock', type: 'flag', label: 'Staff may adjust stock' },
        { key: 'staff_adjustment_max_units', type: 'number', label: 'Adjustment cap (units)', min: 0, max: 1000000 },
        { key: 'staff_safe_spend_max', type: 'number', label: 'Staff may spend from the safe up to (₦)', min: 0 },
      ],
    },
    {
      title: 'Tax',
      blurb: 'Nigeria: VAT 7.5%, prices quoted VAT-inclusive. Withholding is held as data, not code.',
      items: [
        { key: 'vat_enabled', type: 'flag', label: 'The business is VAT-registered and charges VAT' },
        { key: 'vat_rate_percent', type: 'number', label: 'VAT rate (%)', min: 0, max: 100, hint: '7.5% is the standard Nigerian rate. The server warns if it is set to anything else.' },
        { key: 'prices_include_vat', type: 'flag', label: 'Prices are quoted VAT-inclusive' },
      ],
    },
    {
      title: 'Stock and credit discipline',
      blurb: 'Decisions the system makes on your behalf, and how strict to be.',
      items: [
        { key: 'low_stock_alerts', type: 'flag', label: 'Warn when stock falls below the reorder level' },
        { key: 'expiry_alerts', type: 'flag', label: 'Warn about stock nearing expiry' },
        { key: 'expiry_alert_days', type: 'number', label: 'Days of warning before expiry', min: 1, max: 365 },
        // The compliance window lives here rather than as a flag because the
        // number is the policy: a bar with a fire certificate and a dealer with a
        // SONCAP registration do not think about renewals on the same timetable.
        // 90 is the ceiling the server enforces, because the expiry view the alert
        // list reads stops at a quarter's notice.
        { key: 'compliance_alert_days', type: 'number', label: 'Days of warning before a licence expires (90 maximum)', min: 1, max: 90 },
        { key: 'block_negative_stock', type: 'flag', label: 'Refuse to sell stock the branch does not have' },
        { key: 'require_serial_capture', type: 'flag', label: 'Capture serial numbers for products that track them' },
        { key: 'credit_limit_enforced', type: 'flag', label: 'Refuse credit above a customer\'s limit' },
        { key: 'default_credit_limit', type: 'number', label: 'Default credit limit for new customers (₦)', min: 0 },
        { key: 'debtor_reminder_days', type: 'number', label: 'Chase a debtor after (days)', min: 1, max: 365 },
      ],
    },
    {
      title: 'Cash and banking',
      blurb: 'How the drawer and the safe are policed.',
      items: [
        { key: 'require_till_open', type: 'flag', label: 'A sale needs an open till' },
        { key: 'till_variance_alert', type: 'number', label: 'Flag a till variance above (₦)', min: 0 },
        { key: 'require_safe_banking', type: 'flag', label: 'Require cash to be banked from the safe' },
        { key: 'banking_reminder_days', type: 'number', label: 'Remind to bank every (days)', min: 1, max: 30 },
      ],
    },
    {
      title: 'Business identity',
      blurb: 'Appears on receipts, labels and returns.',
      items: [
        { key: 'business_name', type: 'text', label: 'Trading name' },
        { key: 'receipt_footer', type: 'text', label: 'Receipt footer' },
        { key: 'receipt_show_vat', type: 'flag', label: 'Show the VAT breakdown on receipts' },
        { key: 'admin_contact_name', type: 'text', label: 'Support contact' },
        { key: 'admin_contact_phone', type: 'text', label: 'Support phone' },
        { key: 'admin_contact_email', type: 'text', label: 'Support email' },
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
      form.appendChild(ui.h('div', { class: 'form-grid' },
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
          if (!(item.key in s)) continue;          // a setting this deployment does not have
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
      host.replaceChildren(form);
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
          const res = await SR.api.put('/api/settings', { body });
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
        ui.h('button', { class: 'btn btn-sm', onClick: () => verifyChain() }, 'Verify the chain'),
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
              { key: 'username', label: 'Who', render: (a) => ui.h('div', {}, ui.h('div', {}, a.username || 'system'), ui.h('div', { class: 'hint' }, a.role || '')) },
              { key: 'action', label: 'What', render: (a) => ui.badge(U.humanise(a.action), actionTone(a.action)) },
              { key: 'entity_type', label: 'On', render: (a) => ui.h('div', {}, ui.h('div', {}, U.humanise(a.entity_type || '—')), ui.h('div', { class: 'hint' }, String(a.entity_id || '').slice(0, 10))) },
              { key: 'branch_name', label: 'Branch', render: (a) => a.branch_name || '—' },
              { key: 'summary', label: 'Detail', render: (a) => (a.summary || a.description || (a.after_json ? String(a.after_json).slice(0, 70) : '—')) },
              {
                key: 'hash',
                label: 'Chain',
                render: (a) => ui.h('span', { class: 'hint mono', title: a.hash || '' }, a.hash ? `${String(a.hash).slice(0, 8)}…` : '—'),
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
      body.appendChild(ui.kv([
        ['When', U.dateTime(entry.created_at)],
        ['Who', `${entry.username || 'system'}${entry.role ? ` (${entry.role})` : ''}`],
        ['Action', U.humanise(entry.action)],
        ['Entity', `${U.humanise(entry.entity_type || '—')} ${String(entry.entity_id || '').slice(0, 12)}`],
        ['Branch', entry.branch_name || '—'],
        ['Reason', entry.reason || '—'],
        ['Device', entry.device_id || '—'],
      ]));
      for (const [label, raw] of [['Before', entry.before_json], ['After', entry.after_json]]) {
        if (!raw) continue;
        let pretty = raw;
        try { pretty = JSON.stringify(JSON.parse(raw), null, 2); } catch (e) { /* leave as stored */ }
        body.appendChild(ui.h('h3', {}, label));
        body.appendChild(ui.h('pre', { class: 'pre-block' }, String(pretty).slice(0, 4000)));
      }
      body.appendChild(ui.h('h3', {}, 'Hash chain'));
      body.appendChild(ui.h('pre', { class: 'pre-block' }, `previous: ${entry.prev_hash || '—'}\nhash:     ${entry.hash || '—'}`));
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
