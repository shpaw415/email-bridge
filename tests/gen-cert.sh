#!/bin/sh
# Generate the self-signed cert for the email-bridge test mocks.
set -e
mkdir -p /tmp/opencode/email-bridge-test
cd /tmp/opencode/email-bridge-test
openssl req -x509 -newkey rsa:2048 -keyout key.pem -out cert.pem -days 5 -nodes -subj "/CN=localhost" 2>/dev/null
echo "cert ready"
