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

  const ROLES = [
    { value: 'STAFF', label: 'Staff — sell, take payment, clock in' },
    { value: 'MANAGER', label: 'Manager — everything at their branch' },
    { value: 'OWNER', label: 'Owner — every branch, the books, the settings' },
    { value: 'ADMIN', label: 'Administrator — the deployment itself' },
  ];

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
        ui.h('button', { class: 'btn btn-sm', onClick: () => exportList() }, 'Export'))));

    const tabs = ui.h('div', { class: 'tabs' });
    for (const [key, label] of [['team', 'The team'], ['sessions', 'Signed in now']]) {
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

    // ------------------------------------------------------------ sessions
    function renderSessions(data) {
      const rows = data.data || [];
      host.replaceChildren(ui.h('div', { class: 'stack' },
        ui.h('div', { class: 'alert alert-info' },
          'A session is a device holding a valid sign-in. Revoking one is how you remove access from a phone that has been lost, sold or borrowed — the token stops working immediately.'),
        ui.dataCard({
          title: `${rows.length} signed in`,
          table: ui.renderTable({
            columns: [
              { key: 'full_name', label: 'Who', render: (s) => s.full_name || s.username || '—' },
              { key: 'role', label: 'Role', render: (s) => U.titleCase(s.role) },
              { key: 'device_id', label: 'Device', render: (s) => s.device_id || '—' },
              { key: 'ip_address', label: 'From', render: (s) => s.ip_address || '—' },
              { key: 'created_at', label: 'Signed in', render: (s) => U.relTime(s.created_at) },
              { key: 'expires_at', label: 'Expires', render: (s) => (s.expires_at ? U.dateTime(s.expires_at) : '—') },
              {
                key: 'revoke',
                label: '',
                render: (s) => (SR.state.atLeast('OWNER') || String(s.user_id) === String(SR.state.user.id)
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
      const confirmed = await ui.confirmDialog({
        title: 'Sign this device out',
        message: `End the session for ${session.full_name || session.username} on ${session.device_id || 'that device'}?`,
        confirmLabel: 'Sign out',
        danger: true,
        detail: 'Anything already saved stays saved. Anything half-entered on that device is lost.',
      });
      if (!confirmed) return;
      try {
        const res = await SR.api.post(`/api/sessions/${encodeURIComponent(session.user_id)}/revoke`, { body: {} });
        ui.ok(res.message || 'Signed out.');
        load();
      } catch (err) { ui.apiError(err); }
    }

    // -------------------------------------------------------------- create
    function openCreate() {
      const form = ui.h('div', {});
      form.appendChild(ui.h('div', { class: 'form-grid' },
        ui.field({ label: 'Full name', name: 'full_name', required: true, placeholder: 'Chidinma Okafor' }),
        ui.field({ label: 'Username', name: 'username', required: true, hint: 'Lower case, no spaces. This is what they type on the sign-in screen.' }),
        ui.field({ label: 'Role', name: 'role', required: true, options: ROLES }),
        ui.field({ label: 'Branch', name: 'branch_id', options: [{ value: '', label: 'No branch (owner or admin only)' }].concat(SR.state.branches().map((b) => ({ value: b.id, label: b.name }))), hint: 'A person only sees the figures for the branch they belong to. Owners and admins see everything.' }),
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

      go.addEventListener('click', async () => {
        const v = ui.readForm(form);
        if (!v.pin || String(v.pin) !== String(v.confirm_pin)) { ui.warn('The two PINs must match.'); return; }
        await ui.withBusy(form, async () => {
          try {
            const res = await SR.api.post('/api/users', {
              body: {
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
              },
            });
            m.close();
            ui.ok(res.message || `${v.full_name} can now sign in as ${v.username}.`);
            load();
          } catch (err) { ui.apiError(err); }
        });
      });
    }

    // ---------------------------------------------------------------- edit
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

      const pinBtn = ui.h('button', { class: 'btn' }, 'Issue a new PIN');
      const close = ui.h('button', { class: 'btn', onClick: () => m.close() }, 'Close');
      const save = ui.h('button', { class: 'btn btn-primary' }, 'Save changes');
      const m = ui.openModal({ title: u.full_name || u.username, body: form, footer: [pinBtn, ui.h('div', { class: 'spacer' }), close, save], size: 'wide' });

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
          const res = await SR.api.post(`/api/users/${encodeURIComponent(u.id)}/reset-pin`, { body: {} });
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
            const res = await SR.api.put(`/api/users/${encodeURIComponent(u.id)}`, { body });
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
