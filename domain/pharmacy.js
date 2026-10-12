'use strict';
// =====================================================================
// domain/pharmacy.js — PRESCRIPTION AND CONTROLLED-MEDICINE RULES
// =====================================================================
// These rules apply only when a product is marked. A phone, a bag of rice
// and a chair have no dispensing class and no controlled flag, so this
// file does not see them. A pharmaceutical profile turns the marks on.
// A supermarket can turn them on for the one OTC line it stocks. Nothing
// here is a schema CHECK, because a CHECK would refuse every other shop.
//
// The wording of the two refusals matches the PharmaRidge gate this was
// taken from: a POM line needs a prescriber name, and a controlled line
// needs a buyer name and a phone. An empty object is not an identity.
// =====================================================================

function clean(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

/**
 * Refuse a dispense that has no prescription or no buyer identity.
 *
 * Returns the cleaned details the sale will store, or nulls when the
 * product is not a medicine. Throws PRESCRIPTION_REQUIRED or
 * CONTROLLED_KYC_REQUIRED. A continuation of an existing hire is not a
 * dispense and must not be passed here.
 */
function assertDispense(product, line) {
  const klass = product && product.dispensing_class
    ? String(product.dispensing_class).trim().toUpperCase()
    : null;
  const controlled = Boolean(product && Number(product.is_controlled));
  const name = product && product.name ? product.name : 'This product';

  let prescription = null;
  if (klass === 'POM') {
    const prescriber = clean(line && line.prescription && line.prescription.prescriber_name);
    if (!prescriber) {
      const error = new Error(`Product "${name}" is prescription-only (POM); prescription details (at minimum prescriber_name) are required.`);
      error.code = 'PRESCRIPTION_REQUIRED';
      error.status = 400;
      throw error;
    }
    prescription = {
      prescriber_name: prescriber,
      prescriber_pcn_or_mdcn_no: clean(line.prescription.prescriber_pcn_or_mdcn_no),
      patient_name: clean(line.prescription.patient_name),
      patient_phone: clean(line.prescription.patient_phone),
      dosage_notes: clean(line.prescription.dosage_notes),
    };
  }

  let kyc = null;
  if (controlled) {
    const raw = line && (line.controlledKyc || line.controlled_kyc);
    const buyer = clean(raw && raw.buyer_name);
    const phone = clean(raw && raw.buyer_phone);
    if (!buyer || !phone) {
      const error = new Error(`Product "${name}" is a controlled substance; buyer_name and buyer_phone are required (buyer_id_type/buyer_id_number optional).`);
      error.code = 'CONTROLLED_KYC_REQUIRED';
      error.status = 400;
      throw error;
    }
    kyc = {
      buyer_name: buyer,
      buyer_phone: phone,
      buyer_id_type: clean(raw.buyer_id_type),
      buyer_id_number: clean(raw.buyer_id_number),
    };
  }

  return { klass: klass === 'OTC' || klass === 'POM' ? klass : null, controlled, prescription, kyc };
}

module.exports = { assertDispense, clean };
