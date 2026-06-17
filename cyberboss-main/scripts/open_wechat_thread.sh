#!/bin/zsh
set -euo pipefail

ROOT_DIR="${0:A:h:h}"
cd "${ROOT_DIR}"
export CYBERBOSS_RUNTIME="${CYBERBOSS_RUNTIME:-genericagent}"
exec node ./scripts/shared-open.js "$@"
