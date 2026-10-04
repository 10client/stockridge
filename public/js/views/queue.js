// =====================================================================
// public/js/views/queue.js — the offline queue, made visible
// =====================================================================
// A queue nobody can find is a queue that grows until the day's takings are
// missing and nobody knows why. So this screen exists, it is reachable from the
// navigation the moment it has anything in it, and it says plainly what will
// happen next.

'use strict';

import { queueAll, flushQueue, removeQueued } from '../offline.js';
import { state } from '../state.js';
import { el, clear, badge, table, money, spinner, toast, confirmDialog, emptyState } from '../ui.js';

export default async function queueView(ctx) {
  const host = ctx.host;
  host.appendChild(el('header', { class: 'view-head' },
    el('div', {}, el('h1', { text: 'Offline queue' }),
      el('p', { class: 'muted', text: 'Sales made on this device while it could not reach the server. They send automatically when the connection returns.' }))));

  const body = el('div', {}, spinner());
  host.appendChild(body);

  async function paint() {
    const items = await queueAll();
    clear(body);

    if (!items.length) {
      body.appendChild(emptyState('Nothing is queued',
        'Every sale made on this device has reached the server. When the connection drops mid-sale, the sale is saved here instead and sends itself as soon as it can.',
        null, null));
      return;
    }

    body.appendChild(el('div', { class: navigator.onLine ? 'ok-box' : 'warn-box' },
      navigator.onLine
        ? `${items.length} item(s) waiting. They will send in the order they were made, oldest first — two sales of the same last unit must resolve in the order they happened.`
        : `You are offline. ${items.length} sale(s) are safe on this device. Do not clear the browser's site data, or they will be lost.`));

    body.appendChild(el('div', { class: 'row-end' },
      el('button', { class: 'btn btn-primary', onclick: async (ev) => {
        ev.target.disabled = true;
        const r = await flushQueue({ onProgress: () => paint() });
        ev.target.disabled = false;
        if (r.flushed) toast(`${r.flushed} sale(s) reached the server.`, { kind: 'good' });
        for (const bad of r.refused || []) {
          // A refused sale must be surfaced loudly: the operator believes it
          // happened. If it did not, they are holding cash the books do not know
          // about, or they gave away stock that was never recorded.
          toast(`A queued sale could NOT be saved: ${bad.error || bad.code}. ${bad.summary}`, { kind: 'error', duration: 15000 });
        }
        paint();
      } }, navigator.onLine ? 'Send now' : 'Waiting for a connection')));

    body.appendChild(table([
      { key: 'created_at', label: 'Made at', render: (r) => new Date(r.created_at).toLocaleString('en-NG') },
      { key: 'summary', label: 'Contents' },
      { key: 'key', label: 'Idempotency key', render: (r) => el('code', { class: 'small', text: r.key }) },
      { key: 'attempts', label: 'Attempts', align: 'right', render: (r) => Number(r.attempts) > 0 ? badge(r.attempts, 'warn') : '0' },
      { key: 'last_error', label: 'Last result', render: (r) => r.last_error ? el('span', { class: 'small text-bad', text: r.last_error }) : '—' },
      { key: 'action', label: '', render: (r) => el('button', {
        class: 'btn btn-sm btn-danger-ghost',
        onclick: async (ev) => {
          ev.stopPropagation();
          const yes = await confirmDialog({
            title: 'Discard this queued sale?',
            message: 'This removes it from the device without sending it. Only do this if the sale never really happened — if the customer walked out with goods, discarding it means the stock is gone and the books do not know.',
            confirmLabel: 'Discard it',
            danger: true,
          });
          if (!yes) return;
          await removeQueued(r.key);
          toast('Discarded. If goods left the shop, record the sale again.', { kind: 'warn', duration: 9000 });
          paint();
        },
      }, 'Discard') },
    ], items, { dense: true }));

    body.appendChild(el('p', { class: 'hint', text: 'Each item carries the idempotency key it was created with, and reuses it on every retry. That is what makes a blind retry safe: the server executes the key once and replays the stored response, so a sale that reached the server before the connection dropped is never recorded twice.' }));
  }

  await paint();
  return {};
}
