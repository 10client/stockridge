'use strict';
// =====================================================================
// public/js/views/attendance.js — WHO IS AT WORK, AND WHERE THEY CLOCKED IN
// =====================================================================
// Staff attendance at a Nigerian shop is not a formality. It decides wages, it
// decides who was on the floor when stock went missing, and in a branch with a
// generator and a gateman it decides who opened the place.
//
// The clock-in is GEOFENCED. The branch has a centre and a radius; a clock-in
// from outside it is recorded anyway — refusing would just mean the person
// clocks in from the next street instead — but it is flagged, and a manager's
// review decides whether the flag matters. Marking it must come with a note,
// because "outside the fence" with no explanation is exactly the record that
// gets disputed at the end of the month.
//
// There is no way to clock in for somebody else: the device id and the location
// are captured with the entry.
// =====================================================================
(function (global) {
  const SR = global.SR;
  const ui = SR.ui;
  const U = SR.util;

  async function render(ctx) {
    ctx.setTitle('Attendance');
    const state = { tab: ctx.query.tab || 'today', page: 0, pageSize: 50, from: U.addDays(U.todayWat(), -30), to: U.todayWat(), userId: '' };

    const clockSlot = ui.h('span', {});
    let clockedIn = null;
    const wrap = ui.h('div', { class: 'stack' });
    wrap.appendChild(ui.h('div', { class: 'page-head' },
      ui.h('div', {},
        ui.h('h1', {}, 'Attendance'),
        ui.h('p', { class: 'sub' }, `${SR.state.activeBranchName()} · who is in, who is late, and who clocked in from somewhere else`)),
      ui.h('div', { class: 'actions' },
        clockSlot,
        SR.state.atLeast('MANAGER') ? ui.h('button', { class: 'btn btn-sm', onClick: () => openGeofence() }, 'Geofence') : null,
        SR.exporter.buttons((format) => exportList(format)))));

    const tabs = ui.h('div', { class: 'tabs' });
    for (const [key, label] of [['today', 'Today'], ['history', 'History'], ['devices', 'Devices'], ['team', 'Team summary']]) {
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

    function paintClockAction() {
      clockSlot.replaceChildren();
      if (clockedIn === null) return;
      // One action, the one that still applies. A person who is already in does
      // not get a second clock-in, and a person who is out does not get a clock-out.
      clockSlot.appendChild(clockedIn
        ? ui.h('button', { class: 'btn btn-sm btn-primary', onClick: () => clockOut() }, 'Clock out')
        : ui.h('button', { class: 'btn btn-sm btn-primary', onClick: () => clockIn() }, 'Clock in'));
    }

    async function refreshClockState() {
      const me = SR.state.user || {};
      let known = null;
      try {
        const data = await SR.api.get('/api/attendance/today', { query: SR.state.query() });
        const rows = data.records || data.data || [];
        const mine = data.myOpen || rows.find((r) => String(r.user_id) === String(me.id) && r.clock_in_at && !r.clock_out_at);
        known = Boolean(mine && mine.clock_in_at && !mine.clock_out_at);
      } catch (err) {
        try {
          const all = await SR.store.all('attendance', { where: (a) => !Number(a.is_deleted) });
          const mine = all.find((a) => String(a.user_id) === String(me.id) && a.clock_in_at && !a.clock_out_at);
          known = Boolean(mine && mine.clock_in_at && !mine.clock_out_at);
        } catch (e) {
          known = false;
        }
      }
      try {
        const box = await SR.store.outboxAll();
        const pending = (box || []).filter((op) => (op.status === 'PENDING' || op.status === 'RETRY') && (op.type === 'CLOCK_IN' || op.type === 'CLOCK_OUT'));
        if (pending.length) known = pending[pending.length - 1].type === 'CLOCK_IN';
      } catch (e) { /* the server answer stands */ }
      clockedIn = known;
      paintClockAction();
      return clockedIn;
    }

    async function exportList(format) {
      try {
        await SR.exporter.list({
          format,
          filename: 'attendance',
          path: '/api/attendance',
          query: SR.state.query({ from: state.from, to: state.to, user_id: state.userId || undefined }),
          columns: [
            { key: 'work_date', label: 'Date' }, { key: 'full_name', label: 'Staff' },
            { key: 'clock_in_at', label: 'In' }, { key: 'clock_out_at', label: 'Out' },
            { key: 'hours_worked', label: 'Hours' }, { key: 'status', label: 'Status' },
            { key: 'within_geofence', label: 'Inside fence' }, { key: 'outside_reason', label: 'Reason given' },
            { key: 'reviewed_by_name', label: 'Reviewed by' },
          ],
        });
      } catch (err) { ui.apiError(err); }
    }

    async function load() {
      host.replaceChildren(ui.skeleton(6));
      if (state.tab !== 'today') await refreshClockState();
      if (state.tab === 'devices') return renderDevices();
      if (state.tab === 'team') return renderTeam();
      if (state.tab === 'history') return renderHistory();
      return renderToday();
    }

    // ---------------- TODAY ----------------
    async function renderToday() {
      let data; let offline = false;
      try {
        data = await SR.api.get('/api/attendance/today', { query: SR.state.query() });
      } catch (err) {
        if (!err.isOffline && !(err.isAuth && SR.state.user)) { host.replaceChildren(ui.errorBlock(err, { retry: { label: 'Try again', run: renderToday } })); return; }
        offline = true;
        const saved = await SR.store.all('staff_attendance').catch(() => []);
        const records = (saved || []).filter((row) => row && !Number(row.is_deleted));
        data = { records, data: records, summary: { shifts: records.length } };
      }
      // `/attendance/today` answers with `records`, not `data` — it is a roster
      // for one day rather than a paginated list, and the key says so.
      const rows = data.records || data.data || [];
      const s = data.summary || {};
      const absent = data.absent || [];
      const needsReview = data.needsReview || rows.filter((r) => Number(r.flagged) && !r.reviewed_by);
      const inNow = rows.filter((r) => r.clock_in_at && !r.clock_out_at);

      host.replaceChildren();
      if (offline) host.appendChild(ui.h('div', { class: 'alert alert-warn' }, 'Offline — showing the attendance saved on this till. A clock-in from here is queued and sent when the line returns.'));

      const me = SR.state.user || {};
      const todayMine = rows.find((r) => String(r.user_id) === String(me.id));
      const myOpen = data.myOpen && data.myOpen.clock_in_at && !data.myOpen.clock_out_at ? data.myOpen : null;
      const myEntry = (todayMine && todayMine.clock_in_at && !todayMine.clock_out_at) ? todayMine : (myOpen || todayMine);
      const stillOpen = data.stillOpen || [];
      clockedIn = Boolean(myEntry && myEntry.clock_in_at && !myEntry.clock_out_at);
      try {
        const box = await SR.store.outboxAll();
        const pending = (box || []).filter((op) => (op.status === 'PENDING' || op.status === 'RETRY') && (op.type === 'CLOCK_IN' || op.type === 'CLOCK_OUT'));
        if (pending.length) clockedIn = pending[pending.length - 1].type === 'CLOCK_IN';
      } catch (e) { /* the roster answer stands */ }
      paintClockAction();
      const mine = ui.h('div', { class: 'card' });
      mine.appendChild(ui.h('div', { class: 'card-head' }, ui.h('h2', {}, 'Your day'), ui.h('div', { class: 'spacer' }),
        myEntry && !myEntry.clock_out_at ? ui.h('span', { class: 'badge badge-warn' }, openFor(myEntry) && openHours(myEntry) >= 16 ? 'still clocked in' : 'clocked in') : ui.h('span', { class: 'badge badge-mute' }, 'not clocked in')));
      if (myOpen && (!todayMine || String(todayMine.id) !== String(myOpen.id))) {
        mine.appendChild(ui.h('div', { class: 'alert alert-warn' }, `You clocked in ${U.watClock(myOpen.clock_in_at)} and have not clocked out. A new day does not close a shift. Clock it out here — the row stays on the table until you do.`));
      }
      mine.appendChild(ui.h('div', { class: 'card-body row' },
        ui.kv([
          ['Clocked in at', myEntry && myEntry.clock_in_at ? U.watClock(myEntry.clock_in_at) : 'not yet today'],
          ['Clocked out at', myEntry && myEntry.clock_out_at ? U.watClock(myEntry.clock_out_at) : '—'],
          ['Hours so far', myEntry && myEntry.hours_worked != null ? `${myEntry.hours_worked}` : (myEntry && !myEntry.clock_out_at && openFor(myEntry) ? `open ${openFor(myEntry)}` : '—')],
          ['Location', myEntry ? (myEntry.location_status === 'ON_SITE' || myEntry.location_status === 'INSIDE_FENCE' ? 'inside the branch fence' : (myEntry.location_status === 'OFF_SITE' || myEntry.location_status === 'OUTSIDE_FENCE' ? `outside the fence${myEntry.distance_meters != null ? ` by about ${Math.round(Number(myEntry.distance_meters))}m` : ''}` : U.humanise(myEntry.location_status || 'not recorded'))) : '—'],
        ]),
        ui.h('div', { class: 'grow' }),
        ui.h('div', { class: 'btn-row' },
          !myEntry || !myEntry.clock_in_at ? ui.h('button', { class: 'btn btn-primary', onClick: () => clockIn() }, 'Clock in') : null,
          myEntry && myEntry.clock_in_at && !myEntry.clock_out_at ? ui.h('button', { class: 'btn btn-primary', onClick: () => controlShift(myEntry) }, 'Clock out') : null,
          myEntry && myEntry.clock_in_at && !myEntry.clock_out_at ? ui.h('button', { class: 'btn', onClick: () => ui.info(`You came in at ${U.watTime(myEntry.clock_in_at)}.`) }, 'Status') : null)));
      host.appendChild(mine);
      if (stillOpen.length) {
        host.appendChild(ui.h('div', { class: 'alert alert-warn' }, 'A shift stays open until it is clocked out. After about a day it leaves Today, which is why there was no clock-out. Close it from this table. A manager can set the time they actually left and the hours to count.'));
        host.appendChild(openShiftCard(stillOpen));
      }

      host.appendChild(ui.h('div', { class: 'grid grid-4' },
        ui.kpi({ label: 'In the branch now', value: String(inNow.length), tone: 'good', foot: `${rows.length} clocked in today`, small: true }),
        ui.kpi({ label: 'Clocked out', value: String(rows.filter((r) => r.clock_out_at).length), small: true }),
        ui.kpi({ label: 'Not yet clocked in', value: String(absent.length), tone: absent.length ? 'warn' : 'good', foot: `${s.expected || 0} staff expected today`, small: true }),
        ui.kpi({ label: 'Needs review', value: String(needsReview.length), tone: needsReview.length ? 'bad' : 'good', foot: needsReview.length ? 'flagged clock-ins nobody has signed off' : 'every flag has been reviewed', small: true })));

      host.appendChild(ui.dataCard({
        title: 'Today at this branch',
        table: ui.renderTable({
          columns: [
            { key: 'full_name', label: 'Staff', render: (r) => ui.h('div', {},
              ui.h('div', { style: { fontWeight: '600' } }, r.full_name || r.username || '—'),
              ui.h('div', { class: 'hint' }, r.role_label || r.job_title || '')) },
            { key: 'clock_in_at', label: 'In', render: (r) => (r.clock_in_at ? U.watTime(r.clock_in_at) : ui.badge('not in', 'badge-mute')) },
            { key: 'clock_out_at', label: 'Out', render: (r) => (r.clock_out_at ? U.watTime(r.clock_out_at) : (r.clock_in_at ? ui.badge(openHours(r) >= 16 ? 'still open' : 'still in', openHours(r) >= 16 ? 'badge-warn' : 'badge-good') : '—')) },
            { key: 'hours_worked', label: 'Hours', align: 'right', render: (r) => (r.hours_worked != null ? String(r.hours_worked) : '—') },
            { key: 'within_geofence', label: 'Where', render: (r) => {
              if (!r.clock_in_at) return '—';
              return Number(r.within_geofence)
                ? ui.badge('on site', 'badge-good')
                : ui.badge(`outside${r.distance_metres != null ? ` ${Math.round(Number(r.distance_metres))}m` : ''}`, 'badge-bad');
            } },
            { key: 'status', label: '', render: (r) => ui.statusBadge(r.status) },
            { key: 'x', label: '', render: (r) => {
              const cell = ui.h('div', { class: 'btn-row' });
              if (SR.state.atLeast('MANAGER') && r.status !== 'APPROVED' && Number(r.within_geofence) === 0) {
                cell.appendChild(ui.h('button', { class: 'btn btn-sm btn-primary', onClick: () => review(r, true) }, 'Approve'));
                cell.appendChild(ui.h('button', { class: 'btn btn-sm', onClick: () => review(r, false) }, 'Flag'));
              }
              const closeBtn = shiftAction(r);
              if (closeBtn) cell.appendChild(closeBtn);
              if (r.clock_in_at && r.latitude && r.longitude) {
                cell.appendChild(ui.h('button', {
                  class: 'btn btn-sm',
                  onClick: () => ui.info(`Clocked in at ${Number(r.latitude).toFixed(5)}, ${Number(r.longitude).toFixed(5)}${r.distance_metres != null ? ` — ${Math.round(Number(r.distance_metres))}m from the branch` : ''}`),
                }, 'Where?'));
              }
              return cell;
            } },
          ],
          rows,
          emptyTitle: 'Nobody has clocked in today',
          emptyMessage: 'Staff clock in from the Attendance screen on their own device. The branch, the time and the location are stamped on the entry.',
          emptyAction: clockedIn ? null : { label: 'Clock in', run: () => clockIn() },
        }),
      }));
    }

    // ---------------- HISTORY ----------------
    async function renderHistory() {
      const controls = ui.h('div', { class: 'card' }, ui.h('div', { class: 'card-body row' }));
      const fromEl = ui.h('input', { type: 'date', value: state.from, onchange: (e) => { state.from = e.target.value; state.page = 0; renderHistory(); } });
      const toEl = ui.h('input', { type: 'date', value: state.to, onchange: (e) => { state.to = e.target.value; state.page = 0; renderHistory(); } });
      controls.firstElementChild.appendChild(ui.h('div', {}, ui.h('label', { class: 'ctl' }, 'From'), fromEl));
      controls.firstElementChild.appendChild(ui.h('div', {}, ui.h('label', { class: 'ctl' }, 'To'), toEl));

      let data; let offline = false;
      try {
        data = await SR.api.get('/api/attendance', { query: SR.state.query({ from: state.from, to: state.to, user_id: state.userId || undefined, limit: state.pageSize, offset: state.page * state.pageSize }) });
      } catch (err) {
        if (!err.isOffline && !(err.isAuth && SR.state.user)) { host.replaceChildren(ui.errorBlock(err, { retry: { label: 'Try again', run: renderHistory } })); return; }
        offline = true;
        const all = await SR.store.all('staff_attendance', { where: (a) => !Number(a.is_deleted) }).catch(() => []);
        const rows = all.filter((a) => {
          const day = String(a.clock_in_at || a.work_date || '').slice(0, 10);
          return day >= state.from && day <= state.to;
        }).sort((a, b) => String(b.clock_in_at || '').localeCompare(String(a.clock_in_at || '')));
        data = { data: rows, paging: { total: rows.length, limit: rows.length, offset: 0 }, summary: {} };
      }
      const rows = data.data || [];
      const paging = data.paging || {};
      const s = data.summary || {};
      const byStaff = Array.from(U.groupBy(rows, (r) => r.full_name || r.username || 'unknown').entries())
        .map(([name, list]) => ({
          name,
          days: list.length,
          hours: U.round2(U.sum(list, (x) => x.hours_worked)),
          late: list.filter((x) => x.late || x.status === 'LATE').length,
          outside: list.filter((x) => Number(x.within_geofence) === 0).length,
        }))
        .sort((a, b) => b.hours - a.hours);

      host.replaceChildren();
      host.appendChild(controls);
      if (offline) host.appendChild(ui.h('div', { class: 'alert alert-warn' }, 'Offline — from this device\'s last sync.'));
      const stuck = data.stillOpen || [];
      if (stuck.length) {
        host.appendChild(ui.h('div', { class: 'alert alert-warn' }, 'These shifts are still open, including ones that started before this date range. Clock them out here. A new day does not close them.'));
        host.appendChild(openShiftCard(stuck));
      }
      host.appendChild(ui.h('div', { class: 'grid grid-4' },
        ui.kpi({ label: 'Entries', value: String(s.entries || rows.length), foot: `${U.date(state.from)} → ${U.date(state.to)}`, small: true }),
        ui.kpi({ label: 'Hours recorded', value: String(U.round2(s.hours != null ? s.hours : U.sum(rows, (r) => r.hours_worked))), small: true }),
        ui.kpi({ label: 'Late arrivals', value: String(s.late != null ? s.late : rows.filter((r) => r.late).length), tone: 'warn', small: true }),
        ui.kpi({ label: 'Outside the fence', value: String(rows.filter((r) => Number(r.within_geofence) === 0).length), tone: rows.some((r) => Number(r.within_geofence) === 0) ? 'bad' : 'good', small: true })));

      host.appendChild(ui.dataCard({
        title: 'Attendance',
        table: ui.renderTable({
          exportable: false,
          columns: [
            { key: 'work_date', label: 'Date', render: (r) => (r.clock_in_at ? U.watDate(r.clock_in_at) : U.date(r.work_date)) },
            { key: 'full_name', label: 'Staff', render: (r) => r.full_name || r.username },
            { key: 'clock_in_at', label: 'In', render: (r) => (r.clock_in_at ? U.watClock(r.clock_in_at) : '—') },
            { key: 'clock_out_at', label: 'Out', render: (r) => (r.clock_out_at ? U.watClock(r.clock_out_at) : ui.badge('still open', 'badge-warn')) },
            { key: 'hours_worked', label: 'Hours', align: 'right', render: (r) => (r.hours_worked != null ? String(r.hours_worked) : (r.clock_in_at && !r.clock_out_at ? openFor(r) || '—' : '—')) },
            { key: 'within_geofence', label: 'Fence', render: (r) => (Number(r.within_geofence) || r.location_status === 'ON_SITE' ? ui.badge('inside', 'badge-good') : (r.location_status === 'OFF_SITE' ? ui.badge('outside', 'badge-bad') : '—')) },
            { key: 'outside_reason', label: 'Reason', className: 'wrap', render: (r) => r.outside_reason || r.flag_reason || '—' },
            { key: 'status', label: '', render: (r) => (r.status ? ui.statusBadge(r.status) : (r.clock_out_at ? ui.badge('closed', 'badge-mute') : ui.badge('open', 'badge-warn'))) },
            { key: 'reviewed_by_name', label: 'Reviewed', render: (r) => r.reviewed_by_name || r.reviewer_name || '—' },
            { key: 'x', label: '', render: (r) => shiftAction(r) },
          ],
          rows,
          emptyTitle: 'No attendance records',
          emptyMessage: 'Nothing was clocked in this period.',
        }),
        pager: ui.pager({
          page: state.page, pageSize: paging.limit || state.pageSize, total: paging.total != null ? paging.total : rows.length,
          onPage: (p) => { state.page = p; renderHistory(); },
          onSize: (n) => { state.pageSize = n; state.page = 0; renderHistory(); },
        }),
      }));

      if (byStaff.length) {
        host.appendChild(ui.dataCard({
          title: 'By staff member',
          table: ui.renderTable({
            columns: [
              { key: 'name', label: 'Staff' },
              { key: 'days', label: 'Days', align: 'right' },
              { key: 'hours', label: 'Hours', align: 'right' },
              { key: 'late', label: 'Late', align: 'right', render: (b) => (b.late ? ui.badge(String(b.late), 'badge-warn') : '0') },
              { key: 'outside', label: 'Off-site', align: 'right', render: (b) => (b.outside ? ui.badge(String(b.outside), 'badge-bad') : '0') },
            ],
            rows: byStaff,
          }),
        }));
      }
    }

    async function renderTeam() {
      let data; let offline = false;
      try {
        data = await SR.api.get('/api/attendance', { query: SR.state.query({ from: state.from, to: state.to, limit: 500 }) });
      } catch (err) {
        if (!err.isOffline) { host.replaceChildren(ui.errorBlock(err, { retry: { label: 'Try again', run: renderTeam } })); return; }
        offline = true;
        data = { data: [] };
      }
      const rows = data.data || [];
      const byStaff = Array.from(U.groupBy(rows, (r) => `${r.user_id}`).entries()).map(([, list]) => {
        const first = list[0];
        return {
          name: first.full_name || first.username || 'unknown',
          days: new Set(list.map((x) => x.work_date)).size,
          hours: U.round2(U.sum(list, (x) => x.hours_worked)),
          late: list.filter((x) => x.late || x.status === 'LATE').length,
          outside: list.filter((x) => Number(x.within_geofence) === 0).length,
          last: list.map((x) => x.clock_in_at).filter(Boolean).sort().pop(),
        };
      }).sort((a, b) => b.hours - a.hours);

      host.replaceChildren();
      if (offline) host.appendChild(ui.h('div', { class: 'alert alert-warn' }, 'Offline — from this device\'s last sync.'));
      host.appendChild(ui.h('div', { class: 'grid grid-4' },
        ui.kpi({ label: 'Staff with records', value: String(byStaff.length), small: true }),
        ui.kpi({ label: 'Total hours', value: String(U.round2(U.sum(byStaff, (b) => b.hours))), foot: `${U.date(state.from)} → ${U.date(state.to)}`, small: true }),
        ui.kpi({ label: 'Most hours', value: byStaff.length ? byStaff[0].name : '—', foot: byStaff.length ? `${byStaff[0].hours} hours over ${byStaff[0].days} days` : null, small: true }),
        ui.kpi({ label: 'Off-site clock-ins', value: String(U.sum(byStaff, (b) => b.outside)), tone: U.sum(byStaff, (b) => b.outside) ? 'bad' : 'good', small: true })));
      host.appendChild(ui.dataCard({
        title: 'Hours by staff member',
        table: ui.renderTable({
          columns: [
            { key: 'name', label: 'Staff' },
            { key: 'days', label: 'Days present', align: 'right' },
            { key: 'hours', label: 'Hours', align: 'right', render: (b) => ui.h('strong', {}, String(b.hours)) },
            { key: 'late', label: 'Late', align: 'right', render: (b) => (b.late ? ui.badge(String(b.late), 'badge-warn') : '0') },
            { key: 'outside', label: 'Off-site', align: 'right', render: (b) => (b.outside ? ui.badge(String(b.outside), 'badge-bad') : '0') },
            { key: 'last', label: 'Last seen', render: (b) => (b.last ? U.watClock(b.last) : '—') },
          ],
          rows: byStaff,
          emptyMessage: 'No records in this period.',
        }),
      }));
      host.appendChild(ui.h('div', { class: 'hint' }, 'Hours here are what the clock recorded, not what payroll should pay. Overtime, public holidays and the hours an owner forgot to clock out from are all reasons the two differ.'));
    }

    // ---------------- DEVICES ----------------
    async function renderDevices() {
      let data; let offline = false;
      try {
        data = await SR.api.get('/api/attendance/devices', { query: SR.state.query() });
      } catch (err) {
        if (!err.isOffline) { host.replaceChildren(ui.errorBlock(err, { retry: { label: 'Try again', run: renderDevices } })); return; }
        offline = true;
        data = { data: [] };
      }
      const rows = data.data || [];
      host.replaceChildren();
      if (offline) host.appendChild(ui.h('div', { class: 'alert alert-warn' }, 'Offline — the device register is on the server.'));
      if (!SR.state.atLeast('MANAGER')) {
        host.appendChild(ui.empty({ title: 'Manager only', mark: 'lock', message: 'A device register shows which phone a clock-in came from. Ask a manager.' }));
        return;
      }
      host.appendChild(ui.dataCard({
        title: 'Devices seen clocking in',
        table: ui.renderTable({
          columns: [
            { key: 'device_label', label: 'Device', render: (d) => ui.h('div', {}, ui.h('div', { style: { fontWeight: '600' } }, d.device_label || d.device_id), ui.h('div', { class: 'hint' }, d.device_id ? String(d.device_id).slice(0, 16) : '')) },
            { key: 'user_name', label: 'Usually used by', render: (d) => d.user_name || d.full_name || '—' },
            { key: 'status', label: '', render: (d) => ui.statusBadge(d.status || (Number(d.is_approved) ? 'APPROVED' : 'PENDING')) },
            { key: 'first_seen_at', label: 'First seen', render: (d) => (d.first_seen_at ? U.watClock(d.first_seen_at) : '—') },
            { key: 'last_seen_at', label: 'Last seen', render: (d) => (d.last_seen_at ? U.relTime(d.last_seen_at) : '—') },
            { key: 'clock_ins', label: 'Clock-ins', align: 'right' },
            { key: 'x', label: '', render: (d) => (SR.state.atLeast('MANAGER') ? ui.h('div', { class: 'btn-row' },
              ui.h('button', {
                class: 'btn btn-sm',
                onClick: async () => {
                  try {
                    await SR.api.post(`/api/attendance/devices/${encodeURIComponent(d.device_id || d.id)}/status`, { status: Number(d.is_approved) ? 'BLOCKED' : 'APPROVED' });
                    ui.ok('Device status changed.');
                    renderDevices();
                  } catch (err) { ui.apiError(err); }
                },
              }, Number(d.is_approved) ? 'Block' : 'Approve')) : '') },
          ],
          rows,
          emptyTitle: 'No devices yet',
          emptyMessage: 'As staff clock in, the phones they use are registered here. Blocking a device stops future clock-ins from it — useful when a departed employee\'s phone is still in circulation.',
        }),
      }));
      host.appendChild(ui.h('div', { class: 'hint' }, 'A clock-in carries the device it came from. If the same phone clocks in two people at the same minute, that is the pattern worth looking at.'));
    }

    // ---------------- ACTIONS ----------------

    function openHours(row) {
      if (!row || !row.clock_in_at || row.clock_out_at) return 0;
      const start = Date.parse(String(row.clock_in_at).replace(' ', 'T') + (String(row.clock_in_at).endsWith('Z') ? '' : 'Z'));
      if (!Number.isFinite(start)) return 0;
      return (Date.now() - start) / 3600000;
    }

    function openFor(row) {
      const hours = openHours(row);
      if (!hours) return '';
      if (hours < 1) return `${Math.max(1, Math.round(hours * 60))} min`;
      if (hours < 36) return `${Math.round(hours * 10) / 10} hours`;
      const days = Math.floor(hours / 24);
      return `${days} day${days === 1 ? '' : 's'}`;
    }

    function watLocalInput(utcSql) {
      if (!utcSql) return '';
      const raw = String(utcSql).trim().replace(' ', 'T');
      const d = new Date(raw.endsWith('Z') ? raw : `${raw}Z`);
      if (!Number.isFinite(d.getTime())) return '';
      return new Date(d.getTime() + 60 * 60 * 1000).toISOString().slice(0, 16);
    }

    function shiftAction(row) {
      if (!row || !row.id) return null;
      const me = SR.state.user || {};
      const mine = String(row.user_id) === String(me.id);
      const manager = SR.state.atLeast('MANAGER');
      const open = row.clock_in_at && !row.clock_out_at;
      if (open && (mine || manager)) {
        return ui.h('button', { class: 'btn btn-sm btn-primary', onClick: () => controlShift(row) }, 'Clock out');
      }
      if (!open && manager) {
        return ui.h('button', { class: 'btn btn-sm', onClick: () => controlShift(row) }, 'Correct');
      }
      return null;
    }

    function openShiftCard(rows) {
      return ui.dataCard({
        title: 'Still open',
        table: ui.renderTable({
          columns: [
            { key: 'full_name', label: 'Staff', render: (r) => ui.h('div', {},
              ui.h('div', { style: { fontWeight: '600' } }, r.full_name || r.username || '—'),
              ui.h('div', { class: 'hint' }, r.branch_name || '')) },
            { key: 'clock_in_at', label: 'Clocked in', render: (r) => U.watClock(r.clock_in_at) },
            { key: 'open', label: 'Open for', render: (r) => ui.badge(openFor(r) || 'open', openHours(r) >= 16 ? 'badge-warn' : 'badge-good') },
            { key: 'x', label: '', render: (r) => shiftAction(r) },
          ],
          rows,
          emptyMessage: 'No shift is waiting to be closed.',
        }),
      });
    }

    function controlShift(row) {
      const me = SR.state.user || {};
      const mine = String(row.user_id) === String(me.id);
      const manager = SR.state.atLeast('MANAGER');
      const open = row.clock_in_at && !row.clock_out_at;
      if (open && mine && !manager) {
        clockOut();
        return;
      }
      if (!manager) {
        ui.warn('You can only clock out your own shift.');
        return;
      }
      const span = open ? openHours(row) : null;
      const wrapEl = ui.h('div', {});
      wrapEl.appendChild(ui.h('p', { class: 'hint' }, open
        ? `${row.full_name || 'This person'} clocked in ${U.watClock(row.clock_in_at)}${span >= 16 ? `, about ${openFor(row)} ago` : ''}. Closing now counts the whole span and flags it if it is longer than a working day. Set the time they actually left, or the hours to count, when that span is not the shift. The row stays on this table either way.`
        : `${row.full_name || 'This person'} is already clocked out. Correcting the time or the hours does not erase the earlier record — it stays in the notes.`));
      const timeField = ui.field({
        label: 'Left at',
        name: 'clock_out_at',
        type: 'datetime-local',
        value: watLocalInput(row.clock_out_at) || U.nowWatSql().slice(0, 16).replace(' ', 'T'),
        hint: 'West Africa Time. It has to be after the clock-in, and not in the future.',
      });
      const modeField = ui.field({
        label: open ? 'How to close it' : 'What to change',
        name: 'close_mode',
        value: open ? 'NOW' : 'SET',
        options: open
          ? [{ value: 'NOW', label: 'Clock out now' }, { value: 'SET', label: 'Set the time they left' }]
          : [{ value: 'SET', label: 'Correct the clock-out' }],
      });
      wrapEl.appendChild(ui.h('div', { class: 'form-grid' },
        modeField,
        timeField,
        ui.field({
          label: 'Hours to count',
          name: 'hours_worked',
          type: 'number',
          min: '0',
          max: '36',
          step: '0.25',
          value: row.hours_worked != null ? String(row.hours_worked) : '',
          placeholder: 'Leave blank to use the times',
          hint: 'Optional. Use this when they forgot to clock out and the open span is not the shift. 0 to 36.',
        }),
        ui.field({
          label: 'Reason',
          name: 'note',
          type: 'textarea',
          span: true,
          placeholder: 'Left at 6pm and the phone was off',
          hint: 'Required when you set a time or the hours, and when you correct a closed row. It stays on the row.',
        })));
      function showTime() {
        const mode = modeField.querySelector('[name="close_mode"]').value;
        timeField.hidden = mode !== 'SET';
      }
      modeField.querySelector('select').addEventListener('change', showTime);
      showTime();
      const m = ui.openModal({
        title: open ? `Clock out · ${row.full_name || 'shift'}` : `Correct · ${row.full_name || 'shift'}`,
        body: wrapEl,
        size: 'narrow',
        footer: [
          ui.h('button', { class: 'btn', onClick: () => m.close() }, 'Cancel'),
          ui.h('button', {
            class: 'btn btn-primary',
            onClick: async (ev) => {
              const v = ui.readFormStrings(wrapEl);
              const setTime = v.close_mode === 'SET';
              const hours = v.hours_worked != null && String(v.hours_worked).trim() !== '' ? v.hours_worked : null;
              const needsReason = setTime || hours != null || !open;
              if (setTime && !v.clock_out_at) { ui.warn('Set the time they left.'); return; }
              if (needsReason && (!v.note || String(v.note).trim().length < 6)) {
                ui.warn('Say why, in a sentence. The hours are what they are paid.');
                return;
              }
              ev.currentTarget.disabled = true;
              try {
                const result = await SR.api.post(`/api/attendance/${encodeURIComponent(row.id)}/clock-out`, {
                  clock_out_at: setTime ? String(v.clock_out_at).replace('T', ' ') + (String(v.clock_out_at).length === 16 ? ':00' : '') : null,
                  hours_worked: hours,
                  note: v.note || null,
                });
                ui.ok(result && result.message ? result.message : 'Shift closed.');
                m.close();
                load();
              } catch (err) {
                ui.apiError(err);
                ev.currentTarget.disabled = false;
              }
            },
          }, open ? 'Close this shift' : 'Save the correction'),
        ],
      });
    }

    // A general manager has no shop pin. The shell can show the shop they picked,
    // and the clock-in still used to post with no branch_id. The server then
    // answered "Choose which branch this applies to" on every press, so the
    // selection looked ignored. The selected shop is sent. It is not guessed.
    // A pinned cashier already has one shop, and is not offered another.
    function selectedShop() {
      const id = SR.state.activeBranchId;
      if (!id || !SR.state.activeBranch) return null;
      const branch = SR.state.activeBranch();
      if (!branch || String(branch.id) !== String(id)) return null;
      if (SR.state.activeBusinessId && branch.business_id
          && String(branch.business_id) !== String(SR.state.activeBusinessId)) return null;
      return branch;
    }

    function needShop(thenFn) {
      if (SR.state.lockedToOneShop && SR.state.lockedToOneShop()) {
        ui.warn(`You are pinned to ${SR.state.activeBranchName()}. That shop is not on this screen yet. Sign in again. Another shop will not be guessed.`);
        return;
      }
      ui.warn('Pick the shop you are standing in. A general manager is not pinned to one shop, so this will not guess.');
      if (SR.app && SR.app.openBranchPicker) {
        SR.app.openBranchPicker({ requireShop: true, onChosen: () => thenFn() });
      }
    }

    function clockIn() {
      const branch = selectedShop();
      if (!branch) {
        needShop(() => clockIn());
        return;
      }
      const wrapEl = ui.h('div', {});
      wrapEl.appendChild(ui.h('p', { class: 'hint' }, 'Your location and this device are recorded with the clock-in. That is not surveillance — it is what makes the entry defensible when the hours are questioned.'));
      const grid = ui.h('div', { class: 'form-grid' },
        ui.field({ label: 'Note', name: 'notes', span: true, placeholder: 'If you are clocking in from outside the branch, say why here', hint: `The fence for ${branch ? branch.name : 'this branch'} is checked automatically. If you are outside it the entry is still recorded — it is flagged for a manager, with your note beside the flag.` }));
      wrapEl.appendChild(grid);
      const status = ui.h('div', { class: 'alert alert-info' }, 'Ask the device for its location…');
      wrapEl.appendChild(status);

      let coords = null;
      if (navigator.geolocation) {
        navigator.geolocation.getCurrentPosition(
          (pos) => {
            coords = { latitude: pos.coords.latitude, longitude: pos.coords.longitude, accuracy: pos.coords.accuracy };
            status.replaceChildren(ui.h('div', {}, `Location found: ${coords.latitude.toFixed(5)}, ${coords.longitude.toFixed(5)} (±${Math.round(coords.accuracy)}m).`));
          },
          (err) => {
            status.replaceChildren(ui.h('div', {}, `Could not get a location (${err.message}). The clock-in can still be recorded, and it will be flagged for a manager to sign off.`));
          },
          { enableHighAccuracy: true, timeout: 8000 },
        );
      } else {
        status.replaceChildren(ui.h('div', {}, 'This device does not offer a location. The clock-in will be flagged for review.'));
      }

      const m = ui.openModal({
        title: 'Clock in',
        body: wrapEl,
        size: 'narrow',
        footer: [
          ui.h('button', { class: 'btn', onClick: () => m.close() }, 'Cancel'),
          ui.h('button', {
            class: 'btn btn-primary',
            onClick: async (ev) => {
              const v = ui.readFormStrings(wrapEl);
              const shop = selectedShop();
              if (!shop) {
                ui.warn('That shop is no longer selected. Pick it again. The clock-in will not guess.');
                ev.currentTarget.disabled = false;
                return;
              }
              ev.currentTarget.disabled = true;
              try {
                const result = await SR.api.post('/api/attendance/clock-in', {
                  device_id: SR.device.current().id,
                  clocked_at: U.nowWatSql(),
                  notes: v.notes || null,
                  latitude: coords ? coords.latitude : null,
                  longitude: coords ? coords.longitude : null,
                  accuracy_meters: coords ? coords.accuracy : null,
                  branch_id: String(shop.id),
                  business_id: shop.business_id ? String(shop.business_id) : undefined,
                }, { queue: 'auto', query: { branch_id: String(shop.id), business_id: shop.business_id ? String(shop.business_id) : undefined } });
                if (result && result.queued) ui.info('Offline — your clock-in is queued with the time you pressed it.');
                else if (result && result.flagged) ui.warn(result.message || `Recorded, but it needs a manager's review: ${(result.flags || []).join(' ')}`);
                else ui.ok(result && result.message ? result.message : `Clocked in at ${U.watTime(U.nowIso())}.`);
                m.close();
                load();
              } catch (err) {
                ui.apiError(err);
                ev.currentTarget.disabled = false;
              }
            },
          }, 'Clock in'),
        ],
      });
    }

    function clockOut() {
      const shop = selectedShop();
      if (!shop) {
        needShop(() => clockOut());
        return;
      }
      const wrapEl = ui.h('div', {});
      wrapEl.appendChild(ui.h('div', { class: 'form-grid' },
        ui.field({ label: 'Note', name: 'notes', span: true, placeholder: 'Optional', hint: 'The hours are worked out from your clock-in time. If this shift was left open, a manager sets the time you actually left from the attendance table. The earlier time stays in the notes.' })));
      const m = ui.openModal({
        title: 'Clock out',
        body: wrapEl,
        size: 'narrow',
        footer: [
          ui.h('button', { class: 'btn', onClick: () => m.close() }, 'Cancel'),
          ui.h('button', {
            class: 'btn btn-primary',
            onClick: async (ev) => {
              const v = ui.readFormStrings(wrapEl);
              ev.currentTarget.disabled = true;
              try {
                const leaving = selectedShop();
                if (!leaving) {
                  ui.warn('That shop is no longer selected. Pick it again. The clock-out will not guess.');
                  ev.currentTarget.disabled = false;
                  return;
                }
                const result = await SR.api.post('/api/attendance/clock-out', {
                  device_id: SR.device.current().id,
                  clocked_at: U.nowWatSql(),
                  notes: v.notes || null,
                  branch_id: String(leaving.id),
                  business_id: leaving.business_id ? String(leaving.business_id) : undefined,
                }, { queue: 'auto', query: { branch_id: String(leaving.id), business_id: leaving.business_id ? String(leaving.business_id) : undefined } });
                ui.ok(result && result.message ? result.message : 'Clocked out. Have a good evening.');
                m.close();
                load();
              } catch (err) {
                ui.apiError(err);
                ev.currentTarget.disabled = false;
              }
            },
          }, 'Clock out'),
        ],
      });
    }

    function review(entry, approve) {
      const go = (note) => SR.api.post(`/api/attendance/${encodeURIComponent(entry.id)}/review`, { accepted: approve, note })
        .then(() => { ui.ok(approve ? 'Clock-in approved.' : 'Flagged for attention.'); load(); })
        .catch((err) => ui.apiError(err));
      if (approve) {
        ui.promptDialog({ title: 'Approve this clock-in', label: 'Why is it acceptable?', required: true, hint: 'The reason stays on the record — it is what makes the approval defensible later.' })
          .then((note) => { if (note) go(note); });
      } else {
        ui.promptDialog({ title: 'Flag this clock-in', label: 'What is wrong with it?', required: true })
          .then((note) => { if (note) go(note); });
      }
    }

    function openGeofence() {
      const branch = SR.state.activeBranch();
      const wrapEl = ui.h('div', {});
      wrapEl.appendChild(ui.h('p', { class: 'hint' }, 'The fence is a circle: a centre and a radius. Clock-ins inside it are normal; outside it are recorded and flagged. A radius of 150–250 metres suits a shop; a warehouse on a large plot needs more.'));
      wrapEl.appendChild(ui.h('div', { class: 'form-grid' },
        ui.field({ label: 'Branch', name: 'branch_name', value: branch ? branch.name : '', disabled: true }),
        ui.field({ label: 'Radius (metres)', name: 'geofence_radius_meters', type: 'number', step: '10', min: '25', max: '5000', value: String((branch && branch.geofence_radius_meters) || 150) }),
        ui.field({ label: 'Centre latitude', name: 'latitude', type: 'number', step: '0.000001', value: branch && branch.latitude != null ? String(branch.latitude) : '' }),
        ui.field({ label: 'Centre longitude', name: 'longitude', type: 'number', step: '0.000001', value: branch && branch.longitude != null ? String(branch.longitude) : '' })));
      const useNow = ui.h('button', {
        class: 'btn',
        onClick: () => {
          if (!navigator.geolocation) { ui.warn('This device cannot give a location.'); return; }
          navigator.geolocation.getCurrentPosition((pos) => {
            wrapEl.querySelector('[name="latitude"]').value = String(pos.coords.latitude);
            wrapEl.querySelector('[name="longitude"]').value = String(pos.coords.longitude);
            ui.ok('Centre set to where you are standing. Stand where the shop is, not outside it.');
          }, (err) => ui.warn(`Could not get a location: ${err.message}`));
        },
      }, 'Use where I am now');
      wrapEl.appendChild(useNow);
      const m = ui.openModal({
        title: 'Attendance fence',
        body: wrapEl,
        size: 'narrow',
        footer: [
          ui.h('button', { class: 'btn', onClick: () => m.close() }, 'Cancel'),
          ui.h('button', {
            class: 'btn btn-primary',
            onClick: async (ev) => {
              const v = ui.readFormStrings(wrapEl);
              ev.currentTarget.disabled = true;
              try {
                await SR.api.put('/api/attendance/geofence', {
                  branch_id: SR.state.activeBranchId,
                  geofence_radius_meters: Number(v.geofence_radius_meters),
                  latitude: v.latitude == null ? null : Number(v.latitude),
                  longitude: v.longitude == null ? null : Number(v.longitude),
                });
                ui.ok('Fence updated. It applies from the next clock-in.');
                m.close();
                load();
              } catch (err) {
                ui.apiError(err);
                ev.currentTarget.disabled = false;
              }
            },
          }, 'Save the fence'),
        ],
      });
    }

    await load();
    return wrap;
  }

  SR.views = SR.views || {};
  SR.views.attendance = { render };
}(window));
