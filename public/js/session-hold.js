/* StockRidge — keep the saved till when the line returns. */
(function (global) {
  'use strict';
  const SR = global.SR = global.SR || {};

  function decide(row) {
    const reason = String((row && row.reason) || '');
    const message = String((row && row.message) || '');
    const hasLocal = Boolean(row && row.hasLocalSession);
    const foreign = reason === 'TOKEN_BAD_SIGNATURE' || /invalid token signature|TOKEN_BAD_SIGNATURE/i.test(message);
    if (foreign) return { signOut: false, keep: true, why: 'The other shop host does not share this session. This till stays open.' };
    if (row && row.navigated && hasLocal) return { signOut: false, keep: true, why: 'A page change is not a sign-out. This till stays open.' };
    if (row && row.reconnecting && hasLocal) return { signOut: false, keep: true, why: 'The line just returned. This till stays signed in and will catch up.' };
    if (row && row.uploading && hasLocal) return { signOut: false, keep: true, why: 'Queued sales are still uploading. This till stays signed in.' };
    if (row && row.pendingUpload && hasLocal) return { signOut: false, keep: true, why: 'Sales saved on this till have not uploaded yet. Sending them is not a sign-out.' };
    if (hasLocal && row && !row.shopConfirmed) return { signOut: false, keep: true, why: 'The shop has not given a stable answer. The saved till stays open.' };
    const confirmed = Boolean(row && row.confirmedTwice && row.shopConfirmed && !row.reconnecting && !row.uploading);
    if (confirmed && (reason === 'SESSION_SUPERSEDED' || reason === 'SESSION_REVOKED' || reason === 'USER_GONE')) {
      return { signOut: true, keep: false, why: reason === 'SESSION_SUPERSEDED' ? 'This account is signed in on another device.' : 'This session was ended.' };
    }
    if (hasLocal) return { signOut: false, keep: true, needsSignInToUpload: reason === 'TOKEN_EXPIRED' || reason === 'BAD_TOKEN', why: 'The saved till stays open. A shop refusal when the line returns is not a sign-out.' };
    if (row && row.shopConfirmed && (reason === 'SESSION_REVOKED' || reason === 'USER_GONE' || reason === 'TOKEN_EXPIRED' || reason === 'BAD_TOKEN')) {
      return { signOut: true, keep: false, why: 'There is no saved till to keep.' };
    }
    return { signOut: false, keep: false, why: 'Not a confirmed end of this session.' };
  }

  SR.sessionHold = { decide };
}(window));
