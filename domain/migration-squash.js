'use strict';
// Schema changes that used to be separate files now live in 0001_schema.sql.
// The two catalogues stay in their own files: 0002_nigerian_market.sql and
// 0003_nafdac_catalog.sql. A database that already applied the old files
// records the new checksum and does not run 0001 again.

const SQUASHED_INTO = Object.freeze({
  '0001_schema': Object.freeze([
    '0004_mixed_pharmacy_categories',
    '0005_sync_watermarks',
    '0006_sync_revisions',
    '0007_pharma_shelves',
  ]),
});

module.exports = { SQUASHED_INTO };
