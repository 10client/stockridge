// =====================================================================
// public/js/views/admin.js — settings, plan, registers, businesses
// =====================================================================
// Two distinct audiences, deliberately kept apart:
//
//   OWNER  their own governance: which businesses and branches exist, what a
//          manager may do, what a cashier may do, and what their subscription
//          costs and allows. They can see their plan usage but CANNOT change it —
//          a limit a client can raise is not a limit.
//
//   ADMIN  the vendor seat: plan limits and subscription status. Hidden from the
//          client's own screens, not counted against their staff limit, and never
//          blocked by the subscription gate — otherwise a billing problem would
//          lock the vendor out of the instance they need in order to fix it.

'use strict';

import { endpoints as api } from '../api.js';
import { state, activeBusiness, isVendor, atLeast, can, setting } from '../state.js';
import { el, clear, badge, toneForStatus, table, money, spinner, reportError, toast, modal, field, readForm, emptyState, statCard, confirmDialog } from '../ui.js';

// ---------------------------------------------------------------------
// SETTINGS (owner)
// ---------------------------------------------------------------------
async function settingsView(ctx) {
  const host = ctx.host;
  if (!atLeast('OWNER')) {
    host.appendChild(emptyState('Not available', 'Only the owner or the platform administrator can open this screen.', null, null));
    return {};
  }
  host.appendChild(spinner());
  let settings; let usage;
  try {
    settings = await api.settings();
    usage = settings.plan;
    settings = settings.settings;
  } catch (e) {
    clear(host);
    host.appendChild(emptyState('Settings could not be loaded', e.message || String(e), 'Try again', () => ctx.rerender()));
    return {};
  }
  clear(host);

  const tab = ctx.query.tab || 'plan';
  host.appendChild(el('header', { class: 'view-head' },
    el('div', {}, el('h1', { text: 'Administration' }),
      el('p', { class: 'muted', text: isVendor() ? 'Platform administrator — you are the vendor seat, not client staff.' : 'Owner settings for this deployment.' }))));
  host.appendChild(el('nav', { class: 'tabs' },
    (isVendor() ? [['plan', 'Plan & limits'], ['businesses', 'Businesses'], ['branches', 'Branches'], ['permissions', 'Permissions'], ['commerce', 'Commerce rules'], ['compliance', 'Compliance'], ['sync', 'Sync']]
      : [['plan', 'My plan'], ['businesses', 'Businesses'], ['branches', 'Branches'], ['permissions', 'Permissions'], ['commerce', 'Commerce rules'], ['compliance', 'Compliance'], ['sync', 'Sync']])
      .map(([k, label]) => el('a', {
        href: `/admin?tab=${k}`, class: `tab${tab === k ? ' active' : ''}`,
        onclick: (ev) => { ev.preventDefault(); ctx.navigate(`/admin?tab=${k}`); },
      }, label))));

  const body = el('div', {});
  host.appendChild(body);

  if (tab === 'plan') renderPlan(body, settings, usage, ctx);
  else if (tab === 'businesses') await renderBusinesses(body, ctx);
  else if (tab === 'branches') await renderBranches(body, ctx);
  else if (tab === 'permissions') renderPermissions(body, settings, ctx);
  else if (tab === 'commerce') renderCommerce(body, settings, ctx);
  else if (tab === 'compliance') await renderCompliance(body, ctx);
  else await renderSync(body, ctx);

  return {};
}

function renderPlan(body, settings, usage, ctx) {
  const atLimit = usage && usage.at_limit ? usage.at_limit : {};
  body.appendChild(el('section', { class: 'card' },
    el('h2', { class: 'card-title', text: 'Subscription' }),
    el('div', { class: 'stat-grid' },
      statCard({ label: 'Plan', value: settings.subscription_plan, sub: `status ${String(settings.subscription_status).toLowerCase()}`, tone: settings.subscription_status === 'ACTIVE' ? 'good' : settings.subscription_status === 'TRIAL' ? 'warn' : 'bad' }),
      statCard({ label: 'Renewal', value: settings.subscription_renewal_date || 'not set' }),
      statCard({ label: 'Businesses', value: usage ? `${usage.businesses_used} / ${usage.businesses_allowed}` : '—', tone: atLimit.businesses ? 'bad' : null, sub: atLimit.businesses ? 'at the limit' : '' }),
      statCard({ label: 'Branches', value: usage ? `${usage.branches_used} / ${usage.branches_allowed}` : '—', tone: atLimit.branches ? 'bad' : null, sub: atLimit.branches ? 'at the limit — deactivate a closed branch to free its slot' : '' }),
      statCard({ label: 'Staff', value: usage ? `${usage.staff_used} / ${usage.staff_allowed}` : '—', tone: atLimit.staff ? 'bad' : null, sub: atLimit.staff ? 'at the limit — deactivate a leaver to free their seat' : '' })),
    el('p', { class: 'hint', text: 'Only ACTIVE rows are counted. Deactivating a staff member frees their seat immediately and closing a branch frees its slot, so a shop that shuts one location can open a replacement without buying an upgrade. A half-implemented version of this counted one and not the other, which is exactly the contradiction a client hits at the worst moment.' }),
    isVendor()
      ? el('div', { class: 'row-end' }, el('button', { class: 'btn btn-primary', onclick: () => editPlan(settings, ctx) }, 'Change plan or limits'))
      : el('p', { class: 'muted', text: 'Plan limits are set by your account manager. Ask them if you need more branches or staff seats.' })));

  body.appendChild(el('section', { class: 'card' },
    el('h2', { class: 'card-title', text: 'Modules included' }),
    table([
      { key: 'name', label: 'Module' },
      { key: 'on', label: 'Included', render: (r) => r.on ? badge('yes', 'good') : badge('no', 'bad') },
      { key: 'note', label: 'What it does' },
    ], [
      { name: 'Multi-business', on: !!Number(settings.multi_business_enabled), note: 'More than one trading business under this proprietor' },
      { name: 'Multi-branch', on: !!Number(settings.multi_branch_enabled), note: 'More than one shop, warehouse or yard per business' },
      { name: 'Instalment plans', on: !!Number(settings.instalments_module_enabled), note: '"Pay small-small" schedules with deposits and late fees' },
      { name: 'Warranty & serials', on: !!Number(settings.warranty_module_enabled), note: 'Per-unit serial tracking, warranty clocks and claims' },
      { name: 'Delivery & installation', on: !!Number(settings.delivery_module_enabled), note: 'Zones, jobs, dispatch, proof of delivery' },
      { name: 'Accounting', on: !!Number(settings.accounting_module_enabled), note: 'Double-entry ledger, P&L, balance sheet, VAT and WHT' },
      { name: 'Geofenced attendance', on: !!Number(settings.attendance_module_enabled), note: 'Clock-in classification against the branch position' },
      { name: 'Offline sync', on: !!Number(settings.offline_sync_enabled), note: 'Queue sales on the device and replay them when the connection returns' },
    ], { dense: true })));
}

