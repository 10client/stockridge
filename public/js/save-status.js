'use strict';
(function (global) {
  const SR = global.SR = global.SR || {};
  const api = requireSaveStatus();
  SR.saveStatus = api;
  // The Electron Node tests load the exact same decision, rather than keeping
  // a second library whose whole-catalogue rules can drift from the till.
  if (typeof module !== 'undefined' && module.exports) module.exports = { decideSaveStatus: api.decide };

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
      if (running && pending > 0 && online) return { state: 'waiting', label: 'Sending…', finished: false, detail: pending + ' sale' + (pending === 1 ? '' : 's') + ' ' + (pending === 1 ? 'is' : 'are') + ' saved here and uploading. Stay on this till.' };
      if (running) return { state: 'saving', label: 'Saving…', finished: false, detail: 'The till is still writing the latest stock and sales. Leave it open until this says Saved.' };
      if (failed > 0) return { state: 'attention', label: 'Not finished', finished: false, detail: failed + ' item' + (failed === 1 ? '' : 's') + ' ' + (failed === 1 ? 'was' : 'were') + ' refused. ' + (failed === 1 ? 'It is' : 'They are') + ' still on this till. Open Sync and read the reason.' };
      if (pending > 0 && online) return { state: 'waiting', label: 'Sending…', finished: false, detail: pending + ' sale' + (pending === 1 ? '' : 's') + ' ' + (pending === 1 ? 'is' : 'are') + ' saved here and still waiting to upload.' };
      if (pending > 0) return { state: 'held', label: 'Saved here', finished: false, detail: pending + ' sale' + (pending === 1 ? '' : 's') + ' ' + (pending === 1 ? 'is' : 'are') + ' saved on this till. ' + (pending === 1 ? 'It' : 'They') + ' will upload when the line returns.' };
      const shopProducts = Number(row.shopProductCount) || 0;
      const storedProducts = Number(row.visibleProducts != null ? row.visibleProducts : row.productRows) || 0;
      if (pullError) return { state: onTill ? 'partial' : 'empty', label: onTill ? 'Part saved' : 'Not saved', finished: false, detail: pullError };
      // Stock-only: the shelf is stock_batches, not every product ever created.
      // PharmaRidge has 6,804 shop products but 0 stock — the till correctly has
      // 0, and that is Saved, not Part saved. The total-product count is no
      // longer the mirror. Only when the till already has stock do we compare
      // stocked names, and ensureCatalogue already handles a bare stock row.
      if (shopProducts > 0 && storedProducts < shopProducts) {
        // An empty shelf is the empty-shop case, handled by catalogueEmpty
        // below. A shelf that already has stock but whose product names are
        // missing is handled by ensureCatalogue's refill. Otherwise the total
        // count is the old catalogue copy and must not keep the chip on Saving.
        if (stockRows === 0 && productRows === 0 && catalogueEmpty) {
          // let the catalogueEmpty path decide (Saved)
        } else if (stockRows > 0) {
          // Stock is present — the mirror is stock_batches and those names.
          // A total-product gap (6,804 vs 10) is expected; do not stay Part saved.
        } else {
          return { state: 'partial', label: 'Part saved', finished: false, detail: 'The shop has ' + shopProducts + ' products. This till has ' + storedProducts + '. Leave it connected until the counts match. Do not disconnect on this copy.' };
        }
      }
      if (onTill && (!row.lastPullAt || truncated.length || row.incomplete)) {
        const why = 'The last download did not finish.';
        return { state: 'partial', label: 'Part saved', finished: false, detail: 'Some of the catalogue is already on this till. ' + why + ' You can sell from what is here.' };
      }
      if (!catalogue) {
        if (catalogueEmpty && row.lastPullAt) return { state: 'saved', label: 'Saved', finished: true, detail: 'The shop has no goods yet, and this till has that answer. Add a product when you are ready. You can disconnect.' };
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
