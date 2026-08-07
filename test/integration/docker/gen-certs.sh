#!/usr/bin/env bash
# Generates the self-signed TLS certificate used by the disposable Dovecot test
# container. The certificate is a throwaway test artifact: it is gitignored and
# regenerated on demand. It is never used against anything but 127.0.0.1.
set -euo pipefail
cd "$(dirname "$0")"

if [ -f certs/cert.pem ] && [ -f certs/key.pem ]; then
  exit 0
fi

mkdir -p certs
openssl req -x509 -newkey rsa:2048 -keyout certs/key.pem -out certs/cert.pem \
  -days 3650 -nodes -subj "/CN=localhost" -addext "subjectAltName=DNS:localhost"

# Dovecot runs as the unprivileged "vmail" user inside the container and has to
# be able to read the bind-mounted key. Test-only key, no secret value.
chmod 644 certs/key.pem certs/cert.pem
