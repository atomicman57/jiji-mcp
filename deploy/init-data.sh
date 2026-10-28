#!/bin/sh
# Host-side data directory for the companion uid. Does not copy a Mac profile.
set -eu
install -d -o 950 -g 950 -m 0700 /var/lib/jiji-mcp
if [ ! -f /var/lib/jiji-mcp/config.json ]; then
  cat >/var/lib/jiji-mcp/config.json <<'EOF'
{
  "cloudOrigin": "",
  "cloudEnabled": false,
  "enabled": true,
  "port": 38473,
  "credentialHelper": "/usr/local/bin/jiji-credential-helper"
}
EOF
  chown 950:950 /var/lib/jiji-mcp/config.json
  chmod 0600 /var/lib/jiji-mcp/config.json
fi
