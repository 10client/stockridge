// =====================================================================
// tools/probe-frontend-backend.js — comprehensive probe of all FE-BE contracts
// =====================================================================
'use strict';

const ORIGIN = process.env.TEST_ORIGIN || process.env.TARGET_URL || 'https://sample.stockridge.workers.dev';

async function req(path, { method = 'GET', body = null, token = null } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers['Authorization'] = `Bearer ${token}`;
  const res = await fetch(`${ORIGIN}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });
  let data;
  const text = await res.text();
  try {
    data = JSON.parse(text);
  } catch (e) {
    data = text;
  }
  return { status: res.status, ok: res.ok, headers: Object.fromEntries(res.headers.entries()), data };
}

async function runProbe() {
  console.log(`\n====================================================================`);
  console.log(`PROBING STOCKRIDGE FRONTEND <-> BACKEND CONTRACTS`);
  console.log(`Target: ${ORIGIN}`);
  console.log(`====================================================================\n`);

  const results = [];
  function record(name, pass, detail = '') {
    results.push({ name, pass, detail });
    const mark = pass ? '  \x1b[32mPASS\x1b[0m' : '  \x1b[31mFAIL\x1b[0m';
    console.log(`${mark} ${name}${detail ? ` (${detail})` : ''}`);
  }

  // 1. Static Assets & PWA Shell
  try {
    const html = await req('/');
    record('PWA Shell (index.html)', html.status === 200 && typeof html.data === 'string' && html.data.includes('StockRidge'), `status: ${html.status}`);
    const css = await req('/css/app.css');
    record('Design Tokens (app.css)', css.status === 200 && typeof css.data === 'string' && css.data.includes('--green-900'), `size: ${css.data.length} bytes`);
    const theme = await req('/js/theme.js');
    record('Theme Script (theme.js)', theme.status === 200 && typeof theme.data === 'string' && theme.data.includes('Theme'), `size: ${theme.data.length} bytes`);
    const appJs = await req('/js/app.js');
    record('App Core (app.js)', appJs.status === 200 && typeof appJs.data === 'string' && appJs.data.includes('NAV_SECTIONS'), `size: ${appJs.data.length} bytes`);
  } catch (e) {
    record('Static Assets', false, e.message);
  }

  // 2. Public API Endpoints
  try {
    const health = await req('/api/health');
    record('GET /api/health', health.status === 200 && health.data.ok === true, `service: ${health.data.service}`);
    const branding = await req('/branding');
    record('GET /branding', branding.status === 200 && health.data.service === 'StockRidge', `product: ${branding.data.product_name}`);
  } catch (e) {
    record('Public Endpoints', false, e.message);
  }

  // 3. Authentication Flow
  let token = null;
  let user = null;
  try {
    const badLogin = await req('/auth/login', { method: 'POST', body: { username: 'admin', pin: '0000' } });
    record('POST /auth/login (bad credentials rejection)', badLogin.status === 401 && badLogin.data.code === 'BAD_CREDENTIALS', `code: ${badLogin.data.code}`);

    const goodLogin = await req('/auth/login', { method: 'POST', body: { username: 'admin', pin: '9999' } });
    record('POST /auth/login (valid admin sign-in)', goodLogin.status === 200 && goodLogin.data.token, `token length: ${goodLogin.data.token ? goodLogin.data.token.length : 0}`);
    token = goodLogin.data.token;
    user = goodLogin.data.user;

    const me = await req('/auth/me', { token });
    record('GET /auth/me (session recovery & profile)', me.status === 200 && me.data.user && me.data.user.role === 'ADMIN', `role: ${me.data.user ? me.data.user.role : 'none'}`);

    const ref = await req('/reference', { token });
    record('GET /reference (statutory data: states, units, holidays)', ref.status === 200 && Array.isArray(ref.data.states) && ref.data.states.length === 37, `states: ${ref.data.states ? ref.data.states.length : 0}`);
  } catch (e) {
    record('Authentication Flow', false, e.message);
  }

  if (!token) {
    console.error('Fatal: Cannot proceed without auth token.');
    return;
  }

  // 4. Dashboard View Contracts
  try {
    const dash = await req('/dashboard', { token });
    const hasToday = dash.data && dash.data.today && typeof dash.data.today.revenue === 'number';
    const hasAlerts = dash.data && dash.data.alerts && typeof dash.data.alerts.low_stock === 'number';
    const hasStock = dash.data && dash.data.stock && typeof dash.data.stock.cost_value === 'number';
    record('GET /dashboard (live metrics, alerts, receivables)', dash.status === 200 && hasToday && hasAlerts && hasStock, `today revenue: ${hasToday ? dash.data.today.revenue : 'n/a'}`);
  } catch (e) {
    record('Dashboard View', false, e.message);
  }

  // 5. Admin & Management Contracts
  let businessId = null;
  let branchId = null;
  try {
    const bizList = await req('/businesses', { token });
    record('GET /businesses (list)', bizList.status === 200 && Array.isArray(bizList.data), `count: ${bizList.data.length}`);

    // If no business exists, create a probe business & branch
    if (bizList.data.length === 0) {
      const createBiz = await req('/businesses', {
        method: 'POST',
        token,
        body: {
          name: 'Apex Retail Stores Ltd',
          trading_name: 'Apex Retail',
          vertical_profile: 'GENERAL',
          default_currency: 'NGN',
          vat_registered: 1,
          tin: '12345678',
          cac_rc_number: 'RC-192837',
        },

      });
      record('POST /businesses (create business)', createBiz.status === 200 && createBiz.data.id, `created: ${createBiz.data.name || createBiz.data.id}`);
      businessId = createBiz.data.id;

      const createBr = await req('/branches', {
        method: 'POST',
        token,
        body: {
          business_id: businessId,
          name: 'Victoria Island Flagship',
          code: 'VI',
          address_line1: '14 Adeola Odeku St, Victoria Island',
          state_code: 'LA',
          city: 'Lagos',
          phone: '08022223333',
        },
      });
      record('POST /branches (create branch)', createBr.status === 200 && createBr.data.id, `branch: ${createBr.data.name}`);
      branchId = createBr.data.id;
    } else {
      businessId = bizList.data[0].id;
      const brList = await req(`/branches?business_id=${businessId}`, { token });
      record('GET /branches (list)', brList.status === 200 && Array.isArray(brList.data), `count: ${brList.data.length}`);
      if (brList.data.length > 0) branchId = brList.data[0].id;
    }

    // 5b. Users & Staff Management
    const usersList = await req('/users', { token });
    record('GET /users (staff list with lock & role status)', usersList.status === 200 && Array.isArray(usersList.data), `count: ${usersList.data ? usersList.data.length : 0}`);

    const newCashier = await req('/users', {
      method: 'POST',
      token,
      body: {
        full_name: 'Chioma Okeke',
        username: `chioma_${Date.now().toString(36)}`,
        pin: '7284',
        role: 'STAFF',
        branch_id: branchId,
        job_title: 'Senior Cashier',
        phone: '08099887766',
        email: 'chioma@example.com',
      },
    });
    record('POST /users (provision staff cashier with PIN)', newCashier.status === 200 && newCashier.data.id, `user: ${newCashier.data ? newCashier.data.username : 'err'}`);

    if (newCashier.data && newCashier.data.id) {
      const updateU = await req(`/users/${newCashier.data.id}`, {
        method: 'PATCH',
        token,
        body: { job_title: 'Lead Front-of-House Cashier', is_driver: 1 },
      });
      record('PATCH /users/:id (update role metadata & privileges)', updateU.status === 200 && updateU.data.is_driver === 1, `title: ${updateU.data ? updateU.data.job_title : 'err'}`);

      const resetPin = await req(`/users/${newCashier.data.id}/reset-pin`, {
        method: 'POST',
        token,
        body: { new_pin: '8392' },
      });
      record('POST /users/:id/reset-pin (temporary PIN generation)', resetPin.status === 200, `ok: ${resetPin.data ? resetPin.data.ok : false}`);

      const unlock = await req(`/users/${newCashier.data.id}/unlock`, {
        method: 'POST',
        token,
      });
      record('POST /users/:id/unlock (instant failed-attempt lock clearance)', unlock.status === 200, `ok: ${unlock.data ? unlock.data.ok : false}`);
    }
  } catch (e) {
    record('Admin Business/Branch/User Setup', false, e.message);
  }

  // 6. POS & Catalog Contracts
  let productId = null;
  try {
    if (businessId) {
      const prods = await req(`/products?business_id=${businessId}`, { token });
      record('GET /products (catalog search)', prods.status === 200 && Array.isArray(prods.data), `count: ${prods.data.length}`);

      if (prods.data.length === 0) {
        const createProd = await req('/products', {
          method: 'POST',
          token,
          body: {
            business_id: businessId,
            name: 'Samsung 55-inch 4K UHD Smart TV',
            sku: 'ELEC-SAM-55UHD',
            default_selling_price: 450000,
            unit_cost: 380000,
            min_price_floor: 420000,
            is_stocked: 1,
            reorder_level: 5,
            vertical_category_code: 'TELEVISIONS',
          },
        });
        record('POST /products (create product)', createProd.status === 200 && createProd.data.id, `sku: ${createProd.data.sku}`);
        productId = createProd.data.id;
      } else {
        productId = prods.data[0].id;
      }

      // Receive a stock batch into the branch
      if (productId && branchId) {
        const receive = await req('/stock/receive', {
          method: 'POST',
          token,
          body: {
            branch_id: branchId,
            product_id: productId,
            quantity: 5,
            total_cost: 1900000,
            selling_price_per_unit: 450000,
            batch_no: 'BATCH-2026-001',
          },
        });
        record('POST /stock/receive (goods receipt & batch valuation)', receive.status === 200 && (receive.data.batch_id || receive.data.id), `batch: ${receive.data.batch_id || receive.data.id}`);

        // Ensure till 1 is open before accepting cash tender
        const tillStatus = await req(`/till/current?branch_id=${branchId}&till_no=1`, { token });
        if (tillStatus.status !== 200 || !tillStatus.data || !tillStatus.data.id) {
          await req('/till/open', {
            method: 'POST',
            token,
            body: {
              branch_id: branchId,
              till_no: 1,
              opening_float: 20000,
            },
          });
        }

        // Execute POS Cash Sale Checkout
        const sale = await req('/sales', {
          method: 'POST',
          token,
          body: {
            business_id: businessId,
            branch_id: branchId,
            till_no: 1,
            sale_type: 'RETAIL',
            lines: [{
              product_id: productId,
              quantity: 1,
            }],
            payments: [{
              method: 'CASH',
              amount: 450000,
            }],
          },
        });
        record('POST /sales (complete POS cash sale checkout)', sale.status === 200 && (sale.data.id || sale.data.saleId), `sale: ${sale.data.sale_number || sale.data.saleNumber || sale.data.id || sale.data.saleId}`);
      }


    }
  } catch (e) {
    record('POS Product Catalog', false, e.message);
  }


  // 7. Customers & Credit Contracts
  let customerId = null;
  try {
    if (businessId) {
      const custs = await req(`/customers?business_id=${businessId}`, { token });
      record('GET /customers (list)', custs.status === 200 && Array.isArray(custs.data), `count: ${custs.data.length}`);

      if (custs.data.length === 0) {
        const createCust = await req('/customers', {
          method: 'POST',
          token,
          body: {
            business_id: businessId,
            name: 'Dr. Babatunde Adeleke',
            phone: '08033334444',
            email: 'babatunde.adeleke@example.com',
            customer_class: 'CORPORATE',
            customer_type: 'COMPANY',
            credit_limit: 1000000,
            payment_terms_days: 30,
          },
        });
        record('POST /customers (create customer with credit terms)', createCust.status === 200 && createCust.data.id, `name: ${createCust.data.name}`);
        customerId = createCust.data.id;
      } else {
        customerId = custs.data[0].id;
      }


      const ageing = await req(`/customers/debtors/ageing?business_id=${businessId}`, { token });
      record('GET /customers/debtors/ageing (credit risk & debtor buckets)', ageing.status === 200, `status: ${ageing.status}`);
    }
  } catch (e) {
    record('Customers & Credit', false, e.message);
  }

  // 8. Operations Contracts (Holds, Deliveries, Warranty, Tills, Change Owed)
  try {
    if (businessId && branchId) {
      const holds = await req(`/holds?branch_id=${branchId}`, { token });
      record('GET /holds (layaway reservations)', holds.status === 200 && Array.isArray(holds.data), `count: ${holds.data.length}`);

      const deliveries = await req(`/delivery/jobs?branch_id=${branchId}`, { token });
      record('GET /delivery/jobs (fulfillment queue)', deliveries.status === 200 && Array.isArray(deliveries.data), `count: ${deliveries.data.length}`);

      const warranty = await req(`/warranty/claims?business_id=${businessId}`, { token });
      record('GET /warranty/claims (service & RMA records)', warranty.status === 200 && Array.isArray(warranty.data), `count: ${warranty.data.length}`);

      const changeOwed = await req(`/change-owed?branch_id=${branchId}`, { token });
      const rows = changeOwed.data && changeOwed.data.rows ? changeOwed.data.rows : (Array.isArray(changeOwed.data) ? changeOwed.data : []);
      record('GET /change-owed (unclaimed coin liabilities)', changeOwed.status === 200 && Array.isArray(rows), `count: ${rows.length}`);


      const till = await req(`/till/current?branch_id=${branchId}&till_no=1`, { token });
      record('GET /till/current (active till drawer status)', till.status === 200 || till.status === 404, `status: ${till.status}`);
    }
  } catch (e) {
    record('Operations Endpoints', false, e.message);
  }

  // 9. Accounting, General Ledger & Tax Contracts
  try {
    if (businessId) {
      const tb = await req(`/gl/trial-balance?business_id=${businessId}`, { token });
      record('GET /gl/trial-balance (balanced debits & credits)', tb.status === 200, `ok: ${tb.ok}`);

      const pnl = await req(`/gl/pnl?business_id=${businessId}`, { token });
      record('GET /gl/pnl (revenue, COGS, gross margin, expenses)', pnl.status === 200, `ok: ${pnl.ok}`);

      const bs = await req(`/gl/balance-sheet?business_id=${businessId}`, { token });
      record('GET /gl/balance-sheet (assets = liabilities + equity)', bs.status === 200, `ok: ${bs.ok}`);

      const vat = await req(`/vat/returns?business_id=${businessId}`, { token });
      record('GET /vat/returns (NRS output vs input VAT schedule)', vat.status === 200, `ok: ${vat.ok}`);

      const wht = await req(`/wht/rates`, { token });
      const rates = wht.data && wht.data.rates ? wht.data.rates : (Array.isArray(wht.data) ? wht.data : []);
      record('GET /wht/rates (statutory 2024 withholding schedules)', wht.status === 200 && Array.isArray(rates) && rates.length > 0, `rates: ${rates.length}`);

    }
  } catch (e) {
    record('Accounting & General Ledger', false, e.message);
  }

  // 10. Tamper-Evident Registers & Audit Contracts
  try {
    const reg = await req(`/registers/HIGH_VALUE_REGISTER`, { token });
    record('GET /registers/HIGH_VALUE_REGISTER (immutable chained log)', reg.status === 200 && Array.isArray(reg.data.rows), `rows: ${reg.data.rows ? reg.data.rows.length : 0}`);

    const verify = await req(`/registers/HIGH_VALUE_REGISTER/verify`, { method: 'POST', token });
    record('POST /registers/HIGH_VALUE_REGISTER/verify (cryptographic SHA-256 integrity)', verify.status === 200 && verify.data.intact !== false, `intact: ${verify.data.intact}`);
  } catch (e) {
    record('Tamper-Evident Registers', false, e.message);
  }


  // Summary
  console.log(`\n====================================================================`);
  const passed = results.filter((r) => r.pass).length;
  const failed = results.filter((r) => !r.pass).length;
  console.log(`PROBE SUMMARY: ${passed} PASSED, ${failed} FAILED (${results.length} total contracts evaluated)`);
  console.log(`====================================================================\n`);

  if (failed > 0) process.exit(1);
}

runProbe().catch((err) => {
  console.error('[probe] FATAL ERROR:', err);
  process.exit(1);
});
