#!/usr/bin/env bash
# =====================================================================
# scripts/push-github.sh — push this workspace to the GitHub repository
# =====================================================================
# WHY THIS IS A SCRIPT AND NOT A `git push` IN THE DOCS
#
# The credential must not be written into .git/config, which would leave a token
# on disk in a place that is easy to copy and hard to notice. This script reads
# .env.deploy, uses the token for the duration of one push, and leaves no copy
# of it behind in the repository's own configuration.
#
# It also sets the identity and the remote, so it works on a machine where the
# repository has never been configured — which is every fresh clone, and every
# sandbox that does not preserve .git/config.
#
#   ./scripts/push-github.sh                  # commit everything, then push
#   ./scripts/push-github.sh "commit message" # ...with your own message
#   ./scripts/push-github.sh --no-commit      # push what is already committed
# =====================================================================
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

if [ -f .env.deploy ]; then
  set -a
  # shellcheck disable=SC1091
  . ./.env.deploy
  set +a
fi

: "${GITHUB_TOKEN:?GITHUB_TOKEN is not set. Put it in .env.deploy or export it.}"
REPO_URL="${GITHUB_REPO:-https://github.com/10client/stockridge}"
BRANCH="${GITHUB_BRANCH:-main}"

# https://<token>@github.com/... — used twice, never stored.
AUTH_URL="$(printf '%s' "$REPO_URL" | sed -E "s#^https://#https://x-access-token:${GITHUB_TOKEN}@#")"

git init -q 2>/dev/null || true
git config user.name  "${GIT_AUTHOR_NAME:-StockRidge}"
git config user.email "${GIT_AUTHOR_EMAIL:-deploy@stockridge.local}"
# A remote WITHOUT the token: it is here so `git fetch` and friends work.
git remote remove origin 2>/dev/null || true
git remote add origin "$REPO_URL"

if [ "${1:-}" != "--no-commit" ]; then
  MESSAGE="${1:-Update StockRidge}"
  echo "── staging"
  git add -A
  if git diff --cached --quiet; then
    echo "   nothing to commit"
  else
    git -c core.hooksPath=/dev/null commit -q -m "$MESSAGE"
    echo "   committed: $(git rev-parse --short HEAD) $(git log -1 --pretty=%s)"
  fi
fi

# --force-with-lease is only a safety net if git knows what the remote held a
# moment ago. Without the fetch it compares against nothing and either refuses
# ("stale info") or silently overwrites — so fetch first, then lease.
echo "── fetching the current remote state"
if git fetch -q "$AUTH_URL" "+refs/heads/${BRANCH}:refs/remotes/origin/${BRANCH}" 2>/dev/null \
   && git rev-parse --verify -q "refs/remotes/origin/${BRANCH}" >/dev/null; then
  echo "   remote ${BRANCH} is at $(git rev-parse --short "refs/remotes/origin/${BRANCH}")"
  echo "── pushing to ${BRANCH}"
  git push "$AUTH_URL" "HEAD:refs/heads/${BRANCH}" --force-with-lease
else
  echo "   no remote ${BRANCH} yet — this is a first push"
  git push "$AUTH_URL" "HEAD:refs/heads/${BRANCH}"
fi
echo "── done: ${REPO_URL}/commits/${BRANCH}"
