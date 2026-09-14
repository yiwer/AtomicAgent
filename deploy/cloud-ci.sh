#!/bin/bash
# Installed by an administrator; the dedicated authorized_key can invoke only this.
set -euo pipefail
if [[ ${SSH_ORIGINAL_COMMAND:-} == base ]]; then
  exec sudo /usr/local/sbin/atomicagent-deploy --base
fi
if [[ ${SSH_ORIGINAL_COMMAND:-} =~ ^(deploy|release)\ ([a-f0-9]{40})$ ]]; then
  exec sudo /usr/local/sbin/atomicagent-deploy "${BASH_REMATCH[2]}" "${BASH_REMATCH[1]}"
fi
echo 'Only base, deploy <SHA>, or release <SHA> is allowed.' >&2
exit 64
