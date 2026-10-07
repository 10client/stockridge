'use strict';
// =====================================================================
// public/js/views/transfers.js — MOVING STOCK BETWEEN SHOPS
// =====================================================================
// A multi-branch appliance business moves stock constantly: the Ikeja showroom
// has a freezer nobody wants and the Onitsha branch has three customers waiting
// for it. A transfer is a two-sided event that people treat as one-sided:
//
//   * THE SENDING BRANCH believes the goods are gone the moment it loads them.
//   * THE RECEIVING BRANCH cannot sell what it has not booked in.
//
// Between those two beliefs is a truck, a driver, and — with real money —
// a shortfall. So a transfer has TWO STEPS and this screen keeps them apart:
//
//   SENT          stock left the sending branch. It is OUT OF STOCK THERE and
//                 IN TRANSIT. It is NOT yet sellable anywhere.
//   RECEIVED      the receiving branch counted what arrived. A line that arrived
//                 short is recorded as arriving short, with a note, and the
//                 shortfall stays visible — it is either still on the road or it
//                 never left, and only a person can say which.
//
// The goods move in the ledger at their cost, so a transfer does not create a
// profit — it moves value from one branch's stock to another's.
// =====================================================================
(function (global) {
  const SR = global.SR;
  const ui = SR.ui;
  const U = SR.util;

  // =====================================================================
  // THE STATUS VOCABULARY OF A STOCK TRANSFER
  // =====================================================================
  // ONE COPY, AT THE SCOPE BOTH SCREENS SHARE. The list and the detail are SIBLING functions
  // here, so a `let` declared inside either one is invisible to the other — a vocabulary
  // declared inside the list screen produced `statuses is not defined` the moment the detail
  // screen or a deep link read it, which is the same class of mistake that once put "That
  // failed. transfers is not defined" in front of a shop owner.
  //
  // The values are the SERVER's. They used to be typed into the list screen as
  // DRAFT/SENT/RECEIVED/CANCELLED — a vocabulary the API has never used, so the "In transit"
  // filter matched nothing and every status comparison on this screen (INCLUDING the one that
  // decided whether to draw the Book-in button) tested a word the database cannot contain. The
  // defaults below are the transfer table's own five, used only until the server answers.
  const STATUS_WORDS = ['INITIATED', 'IN_TRANSIT', 'PARTIALLY_RECEIVED', 'RECEIVED', 'CANCELLED'];
  const STATUS_LABELS = { INITIATED: 'Prepared', IN_TRANSIT: 'In transit', PARTIALLY_RECEIVED: 'Part received', RECEIVED: 'Received', CANCELLED: 'Cancelled' };
  let statuses = STATUS_WORDS.slice();
  /** The statuses a branch may still book in — sent, or part of it already booked. */
  let receivable = ['IN_TRANSIT', 'PARTIALLY_RECEIVED'];
  /** Take the vocabulary from an answer, whichever route it came from. True if it changed. */
  function learnStatuses(data) {
    if (!data) return false;
    let changed = false;
    if (Array.isArray(data.statuses) && data.statuses.length && data.statuses.join(',') !== statuses.join(',')) {
      statuses = data.statuses.slice(); changed = true;
    }
    if (Array.isArray(data.receivable) && data.receivable.length) receivable = data.receivable.slice();
    return changed;
  }
  /** Can the receiving branch still book this transfer in? Sent, or part of it already booked. */
  function isReceivable(t) { return receivable.includes(String(t && t.status)); }

  async function render(ctx) {
    if (ctx.params.id) return renderDetail(ctx, ctx.params.id);
    return renderList(ctx);
  }

  // -------------------------------------------------------------------
  // LIST
  // -------------------------------------------------------------------
  async function renderList(ctx) {
    ctx.setTitle('Transfers');
    const state = { page: 0, pageSize: 25, status: ctx.query.status || '', mine: ctx.query.mine === '1' };

    const wrap = ui.h('div', { class: 'stack' });
    wrap.appendChild(ui.h('div', { class: 'page-head' },
      ui.h('div', {},
        ui.h('h1', {}, 'Stock transfers'),
        ui.h('p', { class: 'sub' }, 'Stock moving between branches. Sent is not received — the receiving branch books it in.')),
      ui.h('div', { class: 'actions' },
        ui.h('button', { class: 'btn btn-sm btn-primary', onClick: () => openCreate() }, 'Send stock'))));

    const statusSelect = ui.h('select', { onChange: () => { state.status = statusSelect.value; state.page = 0; load(); } },
      ui.h('option', { value: '' }, 'Any status'),
      ...statuses.map((v) => ui.h('option', { value: v }, STATUS_LABELS[v] || U.humanise(v))));
    statusSelect.value = state.status;
    function fillStatuses() {
      const chosen = state.status;
      statusSelect.replaceChildren(
        ui.h('option', { value: '' }, 'Any status'),
        ...statuses.map((v) => ui.h('option', { value: v }, STATUS_LABELS[v] || U.humanise(v))));
      statusSelect.value = statuses.includes(chosen) ? chosen : '';
    }
    fillStatuses();

    const host = ui.h('div', {});
    wrap.appendChild(host);

    async function load() {
      host.replaceChildren(ui.skeleton(5));
      let data;
      try {
        data = await SR.api.get('/api/transfers', {
          query: SR.state.query({ status: state.status || undefined, limit: state.pageSize, offset: state.page * state.pageSize }),
        });
      } catch (err) {
        host.replaceChildren();
        host.appendChild(ui.errorBlock(err, { retry: { label: 'Try again', run: load } }));
        return;
      }
      const rows = data.data || [];
      const paging = data.paging || {};
      // THE SERVER OWNS THE VOCABULARY — see learnStatuses() above.
      if (learnStatuses(data)) fillStatuses();

      // A transfer is only actionable at one end: you can receive what was sent
      // TO you, never what you sent. Splitting the list this way means the person
      // at the receiving branch sees a short, obvious list of things to book in
      // rather than a wall of history.
      // "WAITING TO BE BOOKED IN" IS A SET OF STATUSES, NOT ONE WORD: a delivery that arrived
      // short is PARTIALLY_RECEIVED and the balance is still coming, so it stays in this list
      // until every line is closed. A single literal here is exactly what hid the Book-in
      // button from every receiving branch in the product.
      const incoming = rows.filter((tr) => isReceivable(tr) && String(tr.to_branch_id) === String(SR.state.activeBranchId));
      const outgoing = rows.filter((tr) => isReceivable(tr) && String(tr.from_branch_id) === String(SR.state.activeBranchId));
      const rest = rows.filter((tr) => !isReceivable(tr));

      host.replaceChildren();
      if (incoming.length) {
        host.appendChild(ui.dataCard({
          title: `Waiting to be booked in at ${SR.state.activeBranchName() || 'this branch'}`,
          subtitle: incoming.some((t) => String(t.status) === 'PARTIALLY_RECEIVED')
            ? 'One or more of these arrived short — the balance on each line is what is still to come.' : null,
          table: transferTable(incoming, { highlight: true }),
        }));
      }
      if (outgoing.length) {
        host.appendChild(ui.dataCard({
          title: 'Sent, not yet received',
          table: transferTable(outgoing, {}),
        }));
      }
      host.appendChild(ui.dataCard({
        title: 'All transfers',
        toolbar: ui.h('label', { class: 'inline-field' }, ui.h('span', {}, 'Status'), statusSelect),
        table: transferTable(rest, {}),
        pager: ui.pager({
          page: state.page, pageSize: state.pageSize, total: Number(paging.total || rows.length),
          onPage: (p) => { state.page = p; load(); },
        }),
      }));
    }

    function transferTable(rows, { highlight = false }) {
      return ui.renderTable({
        columns: [
          { key: 'reference', label: 'Reference', render: (t) => ui.h('strong', {}, t.reference || t.id.slice(0, 8)) },
          { key: 'route', label: 'Route', className: 'wrap', render: (t) => ui.h('div', {},
            ui.h('div', {}, `${t.from_branch_name || '—'} → ${t.to_branch_name || '—'}`),
            t.from_business_name && t.to_business_name && t.from_business_name !== t.to_business_name
              ? ui.h('div', { class: 'hint' }, `across businesses: ${t.from_business_name} → ${t.to_business_name}`) : null) },
          { key: 'status', label: 'Status', render: (t) => ui.statusBadge(t.status) },
          { key: 'item_count', label: 'Lines', align: 'right', render: (t) => Number(t.item_count || 0).toLocaleString('en-NG') },
          { key: 'progress', label: 'Arrived', align: 'right', render: (t) => {
            // WHAT IS STILL COMING, on the row — the same bar the purchase-order list draws,
            // down to the colours: two screens answering "how much of it has arrived" should
            // not look like two different products.
            const sent = Number(t.units_sent) || 0;
            const got = Number(t.units_received) || 0;
            if (!sent) return ui.h('span', { class: 'hint' }, '—');
            if (String(t.status) === 'RECEIVED') return ui.h('span', { class: 'hint' }, `${U.qty(got)} of ${U.qty(sent)}`);
            const pct = U.clamp((got / sent) * 100, 0, 100);
            const bar = ui.h('div', { style: { width: '70px', height: '8px', borderRadius: '4px', background: 'var(--slate-200)', display: 'inline-block', verticalAlign: 'middle', marginRight: '6px' } },
              ui.h('div', { style: { width: `${pct}%`, height: '100%', borderRadius: '4px', background: got >= sent ? 'var(--green-600)' : 'var(--teal-600)' } }));
            return ui.h('span', {}, bar, ui.h('span', { class: 'hint' }, `${U.qty(got)}/${U.qty(sent)}`));
          } },
          { key: 'initiated_at', label: 'Sent', render: (t) => U.relTime(t.initiated_at) },
          { key: 'initiated_by_name', label: 'By', render: (t) => t.initiated_by_name || '—' },
          { key: 'received_at', label: 'Received', render: (t) => (t.received_at ? U.relTime(t.received_at) : '—') },
          { key: 'x', label: '', render: (t) => {
            const cell = ui.h('div', { class: 'row-tight' });
            cell.appendChild(ui.h('button', {
              class: `btn btn-sm${highlight ? ' btn-primary' : ''}`,
              onClick: (ev) => { ev.stopPropagation(); SR.app.navigate(`/transfers/${t.id}`); },
            }, isReceivable(t) && String(t.to_branch_id) === String(SR.state.activeBranchId)
              ? (String(t.status) === 'PARTIALLY_RECEIVED' ? 'Book in the rest' : 'Book in')
              : 'Open'));
            return cell;
          } },
        ],
        rows,
        onRowClick: (t) => SR.app.navigate(`/transfers/${t.id}`),
        emptyTitle: 'No transfers here',
        emptyMessage: 'Stock that moves between branches is recorded here, so each shop\'s shelf matches its own books.',
        emptyAction: SR.state.atLeast('MANAGER') ? { label: 'Send stock', run: () => openCreate() } : null,
      });
    }

    // ---------------------------------------------------------------
    // SEND STOCK
    // ---------------------------------------------------------------
    async function openCreate() {
      if (!SR.state.atLeast('MANAGER')) { ui.warn('Only a manager or above can move stock between branches.'); return; }

      const branches = SR.state.branches();
      const destinations = branches.filter((b) => String(b.id) !== String(SR.state.activeBranchId));
      if (!destinations.length) {
        ui.warn('There is only one branch, so there is nowhere to transfer to. Add a branch first.');
        return;
      }

      const form = ui.h('div', { class: 'stack' });
      form.appendChild(ui.field({
        label: 'Send to', name: 'to_branch_id', type: 'select', required: true,
        options: destinations.map((b) => ({ value: b.id, label: `${b.name}${b.city ? ` (${b.city})` : ''}` })),
      }));
      form.appendChild(ui.field({ label: 'Notes', name: 'notes', type: 'textarea', placeholder: 'Who is carrying it, and when' }));

      const linesHost = ui.h('div', { class: 'stack' });
      const lines = [{ product: null, unitCode: null, quantity: 1 }];

      function paintLines() {
        linesHost.replaceChildren();
        lines.forEach((line, index) => {
          const row = ui.h('div', { class: 'card' }, ui.h('div', { class: 'card-body stack' }));

          const head = ui.h('div', { class: 'row-tight' },
            ui.h('strong', {}, `Line ${index + 1}`),
            ui.h('span', { class: 'spacer' }),
            lines.length > 1 ? ui.h('button', {
              class: 'btn btn-sm', type: 'button',
              onClick: () => { lines.splice(index, 1); paintLines(); },
            }, 'Remove') : null);
          row.appendChild(head);

          // ---- product picker: type, then pick from what this branch actually has
          const searchInput = ui.h('input', { type: 'search', placeholder: 'Search the catalogue…' });
          if (line.product) searchInput.value = line.product.name;
          const results = ui.h('div', { class: 'stack' });
          const stockNote = ui.h('div', { class: 'hint' });

          searchInput.addEventListener('input', U.debounce(async () => {
            const term = searchInput.value.trim();
            if (term.length < 2) { results.replaceChildren(); return; }
            results.replaceChildren(ui.loading('Searching…'));
            try {
              const res = await SR.api.get('/api/products', { query: SR.state.query({ q: term, limit: 12 }) });
              results.replaceChildren();
              if (!(res.data || []).length) { results.appendChild(ui.h('div', { class: 'hint' }, 'Nothing matches that.')); return; }
              for (const p of res.data) {
                results.appendChild(ui.h('button', {
                  class: 'btn btn-sm', type: 'button', style: { textAlign: 'left' },
                  onClick: () => { line.product = p; paintLines(); },
                }, `${p.name}${p.sku ? ` · ${p.sku}` : ''} — ${U.money(p.selling_price)}`));
              }
            } catch (err) { results.replaceChildren(ui.apiError(err)); }
          }, 300));

          row.appendChild(stockNote);
          row.appendChild(searchInput);
          row.appendChild(results);

          if (line.product) {
            results.replaceChildren();
            const unitSelect = ui.h('select', { onchange: () => { line.unitCode = unitSelect.value; } });
            const units = line.product.base_unit_code ? [{ code: line.product.base_unit_code, label: line.product.base_unit_name || line.product.base_unit_code }] : [];
            // The unit ladder is only known in full from the product detail; the
            // list row gives the base unit, which is the one that matters for a
            // branch-to-branch move.
            for (const u of units) unitSelect.appendChild(ui.h('option', { value: u.code }, u.label));
            line.unitCode = units[0] ? units[0].code : null;

            const qtyInput = ui.h('input', { type: 'number', min: '0.0001', step: '1', value: String(line.quantity || 1) });
            qtyInput.addEventListener('input', () => { line.quantity = qtyInput.value; });

            const grid = ui.h('div', { class: 'form-grid' },
              ui.h('div', {}, ui.h('label', { class: 'ctl' }, 'Unit'), unitSelect),
              ui.h('div', {}, ui.h('label', { class: 'ctl' }, 'Quantity'), qtyInput),
              ui.h('div', { class: 'span-2' }, ui.h('div', { class: 'hint' }, `Available at ${SR.state.activeBranchName() || 'this branch'} — checked when you send, so the shelf cannot go negative.`)));
            row.appendChild(grid);

            // How much is actually here. Sending stock the branch does not have is
            // the single most common transfer mistake, and it is worth showing
            // before the button is pressed rather than after.
            SR.api.get('/api/stock', { query: SR.state.query({ product_id: line.product.id, limit: 1 }) })
              .then((res) => {
                const rowData = (res.data || [])[0];
                stockNote.textContent = rowData
                  ? `On hand at this branch: ${U.qty(rowData.quantity_on_hand ?? rowData.quantity ?? 0)} ${rowData.base_unit_name || ''}`
                  : '';
              })
              .catch(() => { stockNote.textContent = ''; });
          }

          linesHost.appendChild(row);
        });

        linesHost.appendChild(ui.h('button', {
          class: 'btn btn-sm', type: 'button',
          onClick: () => { lines.push({ product: null, unitCode: null, quantity: 1 }); paintLines(); },
        }, 'Add another line'));
      }
      paintLines();
      form.appendChild(ui.h('div', {}, ui.h('h3', {}, 'What is moving'), linesHost));

      const modal = ui.openModal({
        title: 'Send stock to another branch',
        body: form,
        size: 'wide',
        footer: [
          ui.h('button', { class: 'btn', onClick: () => modal.close() }, 'Cancel'),
          ui.h('button', {
            class: 'btn btn-primary',
            onClick: () => ui.withBusy(form, async () => {
              const header = ui.readForm(form);
              const items = lines.filter((l) => l.product && Number(l.quantity) > 0)
                .map((l) => ({ product_id: l.product.id, quantity: Number(l.quantity), unit_code: l.unitCode || undefined }));
              if (!items.length) { ui.warn('Add at least one product with a quantity.'); return; }
              try {
                const res = await SR.api.post('/api/transfers', {
                  from_branch_id: SR.state.activeBranchId,
                  to_branch_id: header.to_branch_id,
                  notes: header.notes || undefined,
                  items,
                });
                modal.close();
                ui.ok(res.message || 'Stock sent.');
                SR.app.navigate(`/transfers/${res.id}`);
              } catch (err) { ui.apiError(err); }
            }),
          }, 'Send'),
        ],
      });
    }

    await load();
    return wrap;
  }

  // -------------------------------------------------------------------
  // ONE TRANSFER
  // -------------------------------------------------------------------
  async function renderDetail(ctx, id) {
    ctx.setTitle('Transfer');
    const wrap = ui.h('div', { class: 'stack' });
    const host = ui.h('div', {});
    wrap.appendChild(host);

    async function load() {
      host.replaceChildren(ui.skeleton(6));
      let res;
      try {
        res = await SR.api.get(`/api/transfers/${encodeURIComponent(id)}`);
      } catch (err) {
        host.replaceChildren();
        host.appendChild(ui.errorBlock(err, { retry: { label: 'Try again', run: load } }));
        return;
      }
      learnStatuses(res);
      const t = res.transfer || {};
      const items = res.items || [];
      const summary = res.summary || {};
      ctx.setTitle(t.reference || 'Transfer');

      const iAmReceiving = String(t.to_branch_id) === String(SR.state.activeBranchId);
      // `can(min)` takes a ROLE, not a permission key — asking it about
      // 'receiveTransfer' would rank nothing and quietly return false, hiding
      // the button from everybody. Booking in is ordinary branch work.
      //
      // AND IT IS NOT ONE STATUS. IN_TRANSIT says the goods left; PARTIALLY_RECEIVED says some
      // of them arrived and the rest is coming. Both are bookable — the single literal 'SENT'
      // that used to be here is a word the API has never written, which is why every receiving
      // branch in the product was looking at a transfer with no way to book it in.
      const isOpen = isReceivable(t);
      const isPartial = String(t.status) === 'PARTIALLY_RECEIVED';
      const canReceive = isOpen && iAmReceiving && SR.state.atLeast('STAFF');
      const canManage = SR.state.atLeast('MANAGER');
      // THE SENDING END CAN CALL IT BACK (the route decides this too; this only decides whether
      // to offer the button). An owner may cancel anything.
      const iAmSending = String(t.from_branch_id) === String(SR.state.activeBranchId);
      const canCancel = isOpen && canManage && (iAmSending || SR.state.isOwner());

      // Received-so-far is typed, not assumed. The default is "everything
      // arrived", because that is the common case, but the box is editable
      // precisely so that a shortfall is recorded rather than discovered later.
      // THE DEFAULT IS WHAT IS STILL OUTSTANDING, NOT WHAT WAS SENT. On a first delivery those
      // are the same number; on the second — the balance of a short delivery — the sent
      // quantity is what the line HELD, and defaulting to it would book the first load in twice
      // and invent stock that never arrived. The route counts the same way and refuses the rest.
      const outstandingOf = (it) => U.round2(Math.max(0, Number(it.quantity_sent_base || 0) - Number(it.quantity_received || 0)));
      const received = new Map();
      const notes = new Map();
      for (const it of items) {
        received.set(String(it.id), String(outstandingOf(it)));
      }

      host.replaceChildren();

      host.appendChild(ui.h('div', { class: 'page-head' },
        ui.h('div', {},
          ui.h('h1', {}, t.reference || 'Transfer'),
          ui.h('p', { class: 'sub' }, `${t.from_branch_name || '—'} → ${t.to_branch_name || '—'} · sent ${U.dateTime(t.initiated_at)}${t.initiated_by_name ? ` by ${t.initiated_by_name}` : ''}`)),
        ui.h('div', { class: 'actions' },
          ui.badge(U.humanise(t.status), t.status === 'RECEIVED' ? 'badge-good' : isOpen ? 'badge-warn' : 'badge-mute'),
          ui.h('button', { class: 'btn btn-sm', onClick: () => window.print() }, 'Print'),
          canCancel ? ui.h('button', { class: 'btn btn-sm btn-danger', onClick: () => cancelTransfer() }, 'Cancel transfer') : null,
          canReceive ? ui.h('button', { class: 'btn btn-sm btn-primary', onClick: () => bookIn() }, isPartial ? 'Book in the rest' : 'Book in what arrived') : null)));

      host.appendChild(ui.h('div', { class: 'kpi-grid' },
        ui.kpi({ label: 'Lines', value: Number(summary.lines || items.length).toLocaleString('en-NG') }),
        ui.kpi({ label: 'Units sent', value: U.qty(summary.unitsSent || 0) }),
        ui.kpi({
          label: 'Units received', value: U.qty(summary.unitsReceived || 0),
          foot: isOpen
            ? (Number(summary.unitsReceived || 0) > 0
              ? `${U.qty(U.round2(Number(summary.unitsSent || 0) - Number(summary.unitsReceived || 0)))} still to arrive`
              : 'nothing has been booked in yet')
            : null,
        }),
        ui.kpi({
          label: 'Shortfall', value: U.qty(summary.shortfall || 0),
          tone: Number(summary.shortfall || 0) > 0 ? 'bad' : null,
          foot: Number(summary.disclosed || 0) ? `${summary.disclosed} line(s) arrived short` : 'every line accounted for',
        })));

      if (isOpen) {
        host.appendChild(ui.h('div', { class: 'card' }, ui.h('div', { class: 'card-body' },
          ui.h('p', {}, t.from_business_name && t.to_business_name && t.from_business_name !== t.to_business_name
            ? `This stock is moving between two businesses (${t.from_business_name} → ${t.to_business_name}). It is still counted as ${t.from_business_name}'s until ${t.to_branch_name} books it in.`
            : `This stock has left ${t.from_branch_name} and is not sellable anywhere until ${t.to_branch_name} books it in. If it does not arrive, the shortfall will show on this page — which is why the receiving branch must count it rather than trusting the manifest.`))));
      }

      host.appendChild(ui.dataCard({
        title: 'Lines',
        table: ui.renderTable({
          columns: [
            { key: 'product_name', label: 'Product', className: 'wrap', render: (i) => ui.h('div', {},
              ui.h('div', { style: { fontWeight: '600' } }, i.product_name || '—'),
              ui.h('div', { class: 'hint' }, [i.variant_name, i.sku, i.batch_no ? `batch ${i.batch_no}` : null].filter(Boolean).join(' · '))) },
            { key: 'quantity_sent_base', label: 'Sent', align: 'right', render: (i) => `${U.qty(i.quantity_sent_base)} ${i.base_unit_name || ''}` },
            { key: 'quantity_received', label: 'Received', align: 'right', render: (i) => (i.quantity_received == null ? ui.h('span', { class: 'hint' }, 'not yet') : U.qty(i.quantity_received)) },
            { key: 'shortfall', label: 'Shortfall', align: 'right', render: (i) => {
              if (i.quantity_received == null) return '—';
              const diff = U.round2(Number(i.quantity_sent_base) - Number(i.quantity_received));
              return diff > 0 ? ui.h('strong', { style: { color: 'var(--red-700)' } }, U.qty(diff)) : ui.h('span', { class: 'hint' }, '—');
            } },
            { key: 'unit_transfer_price', label: 'Value moved', align: 'right', render: (i) => U.money(Number(i.unit_transfer_price || i.unit_cost || 0) * Number(i.quantity_sent_base || 0)) },
          ],
          rows: items,
          emptyTitle: 'No lines',
          emptyMessage: 'This transfer has no items on it.',
        }),
      }));

      if (notesCell(t)) {
        host.appendChild(ui.h('div', { class: 'card' }, ui.h('div', { class: 'card-body' },
          ui.h('h3', {}, 'Notes'),
          ui.h('p', {}, t.notes))));
      }

      // -------------------------------------------------------------
      // CANCEL — the goods are not coming
      // -------------------------------------------------------------
      // A transfer that never arrives had no ending at all: IN TRANSIT for ever, the sending
      // branch's stock deducted, and neither branch able to count the difference. The table has
      // always allowed CANCELLED and nothing could write it.
      async function cancelTransfer() {
        const outstanding = U.round2(Number(summary.unitsSent || 0) - Number(summary.unitsReceived || 0));
        const reason = await ui.promptDialog({
          title: `Cancel ${t.reference || 'this transfer'}`,
          label: 'Why is it being cancelled?',
          hint: `${U.qty(outstanding)} unit(s) go back to ${t.from_branch_name || 'the sending branch'} and are sellable there again. The reason is recorded against the transfer and on the audit trail.`,
          placeholder: 'e.g. the truck broke down and the goods went back to the warehouse',
          multiline: true,
          required: true,
        });
        if (reason == null) return;
        try {
          const out = await SR.api.post(`/api/transfers/${encodeURIComponent(id)}/cancel`, { reason });
          ui.ok(out.message || 'Transfer cancelled.');
          await load();
        } catch (err) { ui.apiError(err); }
      }

      // -------------------------------------------------------------
      // BOOK IN
      // -------------------------------------------------------------
      function bookIn() {
        const form = ui.h('div', { class: 'stack' });
        form.appendChild(ui.h('p', {}, isPartial
          ? 'This transfer arrived in part. Every line defaults to what is STILL OUTSTANDING — the balance between what was sent and what has already been booked in. Book in what arrived this time; the transfer closes when every line is complete.'
          : 'Count what actually arrived. Every line defaults to "all of it" — change the ones that arrived short, because the difference is recorded against the line and cannot be added later.'));

        const table = ui.h('div', { class: 'table-wrap' });
        const tbl = ui.h('table', { class: 'data' });
        const thead = ui.h('thead', {}, ui.h('tr', {},
          ui.h('th', {}, 'Product'), ui.h('th', { style: { textAlign: 'right' } }, 'Sent'),
          ui.h('th', { style: { textAlign: 'right' } }, 'Already in'),
          ui.h('th', { style: { textAlign: 'right' } }, 'Arrived now'), ui.h('th', {}, 'If short, what happened')));
        tbl.appendChild(thead);
        const tbody = ui.h('tbody', {});

        for (const it of items) {
          const alreadyOn = Number(it.quantity_received || 0);
          const due = outstandingOf(it);
          const qtyInput = ui.h('input', {
            type: 'number', step: '0.0001', min: '0', max: String(due),
            value: received.get(String(it.id)),
            style: { width: '110px', textAlign: 'right' },
          });
          const noteInput = ui.h('input', { type: 'text', placeholder: 'e.g. one carton damaged in transit' });
          // The note is what turns a shortfall into an explanation, so it is kept
          // as it is typed — a note the browser only remembers on blur would be
          // lost by anyone who hits Book in with the box still focused.
          noteInput.addEventListener('input', () => { notes.set(String(it.id), noteInput.value.trim()); });
          qtyInput.addEventListener('input', () => {
            received.set(String(it.id), qtyInput.value);
            const short = Number(qtyInput.value) < outstandingOf(it);
            noteInput.disabled = !short;
            if (!short) notes.delete(String(it.id));
            paintTotals();
          });
          noteInput.disabled = Number(received.get(String(it.id))) >= outstandingOf(it);

          tbody.appendChild(ui.h('tr', {},
            ui.h('td', {}, ui.h('div', { style: { fontWeight: '600' } }, it.product_name || '—'), ui.h('div', { class: 'hint' }, it.batch_no ? `batch ${it.batch_no}` : '')),
            ui.h('td', { style: { textAlign: 'right' } }, U.qty(it.quantity_sent_base)),
            ui.h('td', { style: { textAlign: 'right' } }, alreadyOn ? U.qty(alreadyOn) : ui.h('span', { class: 'hint' }, '—')),
            ui.h('td', { style: { textAlign: 'right' } }, qtyInput),
            ui.h('td', {}, noteInput)));
        }
        tbl.appendChild(tbody);
        table.appendChild(tbl);
        form.appendChild(table);

        const totals = ui.h('div', { class: 'kpi-grid' });
        function paintTotals() {
          let due = 0; let got = 0; let shortLines = 0;
          for (const it of items) {
            const line = outstandingOf(it);
            due += line;
            const r = Number(received.get(String(it.id)));
            got += Number.isFinite(r) ? r : 0;
            if (Number.isFinite(r) && r < line) shortLines += 1;
          }
          totals.replaceChildren(
            ui.kpi({ label: isPartial ? 'Outstanding' : 'Sent', value: U.qty(due) }),
            ui.kpi({ label: 'Arrived now', value: U.qty(got) }),
            ui.kpi({ label: 'Still short', value: U.qty(U.round2(due - got)), tone: shortLines ? 'bad' : null, foot: shortLines ? `${shortLines} line(s) short` : 'nothing missing' }));
        }
        paintTotals();
        form.appendChild(totals);

        const modal = ui.openModal({
          title: `Book in ${t.reference || 'this transfer'}`,
          body: form,
          size: 'wide',
          footer: [
            ui.h('button', { class: 'btn', onClick: () => modal.close() }, 'Cancel'),
            ui.h('button', {
              class: 'btn btn-primary',
              onClick: () => ui.withBusy(form, async () => {
                const payload = [];
                for (const it of items) {
                  const raw = received.get(String(it.id));
                  const qty = Number(raw);
                  if (!Number.isFinite(qty) || qty < 0) { ui.warn(`"${raw}" is not a quantity.`); return; }
                  const due = outstandingOf(it);
                  if (qty > due) {
                    ui.warn(`${it.product_name}: ${U.qty(qty)} cannot be booked in — only ${U.qty(due)} is still outstanding on that line${Number(it.quantity_received || 0) ? ` (${U.qty(it.quantity_received)} of the ${U.qty(it.quantity_sent_base)} was booked in earlier)` : ''}. Extra goods belong on a separate transfer so the difference is visible.`);
                    return;
                  }
                  payload.push({ item_id: it.id, quantity_received_base: qty, note: qty < due ? (notes.get(String(it.id)) || null) : null });
                }
                try {
                  const out = await SR.api.post(`/api/transfers/${encodeURIComponent(id)}/receive`, { items: payload });
                  modal.close();
                  // THE ANSWER SAYS WHICH STATE THE TRANSFER IS IN NOW, and the screen uses it
                  // rather than assuming: a short booking leaves it open for the balance, and
                  // saying "received" over a transfer that is still coming would be wrong in the
                  // one place it matters most — the message the person at the gate reads.
                  if (out.status === 'PARTIALLY_RECEIVED') ui.warn(out.message || 'Part of the transfer is booked in; the balance is still outstanding.');
                  else ui.ok(out.message || 'Transfer received.');
                  await load();
                } catch (err) { ui.apiError(err); }
              }),
            }, 'Book in'),
          ],
          onOpen: () => { /* the totals repaint on every keystroke */ },
        });
      }
    }

    function notesCell(t) { return Boolean(t.notes); }

    await load();
    return wrap;
  }

  SR.views.transfers = { render };
}(window));
