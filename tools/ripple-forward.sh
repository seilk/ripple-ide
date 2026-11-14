#!/usr/bin/env bash
# Keeps a local port forwarded to a Ripple server on a remote machine, and opens
# the forward again when the SSH connection drops.
#
#   tools/ripple-forward.sh <ssh-host> [local-port] [remote-port]
#
# Then start the IDE with RIPPLE_RUNTIME_URL=http://127.0.0.1:<local-port>/v1
set -uo pipefail
host=${1:?usage: ripple-forward.sh <ssh-host> [local-port] [remote-port]}
local_port=${2:-8000}
remote_port=${3:-8000}
while true; do
  echo "$(date '+%H:%M:%S') forward 127.0.0.1:$local_port -> $host:$remote_port"
  ssh -o BatchMode=yes -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \
    -N -L "$local_port:localhost:$remote_port" "$host"
  echo "$(date '+%H:%M:%S') forward closed (exit $?), again in 3 s"
  sleep 3
done
