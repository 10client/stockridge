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
      const onTill = stockRows > 0 || productRows > 0;
      const catalogue = Boolean(row.lastPullAt) && onTill;
      const running = Boolean(row.running);
      const online = Boolean(row.online);
      const pullError = row.pullError ? String(row.pullError) : '';
      const catalogueEmpty = Boolean(row.catalogueEmpty);
      if (running) return { state: 'saving', label: 'Saving…', finished: false, detail: 'The till is still writing the latest stock and sales. Leave it open until this says Saved.' };
      if (failed > 0) return { state: 'attention', label: 'Not finished', finished: false, detail: failed + ' item' + (failed === 1 ? '' : 's') + ' ' + (failed === 1 ? 'was' : 'were') + ' refused. ' + (failed === 1 ? 'It is' : 'They are') + ' still on this till. Open Sync and read the reason.' };
      if (pending > 0 && online) return { state: 'waiting', label: 'Sending…', finished: false, detail: pending + ' sale' + (pending === 1 ? '' : 's') + ' ' + (pending === 1 ? 'is' : 'are') + ' saved here and still waiting to upload.' };
      if (pending > 0) return { state: 'held', label: 'Saved here', finished: false, detail: pending + ' sale' + (pending === 1 ? '' : 's') + ' ' + (pending === 1 ? 'is' : 'are') + ' saved on this till. ' + (pending === 1 ? 'It' : 'They') + ' will upload when the line returns.' };
      if (onTill && (pullError || !row.lastPullAt || truncated.length || row.incomplete)) {
        const why = pullError || 'The last download did not finish.';
        return { state: 'partial', label: 'Part saved', finished: false, detail: 'Some of the catalogue is already on this till. ' + why + ' You can sell from what is here.' };
      }
      if (!catalogue) {
        if (catalogueEmpty) return { state: 'empty', label: 'Not saved', finished: false, detail: 'The shop answered and has no products or stock to copy onto this till. That is why this says Not saved.' };
        if (pullError) return { state: 'empty', label: 'Not saved', finished: false, detail: 'The catalogue did not save. ' + pullError };
        return { state: 'empty', label: 'Not saved', finished: false, detail: 'This till has not downloaded the catalogue yet. Leave it open and connected until this says Saved.' };
      }
      if (truncated.length || row.incomplete) return { state: 'partial', label: 'Part saved', finished: false, detail: 'Some of the download did not finish. You can sell from what is here, then sync again while connected.' };
      if (!row.salesCopied) return { state: 'partial', label: 'Part saved', finished: false, detail: 'The catalogue is on this till, but the sales book has not been copied yet. Leave it open and connected until this says Saved.' };
      return { state: 'saved', label: 'Saved', finished: true, detail: 'The catalogue and the sales book are on this till. You can disconnect.' };
    }
    return { decide: decideSaveStatus };
  }
}(typeof window !== 'undefined' ? window : globalThis));
