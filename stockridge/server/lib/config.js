// =====================================================================
// server/lib/config.js — CONFIGURATION, RESOLVED ONCE AT BOOT
// =====================================================================
// Every setting has ONE source and ONE resolution order:
//   explicit argument  >  environment variable  >  .env file  >  default
//
// Resolving configuration inside a request handler is how two requests end up
// disagreeing about the database path or the JWT secret. Everything here is read
// once at boot, validated, and then frozen.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..', '..');

// ---------------------------------------------------------------------
// .env loader (deliberately not a dependency)
// ---------------------------------------------------------------------
// A 20-line parser rather than `dotenv`, because a shop deploying this on a
// small VPS should not need a dependency to read a config file — and because
// the failure modes of .env parsing (quotes, exports, inline comments, CRLF)
// are small enough to own completely.
function loadDotEnv(file = path.join(ROOT, '.env')) {
  if (!fs.existsSync(file)) return {};
  const out = {};
  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  for (const raw of lines) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = line.match(/^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (!m) continue;
    let value = m[2].trim();
    // A quoted value keeps its spaces and its '#' literally; an unquoted value
    // ends at an inline comment.
    if (/^".*"$/.test(value)) value = value.slice(1, -1).replace(/\\"/g, '"').replace(/\\n/g, '\n');
    else if (/^'.*'$/.test(value)) value = value.slice(1, -1);
    else value = value.replace(/\s+#.*$/, '').trim();
    out[m[1]] = value;
  }
  return out;
}

const dotEnv = loadDotEnv();

function env(key, fallback) {
  const v = process.env[key];
  if (v != null && v !== '') return v;
  const d = dotEnv[key];
  if (d != null && d !== '') return d;
  return fallback;
}

function envBool(key, fallback) {
  const v = env(key);
  if (v == null) return fallback;
  return ['1', 'true', 'yes', 'on'].includes(String(v).toLowerCase());
}

function envInt(key, fallback) {
  const v = Number(env(key));
  return Number.isFinite(v) ? Math.trunc(v) : fallback;
}

// ---------------------------------------------------------------------
// database path
// ---------------------------------------------------------------------
function resolveDbPath(explicit) {
  const raw = explicit || env('STOCKRIDGE_DB_PATH', path.join(ROOT, 'data', 'stockridge.sqlite'));
  if (raw === ':memory:') return ':memory:';
  return path.isAbsolute(raw) ? raw : path.resolve(ROOT, raw);
}

// ---------------------------------------------------------------------
// JWT secret
// ---------------------------------------------------------------------
const INSECURE_DEFAULTS = new Set([
  'change-me-before-first-run', 'changeme', 'change-me', 'secret', 'dev', 'development',
  'stockridge', 'stockridge-secret', 'test', 'password', 'default',
]);

/**
 * The signing secret.
 *
 * A leaked JWT_SECRET lets anyone mint a valid token for ANY role, including
 * ADMIN — the vendor seat that can rewrite a client's plan limits and branding.
 * It is therefore the one setting that is REFUSED rather than defaulted in
 * production. In development an ephemeral random secret is generated so the app
 * still boots (and every restart signs everyone out, which is the correct
 * behaviour for a secret nobody set).
 */
function resolveJwtSecret({ required = null } = {}) {
  const isProd = String(env('NODE_ENV', 'development')).toLowerCase() === 'production';
  const mustHave = required != null ? required : isProd;
  let secret = env('JWT_SECRET', '');

  if (!secret || INSECURE_DEFAULTS.has(secret.toLowerCase())) {
    if (mustHave) {
      throw new Error(
        'JWT_SECRET is not set (or is still the example value) and NODE_ENV=production.\n'
        + 'Generate one with:\n'
        + "  node -e \"console.log(require('crypto').randomBytes(48).toString('base64url'))\"\n"
        + 'and put it in .env. Without it, anyone can forge a session token for any role,\n'
        + 'including ADMIN.'
      );
    }
    secret = crypto.randomBytes(48).toString('base64url');
    // eslint-disable-next-line no-console
    console.warn('[stockridge] JWT_SECRET not set — generated an ephemeral development secret. '
      + 'All sessions will be invalidated on restart. Set JWT_SECRET in .env before deploying.');
    return { secret, ephemeral: true, source: 'generated' };
  }
  if (secret.length < 32) {
    if (mustHave) {
      throw new Error('JWT_SECRET must be at least 32 characters in production.');
    }
    // eslint-disable-next-line no-console
    console.warn('[stockridge] JWT_SECRET is shorter than 32 characters. Lengthen it before deploying.');
  }
  return { secret, ephemeral: false, source: 'env' };
}

// ---------------------------------------------------------------------
// the whole configuration, frozen
// ---------------------------------------------------------------------
function loadConfig(overrides = {}) {
  const jwt = resolveJwtSecret({ required: overrides.requireJwtSecret });
  const cfg = {
    env: String(env('NODE_ENV', 'development')).toLowerCase(),
    isProduction: String(env('NODE_ENV', 'development')).toLowerCase() === 'production',
    root: ROOT,
    host: env('HOST', '0.0.0.0'),
    port: envInt('PORT', 9001),
    publicOrigin: env('PUBLIC_ORIGIN', '') || null,
    logLevel: String(env('LOG_LEVEL', 'info')).toLowerCase(),

    db: {
      file: overrides.dbFile || resolveDbPath(overrides.dbPath),
      driver: env('STOCKRIDGE_DRIVER', 'auto'),
      wal: envBool('STOCKRIDGE_WAL', true),
    },

    jwt: {
      secret: jwt.secret,
      ephemeral: jwt.ephemeral,
      source: jwt.source,
      algorithm: 'HS256',
      // A shop-floor session should survive a shift but not a fortnight. A
      // long-lived token on a shared till laptop is a standing invitation.
      ttlHours: envInt('SESSION_TTL_HOURS', 12),
      issuer: 'stockridge',
      audience: 'stockridge-app',
    },

    security: {
      // PIN login: the throttle is what stands between a 4-digit keyspace and a
      // script. See login_attempts in migration 0004 for the live reproduction.
      maxFailedLogins: envInt('MAX_FAILED_LOGINS', 8),
      loginWindowMinutes: envInt('LOGIN_WINDOW_MINUTES', 15),
      lockoutMinutes: envInt('LOCKOUT_MINUTES', 15),
      bcryptCost: envInt('PIN_HASH_COST', 12),
      rateLimit: {
        windowMs: envInt('RATE_LIMIT_WINDOW_MS', 60000),
        max: envInt('RATE_LIMIT_MAX', 600),
      },
      corsOrigins: (env('CORS_ORIGINS', '') || '').split(',').map((s) => s.trim()).filter(Boolean),
      trustProxy: envBool('TRUST_PROXY', true),
      maxBodyBytes: envInt('MAX_BODY_BYTES', 4 * 1024 * 1024),
      // A logo is stored as a data: URL. 500 KB is generous for a brand mark and
      // stops a client uploading a 40 MB photograph into a settings column that
      // is then served to every login screen.
      maxLogoBytes: envInt('MAX_LOGO_BYTES', 500 * 1024),
    },

    app: {
      autoseed: envBool('STOCKRIDGE_AUTOSEED', false),
      productName: env('PRODUCT_NAME', 'StockRidge'),
      version: (() => {
        try { return require(path.join(ROOT, 'package.json')).version; } catch (e) { return '0.0.0'; }
      })(),
      timezone: 'Africa/Lagos',
      timezoneOffsetHours: 1,
      defaultCurrency: 'NGN',
      // Housekeeping retention. sync_change_log and audit_log grow without
      // bound over a deployment's life; a parity gap in the pharmacy system
      // meant one backend pruned sync_change_log and the other never did, and
      // nobody noticed. Both retentions are set here, in one place.
      retention: {
        syncLogDays: envInt('RETENTION_SYNC_LOG_DAYS', 90),
        idempotencyHours: envInt('RETENTION_IDEMPOTENCY_HOURS', 72),
        auditLogDays: envInt('RETENTION_AUDIT_LOG_DAYS', 730),   // 2 years: a tax audit can reach back that far
        loginAttemptsDays: envInt('RETENTION_LOGIN_ATTEMPTS_DAYS', 30),
      },
      scheduler: {
        enabled: envBool('SCHEDULER_ENABLED', true),
        intervalMinutes: envInt('SCHEDULER_INTERVAL_MINUTES', 60),
      },
    },
  };
  return Object.freeze(cfg);
}

let _config = null;
function getConfig() {
  if (!_config) _config = loadConfig();
  return _config;
}

