#!/bin/bash
# Installed by an administrator; the dedicated authorized_key can invoke only this.
set -euo pipefail
if [[ ${SSH_ORIGINAL_COMMAND:-} =~ ^deploy\ ([a-f0-9]{40})$ ]]; then
  exec sudo /usr/local/sbin/atomicagent-deploy "${BASH_REMATCH[1]}"
fi
echo 'Only deploy <40-character commit SHA> is allowed.' >&2
exit 64