function editPlan(settings, ctx) {
  const planF = field({ label: 'Plan name', name: 'subscription_plan', value: settings.subscription_plan });
  const statusF = field({ label: 'Subscription status', name: 'subscription_status', type: 'select', choices: ['TRIAL', 'ACTIVE', 'SUSPENDED', 'EXPIRED'], value: settings.subscription_status });
  const renewF = field({ label: 'Renewal date', name: 'subscription_renewal_date', type: 'date', value: settings.subscription_renewal_date || '' });
  const bizF = field({ label: 'Max businesses', name: 'max_businesses', type: 'number', min: 1, value: settings.max_businesses });
  const brF = field({ label: 'Max branches', name: 'max_branches', type: 'number', min: 1, value: settings.max_branches });
  const staffF = field({ label: 'Max staff', name: 'max_staff', type: 'number', min: 1, value: settings.max_staff });
  const notesF = field({ label: 'Vendor notes (contract terms)', name: 'notes', type: 'textarea', rows: 3, value: settings.notes || '' });
  const form = el('form', { onsubmit: async (ev) => {
    ev.preventDefault();
    const v = readForm(form);
    try {
      await api.updatePlan(v);
      m.close(); toast('Plan updated. Every write is now gated by the new status.', { kind: 'good', duration: 6000 }); ctx.rerender();
    } catch (e) { reportError(e, { context: 'The plan could not be updated' }); }
  } }, planF, statusF, renewF, bizF, brF, staffF, notesF,
  el('p', { class: 'hint', text: 'SUSPENDED and EXPIRED block writes but NOT reads. A client whose payment bounced must still be able to see their own stock, debtors and sales history — that is what they need in order to keep trading while they sort out the invoice, and locking reads is how a billing problem becomes a churned customer.' }),
  el('div', { class: 'row-end' }, el('button', { type: 'submit', class: 'btn btn-primary' }, 'Save plan')));
  const m = modal({ title: 'Plan & limits', body: form });
}

async function renderBusinesses(body, ctx) {
  const rows = await api.businesses();
  clear(body);
  body.appendChild(el('section', { class: 'card' },
    el('h2', { class: 'card-title' }, 'Businesses',
      atLeast('OWNER') ? el('button', { class: 'btn btn-sm btn-primary', onclick: () => newBusiness(ctx) }, 'Add a business') : null),
    el('p', { class: 'hint', text: 'A business is a distinct trading entity with its own vertical profile, its own branches and its own books. The vertical decides the category list, the unit vocabulary, the attribute schema, the default restrictions and which compliance types apply — so a new vertical is a data entry, not a code change.' }),
    table([
      { key: 'name', label: 'Business', render: (r) => el('div', {}, el('strong', { text: r.name }), el('div', { class: 'muted small', text: [r.trading_name, r.legal_name].filter(Boolean).join(' · ') })) },
      { key: 'vertical_code', label: 'Vertical', render: (r) => badge(String(r.vertical_code).replace(/_/g, ' ').toLowerCase(), 'info') },
      { key: 'branch_count', label: 'Branches', align: 'right' },
      { key: 'cac_number', label: 'CAC' },
      { key: 'tin', label: 'TIN' },
      { key: 'vat_enabled', label: 'VAT', render: (r) => Number(r.vat_enabled) ? badge(`${r.vat_rate_percent}% inclusive`, 'good') : badge('not registered', 'neutral') },
      { key: 'is_active', label: 'Status', render: (r) => Number(r.is_active) ? badge('active', 'good') : badge('inactive', 'bad') },
      { key: 'action', label: '', render: (r) => el('button', { class: 'btn btn-sm btn-ghost', onclick: (ev) => { ev.stopPropagation(); editBusiness(r, ctx); } }, 'Edit') },
    ], rows, { dense: true, rowKey: 'id' })));
}

