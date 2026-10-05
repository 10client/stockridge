'use strict';
// =====================================================================
// public/js/views/instalments.js — PAYING IT OFF OVER TIME
// =====================================================================
// Two mechanisms, and the difference matters:
//
//   LAYAWAY / DEPOSIT   the customer pays towards ONE item, which stays in the
//                       shop until it is paid for. No debt, no risk to the shop:
//                       if they stop paying, the deposit is forfeited (or
//                       refunded) and the goods go back on the shelf.
//   INSTALMENT PLAN     the customer TAKES the goods and owes the money. This is
//                       credit, and it is how a Nigerian appliance shop actually
//                       sells a ₦650,000 freezer to a teacher — a deposit, then
//                       twelve monthly payments.
//
// The second one is a loan. The business carries the risk until it is repaid, so
// the schedule is generated centrally (`domain/instalments`) with the rounding
// remainder on the FIRST instalment rather than the last: a customer who pays
// every printed figure to the kobo must end at zero, and a remainder on the final
// payment is the one nobody checks until the plan says "paid" and still shows a
// balance.
//
// The effective annual rate is shown at the point of agreement. That is the only
// moment it is useful, and the figure a customer disputes most often.
// =====================================================================
(function (global) {
  const SR = global.SR;
  const ui = SR.ui;
  const U = SR.util;

  const FREQUENCIES = ['WEEKLY', 'BIWEEKLY', 'MONTHLY'];
  const DEPOSIT_TYPES = ['LAYAWAY', 'PART_PAYMENT', 'RESERVATION'];
  const METHODS = ['CASH', 'BANK_TRANSFER', 'POS_TERMINAL', 'MOBILE_MONEY', 'USSD', 'CHEQUE'];

  async function render(ctx) {
    if (ctx.params.id) return renderPlan(ctx);
    ctx.setTitle('Instalments & layaway');
    const state = { tab: ctx.query.tab || 'plans', page: 0, pageSize: 50, status: '' };

    const wrap = ui.h('div', { class: 'stack' });
    wrap.appendChild(ui.h('div', { class: 'page-head' },
      ui.h('div', {},
        ui.h('h1', {}, 'Instalments & layaway'),
        ui.h('p', { class: 'sub' }, `${SR.state.activeBranchName()} · what customers are paying off, and what is being held for them`)),
      ui.h('div', { class: 'actions' },
        SR.state.atLeast('MANAGER') ? ui.h('button', { class: 'btn btn-sm btn-primary', onClick: () => openPlan() }, 'Open a plan') : null,
        ui.h('button', { class: 'btn btn-sm btn-primary', onClick: () => openDeposit() }, 'Take a deposit'),
        ui.h('button', { class: 'btn btn-sm', onClick: () => exportList() }, 'Export'))));

    const tabs = ui.h('div', { class: 'tabs' });
    for (const [key, label] of [['plans', 'Instalment plans'], ['deposits', 'Layaway & holds']]) {
      tabs.appendChild(ui.h('button', {
        class: `tab ${state.tab === key ? 'is-active' : ''}`,
        onClick: () => {
          state.tab = key; state.page = 0;
          for (const b of tabs.children) b.classList.toggle('is-active', b.textContent === label);
          load();
        },
      }, label));
    }
    wrap.appendChild(tabs);
    const host = ui.h('div', {});
    wrap.appendChild(host);

    async function exportList() {
      try {
        await SR.exporter.list({
          filename: state.tab === 'plans' ? 'instalment-plans' : 'layaway-deposits',
          path: state.tab === 'plans' ? '/api/instalments' : '/api/deposits',
          query: SR.state.query({ status: state.status || undefined }),
          columns: state.tab === 'plans'
            ? [
              { key: 'plan_no', label: 'Plan' }, { key: 'customer_name', label: 'Customer' },
              { key: 'customer_phone', label: 'Phone' }, { key: 'principal', label: 'Principal' },
              { key: 'interest_amount', label: 'Interest' }, { key: 'total_payable', label: 'Total payable' },
              { key: 'amount_paid', label: 'Paid' }, { key: 'outstanding', label: 'Outstanding' },
              { key: 'next_due', label: 'Next due' }, { key: 'status', label: 'Status' },
            ]
            : [
              { key: 'deposit_no', label: 'Reference' }, { key: 'customer_name', label: 'Customer' },
              { key: 'product_name', label: 'Held item' }, { key: 'deposit_amount', label: 'Deposit' },
              { key: 'total_paid', label: 'Paid so far' }, { key: 'balance_due', label: 'Balance' },
              { key: 'expires_at', label: 'Expires' }, { key: 'status', label: 'Status' },
            ],
        });
      } catch (err) { ui.apiError(err); }
    }

    async function load() {
      host.replaceChildren(ui.skeleton(6));
      if (state.tab === 'deposits') return renderDeposits();
      return renderPlans();
    }

    // ---------------- PLANS ----------------
    async function renderPlans() {
      let data; let offline = false;
      try {
        data = await SR.api.get('/api/instalments', { query: SR.state.query({ status: state.status || undefined, limit: state.pageSize, offset: state.page * state.pageSize }) });
      } catch (err) {
        if (!err.isOffline) { host.replaceChildren(ui.errorBlock(err, { retry: { label: 'Try again', run: renderPlans } })); return; }
        offline = true;
        data = { data: [], summary: {} };
      }
      const rows = data.data || [];
      const s = data.summary || {};
      const paging = data.paging || {};

      host.replaceChildren();
      if (offline) host.appendChild(ui.h('div', { class: 'alert alert-warn' }, 'Offline — a plan and its schedule are computed on the server.'));
      host.appendChild(ui.h('div', { class: 'grid grid-4' },
        ui.kpi({ label: 'Outstanding on plans', value: U.money(s.outstanding), tone: 'warn', foot: `${s.plans || 0} plan${Number(s.plans) === 1 ? '' : 's'}`, small: true }),
        ui.kpi({ label: 'Overdue', value: U.money(s.overdueValue), tone: Number(s.overdue) > 0 ? 'bad' : 'good', foot: `${s.overdue || 0} plan${Number(s.overdue) === 1 ? '' : 's'} past a due date`, small: true }),
        ui.kpi({ label: 'Interest earned', value: U.money(s.interestEarned), tone: 'good', foot: 'the price of carrying the risk', small: true }),
        ui.kpi({ label: 'Customers on plans', value: String(new Set(rows.map((r) => String(r.customer_id))).size), small: true })));

      const filterRow = ui.h('div', { class: 'row' });
      const statusSel = ui.h('select', { onchange: (e) => { state.status = e.target.value; state.page = 0; renderPlans(); } });
      for (const [v, l] of [['', 'Any status'], ['ACTIVE', 'Active'], ['COMPLETED', 'Completed'], ['DEFAULTED', 'Defaulted'], ['CANCELLED', 'Cancelled']]) {
        statusSel.appendChild(ui.h('option', { value: v, selected: v === state.status }, l));
      }
      filterRow.appendChild(ui.h('div', {}, ui.h('label', { class: 'ctl' }, 'Status'), statusSel));

      host.appendChild(ui.dataCard({
        title: 'Instalment plans',
        toolbar: filterRow,
        table: ui.renderTable({
          columns: [
            { key: 'plan_no', label: 'Plan', render: (p) => ui.h('span', { class: 'mono' }, p.plan_no || String(p.id).slice(0, 8)) },
            { key: 'customer_name', label: 'Customer', className: 'wrap', render: (p) => ui.h('div', {},
              ui.h('div', { style: { fontWeight: '600' } }, p.customer_name || '—'),
              ui.h('div', { class: 'hint' }, [p.customer_phone, p.product_name].filter(Boolean).join(' · '))) },
            { key: 'principal', label: 'Principal', align: 'right', render: (p) => U.money(p.principal) },
            { key: 'interest_amount', label: 'Interest', align: 'right', render: (p) => (Number(p.interest_amount) ? U.money(p.interest_amount) : '—') },
            { key: 'total_payable', label: 'Total', align: 'right', render: (p) => U.money(p.total_payable) },
            { key: 'amount_paid', label: 'Paid', align: 'right', render: (p) => {
              const paid = Number(p.amount_paid);
              const total = Number(p.total_payable) || 1;
              const pct = U.clamp((paid / total) * 100, 0, 100);
              return ui.h('span', {},
                ui.h('div', { style: { width: '72px', height: '8px', borderRadius: '4px', background: 'var(--slate-200)', display: 'inline-block', verticalAlign: 'middle', marginRight: '6px' } },
                  ui.h('div', { style: { width: `${pct}%`, height: '100%', borderRadius: '4px', background: 'var(--teal-600)' } })),
                ui.h('span', { class: 'hint' }, U.money(paid)));
            } },
            { key: 'outstanding', label: 'Outstanding', align: 'right', render: (p) => ui.h('strong', {}, U.money(p.outstanding)) },
            { key: 'next_due', label: 'Next due', render: (p) => {
              if (!p.next_due) return '—';
              if (p.overdue) return ui.badge(`${U.date(p.next_due)} · ${p.days_overdue}d late`, 'badge-bad');
              const soon = String(p.next_due) <= U.addDays(U.todayWat(), 7);
              return soon ? ui.badge(U.date(p.next_due), 'badge-warn') : U.date(p.next_due);
            } },
            { key: 'status', label: '', render: (p) => ui.statusBadge(p.status) },
            { key: 'x', label: '', render: (p) => ui.h('div', { class: 'btn-row' },
              (!['COMPLETED', 'CANCELLED'].includes(String(p.status))
                ? ui.h('button', { class: 'btn btn-sm btn-primary', onClick: (ev) => { ev.stopPropagation(); takePayment(p); } }, 'Take payment')
                : null),
              ui.h('button', { class: 'btn btn-sm', onClick: (ev) => { ev.stopPropagation(); SR.app.navigate(`/instalments/${p.id}`); } }, 'Open')) },
          ],
          rows,
          onRowClick: (p) => SR.app.navigate(`/instalments/${p.id}`),
          emptyTitle: 'No instalment plans',
          emptyMessage: 'A plan lets a customer take the goods and pay over time. The schedule is generated from the principal, the tenure and the interest rate, and every payment is allocated against it in order.',
          emptyAction: SR.state.atLeast('MANAGER') ? { label: 'Open a plan', run: () => openPlan() } : null,
        }),
        pager: ui.pager({
          page: state.page, pageSize: paging.limit || state.pageSize, total: paging.total != null ? paging.total : rows.length,
          onPage: (p) => { state.page = p; renderPlans(); },
          onSize: (n) => { state.pageSize = n; state.page = 0; renderPlans(); },
        }),
      }));
    }

    // ---------------- DEPOSITS ----------------
    async function renderDeposits() {
      let data; let offline = false;
      try {
        data = await SR.api.get('/api/deposits', { query: SR.state.query({ status: state.status || undefined, limit: state.pageSize, offset: state.page * state.pageSize }) });
      } catch (err) {
        if (!err.isOffline) { host.replaceChildren(ui.errorBlock(err, { retry: { label: 'Try again', run: renderDeposits } })); return; }
        offline = true;
        data = { data: [], summary: {} };
      }
      const rows = data.data || [];
      const s = data.summary || {};
      const paging = data.paging || {};

      host.replaceChildren();
      if (offline) host.appendChild(ui.h('div', { class: 'alert alert-warn' }, 'Offline — held stock is reserved on the server, so it cannot be taken offline.'));
      host.appendChild(ui.h('div', { class: 'grid grid-4' },
        ui.kpi({ label: 'Held for customers', value: U.money(s.held), foot: `${rows.length} item${rows.length === 1 ? '' : 's'} reserved`, small: true }),
        ui.kpi({ label: 'Still to collect', value: U.money(s.outstanding), small: true }),
        ui.kpi({ label: 'Expiring within 7 days', value: String(s.expiringSoon || 0), tone: Number(s.expiringSoon) > 0 ? 'warn' : null, foot: 'call these customers', small: true }),
        ui.kpi({ label: 'Expired', value: String(s.expired || 0), tone: Number(s.expired) > 0 ? 'bad' : 'good', foot: 'the deposit can be forfeited or refunded', small: true })));

      host.appendChild(ui.dataCard({
        title: 'Layaway and holds',
        table: ui.renderTable({
          columns: [
            { key: 'product_name', label: 'Held item', className: 'wrap', render: (d) => ui.h('div', {},
              ui.h('div', { style: { fontWeight: '600' } }, d.product_name || '—'),
              ui.h('div', { class: 'hint' }, [d.sku, d.serial_no ? `serial ${d.serial_no}` : null, U.humanise(d.deposit_type || '')].filter(Boolean).join(' · '))) },
            { key: 'customer_name', label: 'For', render: (d) => ui.h('div', {}, ui.h('div', {}, d.customer_name || '—'), ui.h('div', { class: 'hint' }, d.customer_phone || '')) },
            { key: 'quantity', label: 'Qty', align: 'right', render: (d) => U.qty(d.quantity) },
            { key: 'unit_price', label: 'Price', align: 'right', render: (d) => U.money(d.unit_price) },
            { key: 'deposit_amount', label: 'Deposit', align: 'right', render: (d) => U.money(d.deposit_amount) },
            { key: 'total_paid', label: 'Paid so far', align: 'right', render: (d) => U.money(d.total_paid) },
            { key: 'balance_due', label: 'Balance', align: 'right', render: (d) => ui.h('strong', {}, U.money(d.balance_due)) },
            { key: 'expires_at', label: 'Expires', render: (d) => {
              if (!d.expires_at) return '—';
              if (d.expired) return ui.badge(`${U.date(d.expires_at)} · expired`, 'badge-bad');
              const days = Number(d.days_to_expiry);
              return days <= 7 ? ui.badge(`${U.date(d.expires_at)} · ${days}d`, 'badge-warn') : U.date(d.expires_at);
            } },
            { key: 'status', label: '', render: (d) => ui.statusBadge(d.status) },
            { key: 'x', label: '', render: (d) => {
              const cell = ui.h('div', { class: 'btn-row' });
              if (!['COMPLETED', 'FORFEITED', 'CANCELLED'].includes(String(d.status))) {
                cell.appendChild(ui.h('button', { class: 'btn btn-sm btn-primary', onClick: (ev) => { ev.stopPropagation(); addDepositPayment(d); } }, 'Add payment'));
                cell.appendChild(ui.h('button', { class: 'btn btn-sm', onClick: (ev) => { ev.stopPropagation(); completeDeposit(d); } }, 'Hand over'));
                if (SR.state.atLeast('MANAGER')) cell.appendChild(ui.h('button', { class: 'btn btn-sm', onClick: (ev) => { ev.stopPropagation(); cancelDeposit(d); } }, 'Cancel'));
              }
              return cell;
            } },
          ],
          rows,
          emptyTitle: 'Nothing is being held',
          emptyMessage: 'A layaway reserves an item while the customer pays towards it, and the reservation is what stops it being sold to somebody else in the meantime.',
          emptyAction: { label: 'Take a deposit', run: () => openDeposit() },
        }),
        pager: ui.pager({
          page: state.page, pageSize: paging.limit || state.pageSize, total: paging.total != null ? paging.total : rows.length,
          onPage: (p) => { state.page = p; renderDeposits(); },
          onSize: (n) => { state.pageSize = n; state.page = 0; renderDeposits(); },
        }),
      }));
    }

    // ---------------- CREATE ----------------
    function openPlan() {
      const wrapEl = ui.h('div', {});
      wrapEl.appendChild(ui.h('p', { class: 'hint' }, 'This is a loan the business is making. The customer takes the goods now and pays over time, so the schedule is the contract — build it correctly.'));
      wrapEl.appendChild(ui.h('div', { class: 'form-grid' },
        ui.field({ label: 'Customer', name: 'customer_name', required: true, placeholder: 'Search by name or phone…' }),
        ui.field({ label: 'What is being financed', name: 'description', placeholder: 'e.g. LG 2-door fridge, 500L' }),
        ui.field({ label: 'Principal (₦)', name: 'principal', type: 'number', step: '0.01', min: '1', required: true, hint: 'The price of the goods, before interest.' }),
        ui.field({ label: 'Deposit paid today (₦)', name: 'deposit_amount', type: 'number', step: '0.01', min: '0', value: '0' }),
        ui.field({ label: 'Tenure (months)', name: 'tenure_months', type: 'number', step: '1', min: '1', max: '60', value: '6', required: true }),
        ui.field({ label: 'Frequency', name: 'frequency', value: 'MONTHLY', options: FREQUENCIES.map((f) => ({ value: f, label: U.humanise(f) })) }),
        ui.field({ label: 'Interest rate (%)', name: 'interest_percent', type: 'number', step: '0.01', min: '0', value: '0', hint: 'On the principal, for the whole tenure — not per month. The effective annual rate is computed for the customer.' }),
        ui.field({ label: 'First payment date', name: 'schedule_start', type: 'date', value: U.addDays(U.todayWat(), 30) }),
        ui.field({ label: 'Guarantor name', name: 'guarantor_name', hint: 'A guarantor is what turns a default from a loss into a conversation.' }),
        ui.field({ label: 'Guarantor phone', name: 'guarantor_phone' }),
        ui.field({ label: 'Guarantor address', name: 'guarantor_address', span: true })));
      const preview = ui.h('div', { class: 'alert alert-info' }, 'Fill in the amount and the tenure to see the schedule.');
      wrapEl.appendChild(preview);
      const customerBox = ui.h('div', { class: 'pos-results', hidden: true });
      wrapEl.appendChild(customerBox);

      const customerInput = wrapEl.querySelector('[name="customer_name"]');
      let customer = null;
      customerInput.addEventListener('input', U.debounce(async () => {
        const term = customerInput.value.trim();
        if (term.length < 2) { customerBox.hidden = true; return; }
        let rows = [];
        try {
          const d = await SR.api.get('/api/customers', { query: SR.state.query({ q: term, limit: 8 }) });
          rows = d.data || [];
        } catch (err) { rows = []; }
        customerBox.replaceChildren();
        for (const c of rows) {
          customerBox.appendChild(ui.h('button', {
            class: 'pos-hit', type: 'button',
            onClick: () => {
              customer = c;
              customerInput.value = c.name;
              customerBox.hidden = true;
            },
          }, ui.h('div', { class: 'grow' }, ui.h('div', { class: 'ph-name' }, c.name),
            ui.h('div', { class: 'ph-meta' }, [c.phone, Number(c.credit_balance) > 0 ? `owes ${U.money(c.credit_balance)}` : 'no balance'].filter(Boolean).join(' · ')))));
        }
        customerBox.hidden = !rows.length;
        if (!rows.length) {
          customerBox.appendChild(ui.h('div', { class: 'hint' }, 'No customer matched. Add them on the Customers screen first — a plan must be attached to a named person.'));
          customerBox.hidden = false;
        }
      }, 300));

      const principalEl = wrapEl.querySelector('[name="principal"]');
      const depositEl = wrapEl.querySelector('[name="deposit_amount"]');
      const tenureEl = wrapEl.querySelector('[name="tenure_months"]');
      const interestEl = wrapEl.querySelector('[name="interest_percent"]');
      const freqEl = wrapEl.querySelector('[name="frequency"]');
      const startEl = wrapEl.querySelector('[name="schedule_start"]');
      function recompute() {
        const principal = Number(principalEl.value) || 0;
        const deposit = Number(depositEl.value) || 0;
        const tenure = Math.max(1, Number(tenureEl.value) || 1);
        const rate = Number(interestEl.value) || 0;
        const financed = U.round2(principal - deposit);
        const interest = U.round2(financed * rate / 100);
        const total = U.round2(financed + interest);
        const per = U.round2(total / tenure);
        preview.replaceChildren();
        preview.appendChild(ui.kv([
          ['Financed after the deposit', U.money(financed)],
          ['Interest', interest ? U.money(interest) : '—'],
          ['Total payable', ui.h('strong', {}, U.money(total))],
          ['Each payment', `${U.money(per)} ${U.humanise(freqEl.value).toLowerCase()} × ${tenure}`],
          ['First due', startEl.value ? U.date(startEl.value) : 'today'],
          ['Effective annual rate', rate ? U.pct(U.round2((interest / Math.max(1, financed)) * (12 / tenure) * 100)) : 'none — interest free'],
        ]));
        if (deposit > principal) preview.appendChild(ui.h('div', { class: 'hint' }, 'The deposit is larger than the principal — there is nothing to finance.'));
      }
      for (const el of [principalEl, depositEl, tenureEl, interestEl, freqEl, startEl]) el.addEventListener('input', recompute);
      freqEl.addEventListener('change', recompute);
      recompute();

      const m = ui.openModal({
        title: 'Open an instalment plan',
        body: wrapEl,
        size: 'wide',
        footer: [
          ui.h('button', { class: 'btn', onClick: () => m.close() }, 'Cancel'),
          ui.h('button', {
            class: 'btn btn-primary',
            onClick: async (ev) => {
              const v = ui.readFormStrings(wrapEl);
              if (!customer) { ui.warn('Pick the customer from the list — a plan has to be attached to a named person.'); return; }
              if (!(Number(v.principal) >= 1)) { ui.warn('Enter the amount being financed.'); return; }
              ev.currentTarget.disabled = true;
              ev.currentTarget.textContent = 'Opening…';
              try {
                const result = await SR.api.post('/api/instalments', {
                  branch_id: SR.state.activeBranchId,
                  business_id: SR.state.activeBusinessId,
                  customer_id: String(customer.id),
                  description: v.description || null,
                  principal: Number(v.principal),
                  deposit_amount: Number(v.deposit_amount) || 0,
                  tenure_months: Number(v.tenure_months),
                  frequency: v.frequency,
                  interest_percent: Number(v.interest_percent) || 0,
                  schedule_start: v.schedule_start || null,
                  guarantor_name: v.guarantor_name || null,
                  guarantor_phone: v.guarantor_phone || null,
                  guarantor_address: v.guarantor_address || null,
                }, { queue: false });
                ui.ok(result.message || 'Plan opened.');
                if (result.effectiveAnnualRate != null) ui.info(`Effective annual rate ${result.effectiveAnnualRate}% — tell the customer that figure, not just the interest.`);
                m.close();
                state.tab = 'plans';
                load();
              } catch (err) {
                ui.apiError(err);
                ev.currentTarget.disabled = false;
                ev.currentTarget.textContent = 'Open the plan';
              }
            },
          }, 'Open the plan'),
        ],
      });
    }

    function openDeposit() {
      const wrapEl = ui.h('div', {});
      wrapEl.appendChild(ui.h('p', { class: 'hint' }, 'A deposit reserves an item. The stock is held for the named customer until the balance is paid or the reservation expires.'));
      wrapEl.appendChild(ui.h('div', { class: 'form-grid' },
        ui.field({ label: 'Item', name: 'product_name', required: true, placeholder: 'Search the catalogue…' }),
        ui.field({ label: 'Customer', name: 'customer_name', required: true, placeholder: 'Search customers…' }),
        ui.field({ label: 'Kind', name: 'deposit_type', value: 'LAYAWAY', options: DEPOSIT_TYPES.map((d) => ({ value: d, label: U.humanise(d) })) }),
        ui.field({ label: 'Quantity', name: 'quantity', type: 'number', step: 'any', min: '0.0001', value: '1', required: true }),
        ui.field({ label: 'Unit', name: 'unit_code', value: 'PIECE' }),
        ui.field({ label: 'Unit price (₦)', name: 'unit_price', type: 'number', step: '0.01', min: '0', required: true }),
        ui.field({ label: 'Deposit taken now (₦)', name: 'deposit_amount', type: 'number', step: '0.01', min: '0.01', required: true }),
        ui.field({ label: 'Hold for (days)', name: 'days', type: 'number', step: '1', min: '1', max: '365', value: '30', hint: 'What the customer is told the deposit holds the item for.' }),
        ui.field({ label: 'Collected by', name: 'method', value: 'CASH', options: METHODS.map((x) => ({ value: x, label: U.humanise(x) })) }),
        ui.field({ label: 'Reference', name: 'reference' }),
        ui.field({ label: 'Notes', name: 'notes', type: 'textarea', span: true })));
      const productInput = wrapEl.querySelector('[name="product_name"]');
      const customerInput = wrapEl.querySelector('[name="customer_name"]');
      let product = null; let customer = null;
      const productBox = ui.h('div', { class: 'pos-results', hidden: true });
      const customerBox = ui.h('div', { class: 'pos-results', hidden: true });
      productInput.parentElement.appendChild(productBox);
      customerInput.parentElement.appendChild(customerBox);

      productInput.addEventListener('input', U.debounce(async () => {
        const term = productInput.value.trim();
        product = null;
        if (term.length < 2) { productBox.hidden = true; return; }
        let rows = [];
        try {
          const d = await SR.api.get('/api/products', { query: SR.state.query({ q: term, limit: 8 }) });
          rows = d.data || [];
        } catch (err) { rows = []; }
        productBox.replaceChildren();
        for (const p of rows) {
          productBox.appendChild(ui.h('button', {
            class: 'pos-hit', type: 'button',
            onClick: () => {
              product = p;
              productInput.value = p.name;
              const priceEl = wrapEl.querySelector('[name="unit_price"]');
              const unitEl = wrapEl.querySelector('[name="unit_code"]');
              if (priceEl) priceEl.value = U.numInput(p.selling_price);
              if (unitEl) unitEl.value = p.default_unit_code || p.base_unit_name || 'PIECE';
              productBox.hidden = true;
            },
          }, ui.h('div', { class: 'grow' }, ui.h('div', { class: 'ph-name' }, p.name),
            ui.h('div', { class: 'ph-meta' }, [p.sku, p.base_unit_name].filter(Boolean).join(' · '))),
          ui.h('span', { class: 'ph-price' }, U.money(p.selling_price))));
        }
        productBox.hidden = !rows.length;
      }, 300));

      customerInput.addEventListener('input', U.debounce(async () => {
        const term = customerInput.value.trim();
        customer = null;
        if (term.length < 2) { customerBox.hidden = true; return; }
        let rows = [];
        try {
          const d = await SR.api.get('/api/customers', { query: SR.state.query({ q: term, limit: 8 }) });
          rows = d.data || [];
        } catch (err) { rows = []; }
        customerBox.replaceChildren();
        for (const c of rows) {
          customerBox.appendChild(ui.h('button', {
            class: 'pos-hit', type: 'button',
            onClick: () => { customer = c; customerInput.value = c.name; customerBox.hidden = true; },
          }, ui.h('div', { class: 'grow' }, ui.h('div', { class: 'ph-name' }, c.name), ui.h('div', { class: 'ph-meta' }, c.phone || ''))));
        }
        customerBox.hidden = !rows.length;
      }, 300));

      const m = ui.openModal({
        title: 'Take a deposit',
        body: wrapEl,
        size: 'wide',
        footer: [
          ui.h('button', { class: 'btn', onClick: () => m.close() }, 'Cancel'),
          ui.h('button', {
            class: 'btn btn-primary',
            onClick: async (ev) => {
              const v = ui.readFormStrings(wrapEl);
              if (!product) { ui.warn('Pick the item being held, from the catalogue.'); return; }
              if (!customer) { ui.warn('Pick the customer the item is held for.'); return; }
              if (!(Number(v.deposit_amount) > 0)) { ui.warn('Enter the deposit taken.'); return; }
              ev.currentTarget.disabled = true;
              try {
                const result = await SR.api.post('/api/deposits', {
                  branch_id: SR.state.activeBranchId,
                  business_id: SR.state.activeBusinessId,
                  product_id: String(product.id),
                  customer_id: String(customer.id),
                  deposit_type: v.deposit_type,
                  quantity: Number(v.quantity),
                  unit_code: v.unit_code || 'PIECE',
                  unit_price: Number(v.unit_price),
                  deposit_amount: Number(v.deposit_amount),
                  days: Number(v.days) || 30,
                  method: v.method,
                  reference: v.reference || null,
                  notes: v.notes || null,
                }, { queue: false });
                ui.ok(result.message || 'Deposit taken and the item reserved.');
                m.close();
                state.tab = 'deposits';
                for (const b of tabs.children) b.classList.toggle('is-active', b.textContent === 'Layaway & holds');
                load();
              } catch (err) {
                ui.apiError(err);
                ev.currentTarget.disabled = false;
              }
            },
          }, 'Take the deposit'),
        ],
      });
    }

    function addDepositPayment(deposit) {
      const wrapEl = ui.h('div', {});
      wrapEl.appendChild(ui.h('div', { class: 'alert alert-info' },
        `${deposit.product_name} held for ${deposit.customer_name}. Balance ${U.money(deposit.balance_due)}. Expires ${U.date(deposit.expires_at)}.`));
      wrapEl.appendChild(ui.h('div', { class: 'form-grid' },
        ui.field({ label: 'Amount (₦)', name: 'amount', type: 'number', step: '0.01', min: '0.01', value: U.numInput(deposit.balance_due) }),
        ui.field({ label: 'Method', name: 'method', value: 'CASH', options: METHODS.map((x) => ({ value: x, label: U.humanise(x) })) }),
        ui.field({ label: 'Reference', name: 'reference', span: true }),
        ui.field({ label: 'Note', name: 'notes', type: 'textarea', span: true })));
      if (deposit.expired) {
        wrapEl.appendChild(ui.h('label', { class: 'check' },
          ui.h('input', { type: 'checkbox', name: 'accept_expired' }),
          ui.h('div', {}, ui.h('strong', {}, 'Accept a payment on this expired hold'),
            ui.h('div', { class: 'hint' }, 'The reservation has lapsed. Taking money on it means the item has to stay reserved — make sure it is still in the shop.'))));
      }
      const m = ui.openModal({
        title: 'Add a payment',
        body: wrapEl,
        size: 'narrow',
        footer: [
          ui.h('button', { class: 'btn', onClick: () => m.close() }, 'Cancel'),
          ui.h('button', {
            class: 'btn btn-primary',
            onClick: async (ev) => {
              const v = ui.readFormStrings(wrapEl);
              if (!(Number(v.amount) > 0)) { ui.warn('Enter the amount.'); return; }
              ev.currentTarget.disabled = true;
              try {
                const result = await SR.api.post(`/api/deposits/${encodeURIComponent(deposit.id)}/payments`, {
                  amount: Number(v.amount),
                  method: v.method,
                  reference: v.reference || null,
                  notes: v.notes || null,
                  accept_expired: Boolean(wrapEl.querySelector('[name="accept_expired"]') && wrapEl.querySelector('[name="accept_expired"]').checked),
                });
                ui.ok(result.message || 'Payment recorded.');
                m.close();
                load();
              } catch (err) {
                ui.apiError(err);
                ev.currentTarget.disabled = false;
              }
            },
          }, 'Record it'),
        ],
      });
    }

    function completeDeposit(deposit) {
      const outstanding = Number(deposit.balance_due);
      const wrapEl = ui.h('div', {});
      wrapEl.appendChild(ui.h('div', { class: 'alert alert-info' },
        `Handing over ${deposit.product_name} to ${deposit.customer_name}. ${outstanding > 0 ? `${U.money(outstanding)} is still outstanding.` : 'Fully paid.'}`));
      if (outstanding > 0) {
        wrapEl.appendChild(ui.h('div', { class: 'form-grid' },
          ui.field({ label: 'Collecting now (₦)', name: 'amount', type: 'number', step: '0.01', min: '0', value: U.numInput(outstanding) }),
          ui.field({ label: 'Method', name: 'method', value: 'CASH', options: METHODS.map((x) => ({ value: x, label: U.humanise(x) })) }),
          ui.field({ label: 'Reference', name: 'reference', span: true })));
        wrapEl.appendChild(ui.h('label', { class: 'check' },
          ui.h('input', { type: 'checkbox', name: 'allow_outstanding' }),
          ui.h('div', {}, ui.h('strong', {}, 'Hand it over with a balance still owed'),
            ui.h('div', { class: 'hint' }, 'Allowed, but the balance has to be recorded somewhere — the system will put it on the customer\'s account. Handing goods over with an unrecorded balance is how a shop loses money quietly.'))));
      }
      const m = ui.openModal({
        title: 'Complete the layaway',
        body: wrapEl,
        size: 'narrow',
        footer: [
          ui.h('button', { class: 'btn', onClick: () => m.close() }, 'Cancel'),
          ui.h('button', {
            class: 'btn btn-primary',
            onClick: async (ev) => {
              const v = ui.readFormStrings(wrapEl);
              const collected = Number(v.amount) || 0;
              ev.currentTarget.disabled = true;
              try {
                const result = await SR.api.post(`/api/deposits/${encodeURIComponent(deposit.id)}/complete`, {
                  payments: collected > 0 ? [{ amount: collected, method: v.method, reference: v.reference || null }] : [],
                  allow_outstanding: Boolean(wrapEl.querySelector('[name="allow_outstanding"]') && wrapEl.querySelector('[name="allow_outstanding"]').checked),
                }, { queue: false });
                ui.ok(result.message || 'Layaway completed and the goods released.');
                m.close();
                load();
              } catch (err) {
                ui.apiError(err);
                ev.currentTarget.disabled = false;
              }
            },
          }, 'Hand over the goods'),
        ],
      });
    }

    function cancelDeposit(deposit) {
      const wrapEl = ui.h('div', {});
      wrapEl.appendChild(ui.h('div', { class: 'alert alert-warn' },
        `Cancelling ${deposit.customer_name}'s hold on ${deposit.product_name}. Their deposit is ${U.money(deposit.total_paid || deposit.deposit_amount)}.`));
      wrapEl.appendChild(ui.h('div', { class: 'form-grid' },
        ui.field({ label: 'What happens to the deposit?', name: 'forfeit', value: '', options: [{ value: '', label: 'Refund it' }, { value: '1', label: 'Forfeit it — the customer walked away' }], hint: 'A forfeited deposit is recognised as other revenue, not pocketed. It must be recorded, and it is what the customer will argue about.' }),
        ui.field({ label: 'Refund by', name: 'refund_method', value: 'CASH', options: ['CASH', 'BANK_TRANSFER', 'STORE_CREDIT'].map((x) => ({ value: x, label: U.humanise(x) })) }),
        ui.field({ label: 'Reason', name: 'reason', type: 'textarea', span: true, required: true, placeholder: 'e.g. customer relocated; could not keep up payments' })));
      const m = ui.openModal({
        title: 'Cancel the hold',
        body: wrapEl,
        size: 'narrow',
        footer: [
          ui.h('button', { class: 'btn', onClick: () => m.close() }, 'Cancel'),
          ui.h('button', {
            class: 'btn btn-danger',
            onClick: async (ev) => {
              const v = ui.readFormStrings(wrapEl);
              if (!v.reason || String(v.reason).trim().length < 4) { ui.warn('Give a reason. This is the note the customer will be shown.'); return; }
              ev.currentTarget.disabled = true;
              try {
                const result = await SR.api.post(`/api/deposits/${encodeURIComponent(deposit.id)}/cancel`, {
                  forfeit: v.forfeit === '1',
                  reason: v.reason,
                  refund_method: v.refund_method,
                }, { queue: false });
                ui.ok(result.message || 'Hold cancelled and the stock released.');
                m.close();
                load();
              } catch (err) {
                ui.apiError(err);
                ev.currentTarget.disabled = false;
              }
            },
          }, 'Cancel the hold'),
        ],
      });
    }

    function takePayment(plan) {
      const wrapEl = ui.h('div', {});
      wrapEl.appendChild(ui.h('div', { class: 'alert alert-info' },
        `${plan.plan_no || 'Plan'} · outstanding ${U.money(plan.outstanding)}${plan.next_due ? ` · next due ${U.date(plan.next_due)}` : ''}. Payments are allocated against the schedule in order, oldest instalment first.`));
      wrapEl.appendChild(ui.h('div', { class: 'form-grid' },
        ui.field({ label: 'Amount received (₦)', name: 'amount', type: 'number', step: '0.01', min: '0.01', required: true }),
        ui.field({ label: 'Method', name: 'method', value: 'CASH', options: METHODS.map((x) => ({ value: x, label: U.humanise(x) })) }),
        ui.field({ label: 'Reference', name: 'reference', hint: 'Required for a bank transfer, so the payment can be matched to the statement.' }),
        ui.field({ label: 'Notes', name: 'notes', type: 'textarea', span: true })));
      const m = ui.openModal({
        title: 'Take an instalment payment',
        body: wrapEl,
        size: 'narrow',
        footer: [
          ui.h('button', { class: 'btn', onClick: () => m.close() }, 'Cancel'),
          ui.h('button', {
            class: 'btn btn-primary',
            onClick: async (ev) => {
              const v = ui.readFormStrings(wrapEl);
              if (!(Number(v.amount) > 0)) { ui.warn('Enter the amount received.'); return; }
              ev.currentTarget.disabled = true;
              try {
                const result = await SR.api.post(`/api/instalments/${encodeURIComponent(plan.id)}/payments`, {
                  amount: Number(v.amount),
                  method: v.method,
                  reference: v.reference || null,
                  notes: v.notes || null,
                }, { queue: false });
                ui.ok(result.message || 'Payment received.');
                m.close();
                load();
              } catch (err) {
                ui.apiError(err);
                ev.currentTarget.disabled = false;
              }
            },
          }, 'Record the payment'),
        ],
      });
    }

    await load();
    return wrap;
  }

  // -------------------------------------------------------------------
  // ONE PLAN
  // -------------------------------------------------------------------
  async function renderPlan(ctx) {
    ctx.setTitle('Instalment plan');
    const wrap = ui.h('div', { class: 'stack' });
    const host = ui.h('div', { class: 'stack' });
    wrap.appendChild(host);
    await load();

    async function load() {
      host.replaceChildren(ui.skeleton(7));
      let data; let offline = false;
      try {
        data = await SR.api.get(`/api/instalments/${encodeURIComponent(ctx.params.id)}`);
      } catch (err) {
        if (!err.isOffline) { host.replaceChildren(ui.errorBlock(err, { retry: { label: 'Try again', run: load } })); return; }
        offline = true;
        host.replaceChildren(ui.empty({ title: 'Not on this device', message: 'A plan and its schedule are computed on the server.' }));
        return;
      }
      const plan = data.plan;
      const schedule = data.schedule || [];
      const payments = data.payments || [];
      const progress = data.progress || {};
      const trigger = data.trigger || {};

      host.appendChild(ui.h('div', { class: 'page-head' },
        ui.h('div', {},
          ui.h('h1', {}, plan.plan_no || 'Instalment plan'),
          ui.h('p', { class: 'sub' }, [plan.customer_name, plan.customer_phone, plan.description].filter(Boolean).join(' · '))),
        ui.h('div', { class: 'actions' },
          ui.h('button', { class: 'btn btn-sm', onClick: () => SR.app.navigate('/instalments') }, 'Back'),
          ui.h('button', { class: 'btn btn-sm', onClick: () => SR.app.navigate(`/customers/${plan.customer_id}`) }, 'Customer'),
          ui.h('button', { class: 'btn btn-sm', onClick: () => printPlan(plan, schedule) }, 'Print the schedule'),
          !['COMPLETED', 'CANCELLED', 'DEFAULTED'].includes(String(plan.status))
            ? ui.h('button', { class: 'btn btn-sm btn-primary', onClick: () => SR.views.instalments.pay(plan, load) }, 'Take a payment')
            : null)));

      host.appendChild(ui.h('div', { class: 'grid grid-4' },
        ui.kpi({ label: 'Outstanding', value: U.money(plan.outstanding), tone: Number(plan.outstanding) > 0 ? 'warn' : 'good', small: true }),
        ui.kpi({ label: 'Paid so far', value: U.money(plan.amount_paid), foot: `${progress.instalmentsPaid || 0} of ${progress.instalmentsTotal || 0} instalments`, small: true }),
        ui.kpi({ label: 'Next due', value: plan.next_due ? U.date(plan.next_due) : '—', tone: plan.next_due && plan.next_due < U.todayWat() ? 'bad' : null, foot: plan.status, small: true }),
        ui.kpi({ label: 'Interest', value: U.money(plan.interest_amount), foot: Number(plan.interest_percent) ? `${plan.interest_percent}% over the tenure` : 'interest free', small: true })));

      if (trigger && trigger.shouldRemind) {
        host.appendChild(ui.h('div', { class: 'alert alert-warn' }, trigger.message || 'This plan is due or overdue — contact the customer.'));
      }

      const cols = ui.h('div', { class: 'grid grid-2' });
      cols.appendChild(ui.dataCard({
        title: 'Terms',
        table: ui.kv([
          ['Principal', U.money(plan.principal)],
          ['Deposit', Number(plan.deposit_amount) ? U.money(plan.deposit_amount) : null],
          ['Interest rate', Number(plan.interest_percent) ? U.pct(plan.interest_percent) : 'interest free'],
          ['Total payable', U.money(plan.total_payable)],
          ['Frequency', U.humanise(plan.frequency || '')],
          ['Tenure', `${plan.tenure_months} months`],
          ['First payment', plan.schedule_start ? U.date(plan.schedule_start) : null],
          ['Guarantor', plan.guarantor_name],
          ['Guarantor phone', plan.guarantor_phone],
          ['Status', plan.status],
          ['Opened', U.dateTime(plan.created_at)],
          ['Notes', plan.notes],
        ]),
      }));
      cols.appendChild(ui.dataCard({
        title: 'Payments received',
        table: ui.renderTable({
          columns: [
            { key: 'created_at', label: 'When', render: (p) => U.dateTime(p.created_at) },
            { key: 'amount', label: 'Amount', align: 'right', render: (p) => U.money(p.amount) },
            { key: 'method', label: 'Method', render: (p) => U.humanise(p.method || '') },
            { key: 'reference', label: 'Ref', render: (p) => (p.reference ? ui.h('span', { class: 'mono' }, p.reference) : '—') },
            { key: 'received_by_name', label: 'Taken by' },
          ],
          rows: payments,
          emptyMessage: 'No payments received yet.',
        }),
      }));
      host.appendChild(cols);

      const bar = ui.h('div', { style: { height: '10px', borderRadius: '5px', background: 'var(--slate-200)', margin: '4px 0 14px' } },
        ui.h('div', { style: { width: `${U.clamp(Number(progress.pctPaid) || 0, 0, 100)}%`, height: '100%', borderRadius: '5px', background: 'var(--teal-600)' } }));
      host.appendChild(ui.h('div', {}, bar,
        ui.h('div', { class: 'hint' }, `${U.pct(progress.pctPaid || 0)} of the total payable collected${progress.overdueInstalments ? ` · ${progress.overdueInstalments} instalment(s) past due` : ''}`)));

      host.appendChild(ui.dataCard({
        title: 'The schedule',
        table: ui.renderTable({
          columns: [
            { key: 'seq', label: '#', align: 'right' },
            { key: 'due_date', label: 'Due', render: (r) => {
              if (r.status === 'PAID') return U.date(r.due_date);
              if (r.due_date < U.todayWat()) return ui.badge(`${U.date(r.due_date)} · overdue`, 'badge-bad');
              return U.date(r.due_date);
            } },
            { key: 'amount_due', label: 'Amount', align: 'right', render: (r) => U.money(r.amount_due) },
            { key: 'amount_paid', label: 'Paid', align: 'right', render: (r) => U.money(r.amount_paid) },
            { key: 'balance', label: 'Balance', align: 'right', render: (r) => U.money(U.round2(Number(r.amount_due) - Number(r.amount_paid))) },
            { key: 'paid_at', label: 'Settled', render: (r) => (r.paid_at ? U.dateTime(r.paid_at) : '—') },
            { key: 'status', label: '', render: (r) => ui.statusBadge(r.status) },
          ],
          rows: schedule,
          foot: ['', 'Total', U.money(U.sum(schedule, (r) => r.amount_due)), U.money(U.sum(schedule, (r) => r.amount_paid)), U.money(U.sum(schedule, (r) => U.round2(Number(r.amount_due) - Number(r.amount_paid)))), '', ''],
          emptyMessage: 'No schedule rows — this plan may have been opened without one, which should not happen.',
        }),
      }));
      host.appendChild(ui.h('div', { class: 'hint' }, 'The rounding remainder sits on the FIRST instalment on purpose. A customer who pays every printed figure to the kobo has to end at exactly zero, and a remainder on the last payment is the one nobody checks until the plan reads "paid" and still shows a balance.'));
    }

    function printPlan(plan, schedule) {
      const brand = (SR.state.settings || {}).business_name || 'StockRidge';
      SR.print.printReport({
        title: `${brand} — Instalment schedule`,
        subtitle: `${plan.plan_no || ''} · ${plan.customer_name} · ${U.money(plan.total_payable)} over ${plan.tenure_months} months`,
        columns: [
          { key: 'seq', label: '#' },
          { key: 'due_date', label: 'Due', value: (r) => U.date(r.due_date) },
          { key: 'amount_due', label: 'Amount', value: (r) => U.amount(r.amount_due) },
          { key: 'amount_paid', label: 'Paid', value: (r) => U.amount(r.amount_paid) },
          { key: 'status', label: 'Status' },
        ],
        rows: schedule,
        foot: ['', 'TOTAL', U.amount(U.sum(schedule, (r) => r.amount_due)), '', ''],
      });
    }

    return wrap;
  }

  SR.views = SR.views || {};
  SR.views.instalments = { render, pay: null, FREQUENCIES, DEPOSIT_TYPES };
  // The detail screen's "take a payment" button needs the same dialog the list
  // uses, so it is attached here rather than duplicated.
  SR.views.instalments.pay = function pay(plan, after) {
    const wrapEl = ui.h('div', {});
    wrapEl.appendChild(ui.h('div', { class: 'alert alert-info' }, `Outstanding ${U.money(plan.outstanding)}. Payments are allocated oldest instalment first.`));
    wrapEl.appendChild(ui.h('div', { class: 'form-grid' },
      ui.field({ label: 'Amount received (₦)', name: 'amount', type: 'number', step: '0.01', min: '0.01', required: true }),
      ui.field({ label: 'Method', name: 'method', value: 'CASH', options: METHODS.map((x) => ({ value: x, label: U.humanise(x) })) }),
      ui.field({ label: 'Reference', name: 'reference' }),
      ui.field({ label: 'Notes', name: 'notes', type: 'textarea', span: true })));
    const m = ui.openModal({
      title: 'Take an instalment payment',
      body: wrapEl,
      size: 'narrow',
      footer: [
        ui.h('button', { class: 'btn', onClick: () => m.close() }, 'Cancel'),
        ui.h('button', {
          class: 'btn btn-primary',
          onClick: async (ev) => {
            const v = ui.readFormStrings(wrapEl);
            if (!(Number(v.amount) > 0)) { ui.warn('Enter the amount received.'); return; }
            ev.currentTarget.disabled = true;
            try {
              const result = await SR.api.post(`/api/instalments/${encodeURIComponent(plan.id)}/payments`, {
                amount: Number(v.amount), method: v.method, reference: v.reference || null, notes: v.notes || null,
              }, { queue: false });
              ui.ok(result.message || 'Payment received.');
              m.close();
              if (after) after();
            } catch (err) {
              ui.apiError(err);
              ev.currentTarget.disabled = false;
            }
          },
        }, 'Record the payment'),
      ],
    });
  };
}(window));
