#!/usr/bin/env bash
# =====================================================================
# test/run-audits.sh — THE RUNNER
# =====================================================================
# PharmaRidge ran its audits through a shell script that gave each one a fresh
# database and a fresh server, because "isolation prevents one role's exercise
# from becoming another role's fixture or false failure". This is that runner.
#
# WHAT IT DOES
#
#   * checks the toolchain (Node >= 22 for the Workers toolchain; the audits
#     themselves only need 20, but a run that starts and fails halfway is worse
#     than one that refuses to start)
#   * runs every `test/audit/audit.*.js`, each in its OWN process with its own
#     database and its own port (the harness does the isolation — see
#     test/audit/lib/deployment.js)
#   * retries an audit ONCE when it fails, in a brand-new world. A genuine failure
#     fails twice and the suite stops; a flake caused by a lost port or a slow
#     first boot costs one retry instead of a re-run of everything
#   * reports a summary and exits non-zero if anything failed
#
# USAGE
#
#   bash test/run-audits.sh                    # every audit, fresh state each
#   bash test/run-audits.sh --one=http          # one audit, by name
#   bash test/run-audits.sh --list              # what is here
#   AUDIT_BASE=https://stockridge-staging.stockridge.workers.dev \
#   AUDIT_USER=admin AUDIT_PIN=1234 \
#     bash test/run-audits.sh --one=http        # the SAME audit, against a live
#                                               # deployment a client uses
#
# THE LAST FORM IS THE POINT. A green local run proves the code is right about the
# world it was written for. A green live run proves it about the world it will
# meet — real D1, real Workers runtime, real latency, real static-asset layer.
# PharmaRidge's audits passed WORKER_BASE for exactly this reason.
# =====================================================================
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

ONE=""
LIST=0
for arg in "$@"; do
  case "$arg" in
    --one=*) ONE="${arg#--one=}" ;;
    --list) LIST=1 ;;
    -h|--help) sed -n '2,45p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $arg" >&2; exit 2 ;;
  esac
done

AUDIT_DIR="test/audit"
if [ ! -d "$AUDIT_DIR" ]; then
  echo "no $AUDIT_DIR — run this from the repository root" >&2
  exit 2
fi

# Every audit file, in a stable order, so two runs of the suite are comparable.
mapfile -t ALL < <(ls "$AUDIT_DIR"/audit.*.js 2>/dev/null | sort)
if [ "${#ALL[@]}" -eq 0 ]; then
  echo "no audits found in $AUDIT_DIR" >&2
  exit 2
fi

if [ "$LIST" -eq 1 ]; then
  echo "StockRidge audits ($AUDIT_DIR):"
  for f in "${ALL[@]}"; do
    name="$(basename "$f" .js)"; name="${name#audit.}"
    printf '  %-16s %s\n' "$name" "$(sed -n '3p' "$f" | sed 's|^// *||')"
  done
  exit 0
fi

SELECTED=()
if [ -n "$ONE" ]; then
  for f in "${ALL[@]}"; do
    case "$(basename "$f")" in
      "audit.$ONE.js") SELECTED+=("$f") ;;
    esac
  done
  if [ "${#SELECTED[@]}" -eq 0 ]; then
    echo "no audit called '$ONE'. Try --list." >&2
    exit 2
  fi
else
  SELECTED=("${ALL[@]}")
fi

# ---- The toolchain. Refused up front rather than halfway through.
NODE_MAJOR="$(node -p "process.versions.node.split('.')[0]")"
if [ "$NODE_MAJOR" -lt 20 ]; then
  echo "Node.js 20+ is required; found $(node --version)." >&2
  exit 3
fi
if [ ! -d node_modules ]; then
  echo "node_modules is missing — run: npm install --no-audit --no-fund" >&2
  exit 3
fi

if [ -n "${AUDIT_BASE:-}" ]; then
  echo "Targeting a LIVE deployment: ${AUDIT_BASE}"
  echo "  (fixtures are created through the API, and nothing is deleted that this run did not make)"
  if ! curl -fsS "${AUDIT_BASE%/}/api/health" >/dev/null 2>&1; then
    echo "  ${AUDIT_BASE%/}/api/health is not answering — is the deployment up?" >&2
    exit 3
  fi
else
  echo "Targeting fresh local deployments (one database and one server per audit)"
fi

PASSED=0
FAILED=0
declare -a FAILED_NAMES=()

run_one() {
  local file="$1"
  local name; name="$(basename "$file" .js)"; name="${name#audit.}"
  echo
  echo "═══════════════════════════════════════════════════════════════════"
  echo "audit.$name"
  echo "═══════════════════════════════════════════════════════════════════"
  if node "$file"; then
    return 0
  fi
  echo
  echo "----- audit.$name failed; retrying in a fresh world -----"
  echo "  (a genuine failure fails twice; this is for a lost port or a slow boot)"
  node "$file"
}

for file in "${SELECTED[@]}"; do
  name="$(basename "$file" .js)"; name="${name#audit.}"
  if run_one "$file"; then
    PASSED=$((PASSED + 1))
  else
    FAILED=$((FAILED + 1))
    FAILED_NAMES+=("$name")
  fi
done

echo
echo "═══════════════════════════════════════════════════════════════════"
if [ "$FAILED" -eq 0 ]; then
  echo "Audit suite passed: ${PASSED} audit(s), every check green."
  exit 0
fi
echo "Audit suite FAILED: ${FAILED} of $((PASSED + FAILED)) audit(s) — ${FAILED_NAMES[*]}"
echo "  A failing audit is a finding. Read it before re-running it."
exit 1