function businessForm(values, onSave, title) {
  const nameF = field({ label: 'Registered / trading name', name: 'name', required: true, value: values.name || '' });
  const tradingF = field({ label: 'Short trading name (shown on receipts)', name: 'trading_name', value: values.trading_name || '' });
  const legalF = field({ label: 'Legal name (as on the CAC certificate)', name: 'legal_name', value: values.legal_name || '' });
  const vertF = field({ label: 'What kind of business is it?', name: 'vertical_code', type: 'select', choices: (state.reference && state.reference.verticals ? state.reference.verticals : []).map((v) => ({ value: v.code, label: `${v.label} — ${v.blurb}` })), value: values.vertical_code || '' });
  const cacF = field({ label: 'CAC number', name: 'cac_number', value: values.cac_number || '', hint: 'RC-1234567, BN-7654321, LP-… Normalised on save.' });
  const tinF = field({ label: 'TIN', name: 'tin', value: values.tin || '', hint: '8 or 11 digits. Needed for a corporate invoice and before a withholding-tax exemption can be argued.' });
  const vatF = field({ label: 'VAT registered?', name: 'vat_enabled', type: 'checkbox', value: !!Number(values.vat_enabled) });
  const vatRateF = field({ label: 'VAT rate %', name: 'vat_rate_percent', type: 'number', min: 0, max: 30, step: '0.1', value: values.vat_rate_percent || 7.5 });
  const vatNoF = field({ label: 'VAT registration number', name: 'vat_registration_no', value: values.vat_registration_no || '', hint: 'Printed on receipts. A customer cannot claim input VAT without it.' });
  const sizeF = field({ label: 'Company size (for withholding tax)', name: 'company_size', type: 'select', choices: [
    { value: 'SMALL', label: 'Small — turnover ≤ ₦25m' },
    { value: 'MEDIUM', label: 'Medium — turnover ≤ ₦100m' },
    { value: 'LARGE', label: 'Large — turnover > ₦100m' },
  ], value: values.company_size || 'SMALL', hint: 'The 2024 Withholding Regulations differentiate the rate by this. It selects which column of the schedule applies to you.' });
  const phoneF = field({ label: 'Phone', name: 'phone', type: 'tel', value: values.phone || '' });
  const emailF = field({ label: 'Email', name: 'email', value: values.email || '' });
  const addrF = field({ label: 'Address', name: 'address', value: values.address || '' });
  const stateF = field({ label: 'State', name: 'state_code', type: 'select', choices: (state.reference && state.reference.states ? state.reference.states : []).map((x) => ({ value: x.code, label: x.name })), value: values.state_code || '' });

  const modules = el('fieldset', { class: 'module-set' },
    el('legend', { text: 'Which flows does this business actually use?' }),
    el('p', { class: 'hint', text: 'Turning a module off removes it from the navigation and from the POS, rather than showing a screen that is always empty. Defaults are chosen by the vertical — a wholesale provisions dealer has no use for warranty claims, and a furniture gallery has no use for shelf-life alerts.' }),
    ...[['uses_serial_tracking', 'Serial-number tracking'], ['uses_warranty', 'Warranty & claims'], ['uses_delivery', 'Delivery'], ['uses_installation', 'Installation / assembly'], ['uses_layaway', 'Layaway holds'], ['uses_instalments', 'Instalment plans ("pay small-small")'], ['uses_shelf_life', 'Shelf life / best-before'], ['uses_credit', 'Credit sales & debtor ledger'], ['uses_wholesale', 'Wholesale price tiers'], ['uses_fx', 'Foreign-currency sales']]
      .map(([k, label]) => field({ label, name: k, type: 'checkbox', value: values[k] == null ? undefined : !!Number(values[k]) })));

  const form = el('form', { onsubmit: async (ev) => {
    ev.preventDefault();
    const v = readForm(form);
    // readForm skips untouched checkboxes, so every module flag must be
    // normalised explicitly or an unchecked box is indistinguishable from one
    // the operator never saw.
    for (const k of ['uses_serial_tracking', 'uses_warranty', 'uses_delivery', 'uses_installation', 'uses_layaway', 'uses_instalments', 'uses_shelf_life', 'uses_credit', 'uses_wholesale', 'uses_fx', 'vat_enabled']) {
      const node = form.elements[k];
      v[k] = node && node.checked ? 1 : 0;
    }
    try { await onSave(v); m.close(); } catch (e) { reportError(e, { context: 'The business could not be saved' }); }
  } }, nameF, tradingF, legalF, vertF, cacF, tinF, vatF, vatRateF, vatNoF, sizeF, phoneF, emailF, addrF, stateF, modules,
  el('div', { class: 'row-end' }, el('button', { type: 'submit', class: 'btn btn-primary' }, 'Save')));
  const m = modal({ title, size: 'lg', body: form });
  return m;
}

function newBusiness(ctx) {
  businessForm({}, async (v) => {
    const res = await api.createBusiness(v);
    toast(`${res.name} created with ${res.categories_seeded} categories and a full chart of accounts. Add a branch next — a business with no branch cannot trade.`, { kind: 'good', duration: 10000 });
    ctx.rerender();
  }, 'Add a business');
}

function editBusiness(row, ctx) {
  businessForm(row, async (v) => {
    await api.updateBusiness(row.id, v);
    toast('Business updated.', { kind: 'good' });
    ctx.rerender();
  }, `Edit ${row.name}`);
}

