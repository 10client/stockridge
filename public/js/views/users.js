'use strict';
// =====================================================================
// public/js/views/users.js — THE PEOPLE, AND WHAT THEY MAY DO
// =====================================================================
// A user row is not just a login. It carries four things that decide what the
// system will let somebody do:
//
//   ROLE     — what they may open. MANAGER is a single stored role; the branch a
//              person belongs to is what scopes them, not a role per shop.
//   BRANCH   — WHERE their numbers come from. This is the only scoping truth.
//   COMMISSION — what they earn, calculated on NET revenue so staff are never
//              paid out of VAT that was never the business's money.
//   PIN      — the credential. It is hashed, never readable, and only ever shown
//              once, at the moment it is issued.
//
// Two decisions worth stating because they surprise people:
//
//   * Nobody can change their own role, branch or active flag here. Self-service
//     privilege changes are how an "innocent" edit becomes a different person.
//   * Deactivating somebody with an open till is refused unless forced, because
//     a closed drawer that nobody counted is a shortage with no owner.
// =====================================================================
(function (global) {
  const SR = global.SR;
  const ui = SR.ui;
  const U = SR.util;

  const ROLE_LABELS = [
    { value: 'STAFF', label: 'Staff — sell, take payment, clock in' },
    { value: 'MANAGER', label: 'Manager — everything at their branch' },
    { value: 'OWNER', label: 'Owner — every branch, the books, the settings' },
    { value: 'ADMIN', label: 'Administrator — the deployment itself' },
  ];
  // WHAT THIS PERSON MAY HAND OUT, not what exists. `SR.state.canCreateRole` mirrors
  // `canManageUser(actor, { role })` on the route, so an owner is no longer offered "Owner"
  // (refused: "You are a Owner and cannot create a Owner"), and a manager is offered Staff only.
  const ROLES = ROLE_LABELS;
  /** The roles THIS person may hand out — the create form and the role filter use these. */
  const creatableRoles = () => ROLE_LABELS.filter((r) => SR.state.canCreateRole(r.value));

  async function render(ctx) {
    ctx.setTitle('Staff');
    const state = {
      q: '', role: '', branch: ctx.query.branch_id || '', active: '1',
      page: 0, pageSize: 50,
      tab: ctx.query.tab || 'team',
    };

    const wrap = ui.h('div', { class: 'stack' });
    wrap.appendChild(ui.h('div', { class: 'page-head' },
      ui.h('div', {},
        ui.h('h1', {}, 'Staff & access'),
        ui.h('p', { class: 'sub' }, 'Who works here, where, and what the system lets them do')),
      ui.h('div', { class: 'actions' },
        SR.state.atLeast('MANAGER') ? ui.h('button', { class: 'btn btn-sm btn-primary', onClick: () => openCreate() }, 'Add someone') : null,
        SR.state.atLeast('MANAGER') ? ui.h('button', { class: 'btn btn-sm', onClick: () => openCoverage() }, 'Who was here on…') : null,
        ui.h('button', { class: 'btn btn-sm', onClick: () => exportList() }, 'Export'))));

    const tabs = ui.h('div', { class: 'tabs' });
    for (const [key, label] of [['team', 'The team'], ['transfers', 'Transfers'], ['sessions', 'Signed in now']]) {
      tabs.appendChild(ui.h('button', {
        class: `tab ${state.tab === key ? 'is-active' : ''}`,
        onClick: (ev) => {
          state.tab = key;
          for (const b of ev.currentTarget.parentElement.children) b.classList.remove('is-active');
          ev.currentTarget.classList.add('is-active');
          load();
        },
      }, label));
    }
    wrap.appendChild(tabs);

    const toolbar = ui.h('div', { class: 'card' }, ui.h('div', { class: 'card-body row' }));
    const search = ui.h('input', { type: 'search', placeholder: 'Name, username or phone', value: state.q, style: { maxWidth: '260px' } });
    search.addEventListener('input', ui.debounceInput(search, (v) => { state.q = v; state.page = 0; load(); }, 300));
    const roleSel = ui.h('select', { onchange: (e) => { state.role = e.target.value; state.page = 0; load(); } });
    roleSel.appendChild(ui.h('option', { value: '' }, 'Any role'));
    for (const r of ROLES) roleSel.appendChild(ui.h('option', { value: r.value, selected: r.value === state.role }, U.titleCase(r.value)));
    const branchSel = ui.h('select', { onchange: (e) => { state.branch = e.target.value; state.page = 0; load(); } });
    branchSel.appendChild(ui.h('option', { value: '' }, 'Any branch'));
    for (const b of SR.state.branches()) branchSel.appendChild(ui.h('option', { value: b.id, selected: String(b.id) === String(state.branch) }, b.name));
    const activeSel = ui.h('select', { onchange: (e) => { state.active = e.target.value; state.page = 0; load(); } });
    for (const [v, l] of [['1', 'Active'], ['0', 'Deactivated'], ['', 'Everyone']]) {
      activeSel.appendChild(ui.h('option', { value: v, selected: v === state.active }, l));
    }
    toolbar.firstElementChild.appendChild(ui.h('div', {}, ui.h('label', { class: 'ctl' }, 'Search'), search));
    toolbar.firstElementChild.appendChild(ui.h('div', {}, ui.h('label', { class: 'ctl' }, 'Role'), roleSel));
    toolbar.firstElementChild.appendChild(ui.h('div', {}, ui.h('label', { class: 'ctl' }, 'Branch'), branchSel));
    toolbar.firstElementChild.appendChild(ui.h('div', {}, ui.h('label', { class: 'ctl' }, 'Status'), activeSel));
    wrap.appendChild(toolbar);

    const host = ui.h('div', {});
    wrap.appendChild(host);

    async function load() {
      host.replaceChildren(ui.skeleton(7));
      try {
        if (state.tab === 'sessions') return renderSessions(await SR.api.get('/api/sessions', { query: SR.state.query({}) }));
        if (state.tab === 'transfers') return renderTransfers();
        renderTeam(await SR.api.get('/api/users', {
          query: SR.state.query({
            q: state.q || undefined,
            role: state.role || undefined,
            branch_id: state.branch || undefined,
            active: state.active === '' ? undefined : state.active,
            limit: state.pageSize, offset: state.page * state.pageSize,
          }),
        }));
      } catch (err) {
        if (err.isOffline) {
          const all = await SR.store.all('users', { where: (u) => !Number(u.is_deleted) });
          renderTeam({ data: all, paging: { total: all.length }, _offline: true });
          return;
        }
        host.replaceChildren(ui.errorBlock(err, { retry: { label: 'Try again', run: load } }));
      }
    }

    // ---------------------------------------------------------------- team
    function renderTeam(data) {
      const rows = data.data || data.records || [];
      const total = (data.paging && data.paging.total != null) ? data.paging.total : rows.length;
      const stack = ui.h('div', { class: 'stack' });
      if (data._offline) {
        stack.appendChild(ui.h('div', { class: 'alert alert-warn' },
          'Offline — this is the staff list mirrored on this device. Roles follow each person to whichever device they sign in on, so this copy can be out of date.'));
      }

      const byRole = {};
      for (const u of rows) byRole[u.role] = (byRole[u.role] || 0) + 1;
      stack.appendChild(ui.h('div', { class: 'kpis' },
        ui.kpi({ label: 'People', value: U.qty(total) }),
        ...['STAFF', 'MANAGER', 'OWNER', 'ADMIN'].filter((r) => byRole[r]).map((r) => ui.kpi({ label: U.titleCase(r), value: U.qty(byRole[r]) }))));

      stack.appendChild(ui.dataCard({
        title: 'The team',
        table: ui.renderTable({
          columns: [
            {
              key: 'full_name',
              label: 'Name',
              render: (u) => ui.h('div', {},
                ui.h('div', {}, u.full_name || u.username),
                ui.h('div', { class: 'hint' }, [u.username ? `@${u.username}` : null, u.phone].filter(Boolean).join(' · '))),
            },
            { key: 'role', label: 'Role', render: (u) => ui.badge(u.roleLabel ? U.titleCase(u.roleLabel) : U.titleCase(u.role), u.role === 'STAFF' ? 'badge-mute' : 'badge-info') },
            { key: 'job_title', label: 'Job', render: (u) => u.job_title || '—' },
            { key: 'branch_name', label: 'Branch', render: (u) => u.branch_name || (u.role === 'OWNER' || u.role === 'ADMIN' ? ui.badge('all branches', 'badge-violet') : '—') },
            { key: 'revenue_30d', label: 'Sold (30d)', align: 'right', render: (u) => (Number(u.revenue_30d) ? U.money(u.revenue_30d) : '—') },
            { key: 'commission_rate_pct', label: 'Commission', align: 'right', render: (u) => (Number(u.commission_rate_pct) ? `${u.commission_rate_pct}%` : '—') },
            { key: 'last_login_at', label: 'Last seen', render: (u) => (u.last_login_at ? U.relTime(u.last_login_at) : 'never') },
            { key: 'is_active', label: 'Status', render: (u) => (Number(u.is_active) ? ui.badge('active', 'badge-good') : ui.badge('deactivated', 'badge-mute')) },
          ],
          rows,
          onRowClick: (u) => openEdit(u),
          emptyTitle: 'Nobody matches',
          emptyMessage: state.q ? 'Try part of a name or a phone number.' : 'Add the people who work here so their sales, their till and their clock-ins have somewhere to land.',
        }),
        actions: [SR.state.atLeast('MANAGER') ? ui.h('button', { class: 'btn btn-sm btn-primary', onClick: () => openCreate() }, 'Add someone') : null].filter(Boolean),
        pager: total > state.pageSize ? ui.pager({
          page: state.page, pageSize: state.pageSize, total,
          onPage: (p) => { state.page = p; load(); },
          onSize: (s) => { state.pageSize = s; state.page = 0; load(); },
        }) : null,
      }));
      host.replaceChildren(stack);
    }

    // ----------------------------------------------------------- transfers
    /**
     * WHAT IS WAITING FOR A DECISION.
     *
     * Two lists, and they answer different questions. The first is what THIS person
     * has been asked to decide — a manager answers for their own branch, and the person
     * arriving is the one they will be accountable for. The second is what concerns
     * them personally: a move they asked for, or a move somebody has asked for them,
     * which is exactly what a cashier needs to see when a transfer is described to them
     * as already arranged.
     *
     * ACCEPT AND REFUSE ARE BOTH HERE, side by side and plainly labelled, because a
     * screen that only offers "accept" is a screen that turns a decision into a
     * notification.
     */
    async function renderTransfers() {
      const stack = ui.h('div', { class: 'stack' });
      stack.appendChild(ui.h('div', { class: 'alert alert-info' },
        'A move between branches is a question first: the person keeps working where they are until somebody at the branch receiving them agrees. Nobody can be moved into a shop that has not agreed to take them.'));
      let waiting = { data: [] };
      let mine = { data: [] };
      try {
        if (SR.state.atLeast('MANAGER')) waiting = await SR.api.get('/api/users/transfers/pending', { query: SR.state.query({ limit: 100 }) });
        mine = await SR.api.get('/api/users/transfers/pending/mine');
      } catch (err) {
        stack.appendChild(ui.errorBlock(err, { retry: { label: 'Try again', run: load } }));
        host.replaceChildren(stack);
        return;
      }
      const rows = waiting.data || [];
      stack.appendChild(ui.dataCard({
        title: SR.state.atLeast('MANAGER') ? `${rows.length} waiting for your decision` : 'Waiting for a decision',
        table: ui.renderTable({
          columns: [
            { key: 'full_name', label: 'Who', render: (r) => ui.h('div', {},
                ui.h('div', {}, r.full_name || r.username),
                ui.h('div', { class: 'hint' }, [r.username ? `@${r.username}` : null, U.titleCase(r.role)].filter(Boolean).join(' · '))) },
            { key: 'from_branch_name', label: 'From', render: (r) => r.from_branch_name || '—' },
            { key: 'to_branch_name', label: 'To', render: (r) => ui.h('strong', {}, r.to_branch_name) },
            { key: 'requested_by_name', label: 'Asked by', render: (r) => r.requested_by_name || '—' },
            { key: 'requested_at', label: 'Asked', render: (r) => U.relTime(r.requested_at) },
            { key: 'reason', label: 'Why', render: (r) => ui.h('span', { class: 'hint' }, r.reason || '—') },
            // THE DECISION IS A COLUMN, not a hover menu: these buttons are the whole
            // point of the screen, and a decision buried behind a row click is one
            // nobody finds.
            { key: 'act', label: '', render: (r) => ui.h('div', { class: 'btn-row' },
                ui.h('button', { class: 'btn btn-sm btn-primary', onClick: (ev) => decide(ev, r, 'accept') }, 'Accept'),
                ui.h('button', { class: 'btn btn-sm', onClick: (ev) => decide(ev, r, 'reject') }, 'Refuse')) },
          ],
          rows,
          emptyTitle: 'Nothing is waiting',
          emptyMessage: 'When somebody asks to move a member of staff into your branch, it appears here for you to accept or refuse.',
        }),
      }));
      const mineRows = mine.data || [];
      if (mineRows.length) {
        stack.appendChild(ui.dataCard({
          title: 'Involving you',
          table: ui.renderTable({
            columns: [
              { key: 'full_name', label: 'Person', render: (r) => r.full_name || r.username },
              { key: 'from_branch_name', label: 'From', render: (r) => r.from_branch_name || '—' },
              { key: 'to_branch_name', label: 'To', render: (r) => r.to_branch_name || '—' },
              { key: 'requested_by_name', label: 'Asked by', render: (r) => r.requested_by_name || '—' },
              { key: 'status', label: 'State', render: () => ui.badge('waiting', 'badge-warn') },
              { key: 'act', label: '', render: (r) => ui.h('button', { class: 'btn btn-sm', onClick: () => withdraw(r) }, 'Withdraw') },
            ],
            rows: mineRows,
            emptyTitle: '',
          }),
        }));
      }
      host.replaceChildren(stack);
    }

    /** Answer a transfer. A refusal may carry a reason, and the reason is kept. */
    async function decide(ev, row, what) {
      const btn = ev && ev.currentTarget ? ev.currentTarget : null;
      const label = what === 'accept' ? 'Accept' : 'Refuse';
      if (what === 'accept') {
        const ok = await ui.confirmDialog({
          danger: false,
          title: `Accept ${row.full_name || row.username}?`,
          // Said in full, because accepting is the moment a person's scope changes.
          message: `${row.full_name || row.username} will start working at ${row.to_branch_name} and will be able to see its sales, its stock and its cash. Their record of where they have worked keeps the date and your name against this decision.`,
          confirmLabel: 'Accept the move',
        });
        if (!ok) return;
      }
      let reason = null;
      if (what === 'reject') {
        // READ WITHOUT `required`, AND THAT IS THE DESIGN: refusing a transfer is
        // allowed to be brief, and the placeholder says what would be useful rather
        // than what is mandatory. `null` means the dialog was cancelled.
        reason = await ui.promptDialog({
          title: `Refuse the move to ${row.to_branch_name}?`,
          label: `Why is this being refused? (optional — ${row.full_name || row.username} stays at ${row.from_branch_name || 'their branch'})`,
          placeholder: 'We have no counter free for another cashier this quarter.',
          hint: 'Kept on the record. It is what the owner reads the next time this is asked.',
          multiline: true,
        });
        if (reason === null) return; // cancelled
      }
      // THE PATH IS WRITTEN OUT, one literal per action, so the frontend-contract test
      // can see which endpoint this calls. Building it as `.../${what}` hid the two real
      // paths behind a variable and the checker reported a route that does not exist —
      // which is exactly what it is for, and the fix is to spell them.
      const url = what === 'accept'
        ? `/api/users/transfers/${encodeURIComponent(row.id)}/accept`
        : `/api/users/transfers/${encodeURIComponent(row.id)}/reject`;
      if (btn) btn.disabled = true;
      try {
        const res = await SR.api.post(url, reason ? { reason } : {});
        ui.ok(res.message || `${label}ed.`);
        load();
      } catch (err) {
        ui.apiError(err);
        if (btn) btn.disabled = false;
      }
    }

    /** Withdraw a question that concerns me. */
    async function withdraw(row) {
      const ok = await ui.confirmDialog({
        title: 'Withdraw this request?',
        message: `Nobody will be asked to decide, and ${row.full_name || row.username} stays at ${row.from_branch_name || 'their branch'}.`,
        confirmLabel: 'Withdraw',
      });
      if (!ok) return;
      try {
        const res = await SR.api.post(`/api/users/transfers/${encodeURIComponent(row.id)}/cancel`, {});
        ui.ok(res.message || 'Withdrawn.');
        load();
      } catch (err) { ui.apiError(err); }
    }

    // ------------------------------------------------------ move & history
    /**
     * ASK FOR A MOVE FROM HERE, so the person who knows the reason is the person who
     * types it. The screen says plainly that this does not move anybody yet — an owner
     * who believes they have moved a cashier is worse off than one who knows they have
     * asked.
     */
    function openMove(u) {
      const branchSel = ui.h('select', {}, SR.state.branches()
        .filter((b) => String(b.id) !== String(u.branch_id || ''))
        .map((b) => ui.h('option', { value: b.id }, b.name)));
      const reason = ui.h('input', { type: 'text', placeholder: 'Why are they moving? (optional, kept on the record)', autocomplete: 'off' });
      const body = ui.h('div', { class: 'stack' });
      body.appendChild(ui.h('p', {}, `${u.full_name || u.username} works at ${u.branch_name || 'no branch'} now.`));
      if (!branchSel.options.length) {
        body.appendChild(ui.h('div', { class: 'alert alert-warn' }, 'There is no other branch to move them to. Open a branch first.'));
        const m = ui.openModal({ title: 'Move to another branch', body, size: 'narrow' });
        body.appendChild(ui.h('div', { class: 'btn-row' }, ui.h('button', { class: 'btn', onClick: () => m.close() }, 'Close')));
        return;
      }
      body.appendChild(ui.h('label', { class: 'ctl' }, 'Move to'));
      body.appendChild(branchSel);
      body.appendChild(ui.h('label', { class: 'ctl' }, 'Why (optional)'));
      body.appendChild(reason);
      const go = ui.h('button', { class: 'btn btn-primary', onClick: async () => {
        go.disabled = true;
        try {
          const res = await SR.api.post(`/api/users/${encodeURIComponent(u.id)}/transfer`, {
            to_branch_id: branchSel.value,
            reason: String(reason.value || '').trim() || undefined,
          });
          ui.ok(res.message || 'Asked.');
          m.close();
          load();
        } catch (err) {
          ui.apiError(err);
          go.disabled = false;
        }
      } }, 'Ask for the move');
      const m = ui.openModal({
        title: 'Move to another branch',
        body,
        footer: [ui.h('button', { class: 'btn', onClick: () => m.close() }, 'Cancel'), go],
        size: 'narrow',
      });
    }

    /** "Who could see the Minna till on 14 March?" — asked after something has gone missing. */
    function openCoverage() {
      const branchSel = ui.h('select', {}, SR.state.branches().map((b) => ui.h('option', { value: b.id }, b.name)));
      const date = ui.h('input', { type: 'date', value: new Date().toISOString().slice(0, 10) });
      const out = ui.h('div', {});
      const body = ui.h('div', { class: 'stack' },
        ui.h('p', { class: 'sub' }, 'Read from the assignment history, so a person who has since moved or been deactivated is still listed for the days they were actually here.'),
        ui.h('div', { class: 'row' }, branchSel, date,
          ui.h('button', { class: 'btn btn-primary', onClick: async (ev) => {
            ev.currentTarget.disabled = true;
            out.replaceChildren(ui.loading('Reading the history…'));
            try {
              const res = await SR.api.get('/api/assignment-history', { query: { branch_id: branchSel.value, at: date.value } });
              const rows = res.data || [];
              out.replaceChildren(rows.length
                ? ui.renderTable({
                    columns: [
                      { key: 'full_name', label: 'Who', render: (r) => ui.h('div', {},
                          ui.h('div', {}, r.full_name || r.username),
                          ui.h('div', { class: 'hint' }, `@${r.username}`)) },
                      { key: 'role', label: 'Role', render: (r) => U.titleCase(r.role) },
                      { key: 'is_active', label: 'Now', render: (r) => (Number(r.is_active) ? ui.badge('still here', 'badge-good') : ui.badge('deactivated since', 'badge-mute')) },
                    ],
                    rows,
                  })
                : ui.empty({ title: 'Nobody', message: `No assignment history places anybody at ${branchSel.options[branchSel.selectedIndex].text} on ${date.value}.` }));
            } catch (err) {
              out.replaceChildren(ui.h('div', { class: 'alert alert-warn' }, (err && err.message) || 'That could not be read.'));
            } finally { ev.currentTarget.disabled = false; }
          } }, 'Who was here?')),
        out);
      ui.openModal({ title: 'Who could see this branch on that day?', body, size: 'wide' });
    }

    /** One person's assignments, newest first. */
    function openHistory(u) {
      const out = ui.h('div', {}, ui.loading('Reading their history…'));
      const body = ui.h('div', { class: 'stack' },
        ui.h('p', { class: 'sub' }, `Every move and the moment the record for ${u.full_name || u.username} was created.`), out);
      const m = ui.openModal({ title: 'Where they have worked', body, size: 'wide' });
      SR.api.get(`/api/users/${encodeURIComponent(u.id)}/assignment-history`).then((res) => {
        const rows = res.data || [];
        out.replaceChildren(rows.length
          ? ui.renderTable({
              columns: [
                { key: 'changed_at', label: 'When', render: (r) => U.date(r.changed_at) },
                { key: 'from_branch_name', label: 'From', render: (r) => r.from_branch_name || '—' },
                { key: 'to_branch_name', label: 'To', render: (r) => r.to_branch_name || '—' },
                { key: 'reason', label: 'Why', render: (r) => ui.h('span', { class: 'hint' }, r.reason || '—') },
                { key: 'changed_by_name', label: 'Decided by', render: (r) => r.changed_by_name || '—' },
              ],
              rows,
            })
          : ui.empty({ title: 'No history', message: 'This account has no recorded assignment, which should only be true of a user created before this feature existed.' }));
        if (res.pending) {
          out.appendChild(ui.h('div', { class: 'alert alert-info', style: { marginTop: '10px' } },
            `A move to ${res.pending.to_branch_name} is waiting for somebody there to agree to it. Until then they stay where they are.`));
        }
      }).catch((err) => { out.replaceChildren(ui.h('div', { class: 'alert alert-warn' }, (err && err.message) || 'That could not be read.')); });
      return m;
    }

    // ------------------------------------------------------------ sessions
    function renderSessions(data) {
      const rows = data.data || [];
      host.replaceChildren(ui.h('div', { class: 'stack' },
        ui.h('div', { class: 'alert alert-info' },
          'A session is a device holding a valid sign-in. Revoking one is how you remove access from a phone that has been lost, sold or borrowed — the token stops working immediately.'),
        ui.dataCard({
          title: `${rows.length} signed in`,
          // EVERY COLUMN READS A FIELD THE API ACTUALLY SENDS. This table used to show
          // `device_id`, `ip_address`, `created_at` and `expires_at`, and the route sends
          // `last_ip`, `issued_at` and computes `expires_at` — four columns out of six drawing
          // an em dash at every row. It is the same defect P13 fixed on the audit trail, found
          // the same way: by reading the screen against the query instead of against the idea
          // of the screen. `device_id` now really is a column too (migration 0008).
          table: ui.renderTable({
            columns: [
              { key: 'full_name', label: 'Who', render: (s) => s.full_name || s.username || '—' },
              { key: 'role', label: 'Role', render: (s) => U.titleCase(s.role) },
              { key: 'branch_name', label: 'Branch', render: (s) => s.branch_name || 'All branches' },
              { key: 'device_id', label: 'Device', render: (s) => s.device_id || '—' },
              { key: 'last_ip', label: 'From', render: (s) => s.last_ip || '—' },
              { key: 'issued_at', label: 'Signed in', render: (s) => U.relTime(s.issued_at) },
              { key: 'last_action_at', label: 'Last did something', render: (s) => (s.last_action_at ? U.relTime(s.last_action_at) : '—') },
              { key: 'expires_at', label: 'Ends on its own', render: (s) => (s.expires_at ? U.dateTime(s.expires_at) : '—') },
              {
                key: 'revoke',
                label: '',
                // THE SAME RULE THE ROUTE ENFORCES: yourself always, somebody below you if you
                // are a manager or above. The screen offered this only to owners, so a manager
                // with a cashier's lost phone in front of them could not end that session from
                // the till — the route allows it, the audit proves it, and the button was
                // hidden. `SR.state.canManageUser` mirrors `canManageUser` on the server.
                render: (s) => (SR.state.canManageUser(s)
                  ? ui.h('button', { class: 'btn btn-xs', onClick: (ev) => { ev.stopPropagation(); revoke(s); } }, 'Sign out')
                  : ''),
              },
            ],
            rows,
            emptyTitle: 'Nobody is signed in',
            emptyMessage: 'Sign-ins appear here as people log in from their devices.',
          }),
        })));
    }

    async function revoke(session) {
      // The dialog names the DEVICE when there is one and the ADDRESS when there is not, and it
      // says which of the two is happening: "cut off the phone" and "cut off whatever is coming
      // from 197.x.x.x" are different decisions with the same button.
      const where = session.device_id
        ? `the device “${session.device_id}”`
        : (session.last_ip ? `whatever is signed in from ${session.last_ip}` : 'that device');
      const mine = String(session.user_id) === String(SR.state.user && SR.state.user.id);
      const confirmed = await ui.confirmDialog({
        title: mine ? 'Sign yourself out here' : 'Sign this device out',
        message: mine
          ? 'End your own session? You will have to sign in again — on this device too.'
          : `End the session for ${session.full_name || session.username} on ${where}?`,
        confirmLabel: 'Sign out',
        danger: true,
        detail: mine
          ? 'The work you have already saved stays saved.'
          : 'Anything already saved stays saved. Anything half-entered on that device is lost. They can sign in again with their PIN.',
      });
      if (!confirmed) return;
      try {
        const res = await SR.api.post(`/api/sessions/${encodeURIComponent(session.user_id)}/revoke`, {});
        ui.ok(res.message || 'Signed out.');
        load();
      } catch (err) { ui.apiError(err); }
    }

    /**
     * HOW THIS PERSON SIGNS IN, AND WHAT HAS GONE WRONG DOING IT.
     *
     * Two reads and one write, all three of them previously unreachable from the app:
     * the lock state, the recent attempts, and the override. The override is the one worth
     * being careful with — it hands an attacker another eight guesses — so it asks for a
     * REASON, the reason is required by the route, and the whole act lands on the audit trail
     * with the state it overrode.
     */
    function signInSecurity(u) {
      const card = ui.h('div', { class: 'card' });
      const body = ui.h('div', { class: 'card-body' });
      body.appendChild(ui.h('h2', {}, 'Signing in'));
      body.appendChild(ui.h('p', { class: 'sub' }, 'Failed attempts, lockouts, and the device and address they came from.'));
      const host = ui.h('div', {});
      body.appendChild(host);
      card.appendChild(body);

      async function loadLock() {
        host.replaceChildren(ui.skeleton(3));
        let state;
        try {
          state = await SR.api.get('/api/auth/lock-state', { query: { username: u.username } });
        } catch (err) {
          host.replaceChildren(ui.errorBlock(err, { retry: { label: 'Try again', run: loadLock } }));
          return;
        }
        const fails = Number(state.failed_attempts || 0);
        const stack = ui.h('div', { class: 'stack' });
        stack.appendChild(ui.h('div', { class: state.is_locked ? 'alert alert-warn' : 'alert alert-info' },
          state.is_locked
            ? `Locked out after ${fails} failed attempt(s). The last was ${U.relTime(state.last_failed_at)}. They cannot sign in here — not even with the right PIN — until an owner clears it or the lockout expires on its own.`
            : `${fails} failed attempt(s) in the last quarter of an hour. A lockout happens after ${8} of them; the counter falls back to zero on a successful sign-in.`));

        // The override: owner only, as the route is, and only when there is something to clear.
        if (SR.state.atLeast('OWNER') && state.is_locked) {
          const clear = ui.h('button', { class: 'btn btn-sm btn-primary' }, 'Clear the lockout');
          clear.addEventListener('click', async () => {
            const reason = await ui.promptDialog({
              title: `Clear the lockout for ${u.full_name || u.username}`,
              label: 'Why is the lockout being cleared?',
              required: true,
              hint: 'This is on the audit trail with your name and the state you overrode. An override without a reason is one nobody can defend later.',
            });
            if (!reason) return;
            await ui.withBusy(clear, async () => {
              try {
                const res = await SR.api.post('/api/auth/unlock', { username: u.username, reason: String(reason) });
                ui.ok(res.message || 'Lockout cleared.');
                loadLock();
              } catch (err) { ui.apiError(err); }
            });
          });
          stack.appendChild(ui.h('div', { class: 'row' }, clear,
            ui.h('span', { class: 'hint' }, 'They sign in with their existing PIN — a lockout is not a PIN reset.')));
        } else if (SR.state.atLeast('OWNER')) {
          stack.appendChild(ui.h('div', { class: 'hint' }, 'Nothing to clear: this account is not locked out.'));
        } else {
          stack.appendChild(ui.h('div', { class: 'hint' }, 'Only the owner can clear a lockout. Ask them, or wait for it to expire.'));
        }

        // The attempts log is the owner's read, exactly as the route is.
        if (SR.state.atLeast('OWNER')) {
          const attempts = await SR.api.get('/api/auth/attempts', { query: { username: u.username, limit: 10 } }).catch(() => null);
          const rows = (attempts && attempts.data) || [];
          stack.appendChild(ui.dataCard({
            title: 'Recent sign-in attempts',
            table: ui.renderTable({
              // THE FIELDS THE ROUTE SENDS. `attempted_at`, `succeeded`, `ip_address`, `user_agent`.
              columns: [
                { key: 'attempted_at', label: 'When', render: (r) => U.relTime(r.attempted_at) },
                { key: 'succeeded', label: 'Result', render: (r) => (Number(r.succeeded) ? 'Signed in' : 'Wrong PIN') },
                { key: 'ip_address', label: 'From', render: (r) => r.ip_address || '—' },
                { key: 'user_agent', label: 'Device', render: (r) => String(r.user_agent || '—').slice(0, 60) },
              ],
              rows,
              emptyTitle: 'No attempts recorded',
              emptyMessage: 'Sign-ins and wrong PINs appear here as they happen.',
            }),
          }));
        }
        host.replaceChildren(stack);
      }

      loadLock();
      return card;
    }

    // -------------------------------------------------------------- create
    function openCreate() {
      const form = ui.h('div', {});
      const mine = (SR.state.branches() || []).find((b) => String(b.id) === String(SR.state.activeBranchId));
      const branchField = ui.field({
        label: 'Branch', name: 'branch_id', required: true,
        options: (mine ? [{ value: mine.id, label: `${mine.name} — where you work` }] : [])
          .concat(SR.state.branches().filter((b) => !mine || String(b.id) !== String(mine.id)).map((b) => ({ value: b.id, label: b.name }))),
        hint: 'A person only sees the figures for the branch they belong to. Owners and admins see everything.',
      });
      form.appendChild(ui.h('div', { class: 'form-grid' },
        ui.field({ label: 'Full name', name: 'full_name', required: true, placeholder: 'Chidinma Okafor' }),
        ui.field({ label: 'Username', name: 'username', required: true, hint: 'Lower case, no spaces. This is what they type on the sign-in screen.' }),
        ui.field({ label: 'Role', name: 'role', required: true, options: creatableRoles() }),
        // THE BRANCH FIELD FOLLOWS THE ROLE, because the ROUTE does: only the deployment
        // administrator may belong to no branch ("A user with no branch has no scope, so they
        // would see nothing") — while the blank option used to be labelled "owner or admin
        // only", so an owner adding a cashier and leaving it blank was refused after filling in
        // everything else. For every other role the field is required, defaults to the branch the
        // person creating them works at, and the blank option is not offered at all.
        branchField,
        ui.field({ label: 'Job title', name: 'job_title', placeholder: 'Sales assistant' }),
        ui.field({ label: 'Phone', name: 'phone', placeholder: '0803 000 0000' }),
        ui.field({ label: 'PIN', name: 'pin', type: 'password', required: true, hint: 'Digits only. They can change it after signing in.' }),
        ui.field({ label: 'Confirm PIN', name: 'confirm_pin', type: 'password', required: true }),
        ui.field({ label: 'Commission %', name: 'commission_rate_pct', type: 'number', step: '0.01', min: '0', max: '100', hint: 'Paid on NET revenue — the money the business actually earned.' }),
        ui.field({ label: 'Bank', name: 'bank_name', placeholder: 'GTBank' }),
        ui.field({ label: 'Account number', name: 'bank_account_no', placeholder: '0123456789' }),
        ui.field({ label: 'Employed since', name: 'employment_started', type: 'date' })));
      form.appendChild(ui.h('div', { class: 'hint' }, 'The PIN is stored hashed. Nobody — including you — can read it back. If it is forgotten, issue a new one.'));

      const cancel = ui.h('button', { class: 'btn', onClick: () => m.close() }, 'Cancel');
      const go = ui.h('button', { class: 'btn btn-primary' }, 'Add them');
      const m = ui.openModal({ title: 'Add someone to the team', body: form, footer: [cancel, go], size: 'wide' });

      // THE BRANCH FIELD FOLLOWS THE ROLE AS IT IS CHOSEN — the same rule the route applies, so
      // the form cannot offer a combination the API will refuse.
      const roleSel = form.querySelector('[name="role"]');
      function syncBranchField() {
        const role = roleSel ? String(roleSel.value || '') : '';
        const needs = SR.state.roleNeedsBranch(role);
        const sel = branchField.querySelector('select');
        if (!sel) return;
        const hadBlank = [...sel.options].some((o) => o.value === '');
        if (needs && hadBlank) {
          for (const o of [...sel.options]) if (o.value === '') o.remove();
          sel.value = branchField.dataset.defaultBranch || sel.options[0] && sel.options[0].value || '';
        } else if (!needs && !hadBlank) {
          const opt = document.createElement('option');
          opt.value = ''; opt.textContent = 'No branch — administrators are not pinned to one';
          sel.insertBefore(opt, sel.firstChild);
          sel.value = '';
        }
        const label = branchField.querySelector('.ctl');
        if (label) label.textContent = needs ? 'Branch' : 'Branch (not needed for an administrator)';
      }
      branchField.dataset.defaultBranch = (mine && mine.id) || ((SR.state.branches() || [])[0] || {}).id || '';
      if (roleSel) { roleSel.addEventListener('change', syncBranchField); syncBranchField(); }

      go.addEventListener('click', async () => {
        const v = ui.readForm(form);
        if (!v.pin || String(v.pin) !== String(v.confirm_pin)) { ui.warn('The two PINs must match.'); return; }
        // REFUSED HERE, IN THE ROUTE'S OWN SENTENCE, rather than after a round trip — and with
        // the field marked so the person can see what is missing.
        if (SR.state.roleNeedsBranch(v.role) && !v.branch_id) {
          ui.warn('Choose the branch they work at. A user with no branch has no scope, so they would see nothing — only the deployment administrator can belong to no branch.');
          return;
        }
        await ui.withBusy(form, async () => {
          try {
            const res = await SR.api.post('/api/users', {
              full_name: v.full_name,
              username: v.username,
              role: v.role,
              branch_id: v.branch_id || null,
              job_title: v.job_title || undefined,
              phone: v.phone || undefined,
              pin: String(v.pin),
              confirm_pin: String(v.confirm_pin),
              commission_rate_pct: v.commission_rate_pct === null ? undefined : Number(v.commission_rate_pct),
              bank_name: v.bank_name || undefined,
              bank_account_no: v.bank_account_no || undefined,
              employment_started: v.employment_started || undefined,
            });
            m.close();
            ui.ok(res.message || `${v.full_name} can now sign in as ${v.username}.`);
            load();
          } catch (err) { ui.apiError(err); }
        });
      });
    }

    // ---------------------------------------------------------------- edit

    /**
     * WHICH BUSINESSES THIS PERSON CAN REACH.
     *
     * A group running two businesses — a furniture showroom and an appliance shop,
     * or a retail counter and its wholesale arm — needs one manager to run both.
     * Until now the only way was a second account with a second PIN, after which
     * the audit trail shows two people where there is one.
     *
     * Shown to the deployment administrator only, because a grant reaches ACROSS
     * businesses and a business is a separate legal entity with its own books.
     * Each toggle saves on its own, immediately: a checkbox that needs a separate
     * "save" is how somebody ticks a box, closes the modal, and believes they gave
     * somebody access they did not.
     */
    function accessSection(u) {
      const wrap = ui.h('fieldset', {});
      wrap.appendChild(ui.h('legend', {}, 'Businesses this person can reach'));
      const body = ui.h('div', { class: 'stack' });
      wrap.appendChild(body);
      body.appendChild(ui.loading('Checking…'));

      async function loadAccess() {
        let data;
        try {
          data = await SR.api.get(`/api/users/${encodeURIComponent(u.id)}/business-access`);
        } catch (err) {
          body.replaceChildren(ui.h('div', { class: 'alert alert-warn' },
            'Could not read the businesses this person can reach. ' + ((err && err.message) || '')));
          return;
        }
        const rows = data.data || [];
        const reached = rows.filter((b) => b.own || b.viaGrant || data.reachesEverything).length;
        const list = ui.h('div', { class: 'stack' });

        // WHY the switches are locked, in the words of the case that applies. The
        // server answers with the reason (`reachesEverythingBy`) rather than the
        // screen inferring it from the role, because "reaches everything" has
        // three causes and an owner is the one that surprises people.
        const byRole = data.reachesEverythingBy;
        const whyLocked = byRole === 'ROLE:ADMIN'
          ? `${u.full_name || u.username} is the deployment administrator and reaches every business here by virtue of that role. There is nothing to grant or withdraw.`
          : byRole === 'ROLE:OWNER'
            ? `${u.full_name || u.username} is an owner, and an owner reaches every business in this deployment. There is nothing to grant or withdraw.`
            : byRole === 'NO_BUSINESS_PINNED'
              ? `${u.full_name || u.username} is not tied to any one business, so every business already reaches them. Put them on a business to confine their view to it.`
              : null;

        list.appendChild(ui.h('p', { class: 'hint' },
          whyLocked
            || `Reaching ${reached} of ${rows.length}. Their own business is theirs by being on their record; the others are grants. A grant widens what they can SEE, never what they may DO — the role above still decides that.`));

        for (const b of rows) {
          const locked = data.reachesEverything || b.own;
          const box = ui.h('input', { type: 'checkbox', checked: b.own || b.viaGrant || data.reachesEverything, disabled: locked });
          const line = ui.h('div', { class: 'hint' },
            b.own ? 'Their own business — not a grant, and not something to switch off here.'
              : byRole ? (byRole === 'NO_BUSINESS_PINNED' ? 'Reached — nothing pins them to one business.' : 'Reached by role.')
                : b.viaGrant && b.grantedAt ? `Granted ${U.date(b.grantedAt)}.` : 'No access yet.');
          const rowEl = ui.h('label', { class: 'check', style: { marginBottom: '6px', alignItems: 'flex-start' } },
            box,
            ui.h('div', {},
              ui.h('strong', {}, b.name),
              ui.h('div', { class: 'hint' }, [U.titleCase(String(b.profile_code || '').replace(/_/g, ' ')), Number(b.is_active) ? null : 'inactive'].filter(Boolean).join(' · ')),
              line));

          if (!locked) {
            box.addEventListener('change', async () => {
              const wanted = box.checked;
              box.disabled = true;
              try {
                // `SR.api.post(path, payload)` — the payload is the SECOND argument.
                // Passing `{ body: { … } }` sent an object with no `business_id` in
                // it, and the server answered "business id is required" — a message
                // about the field rather than about the mistake.
                const res = wanted
                  ? await SR.api.post(`/api/users/${encodeURIComponent(u.id)}/business-access`, { business_id: b.id })
                  : await SR.api.del(`/api/users/${encodeURIComponent(u.id)}/business-access/${encodeURIComponent(b.id)}`);
                ui.ok(res.message || 'Saved.');
                await loadAccess();
              } catch (err) {
                box.checked = !wanted;
                box.disabled = false;
                ui.error(err && err.isOffline
                  ? 'Changing who can reach a business needs a line.'
                  : (err && err.message) || 'Could not save that.');
              }
            });
          }
          list.appendChild(rowEl);
        }
        body.replaceChildren(list);
      }

      loadAccess();
      return wrap;
    }

    function openEdit(u) {
      const self = String(u.id) === String(SR.state.user.id);
      const form = ui.h('div', {});
      form.appendChild(ui.kv([
        ['Username', `@${u.username}`],
        ['Role', U.titleCase(u.roleLabel || u.role)],
        ['Branch', u.branch_name || 'Every branch'],
        ['Role grants', (u.navigation || []).map((n) => U.titleCase(n)).join(', ') || '—'],
      ]));
      form.appendChild(ui.h('div', { class: 'form-grid' },
        ui.field({ label: 'Full name', name: 'full_name', value: u.full_name || '', required: true }),
        ui.field({ label: 'Job title', name: 'job_title', value: u.job_title || '' }),
        ui.field({ label: 'Phone', name: 'phone', value: u.phone || '' }),
        ui.field({ label: 'Email', name: 'email', value: u.email || '' }),
        ui.field({ label: 'Commission %', name: 'commission_rate_pct', type: 'number', step: '0.01', min: '0', max: '100', value: u.commission_rate_pct == null ? '' : String(u.commission_rate_pct) }),
        SR.state.atLeast('OWNER') ? ui.field({
          label: 'Role',
          name: 'role',
          options: ROLES.map((r) => ({ value: r.value, label: U.titleCase(r.value) })),
          value: u.role,
          disabled: self,
          hint: self ? 'You cannot change your own role.' : 'Changing a role takes effect at their next sign-in.',
        }) : null,
        SR.state.atLeast('OWNER') ? ui.field({
          label: 'Branch',
          name: 'branch_id',
          options: [{ value: '', label: 'No branch (owner or admin only)' }].concat(SR.state.branches().map((b) => ({ value: b.id, label: b.name }))),
          value: u.branch_id || '',
          disabled: self,
          hint: 'This is the whole of a person\'s scope: their branch, and nobody else\'s.',
        }) : null,
        SR.state.atLeast('OWNER') ? ui.field({
          label: 'Active',
          name: 'is_active',
          type: 'checkbox',
          value: Number(u.is_active) ? 1 : 0,
          disabled: self,
          hint: 'Deactivating keeps every sale, till and clock-in they recorded. It only stops them signing in.',
        }) : null));

      // SIGNING IN — the locks, the failures behind them, and the owner's way out.
      //
      // `GET /api/auth/lock-state`, `GET /api/auth/attempts` and `POST /api/auth/unlock` were
      // three complete routes that NO SCREEN CALLED. An owner with a cashier locked out at the
      // counter — the cashier having mistyped their PIN eight times, which on a busy morning
      // is not an attack — had no way to clear it from the product; the only route was to wait
      // fifteen minutes or talk to the vendor. The manager, meanwhile, could not see WHO was
      // locked out at all. All three are reached from here now, with the same gates the routes
      // enforce (a manager may look, only an owner may clear) and the same field names they
      // answer with.
      if (SR.state.atLeast('MANAGER')) form.appendChild(signInSecurity(u));

      // A grant reaches across businesses, so only the deployment administrator
      // sees this. A client's own owner is scoped to every business in THEIR
      // deployment by role already, which is a different thing from handing
      // somebody else a second company to work in.
      const isAdmin = String((SR.state.user && SR.state.user.role) || '').toUpperCase() === 'ADMIN';
      if (isAdmin && !self) form.appendChild(accessSection(u));

      const pinBtn = ui.h('button', { class: 'btn' }, 'Issue a new PIN');
      // WHERE THEY HAVE WORKED, and the move itself, sit next to the PIN button because
      // they are the same kind of action: they change what this person can do, and they
      // are decisions rather than edits.
      const historyBtn = ui.h('button', { class: 'btn btn-sm', onClick: () => openHistory(u) }, 'Where they have worked');
      const moveBtn = !self && SR.state.atLeast('OWNER') && u.branch_id
        ? ui.h('button', { class: 'btn btn-sm', onClick: () => { m.close(); openMove(u); } }, 'Move to another branch')
        : null;
      const close = ui.h('button', { class: 'btn', onClick: () => m.close() }, 'Close');
      const save = ui.h('button', { class: 'btn btn-primary' }, 'Save changes');
      const m = ui.openModal({ title: u.full_name || u.username, body: form, footer: [historyBtn, moveBtn, pinBtn, ui.h('div', { class: 'spacer' }), close, save].filter(Boolean), size: 'wide' });

      pinBtn.addEventListener('click', async () => {
        const confirmed = await ui.confirmDialog({
          title: 'Issue a new PIN',
          message: `Generate a new PIN for ${u.full_name || u.username}?`,
          confirmLabel: 'Generate',
          detail: self
            ? 'You will be signed out of every device and will need the new PIN to get back in.'
            : 'They will be signed out of every device immediately. The new PIN is shown once — write it down and hand it over in person.',
        });
        if (!confirmed) return;
        try {
          const res = await SR.api.post(`/api/users/${encodeURIComponent(u.id)}/reset-pin`, {});
          m.close();
          showPin(u, res.pin, res.message);
          load();
        } catch (err) { ui.apiError(err); }
      });

      save.addEventListener('click', async () => {
        const v = ui.readForm(form);
        await ui.withBusy(form, async () => {
          try {
            const body = {
              full_name: v.full_name,
              job_title: v.job_title || null,
              phone: v.phone || null,
              email: v.email || null,
              commission_rate_pct: v.commission_rate_pct === null ? 0 : Number(v.commission_rate_pct),
            };
            if (SR.state.atLeast('OWNER') && !self) {
              if (v.role) body.role = v.role;
              body.branch_id = v.branch_id === null ? null : v.branch_id;
              body.is_active = Number(v.is_active) ? true : false;
            }
            // THE PAYLOAD IS THE SECOND ARGUMENT, not an object holding it. `{ body }`
            // sent the JSON `{"body":{...}}`, so editing a user saved nothing: the
            // route read `body.full_name` and found `undefined`, and the screen
            // reported success. Same defect as the Settings Save button, written in
            // the shorthand form the sweep's pattern could not see.
            const res = await SR.api.put(`/api/users/${encodeURIComponent(u.id)}`, body);
            m.close();
            ui.ok(res.message || 'Saved.');
            load();
          } catch (err) { ui.apiError(err); }
        });
      });
    }

    function showPin(u, pin, message) {
      const body = ui.h('div', { class: 'stack' });
      body.appendChild(ui.h('div', { class: 'pin-display' }, pin || '—'));
      body.appendChild(ui.h('p', {}, message || 'Write this down now: it is shown once and cannot be read back later.'));
      body.appendChild(ui.h('button', {
        class: 'btn',
        onClick: async () => { await ui.copyToClipboard(String(pin || ''), 'PIN copied.'); },
      }, 'Copy the PIN'));
      const done = ui.h('button', { class: 'btn btn-primary', onClick: () => m.close() }, 'I have written it down');
      const m = ui.openModal({ title: `New PIN for ${u.full_name || u.username}`, body, footer: [done], size: 'narrow' });
    }

    async function exportList() {
      try {
        await SR.exporter.list({
          filename: 'staff',
          path: '/api/users',
          query: SR.state.query({ role: state.role || undefined, branch_id: state.branch || undefined, active: state.active === '' ? undefined : state.active }),
          mirrorTable: 'users',
          columns: [
            { key: 'full_name', label: 'Name' }, { key: 'username', label: 'Username' },
            { key: 'role', label: 'Role' }, { key: 'job_title', label: 'Job title' },
            { key: 'branch_name', label: 'Branch' }, { key: 'phone', label: 'Phone' },
            { key: 'commission_rate_pct', label: 'Commission %' },
            { key: 'is_active', label: 'Active (1/0)' },
          ],
        });
      } catch (err) { ui.apiError(err); }
    }

    wrap.appendChild(ui.html('<style>' +
      '.kpis{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:10px}' +
      '.kpi-label{font-size:11px;text-transform:uppercase;letter-spacing:.06em;opacity:.65;margin-bottom:2px}' +
      '.kpi-value{font-size:19px;font-weight:650}' +
      '.kpi-foot{font-size:11px;opacity:.62;margin-top:2px}' +
      '.pin-display{font-family:var(--mono,monospace);font-size:30px;letter-spacing:.28em;text-align:center;padding:16px;border-radius:12px;background:var(--line)}' +
      '</style>'));

    await load();
    return wrap;
  }

  SR.views = SR.views || {};
  SR.views.users = { render };
}(window));
