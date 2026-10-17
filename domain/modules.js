'use strict';
// Which screens and fields a business actually uses.
//
// A profile already says what it sells and which switches are on. The shell
// was ignoring that and showing the hire book, the Greenbook and a warranty
// claim to every shop. This is the one map both backends and the shell read,
// so a furniture showroom cannot open a dispensary catalogue by knowing the URL.

const { billsFirst } = require('./billing');

function modulesFor(profile) {
  const features = (profile && profile.features) || {};
  const modes = new Set(Array.isArray(profile && profile.tradeModes) ? profile.tradeModes : ['RETAIL']);
  return Object.freeze({
    hire: modes.has('HIRE'),
    lease: modes.has('LEASE'),
    hireBook: modes.has('HIRE') || modes.has('LEASE'),
    wholesale: modes.has('WHOLESALE'),
    instalments: Boolean(features.instalments || features.layaway),
    deliveries: Boolean(features.bulkyDelivery || features.installation),
    warranty: Boolean(features.warranty),
    serials: Boolean(features.serialTracking),
    dispensing: Boolean(features.dispensing),
    // The Greenbook is a pharmaceutical catalogue, not a feature a general
    // shop inherits by turning every switch on.
    nafdac: Boolean(profile && profile.code === 'PHARMACEUTICAL'),
    expiry: Boolean(features.expiryTracking),
    variants: Boolean(features.variants),
    commission: Boolean(features.commissionTracking),
    fragile: Boolean(features.fragileHandling),
    bulky: Boolean(features.bulkyDelivery),
    installation: Boolean(features.installation),
    // Bill, then cashier, then receipt, then the store releases the goods.
    // Not a FEATURE_FLAGS entry: general retail turns every flag on, and a
    // counter shop must not start holding stock unless it asked to.
    billBeforeReceipt: billsFirst(profile),
  });
}

function modulesOf(code, overrides) {
  const { resolveProfile } = require('./verticals');
  return modulesFor(resolveProfile(code, overrides || null));
}

module.exports = { modulesFor, modulesOf };