async function renderBranches(body, ctx) {
  const rows = await api.branches();
  clear(body);
  body.appendChild(el('section', { class: 'card' },
    el('h2', { class: 'card-title' }, 'Branches',
      atLeast('MANAGER') ? el('button', { class: 'btn btn-sm btn-primary', onclick: () => newBranch(ctx) }, 'Add a branch') : null),
    el('p', { class: 'hint', text: 'A branch belongs to exactly one business, and that is the tenancy boundary inside a deployment: a Branch Manager of one business cannot see another\'s branches even though both live in the same database.' }),
    table([
      { key: 'name', label: 'Branch', render: (r) => el('div', {}, el('strong', { text: r.name }), el('div', { class: 'muted small', text: [r.code, r.branch_type, r.area, r.state_code].filter(Boolean).join(' · ') })) },
      { key: 'business_name', label: 'Business' },
      { key: 'staff_count', label: 'Staff', align: 'right' },
      { key: 'phone', label: 'Phone' },
      { key: 'latitude', label: 'Geofence', render: (r) => r.latitude != null ? el('span', { class: 'small', text: `${Number(r.latitude).toFixed(4)}, ${Number(r.longitude).toFixed(4)} ±${r.geofence_radius_meters}m` }) : badge('not set', 'warn') },
      { key: 'can_deliver', label: 'Delivers', render: (r) => Number(r.can_deliver) ? `${r.vehicles} vehicle(s)` : 'no' },
      { key: 'stock_pick_policy', label: 'Stock picking', render: (r) => badge(String(r.stock_pick_policy).toLowerCase(), 'neutral') },
      { key: 'is_active', label: 'Status', render: (r) => Number(r.is_active) ? badge('active', 'good') : badge('closed', 'bad') },
      { key: 'action', label: '', render: (r) => el('button', { class: 'btn btn-sm btn-ghost', onclick: (ev) => { ev.stopPropagation(); editBranch(r, ctx); } }, 'Edit') },
    ], rows, { dense: true, rowKey: 'id' })));
}

function branchForm(values, onSave, title) {
  const nameF = field({ label: 'Branch name', name: 'name', required: true, value: values.name || '' });
  const codeF = field({ label: 'Short code', name: 'code', value: values.code || '', hint: 'Up to 4 characters. It appears in invoice numbers (SR-IKJ-000417), so it must be unique within the business and readable aloud over the phone.' });
  const bizF = field({ label: 'Business', name: 'business_id', type: 'select', choices: state.businesses.map((b) => ({ value: b.id, label: b.name })), value: values.business_id || state.activeBusinessId });
  const typeF = field({ label: 'Type', name: 'branch_type', type: 'select', choices: ['RETAIL', 'WHOLESALE', 'WAREHOUSE', 'SHOWROOM', 'FACTORY', 'KIOSK', 'YARD', 'MIXED'], value: values.branch_type || 'RETAIL' });
  const addrF = field({ label: 'Address', name: 'address', value: values.address || '' });
  const areaF = field({ label: 'Area', name: 'area', value: values.area || '', hint: 'Ikeja, Lekki Phase 1, Sabon Gari — how the market actually talks about itself, and what a delivery zone keys on.' });
  const lgaF = field({ label: 'LGA', name: 'lga', value: values.lga || '' });
  const stateF = field({ label: 'State', name: 'state_code', type: 'select', choices: (state.reference && state.reference.states ? state.reference.states : []).map((x) => ({ value: x.code, label: x.name })), value: values.state_code || '' });
  const phoneF = field({ label: 'Phone', name: 'phone', type: 'tel', value: values.phone || '' });
  const latF = field({ label: 'Latitude', name: 'latitude', type: 'number', step: '0.000001', value: values.latitude != null ? values.latitude : '', hint: 'Used to classify clock-ins. Leave blank if you do not want location-based attendance — a branch with no position reports "geofence not set" rather than guessing on-site.' });
  const lngF = field({ label: 'Longitude', name: 'longitude', type: 'number', step: '0.000001', value: values.longitude != null ? values.longitude : '' });
  const radiusF = field({ label: 'Geofence radius (metres)', name: 'geofence_radius_meters', type: 'number', min: 10, max: 5000, value: values.geofence_radius_meters || 100, hint: 'A market stall needs 50m; a yard with a gatehouse needs 300m. Indoors GPS is poor, so a too-tight radius flags everyone.' });
  const openF = field({ label: 'Opens', name: 'opening_time', type: 'time', value: values.opening_time || '' });
  const closeF = field({ label: 'Closes', name: 'closing_time', type: 'time', value: values.closing_time || '' });
  const floatF = field({ label: 'Default till float (₦)', name: 'default_till_float', type: 'number', min: 0, step: '0.01', value: values.default_till_float || 0 });
  const pickF = field({ label: 'Stock picking policy', name: 'stock_pick_policy', type: 'select', choices: [
    { value: 'FIFO', label: 'FIFO — first in, first out (default)' },
    { value: 'FEFO', label: 'FEFO — soonest best-before first (food, paint, cement)' },
    { value: 'LIFO', label: 'LIFO — last in, first out' },
    { value: 'SPECIFIC', label: 'SPECIFIC — the operator chooses the batch' },
  ], value: values.stock_pick_policy || 'FIFO', hint: 'Getting this wrong does not look like an error: the quantity total stays right while the COST is wrong, so margin, COGS and the stock valuation are all quietly wrong and nothing on any screen looks broken.' });
  const deliverF = field({ label: 'This branch delivers', name: 'can_deliver', type: 'checkbox', value: values.can_deliver == null ? true : !!Number(values.can_deliver) });
  const vehiclesF = field({ label: 'Vehicles', name: 'vehicles', type: 'number', min: 0, value: values.vehicles || 0 });
  const driversF = field({ label: 'Drivers', name: 'drivers', type: 'number', min: 0, value: values.drivers || 0 });
  const capacityF = field({ label: 'Deliveries per day', name: 'daily_delivery_capacity', type: 'number', min: 0, value: values.daily_delivery_capacity || 10, hint: 'A branch has a finite number of trucks. Letting a cashier book forty deliveries for Saturday is how a shop breaks a promise it cannot keep.' });
  const activeF = field({ label: 'Active', name: 'is_active', type: 'checkbox', value: values.is_active == null ? true : !!Number(values.is_active) });

  const form = el('form', { onsubmit: async (ev) => {
    ev.preventDefault();
    const v = readForm(form);
    for (const k of ['can_deliver', 'is_active']) { const n = form.elements[k]; v[k] = n && n.checked ? 1 : 0; }
    try { await onSave(v); m.close(); } catch (e) { reportError(e, { context: 'The branch could not be saved' }); }
  } }, nameF, codeF, bizF, typeF, addrF, areaF, lgaF, stateF, phoneF,
  el('fieldset', { class: 'module-set' }, el('legend', { text: 'Location & attendance' }), latF, lngF, radiusF, openF, closeF),
  el('fieldset', { class: 'module-set' }, el('legend', { text: 'Till & stock' }), floatF, pickF),
  el('fieldset', { class: 'module-set' }, el('legend', { text: 'Delivery' }), deliverF, vehiclesF, driversF, capacityF),
  activeF,
  el('div', { class: 'row-end' }, el('button', { type: 'submit', class: 'btn btn-primary' }, 'Save')));
  const m = modal({ title, size: 'lg', body: form });
}

