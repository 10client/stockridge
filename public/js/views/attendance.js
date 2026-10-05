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

    const wrap = ui.h('div', { class: 'stack' });
    wrap.appendChild(ui.h('div', { class: 'page-head' },
      ui.h('div', {},
        ui.h('h1', {}, 'Attendance'),
        ui.h('p', { class: 'sub' }, `${SR.state.activeBranchName()} · who is in, who is late, and who clocked in from somewhere else`)),
      ui.h('div', { class: 'actions' },
        ui.h('button', { class: 'btn btn-sm btn-primary', onClick: () => clockIn() }, 'Clock in'),
        ui.h('button', { class: 'btn btn-sm', onClick: () => clockOut() }, 'Clock out'),
        SR.state.atLeast('MANAGER') ? ui.h('button', { class: 'btn btn-sm', onClick: () => openGeofence() }, 'Geofence') : null,
        ui.h('button', { class: 'btn btn-sm', onClick: () => exportList() }, 'Export'))));

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

    async function exportList() {
      try {
        await SR.exporter.list({
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
        if (!err.isOffline) { host.replaceChildren(ui.errorBlock(err, { retry: { label: 'Try again', run: renderToday } })); return; }
        offline = true;
        data = { data: [], summary: {} };
      }
      // `/attendance/today` answers with `records`, not `data` — it is a roster
      // for one day rather than a paginated list, and the key says so.
      const rows = data.records || data.data || [];
      const s = data.summary || {};
      const absent = data.absent || [];
      const needsReview = data.needsReview || rows.filter((r) => Number(r.flagged) && !r.reviewed_by);
      const inNow = rows.filter((r) => r.clock_in_at && !r.clock_out_at);

      host.replaceChildren();
      if (offline) host.appendChild(ui.h('div', { class: 'alert alert-warn' }, 'Offline — a clock-in is stamped with a location and a device, so it has to reach the server. If you are offline the entry is queued with its original time.'));

      const me = SR.state.user || {};
      const myEntry = rows.find((r) => String(r.user_id) === String(me.id));
      const mine = ui.h('div', { class: 'card' });
      mine.appendChild(ui.h('div', { class: 'card-head' }, ui.h('h2', {}, 'Your day'), ui.h('div', { class: 'spacer' }),
        myEntry && !myEntry.clock_out_at ? ui.h('span', { class: 'badge badge-good' }, 'clocked in') : ui.h('span', { class: 'badge badge-mute' }, 'not clocked in')));
      mine.appendChild(ui.h('div', { class: 'card-body row' },
        ui.kv([
          ['Clocked in at', myEntry && myEntry.clock_in_at ? U.dateTime(myEntry.clock_in_at) : 'not yet today'],
          ['Clocked out at', myEntry && myEntry.clock_out_at ? U.dateTime(myEntry.clock_out_at) : '—'],
          ['Hours so far', myEntry && myEntry.hours_worked != null ? `${myEntry.hours_worked}` : '—'],
          ['Location', myEntry ? (myEntry.location_status === 'INSIDE_FENCE' ? 'inside the branch fence' : (myEntry.location_status === 'OUTSIDE_FENCE' ? `outside the fence${myEntry.distance_meters != null ? ` by about ${Math.round(Number(myEntry.distance_meters))}m` : ''}` : U.humanise(myEntry.location_status || 'not recorded'))) : '—'],
        ]),
        ui.h('div', { class: 'grow' }),
        ui.h('div', { class: 'btn-row' },
          !myEntry || !myEntry.clock_in_at ? ui.h('button', { class: 'btn btn-primary', onClick: () => clockIn() }, 'Clock in') : null,
          myEntry && myEntry.clock_in_at && !myEntry.clock_out_at ? ui.h('button', { class: 'btn', onClick: () => clockOut() }, 'Clock out') : null,
          myEntry && myEntry.clock_in_at && !myEntry.clock_out_at ? ui.h('button', { class: 'btn', onClick: () => ui.info(`You came in at ${U.time(myEntry.clock_in_at)}.`) }, 'Status') : null)));
      host.appendChild(mine);

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
            { key: 'clock_in_at', label: 'In', render: (r) => (r.clock_in_at ? U.time(r.clock_in_at) : ui.badge('not in', 'badge-mute')) },
            { key: 'clock_out_at', label: 'Out', render: (r) => (r.clock_out_at ? U.time(r.clock_out_at) : (r.clock_in_at ? ui.badge('still in', 'badge-good') : '—')) },
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
          emptyAction: { label: 'Clock in', run: () => clockIn() },
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
        if (!err.isOffline) { host.replaceChildren(ui.errorBlock(err, { retry: { label: 'Try again', run: renderHistory } })); return; }
        offline = true;
        const all = await SR.store.all('attendance', { where: (a) => !Number(a.is_deleted) });
        const rows = all.filter((a) => String(a.work_date) >= state.from && String(a.work_date) <= state.to)
          .sort((a, b) => String(b.work_date).localeCompare(String(a.work_date)));
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
      host.appendChild(ui.h('div', { class: 'grid grid-4' },
        ui.kpi({ label: 'Entries', value: String(s.entries || rows.length), foot: `${U.date(state.from)} → ${U.date(state.to)}`, small: true }),
        ui.kpi({ label: 'Hours recorded', value: String(U.round2(s.hours != null ? s.hours : U.sum(rows, (r) => r.hours_worked))), small: true }),
        ui.kpi({ label: 'Late arrivals', value: String(s.late != null ? s.late : rows.filter((r) => r.late).length), tone: 'warn', small: true }),
        ui.kpi({ label: 'Outside the fence', value: String(rows.filter((r) => Number(r.within_geofence) === 0).length), tone: rows.some((r) => Number(r.within_geofence) === 0) ? 'bad' : 'good', small: true })));

      host.appendChild(ui.dataCard({
        title: 'Attendance',
        table: ui.renderTable({
          columns: [
            { key: 'work_date', label: 'Date', render: (r) => U.date(r.work_date) },
            { key: 'full_name', label: 'Staff', render: (r) => r.full_name || r.username },
            { key: 'clock_in_at', label: 'In', render: (r) => (r.clock_in_at ? U.time(r.clock_in_at) : '—') },
            { key: 'clock_out_at', label: 'Out', render: (r) => (r.clock_out_at ? U.time(r.clock_out_at) : '—') },
            { key: 'hours_worked', label: 'Hours', align: 'right', render: (r) => (r.hours_worked != null ? String(r.hours_worked) : '—') },
            { key: 'within_geofence', label: 'Fence', render: (r) => (Number(r.within_geofence) ? ui.badge('inside', 'badge-good') : ui.badge('outside', 'badge-bad')) },
            { key: 'outside_reason', label: 'Reason', className: 'wrap' },
            { key: 'status', label: '', render: (r) => ui.statusBadge(r.status) },
            { key: 'reviewed_by_name', label: 'Reviewed', render: (r) => r.reviewed_by_name || '—' },
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
            { key: 'last', label: 'Last seen', render: (b) => (b.last ? U.dateTime(b.last) : '—') },
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
            { key: 'first_seen_at', label: 'First seen', render: (d) => (d.first_seen_at ? U.dateTime(d.first_seen_at) : '—') },
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
    function clockIn() {
      const branch = SR.state.activeBranch();
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
              ev.currentTarget.disabled = true;
              try {
                const result = await SR.api.post('/api/attendance/clock-in', {
                  device_id: SR.device.current().id,
                  notes: v.notes || null,
                  latitude: coords ? coords.latitude : null,
                  longitude: coords ? coords.longitude : null,
                  accuracy_meters: coords ? coords.accuracy : null,
                }, { queue: 'auto' });
                if (result && result.queued) ui.info('Offline — your clock-in is queued with the time you pressed it.');
                else if (result && result.flagged) ui.warn(result.message || `Recorded, but it needs a manager's review: ${(result.flags || []).join(' ')}`);
                else ui.ok(result && result.message ? result.message : `Clocked in at ${U.time(U.nowIso())}.`);
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
      const wrapEl = ui.h('div', {});
      wrapEl.appendChild(ui.h('div', { class: 'form-grid' },
        ui.field({ label: 'Note', name: 'notes', span: true, placeholder: 'Optional', hint: 'The hours are worked out from your clock-in time. If the clock is wrong, a manager corrects the shift through Review, and the correction is stamped beside the original times rather than replacing them.' })));
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
                const result = await SR.api.post('/api/attendance/clock-out', {
                  device_id: SR.device.current().id,
                  notes: v.notes || null,
                }, { queue: 'auto' });
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
