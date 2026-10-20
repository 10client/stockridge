'use strict';
(function (global) {
  const SR = global.SR = global.SR || {};
  const api = requireSaveStatus();
  SR.saveStatus = api;

  function requireSaveStatus() {
    function decideSaveStatus(facts) {
      const row = facts || {};
      const pending = Number(row.pending) || 0;
      const failed = Number(row.failed) || 0;
      const stockRows = Number(row.stockRows) || 0;
      const productRows = Number(row.productRows) || 0;
      const truncated = Array.isArray(row.truncated) ? row.truncated.filter(Boolean) : [];
      const catalogue = Boolean(row.lastPullAt) && (stockRows > 0 || productRows > 0);
      const running = Boolean(row.running);
      const online = Boolean(row.online);
      if (running) return { state: 'saving', label: 'Saving…', finished: false, detail: 'The till is still writing the latest stock and sales. Leave it open until this says Saved.' };
      if (failed > 0) return { state: 'attention', label: 'Not finished', finished: false, detail: failed + ' item' + (failed === 1 ? '' : 's') + ' ' + (failed === 1 ? 'was' : 'were') + ' refused. ' + (failed === 1 ? 'It is' : 'They are') + ' still on this till. Open Sync and read the reason.' };
      if (pending > 0 && online) return { state: 'waiting', label: 'Sending…', finished: false, detail: pending + ' sale' + (pending === 1 ? '' : 's') + ' ' + (pending === 1 ? 'is' : 'are') + ' saved here and still waiting to upload.' };
      if (pending > 0) return { state: 'held', label: 'Saved here', finished: false, detail: pending + ' sale' + (pending === 1 ? '' : 's') + ' ' + (pending === 1 ? 'is' : 'are') + ' saved on this till. ' + (pending === 1 ? 'It' : 'They') + ' will upload when the line returns.' };
      if (!catalogue) return { state: 'empty', label: 'Not saved', finished: false, detail: 'This till has not finished saving the catalogue. Connect, sign in, and leave it open until this says Saved.' };
      if (truncated.length || row.incomplete) return { state: 'partial', label: 'Part saved', finished: false, detail: 'Some of the download did not finish. You can sell from what is here, then sync again while connected.' };
      return { state: 'saved', label: 'Saved', finished: true, detail: 'The catalogue is on this till and nothing is waiting to upload. You can disconnect.' };
    }
    return { decide: decideSaveStatus };
  }
}(typeof window !== 'undefined' ? window : globalThis));