function newBranch(ctx) {
  branchForm({}, async (v) => { await api.createBranch(v); toast('Branch added.', { kind: 'good' }); ctx.rerender(); }, 'Add a branch');
}
function editBranch(row, ctx) {
  branchForm(row, async (v) => { await api.updateBranch(row.id, v); toast('Branch updated.', { kind: 'good' }); ctx.rerender(); }, `Edit ${row.name}`);
}

function renderPermissions(body, settings, ctx) {
  const s = settings;
  const save = async (changes) => {
    try { await api.updateSettings(changes); toast('Saved. These take effect on the next request — nobody has to sign out.', { kind: 'good', duration: 6000 }); ctx.rerender(); }
    catch (e) { reportError(e, { context: 'The setting could not be saved' }); }
  };

  body.appendChild(el('section', { class: 'card' },
    el('h2', { class: 'card-title', text: 'What your MANAGERS may do' }),
    el('p', { class: 'hint', text: 'You (the owner) and the platform administrator are never restricted by these switches. A switch that could lock the proprietor out of their own books would be a footgun.' }),
    toggleGrid([
      ['managers_can_void_sales', 'Void a sale', s.managers_can_void_sales],
      ['managers_can_approve_expenses', 'Approve an expense', s.managers_can_approve_expenses],
      ['managers_can_edit_prices', 'Change a selling price', s.managers_can_edit_prices],
      ['managers_can_override_price_floor', 'Sell below the price floor', s.managers_can_override_price_floor],
      ['managers_can_dispatch_unpaid', 'Dispatch a delivery before payment', s.managers_can_dispatch_unpaid],
      ['managers_can_write_off_debt', 'Write off a debt as bad', s.managers_can_write_off_debt],
    ], save)));

  body.appendChild(el('section', { class: 'card' },
    el('h2', { class: 'card-title', text: 'What your CASHIERS may do' }),
    el('p', { class: 'hint', text: 'These exist because a cashier holding both powers can run the two classic retail-theft patterns unaided. VOID: sell for cash, void the sale, keep the note — the books show no sale and the stock is already gone. WRITE-OFF: take the goods and record them as damage, so shrinkage looks like breakage. Both were reproduced live against a running system before these controls existed.' }),
    el('p', { class: 'hint', text: 'They are deliberately NOT a flat ban. A mis-keyed sale at a busy counter is common and a lone cashier on a late shift must be able to correct it, so the default is a NARROW allowance — and the window plus the cap are what make it safe. They cover "I just rang that up wrong" without covering "I am reversing yesterday\'s takings".' }),
    toggleGrid([
      ['staff_can_void_sales', 'Void their OWN sale, within the window below', s.staff_can_void_sales],
      ['staff_can_adjust_stock', 'Post a stock adjustment, within the cap below', s.staff_can_adjust_stock],
      ['staff_can_spend_from_safe', 'Spend from the branch safe, within the cap below', s.staff_can_spend_from_safe],
    ], save),
    numberGrid([
      ['staff_void_window_minutes', 'Void window (minutes)', s.staff_void_window_minutes, 'After this a cashier can no longer void; a manager must. 0 means no window — a cashier could void a sale from last week.'],
      ['staff_adjustment_max_units', 'Adjustment cap (units)', s.staff_adjustment_max_units, 'Largest single variance a cashier may post. Counting a stocktake stays open to them — walking the shelves is their job — but committing a large variance needs a manager. 0 means no cap.'],
      ['staff_safe_spend_max', 'Safe spend cap (₦)', s.staff_safe_spend_max, '0 means NO CAP, which is a deliberate choice some owners make. It is read as unlimited, never as "zero allowed" — the can/cannot decision is the switch above.'],
      ['staff_max_discount_percent', 'Discount cap (%)', s.staff_max_discount_percent, 'Above this a cashier needs a manager override, which is recorded against the manager\'s login.'],
    ], save)));

  body.appendChild(el('section', { class: 'card' },
    el('h2', { class: 'card-title', text: 'Pricing guard rails' }),
    numberGrid([
      ['price_floor_percent_of_cost', 'Price floor (% of cost)', s.price_floor_percent_of_cost, '100 means never below cost. This is what stops a cashier discounting a ₦400,000 TV to ₦40,000 for a friend — at the point of sale, not at month end when the margin report is read.'],
      ['max_discount_percent', 'Maximum discount anyone below the owner may give (%)', s.max_discount_percent, ''],
    ], save)));

  body.appendChild(el('section', { class: 'card' },
    el('h2', { class: 'card-title', text: 'Credit policy' }),
    toggleGrid([['credit_enabled', 'Allow credit sales at all', s.credit_enabled]], save),
    numberGrid([
      ['credit_max_overdue_days', 'Block further credit after (days overdue)', s.credit_max_overdue_days, 'The gate that saves the most money and the one shops most often forget, because a POS that only checks the limit will happily sell more to a customer who is already 60 days late.'],
      ['credit_max_concentration_pct', 'Warn when one customer exceeds (% of the whole book)', s.credit_max_concentration_pct, 'Advisory only. One customer being most of your debtor book is a concentration risk worth seeing, but it is not a reason to refuse a sale.'],
    ], save)));
}

