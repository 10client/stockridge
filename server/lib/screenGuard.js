'use strict';
// The screen list is the same file the sidebar reads. A route that answers
// for a screen the role cannot open is how a cashier still reads the books
// after the menu has been corrected.

const { HttpError } = require('./http');
const { screensFor, roleLabel } = require('../../domain/roles');

function requireScreen(ctx, key) {
  const user = ctx.get('user');
  const screens = screensFor(user);
  if (!screens.includes(key)) {
    const who = roleLabel(user && user.role, user);
    throw new HttpError(`That is not part of a ${who} account.`, { status: 403, code: 'ROLE_REQUIRED' });
  }
}

module.exports = { requireScreen };
