'use strict';
// One category list, not two trees.
//
// Pharmaceuticals and Others are a property of a category, not a second
// hierarchy sitting above the shelves. The two rows still exist so a category
// can be filed under one of them, and so a book that already posted
// "Non-pharmaceuticals" can still be read. The shop sees one list. An owner
// creates a category and edits its name or which of the two it counts as.
// A shelf with no parent yet is filed once, and an owner can move it afterwards.

const selling = require('../../domain/selling');
const { newId } = require('../../domain/crypto');

const MAJORS = Object.freeze([
  { code: 'PHARMACEUTICALS', name: 'Pharmaceuticals' },
  { code: 'NON_PHARMACEUTICALS', name: 'Others' },
]);

function isMajorCode(code) {
  return MAJORS.some((major) => major.code === String(code || '').toUpperCase());
}

/** The stored side. Others is the same row the books used to call non-pharmaceuticals. */
function normalizeSide(value) {
  const side = String(value || '').trim().toUpperCase().replace(/[\s-]+/g, '_');
  if (side === 'OTHERS' || side === 'OTHER' || side === 'NON_PHARMACEUTICALS' || side === 'NONPHARMACEUTICALS') {
    return 'NON_PHARMACEUTICALS';
  }
  if (side === 'PHARMACEUTICALS' || side === 'PHARMACEUTICAL') return 'PHARMACEUTICALS';
  return '';
}

function sideLabel(code) {
  return normalizeSide(code) === 'PHARMACEUTICALS' ? 'Pharmaceuticals' : 'Others';
}

async function ensureMajors(db, businessId) {
  const id = String(businessId || '');
  if (!id) return { byCode: {} };
  const byCode = {};
  for (const major of MAJORS) {
    let row = await db.first(
      'SELECT id, parent_id, name FROM product_categories WHERE business_id = ? AND code = ? AND is_deleted = 0',
      [id, major.code],
    );
    if (!row) {
      const majorId = newId();
      await db.run(
        `INSERT INTO product_categories (id, business_id, code, name, parent_id, sort_order, is_active, created_at, updated_at)
         VALUES (?,?,?,?,NULL,0,1, datetime('now'), datetime('now'))`,
        [majorId, id, major.code, major.name],
      );
      row = { id: majorId, parent_id: null, name: major.name };
    } else if (row.parent_id || row.name !== major.name) {
      await db.run(
        "UPDATE product_categories SET parent_id = NULL, name = ?, sort_order = 0, updated_at = datetime('now') WHERE id = ?",
        [major.name, String(row.id)],
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

module.exports = { MAJORS, isMajorCode, normalizeSide, sideLabel, ensureMajors };