function toggleGrid(items, save) {
  return el('div', { class: 'toggle-grid' }, items.map(([key, label, value]) => {
    const input = el('input', { type: 'checkbox', checked: !!Number(value), onchange: (ev) => save({ [key]: ev.target.checked ? 1 : 0 }) });
    return el('label', { class: 'toggle-row' }, input, el('span', { text: label }));
  }));
}

function numberGrid(items, save) {
  return el('div', { class: 'number-grid' }, items.map(([key, label, value, hint]) => {
    const input = el('input', { type: 'number', value: value == null ? '' : value, min: 0, step: 'any' });
    const btn = el('button', { class: 'btn btn-sm btn-ghost', onclick: () => save({ [key]: Number(input.value) || 0 }) }, 'Save');
    return el('div', { class: 'number-row' },
      el('label', {}, el('span', { text: label }), input, btn),
      hint ? el('p', { class: 'hint', text: hint }) : null);
  }));
}

function renderCommerce(body, settings, ctx) {
  const save = async (changes) => {
    try { await api.updateSettings(changes); toast('Saved.', { kind: 'good' }); ctx.rerender(); }
    catch (e) { reportError(e, { context: 'The setting could not be saved' }); }
  };
  body.appendChild(el('section', { class: 'card' },
    el('h2', { class: 'card-title', text: 'Instalment plans' }),
    numberGrid([
      ['instalment_min_deposit_percent', 'Minimum deposit (%)', settings.instalment_min_deposit_percent, 'Below this the plan is refused. A zero-deposit plan on goods that have already left the shop is an unsecured loan.'],
      ['instalment_max_tenor_months', 'Longest plan (months)', settings.instalment_max_tenor_months, ''],
      ['instalment_grace_days', 'Grace period (days)', settings.instalment_grace_days, 'An instalment is only MISSED after this many days past its due date.'],
      ['instalment_missed_before_default', 'Missed instalments before the plan DEFAULTS', settings.instalment_missed_before_default, ''],
      ['instalment_late_fee_percent', 'Late fee (%)', settings.instalment_late_fee_percent, '0 means no late fees, which many shops choose deliberately because the relationship matters more than the fee. A fee is only charged when an instalment is actually recorded as missed — never pre-charged on a schedule the customer might well pay on time.'],
      ['instalment_plan_fee_percent', 'Flat admin fee on the financed amount (%)', settings.instalment_plan_fee_percent, 'A disclosed flat fee, NOT interest and NOT compounded. This is trade credit on your own goods; a feature that quietly turned a furniture shop into an unlicensed lender would be a feature that got the client in trouble.'],
    ], save)));

  body.appendChild(el('section', { class: 'card' },
    el('h2', { class: 'card-title', text: 'Layaway holds' }),
    numberGrid([
      ['layaway_default_hold_days', 'Default hold length (days)', settings.layaway_default_hold_days, ''],
      ['layaway_max_hold_days', 'Longest hold (days)', settings.layaway_max_hold_days, 'An unbounded hold is a stock report that lies: three abandoned holds on the only generator in the branch means it has been showing zero available for a month while the generator sat in the corner.'],
      ['layaway_max_extensions', 'Maximum extensions', settings.layaway_max_extensions, 'Repeated extension is how an abandoned hold quietly becomes permanent.'],
      ['layaway_forfeit_percent', 'Deposit forfeited on release (%)', settings.layaway_forfeit_percent, 'Forfeited money is OTHER INCOME, not sales revenue: no goods left the shop.'],
    ], save)));

  body.appendChild(el('section', { class: 'card' },
    el('h2', { class: 'card-title', text: 'Warranty' }),
    numberGrid([
      ['warranty_provision_percent', 'Warranty provision (% of warrantied revenue)', settings.warranty_provision_percent, 'A business selling a thousand warrantied appliances a month WILL have claims. Recognising the cost only when a claim arrives makes one month look catastrophic and the rest artificially profitable.'],
    ], save),
    el('div', { class: 'field' },
      el('label', { text: 'Warranty clock starts at' }),
      (() => {
        const sel = el('select', {}, ['SALE', 'RECEIPT', 'MANUFACTURE'].map((x) => el('option', { value: x, text: { SALE: 'the sale date (matches the customer\'s receipt)', RECEIPT: 'goods received (B2B supply, and manufacturer cover that starts at import)', MANUFACTURE: 'the manufacture date' }[x], selected: settings.warranty_basis_default === x })));
        sel.addEventListener('change', (ev) => save({ warranty_basis_default: ev.target.value }));
        return sel;
      })()))));

  body.appendChild(el('section', { class: 'card' },
    el('h2', { class: 'card-title', text: 'Payments and fees' }),
    el('p', { class: 'hint', text: 'A shop that records "₦500,000 POS" and nothing else reconciles its bank at ₦492,500 with no idea why. The fee and the expected settlement date are recorded on every non-cash tender so the till report, the bank reconciliation and the ledger all agree.' }),
    numberGrid([
      ['pos_fee_percent', 'POS terminal fee (%)', settings.pos_fee_percent, 'CBN guidance has been 1.5% capped at ₦2,000. Merchants report higher effective costs once the acquirer\'s own fees and terminal rental are included, so this is editable.'],
      ['pos_fee_cap', 'POS fee cap (₦)', settings.pos_fee_cap, ''],
      ['pos_settlement_business_days', 'POS settlement (business days)', settings.pos_settlement_business_days, 'A Friday sale settles Monday. Public holidays are taken from the holidays table, because hard-coding them would be wrong within a year.'],
    ], save),
    toggleGrid([['pos_fee_configured', 'These fees are correct for our acquirer', settings.pos_fee_configured]], save),
    !Number(settings.pos_fee_configured) ? el('div', { class: 'warn-box' }, 'Fees are marked as not configured, so the system reports a fee of zero and flags the gap rather than assuming a number. Your bank settlement will differ from your till until this is set.') : null));

  body.appendChild(el('section', { class: 'card' },
    el('h2', { class: 'card-title', text: 'Delivery and receipts' }),
    toggleGrid([
      ['require_delivery_proof', 'Require proof of delivery (name, signature or photo)', settings.require_delivery_proof],
      ['require_payment_before_dispatch', 'Refuse to dispatch an unpaid sale', settings.require_payment_before_dispatch],
      ['receipt_show_pricing_trail', 'Show "why this price" on the receipt', settings.receipt_show_pricing_trail],
    ], save),
    el('div', { class: 'field' },
      el('label', { for: 'footer', text: 'Receipt footer' }),
      (() => {
        const ta = el('textarea', { id: 'footer', rows: 2, maxlength: 300 }, settings.receipt_footer_text || '');
        const btn = el('button', { class: 'btn btn-sm btn-ghost', onclick: () => save({ receipt_footer_text: ta.value }) }, 'Save');
        return el('div', {}, ta, btn);
      })()))));
}

