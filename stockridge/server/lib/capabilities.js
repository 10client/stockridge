// =====================================================================
// StockRidge — CAPABILITIES  (the profile-driven feature gate)
// =====================================================================
// This module is the mechanism that makes ONE binary serve four verticals.
//
// A capability can be switched off by THREE independent layers, and a flow
// is reachable only when all three agree:
//
//   1. the industry PROFILE declares it (shared/industryProfiles.js)
//        -> "does this kind of business have serial numbers at all?"
//   2. the BUSINESS UNIT's feature toggles (business_units.*_enabled)
//        -> "did this client pay for the module?"   [vendor/ADMIN set]
//   3. the product or category opts in (products.tracks_serials etc.)
//        -> "does THIS item carry a serial?"
//
// Layer 1 is domain truth, layer 2 is commercial, layer 3 is per-item. A
// furniture showroom that also sells televisions turns on serial tracking
// for the television category only, and the sofa category never grows a
// meaningless IMEI field. That is not expressible with a global toggle and
// it is the reason the three layers exist.
//
// ENFORCEMENT IS SERVER-SIDE. Hiding a button in the UI is presentation;
// assertCapability() below is the gate. A route that forgets it is a hole,
// which is why every capability-dependent route calls it and why
// test/capabilities.test.js exercises the "capability off => 403" path for
// each one rather than trusting the code review.
// =====================================================================

const { getProfile, requireProfile, CAPABILITY_KEYS } = require('../../shared/industryProfiles');

// Map capability -> the business_units column that gates it commercially.
// Capabilities with no column are always available when the profile
// declares them (they are core, not a paid module).
const MODULE_TOGGLES = Object.freeze({
  multi_branch: 'multi_branch_enabled',
  instalment_plans: 'instalment_module_enabled',
  layaway_holds: 'layaway_module_enabled',
  delivery_management: 'delivery_module_enabled',
  warranty_tracking: 'warranty_module_enabled',
  wholesale_tiers: 'wholesale_tier_enabled',
  attendance: 'attendance_module_enabled',
  compliance_certificates: 'compliance_register_enabled',
  general_ledger: 'gl_module_enabled',
  offline_sync: 'offline_sync_enabled',
});

// Serial tracking and expiry tracking ride on the warranty/compliance
// modules respectively but are not separately billable — a client who paid
// for warranties needs serials to make them meaningful.
const IMPLIED_BY = Object.freeze({
  serial_tracking: 'warranty_module_enabled',
});

function profileOf(businessUnit) {
  if (!businessUnit) return null;
  if (businessUnit.profile_is_custom && businessUnit.profile_json) {
    try {
      const parsed = JSON.parse(businessUnit.profile_json);
      if (parsed && parsed.code && parsed.capabilities) return parsed;
    } catch (_) { /* fall through to the declared profile */ }
  }
  return getProfile(businessUnit.industry_profile);
}

function capabilitiesOf(businessUnit) {
  const profile = profileOf(businessUnit);
  if (!profile) {
    // No profile resolvable: fail CLOSED for domain capabilities and OPEN
    // for none. A business whose profile cannot be read must not silently
    // gain every module.
    const out = {};
    for (const k of CAPABILITY_KEYS) out[k] = false;
    return out;
  }
  const declared = profile.capabilities || {};
  const out = {};
  for (const key of CAPABILITY_KEYS) {
    let on = !!declared[key];
    const toggleColumn = MODULE_TOGGLES[key] || IMPLIED_BY[key];
    if (on && toggleColumn && businessUnit && businessUnit[toggleColumn] === 0) on = false;
    out[key] = on;
  }
  return out;
}

function has(businessUnit, capability) {
  return !!capabilitiesOf(businessUnit)[capability];
}

// Which of the three layers switched this off. Returned in the 403 body so
// the person hitting it knows whether to ask their vendor, their owner, or
// to edit the product — three very different conversations.
function capabilityStatus(businessUnit, capability) {
  const profile = profileOf(businessUnit);
  const declaredByProfile = !!(profile && profile.capabilities && profile.capabilities[capability]);
  const toggleColumn = MODULE_TOGGLES[capability] || IMPLIED_BY[capability];
  const moduleEnabled = toggleColumn ? (businessUnit ? businessUnit[toggleColumn] !== 0 : false) : true;
  const enabled = declaredByProfile && moduleEnabled;
  let reason = null;
  if (!profile) reason = 'This business has no readable industry profile.';
  else if (!declaredByProfile) reason = `${profile.label} does not use this feature.`;
  else if (!moduleEnabled) reason = 'This module is not enabled on your plan. Contact your account administrator.';
  return { capability, enabled, declared_by_profile: declaredByProfile, module_enabled: moduleEnabled, toggle_column: toggleColumn || null, reason };
}

function assertCapability(businessUnit, capability, { action } = {}) {
  const status = capabilityStatus(businessUnit, capability);
  if (status.enabled) return true;
  const e = new Error(
    action
      ? `You cannot ${action}: ${status.reason}`
      : status.reason || 'That feature is not available for this business.'
  );
  e.status = 403;
  e.code = 'CAPABILITY_DISABLED';
  e.details = status;
  throw e;
}

// Per-item opt-in. The product's own flags win over the category default,
// and both are gated by the profile — a category cannot switch on serial
// tracking for a business whose profile does not have it.
function itemCapabilities(businessUnit, product, category) {
  const caps = capabilitiesOf(businessUnit);
  const pick = (productValue, categoryValue, capability) => {
    if (!caps[capability]) return false;
    if (productValue != null) return !!productValue;
    if (category && categoryValue != null) return !!categoryValue;
    return false;
  };
  return {
    serial_tracking: pick(product && product.tracks_serials, category && category.tracks_serials, 'serial_tracking'),
    expiry_tracking: pick(product && product.tracks_expiry, category && category.tracks_expiry, 'expiry_tracking'),
    warranty_tracking: pick(product && product.tracks_warranty, category && category.tracks_warranty, 'warranty_tracking'),
    installation_service: !!(product && product.requires_installation) && caps.installation_service,
    assembly_required: !!(product && product.assembly_required) && caps.assembly_required,
  };
}

function sellingUnitsFor(businessUnit, product) {
  const profile = profileOf(businessUnit);
  const allowedByProfile = (profile && profile.selling_units) || ['BASE_UNIT', 'PACK'];
  const onProduct = String((product && product.selling_units) || '')
    .split(',').map((s) => s.trim().toUpperCase()).filter(Boolean);
  const effective = onProduct.length ? onProduct.filter((u) => allowedByProfile.includes(u)) : allowedByProfile;
  return effective.length ? effective : ['BASE_UNIT'];
}

module.exports = {
  MODULE_TOGGLES, IMPLIED_BY,
  profileOf, capabilitiesOf, has, capabilityStatus, assertCapability,
  itemCapabilities, sellingUnitsFor, requireProfile,
};
