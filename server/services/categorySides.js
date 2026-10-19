'use strict';
// The two categories above every shelf.
//
// Pharmaceuticals and non-pharmaceuticals are not a label guessed from a
// shelf code. Each business has the two rows. Every other category sits
// under one of them. A shelf with no parent yet is filed from the old code
// list once, and an owner can move it afterwards. That move is what the
// books read next.

const selling = require('../../domain/selling');
const { newId } = require('../../domain/crypto');

const MAJORS = Object.freeze([
  { code: 'PHARMACEUTICALS', name: 'Pharmaceuticals' },
  { code: 'NON_PHARMACEUTICALS', name: 'Non-pharmaceuticals' },
]);

function isMajorCode(code) {
  return MAJORS.some((major) => major.code === String(code || '').toUpperCase());
}

async function ensureMajors(db, businessId) {
  const id = String(businessId || '');
  if (!id) return { byCode: {} };
  const byCode = {};
  for (const major of MAJORS) {
    let row = await db.first(
      'SELECT id, parent_id FROM product_categories WHERE business_id = ? AND code = ? AND is_deleted = 0',
      [id, major.code],
    );
    if (!row) {
      const majorId = newId();
      await db.run(
        `INSERT INTO product_categories (id, business_id, code, name, parent_id, sort_order, is_active, created_at, updated_at)
         VALUES (?,?,?,?,NULL,0,1, datetime('now'), datetime('now'))`,
        [majorId, id, major.code, major.name],
      );
      row = { id: majorId, parent_id: null };
    } else if (row.parent_id) {
      await db.run(
        "UPDATE product_categories SET parent_id = NULL, sort_order = 0, updated_at = datetime('now') WHERE id = ?",
        [String(row.id)],
      );
    }
    byCode[major.code] = String(row.id);
  }
  const loose = await db.all(
    `SELECT id, code FROM product_categories
      WHERE business_id = ? AND is_deleted = 0 AND parent_id IS NULL
        AND code NOT IN ('PHARMACEUTICALS', 'NON_PHARMACEUTICALS')`,
    [id],
  );
  for (const shelf of loose) {
    const side = selling.sellingGroup({ code: shelf.code }).code;
    const parentId = byCode[side] || byCode.NON_PHARMACEUTICALS;
    await db.run(
      "UPDATE product_categories SET parent_id = ?, updated_at = datetime('now') WHERE id = ? AND parent_id IS NULL",
      [parentId, String(shelf.id)],
    );
  }
  return { byCode };
}

module.exports = { MAJORS, isMajorCode, ensureMajors };