async function renderCompliance(body, ctx) {
  clear(body);
  try {
    const alerts = await api.stockAlerts({});
    body.appendChild(el('section', { class: 'card' },
      el('h2', { class: 'card-title', text: 'Compliance certificates' }),
      el('p', { class: 'hint', text: 'One table for every dated obligation, replacing the two hard-coded licence columns a pharmacy schema needs. Which certificates apply depends on what the business trades in: SONCAP for electronics, NAFDAC for food and cosmetics, SON/NIS for cement and steel, fire safety and LG permits for any premises. Adding a new kind is a row, not a schema change.' }),
      table([
        { key: 'certificate_type', label: 'Type' },
        { key: 'certificate_number', label: 'Number' },
        { key: 'business_name', label: 'Business' },
        { key: 'branch_name', label: 'Branch', render: (r) => r.branch_name || 'all' },
        { key: 'issuing_authority', label: 'Authority' },
        { key: 'expiry_date', label: 'Expires' },
        { key: 'days_until_expiry', label: 'Days', align: 'right', render: (r) => el('strong', { class: r.days_until_expiry < 0 ? 'text-bad' : 'text-warn', text: String(r.days_until_expiry) }) },
        { key: 'alert_level', label: 'Status', render: (r) => badge(String(r.alert_level).replace(/_/g, ' ').toLowerCase(), toneForStatus(r.alert_level)) },
        { key: 'renewal_agent', label: 'Renewal' },
      ], alerts.compliance || [], { dense: true, empty: 'No certificates are due for attention. Add them under each business so a renewal is never discovered at the port.' })));
  } catch (e) { body.appendChild(emptyState('Compliance could not be loaded', e.message || String(e))); }
}

async function renderSync(body, ctx) {
  clear(body);
  body.appendChild(spinner());
  const rows = await api.syncStatus();
  clear(body);
  body.appendChild(el('section', { class: 'card' },
    el('h2', { class: 'card-title', text: 'Branch synchronisation' }),
    el('p', { class: 'hint', text: 'The point of an offline-first app is that a branch with no network keeps trading. The cost is that a manager must be able to SEE which branches are behind, by how much, and since when — otherwise "the numbers are wrong" is indistinguishable from "the numbers are stale".' }),
    table([
      { key: 'branch_name', label: 'Branch' },
      { key: 'device_label', label: 'Device', render: (r) => r.device_label || r.device_id || '—' },
      { key: 'app_version', label: 'App version' },
      { key: 'last_heartbeat_at', label: 'Last seen', render: (r) => r.last_heartbeat_at ? String(r.last_heartbeat_at).slice(0, 16) : 'never' },
      { key: 'pending_push_count', label: 'Queued', align: 'right', render: (r) => Number(r.pending_push_count) > 0 ? badge(r.pending_push_count, 'warn') : '0' },
      { key: 'consecutive_failures', label: 'Failures', align: 'right', render: (r) => Number(r.consecutive_failures) > 0 ? badge(r.consecutive_failures, 'bad') : '0' },
      { key: 'unreviewed_conflicts', label: 'Conflicts', align: 'right', render: (r) => Number(r.unreviewed_conflicts) > 0 ? badge(r.unreviewed_conflicts, 'bad') : '0' },
      { key: 'sync_health', label: 'Health', render: (r) => badge(String(r.sync_health).replace(/_/g, ' ').toLowerCase(), toneForStatus(r.sync_health)) },
      { key: 'last_sync_error', label: 'Last error', render: (r) => r.last_sync_error ? el('span', { class: 'small text-bad', text: String(r.last_sync_error).slice(0, 90) }) : '—' },
    ], rows, { dense: true, empty: 'No branch has synced yet.' })));
}

