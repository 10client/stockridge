'use strict';
// =====================================================================
// public/js/views/account.js — THE PERSON USING THIS DEVICE
// =====================================================================
// Four things live here, in the order somebody actually needs them:
//
//   1. WHO I AM     — name, role, branch. Worth showing plainly, because a
//                     person who has borrowed a colleague's device needs to see
//                     that the sales they ring up will be credited to somebody
//                     else, before they ring up a single one.
//   2. MY PIN       — change it, with the current one required. Changing it
//                     retires every OTHER session, which is the point: if the
//                     PIN is being changed because somebody else knew it, their
//                     session must not outlive the change.
//   3. THIS DEVICE  — what is stored locally, the printer/receipt preferences
//                     that follow this till rather than the person, and the
//                     sessions that are signed in.
//   4. ABOUT        — the build stamp. It is the first question any support
//                     conversation asks, so it is on the screen rather than in
//                     a console.
// =====================================================================
(function (global) {
  const SR = global.SR;
  const ui = SR.ui;
  const U = SR.util;

  async function render(ctx) {
    ctx.setTitle('My account');
    const wrap = ui.h('div', { class: 'stack' });
    wrap.appendChild(ui.h('div', { class: 'page-head' },
      ui.h('div', {},
        ui.h('h1', {}, 'My account'),
        ui.h('p', { class: 'sub' }, 'Your access, your PIN, this device, and the build you are running'))));

    const host = ui.h('div', {});
    wrap.appendChild(host);

    async function load() {
      host.replaceChildren(ui.skeleton(7));
      let me = null;
      try {
        const data = await SR.api.get('/api/auth/me', { query: SR.state.query({}) });
        me = data.user || data;
      } catch (err) {
        me = (SR.state.user || null);
        if (!me) { host.replaceChildren(ui.errorBlock(err, { retry: { label: 'Try again', run: load } })); return; }
      }
      // A MOVE THAT CONCERNS ME. A cashier who has been told "you are going to Minna"
      // should be able to see from their own account that it is a question and not a
      // fact — and, if they do not want to go, withdraw it themselves.
      let transfers = [];
      try {
        const t = await SR.api.get('/api/users/transfers/pending/mine');
        transfers = (t.data || []);
      } catch (err) { transfers = []; }
      let sessions = [];
      try {
        const s = await SR.api.get('/api/sessions', { query: SR.state.query({}) });
        sessions = (s.data || []).filter((x) => String(x.user_id) === String(me.id));
      } catch (err) { sessions = []; }
      render(me, sessions);
    }

    function render(me, sessions) {
      const device = SR.device.current() || {};
      const prefs = SR.print.prefs ? SR.print.prefs() : { paper: '80' };
      const stack = ui.h('div', { class: 'stack' });

      // ------------------------------------------------------------ who I am
      stack.appendChild(ui.h('div', { class: 'card' }, ui.h('div', { class: 'card-body' },
        ui.h('div', { class: 'row' },
          ui.h('div', { class: 'avatar', html: U.esc(U.initials(me.full_name || me.username || '?')) }),
          ui.h('div', { class: 'grow' },
            ui.h('h2', {}, me.full_name || me.username),
            ui.h('p', { class: 'sub' }, `${U.titleCase(me.role || '')} · ${me.branch && me.branch.name ? me.branch.name : (me.branch_id ? 'a branch' : 'every branch')}${me.job_title ? ` · ${me.job_title}` : ''}`)),
          ui.h('div', { class: 'actions' }, ui.badge(`@${me.username}`, 'badge-mute'))),
        ui.kv([
          ['Role', U.titleCase(me.role || '')],
          ['Branch', me.branch && me.branch.name ? me.branch.name : (me.branch_id ? '—' : 'Every branch')],
          ['Job title', me.job_title],
          ['Phone', me.phone],
          ['Email', me.email],
          ['Commission', me.commission_rate_pct ? `${me.commission_rate_pct}% of net revenue` : null],
          ['Employed since', me.employment_started],
          ['Last signed in', me.last_login_at ? U.dateTime(me.last_login_at) : null],
        ]),
        ui.h('p', { class: 'sub' }, 'Sales you ring up, tills you open and clock-ins you record are credited to this account. If you are borrowing a colleague\'s device, sign out and sign in as yourself first — otherwise their figures and yours mix.'))));

      // -------------------------------------------------------------- my PIN
      const pinCard = ui.h('div', { class: 'card' }, ui.h('div', { class: 'card-body' }));
      pinCard.firstElementChild.appendChild(ui.h('h2', {}, 'Change my PIN'));
      pinCard.firstElementChild.appendChild(ui.h('p', { class: 'sub' },
        'Your PIN is stored hashed — nobody, including the owner, can read it back. Changing it retires every other device you are signed in on, which is exactly what you want if you think somebody has seen it.'));
      const pinForm = ui.h('div', { class: 'form-grid' },
        ui.field({ label: 'Current PIN', name: 'currentPin', type: 'password', required: true }),
        ui.field({ label: 'New PIN', name: 'newPin', type: 'password', required: true, hint: 'Digits only, at least four. Avoid 1234 and your year of birth.' }),
        ui.field({ label: 'New PIN again', name: 'confirmPin', type: 'password', required: true }));
      pinCard.firstElementChild.appendChild(pinForm);
      const pinGo = ui.h('button', { class: 'btn btn-primary', onClick: () => changePin(pinForm) }, 'Change my PIN');
      pinCard.firstElementChild.appendChild(pinGo);
      stack.appendChild(pinCard);

      // ---------------------------------------------------------- this device
      const deviceCard = ui.h('div', { class: 'card' }, ui.h('div', { class: 'card-body' }));
      deviceCard.firstElementChild.appendChild(ui.h('h2', {}, 'This device'));
      deviceCard.firstElementChild.appendChild(ui.kv([
        ['Device id', device.id],
        ['Known as', device.label || 'this browser'],
        ['Build', SR.BUILD],
        ['Signed in since', device.since ? U.dateTime(device.since) : null],
      ]));
      const paperSel = ui.h('select', { onchange: (e) => savePrefs({ paper: e.target.value }) });
      for (const [v, l] of [['58', '58mm — small thermal till roll'], ['80', '80mm — standard thermal till roll'], ['a4', 'A4 — full page']]) {
        paperSel.appendChild(ui.h('option', { value: v, selected: v === String(prefs.paper) }, l));
      }
      const brandInput = ui.h('input', { value: prefs.brand || (SR.state.settings && SR.state.settings.business_name) || 'StockRidge' });
      brandInput.addEventListener('change', () => savePrefs({ brand: brandInput.value }));
      deviceCard.firstElementChild.appendChild(ui.h('div', { class: 'form-grid' },
        ui.h('div', {}, ui.h('label', { class: 'ctl' }, 'Receipt paper'), paperSel),
        ui.h('div', {}, ui.h('label', { class: 'ctl' }, 'Name on receipts'), brandInput)));
      deviceCard.firstElementChild.appendChild(ui.h('p', { class: 'sub' },
        'These follow THIS till, not you: the printer attached to it does not change when somebody else signs in.'));
      deviceCard.firstElementChild.appendChild(ui.h('div', { class: 'row' },
        ui.h('button', { class: 'btn btn-sm', onClick: () => SR.print.testPage({ brand: brandInput.value }) }, 'Print a test receipt'),
        ui.h('button', { class: 'btn btn-sm', onClick: () => SR.app.navigate('/sync') }, 'Sync & offline'),
        ui.h('button', { class: 'btn btn-sm', onClick: () => toggleTheme() }, SR.theme.current() === 'dark' ? 'Switch to light' : 'Switch to dark')));
      stack.appendChild(deviceCard);

      // ------------------------------------------------------ a move in progress
      if (transfers.length) {
        const rows = transfers.map((t) => ({
          id: t.id,
          person: t.full_name || t.username,
          from: t.from_branch_name || '—',
          to: t.to_branch_name || '—',
          asked: t.requested_by_name || '—',
          mine: String(t.user_id) === String(me.id),
        }));
        stack.appendChild(ui.dataCard({
          title: 'A branch move is being discussed',
          hint: 'Nothing has changed yet. You keep working where you are until somebody at the branch receiving you agrees to the move.',
          table: ui.renderTable({
            columns: [
              { key: 'person', label: 'Who', render: (r) => (r.mine ? `${r.person} (you)` : r.person) },
              { key: 'from', label: 'From' },
              { key: 'to', label: 'To' },
              { key: 'asked', label: 'Asked by' },
              { key: 'act', label: '', render: (r) => ui.h('button', { class: 'btn btn-sm', onClick: async (ev) => {
                ev.currentTarget.disabled = true;
                try {
                  const res = await SR.api.post(`/api/users/transfers/${encodeURIComponent(r.id)}/cancel`, {});
                  ui.ok(res.message || 'Withdrawn.');
                  load();
                } catch (err) { ui.apiError(err); ev.currentTarget.disabled = false; }
              } }, 'Withdraw') },
            ],
            rows,
          }),
        }));
      }

      // ------------------------------------------------------------ sessions
      if (sessions.length) {
        stack.appendChild(ui.dataCard({
          title: 'Where you are signed in',
          table: ui.renderTable({
            columns: [
              { key: 'device_id', label: 'Device', render: (s) => s.device_id || '—' },
              { key: 'ip_address', label: 'From', render: (s) => s.ip_address || '—' },
              { key: 'created_at', label: 'Signed in', render: (s) => U.relTime(s.created_at) },
              { key: 'expires_at', label: 'Expires', render: (s) => (s.expires_at ? U.dateTime(s.expires_at) : '—') },
            ],
            rows: sessions,
            emptyTitle: 'Only this device',
            emptyMessage: '',
          }),
        }));
      }

      // --------------------------------------------------------------- about
      const about = ui.h('div', { class: 'card' }, ui.h('div', { class: 'card-body' }));
      about.firstElementChild.appendChild(ui.h('h2', {}, 'About'));
      about.firstElementChild.appendChild(ui.kv([
        ['Build', SR.BUILD],
        ['Business', SR.state.activeBusinessName('—')],
        ['Working offline', SR.api.isOnline() ? 'no — you are connected' : 'yes — your work is queued on this device'],
      ]));
      about.firstElementChild.appendChild(ui.h('div', { class: 'row' },
        ui.h('button', { class: 'btn btn-sm', onClick: () => SR.app.navigate('/sync') }, 'See what is queued'),
        ui.h('button', { class: 'btn btn-sm', onClick: () => signOut() }, 'Sign out')));
      about.firstElementChild.appendChild(ui.h('p', { class: 'sub' },
        'StockRidge stores your work on this device first and uploads it as soon as the line allows. Signing out does not throw anything away — anything not yet uploaded stays queued and goes the next time somebody signs in here.'));
      stack.appendChild(about);

      host.replaceChildren(stack);
    }

    // ------------------------------------------------------------- actions
    async function changePin(form) {
      const v = ui.readForm(form);
      if (!v.currentPin || !v.newPin) { ui.warn('Fill in your current PIN and the new one.'); return; }
      if (String(v.newPin) !== String(v.confirmPin)) { ui.warn('The two new PINs do not match.'); return; }
      if (String(v.newPin) === String(v.currentPin)) { ui.warn('The new PIN must be different from the current one.'); return; }
      await ui.withBusy(form, async () => {
        try {
          const res = await SR.api.post('/api/auth/change-pin', { currentPin: String(v.currentPin), newPin: String(v.newPin) });
          form.querySelectorAll('input').forEach((i) => { i.value = ''; });
          ui.ok(res.message || 'PIN changed.');
        } catch (err) { ui.apiError(err); }
      });
    }

    async function savePrefs(patch) {
      try {
        await SR.print.savePrefs(patch);
        ui.ok('Saved for this till.');
      } catch (err) { ui.apiError(err); }
    }

    function toggleTheme() {
      const next = SR.theme.toggle();
      ui.info(`Switched to ${next}.`);
      load();
    }

    async function signOut() {
      const queued = await SR.sync.queueStats().catch(() => ({ pending: 0 }));
      const confirmed = await ui.confirmDialog({
        title: 'Sign out',
        message: 'Sign out of StockRidge on this device?',
        confirmLabel: 'Sign out',
        detail: queued.pending
          ? `${queued.pending} item(s) are still waiting to upload. They will stay on this device and go the next time somebody signs in here — nothing is lost, but the books will not have them until then.`
          : null,
      });
      if (!confirmed) return;
      await SR.api.logout();
      SR.state.clear();
      global.location.reload();
    }

    wrap.appendChild(ui.html('<style>' +
      '.avatar{width:46px;height:46px;border-radius:50%;display:grid;place-items:center;font-weight:650;background:var(--line)}' +
      '.grow{flex:1;min-width:0}' +
      '</style>'));

    await load();
    return wrap;
  }

  SR.views = SR.views || {};
  SR.views.account = { render };
}(window));
