#!/usr/bin/env bash
# Fails fast, with a fix, when a deploy job can't see its Cloudflare credentials.
# Never prints the values themselves.
#
# Reads: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID, TOKEN_IN_VARIABLES ("true" when
# vars.CLOUDFLARE_API_TOKEN is set), and DEPLOY_ENVIRONMENT (the job's environment name).
set -euo pipefail

where="Settings → Environments → ${DEPLOY_ENVIRONMENT} → Environment secrets"
missing=0

if [ -z "${CLOUDFLARE_API_TOKEN:-}" ]; then
  missing=1
  if [ "${TOKEN_IN_VARIABLES:-}" = "true" ]; then
    echo "::error title=CLOUDFLARE_API_TOKEN is a variable, not a secret::Delete it from Variables and add it under ${where}."
  else
    echo "::error title=CLOUDFLARE_API_TOKEN is not set::Add it under ${where}. Secrets saved in a different environment are not visible to this job."
  fi
fi

if [ -z "${CLOUDFLARE_ACCOUNT_ID:-}" ]; then
  missing=1
  echo "::error title=CLOUDFLARE_ACCOUNT_ID is not set::Add it under ${where} (as a secret or a variable)."
fi

if [ "$missing" -eq 0 ]; then
  echo "Cloudflare credentials found for the ${DEPLOY_ENVIRONMENT} environment."
fi
exit "$missing"