// ---------------------------------------------------------------------
// REGISTERS (manager+)
// ---------------------------------------------------------------------
async function registersView(ctx) {
  const host = ctx.host;
  if (!atLeast('MANAGER')) {
    host.appendChild(emptyState('Not available', 'Only a manager or above can open the registers.', null, null));
    return {};
  }
  const type = ctx.query.type || 'HIGH_VALUE_REGISTER';
  host.appendChild(el('header', { class: 'view-head' },
    el('div', {}, el('h1', { text: 'Registers & audit' }),
      el('p', { class: 'muted', text: 'Append-only and hash-chained. Each row stores the hash of the one before it, so editing or deleting a row in the middle breaks every subsequent link — and the verify action finds exactly where.' }))));
  host.appendChild(el('nav', { class: 'tabs' },
    [['HIGH_VALUE_REGISTER', 'High-value sales'], ['AGE_VERIFICATION_LOG', 'Age checks'], ['AUTHORITY_DOCUMENT_LOG', 'Authority docs'], ['CASH_MOVEMENT_CHAIN', 'Cash movements'], ['DATA_EXPORT_LOG', 'Data exports'], ['PRICE_OVERRIDE_LOG', 'Price overrides']]
      .map(([k, label]) => el('a', {
        href: `/registers?type=${k}`, class: `tab${type === k ? ' active' : ''}`,
        onclick: (ev) => { ev.preventDefault(); ctx.navigate(`/registers?type=${k}`); },
      }, label))));

  const body = el('div', {}, spinner());
  host.appendChild(body);
  const res = await api.register(type, { limit: 200 });
  clear(body);

  body.appendChild(el('section', { class: 'card' },
    el('h2', { class: 'card-title' }, `${res.count} entries`,
      el('button', { class: 'btn btn-sm btn-primary', onclick: () => verify(type, ctx) }, 'Verify the chain')),
    el('p', { class: 'hint', text: res.note }),
    table([
      { key: 'chain_day', label: 'Day' },
      { key: 'seq', label: '#', align: 'right' },
      { key: 'branch_name', label: 'Branch' },
      { key: 'sale_number', label: 'Sale' },
      { key: 'product_name', label: 'Item' },
      { key: 'quantity', label: 'Qty', align: 'right' },
      { key: 'buyer_name', label: 'Buyer' },
      { key: 'buyer_phone', label: 'Phone' },
      { key: 'id_type', label: 'ID', render: (r) => r.id_type ? `${r.id_type}${r.id_number ? ` ${r.id_number}` : ''}` : '—' },
      { key: 'serial_numbers', label: 'Serials', render: (r) => r.serial_numbers ? el('code', { class: 'small', text: r.serial_numbers }) : '—' },
      { key: 'recorded_by_name', label: 'Recorded by' },
      { key: 'recorded_at', label: 'When', render: (r) => String(r.recorded_at || '').slice(0, 16) },
    ], res.rows || [], { dense: true, empty: 'Nothing recorded in this register yet.' })));
  return {};
}

async function verify(type, ctx) {
  try {
    const r = await api.verifyRegister(type, {});
    const bad = (r.results || []).filter((x) => !x.ok);
    modal({
      title: `Chain verification — ${String(type).replace(/_/g, ' ').toLowerCase()}`,
      size: bad.length ? 'lg' : 'sm',
      body: el('div', {},
        r.intact
          ? el('div', { class: 'ok-box' }, `${r.chains_checked} chain(s) checked, every one intact. Each entry follows from the one before it and no field has been altered.`)
          : el('div', { class: 'error-box' },
            el('strong', { text: `${bad.length} of ${r.chains_checked} chain(s) have been altered. ` }),
            'Do not rely on entries after the first break until the change is explained and documented. This is what the chain is for: a rewrite is still possible for somebody with database access, but it is now expensive, visible and provable rather than silent.',
            table([
              { key: 'chain_day', label: 'Day' },
              { key: 'rows', label: 'Rows', align: 'right' },
              { key: 'breaks', label: 'Breaks', align: 'right', render: (x) => x.breaks.length },
              { key: 'first', label: 'First problem', render: (x) => x.breaks[0] ? `${String(x.breaks[0].type).replace(/_/g, ' ').toLowerCase()} at row ${x.breaks[0].index + 1}` : '—' },
              { key: 'detail', label: 'Detail', render: (x) => el('span', { class: 'small', text: x.breaks[0] ? x.breaks[0].detail : '' }) },
            ], bad, { dense: true }))),
      footer: el('div', { class: 'row-end' }, el('button', { class: 'btn btn-primary', onclick: (ev) => { ev.target.closest('.modal-host').hidden = true; } }, 'Close')),
    });
  } catch (e) { reportError(e, { context: 'The verification could not run' }); }
}

export default settingsView;
export { registersView, settingsView };
