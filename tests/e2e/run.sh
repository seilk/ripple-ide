#!/bin/bash
# Runs the browser smoke test with a globally installed Playwright.
set -euo pipefail
cd "$(dirname "$0")/../.."
: "${PLAYWRIGHT_CORE:=$(npm root -g)/@playwright/cli/node_modules/playwright-core}"
if [ -z "${CHROMIUM:-}" ]; then
  CHROMIUM=$(find "$HOME/Library/Caches/ms-playwright" "$HOME/.cache/ms-playwright" -type f \( -name "Google Chrome for Testing" -o -name chrome \) 2>/dev/null | sort | tail -1 || true)
fi
export PLAYWRIGHT_CORE CHROMIUM
node tests/e2e/smoke.mjs 2>&1 | grep -v -E '"(GET|POST|PUT) /api'
exit "${PIPESTATUS[0]}"
