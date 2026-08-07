#!/usr/bin/env bash
# Starts a disposable Dovecot container on 127.0.0.1 and runs the integration
# suite against it. Nothing here ever touches a real mail server.
#
# `npm test` does not call this script; the integration tests skip themselves
# unless RUN_INTEGRATION is set, so the default test run stays Docker-free.
set -euo pipefail

CONTAINER_NAME="${PYLOS_DOVECOT_CONTAINER:-pylos-test-dovecot}"
# Pinned. The 2.3 line is published for amd64 only and Dovecot's
# privilege-separated login processes do not survive Rosetta emulation, so 2.3
# is unusable on Apple Silicon. 2.4.x is multi-arch.
IMAGE="${PYLOS_DOVECOT_IMAGE:-dovecot/dovecot:2.4.4}"
IMAP_PORT="${PYLOS_IMAP_PORT:-10993}"
SIEVE_PORT="${PYLOS_SIEVE_PORT:-14190}"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(cd "$SCRIPT_DIR/../.." && pwd)"
CERT="$SCRIPT_DIR/docker/certs/cert.pem"

cleanup() {
  docker rm -f "$CONTAINER_NAME" >/dev/null 2>&1 || true
}
# Armed before the container is created so an interrupt or a failure at any
# point below still removes it.
trap cleanup EXIT INT TERM
cleanup

bash "$SCRIPT_DIR/docker/gen-certs.sh"

# The container image is the official rootless build: it runs as "vmail" and
# listens on high ports (31993 imaps, 34190 managesieve), which are published
# on the loopback interface only.
docker run -d --name "$CONTAINER_NAME" \
  -e USER_PASSWORD=testpass \
  -p "127.0.0.1:$IMAP_PORT:31993" \
  -p "127.0.0.1:$SIEVE_PORT:34190" \
  -v "$SCRIPT_DIR/docker/dovecot.conf:/etc/dovecot/conf.d/zz-pylos.conf:ro" \
  -v "$SCRIPT_DIR/docker/certs:/etc/dovecot/certs:ro" \
  "$IMAGE" >/dev/null

# Readiness is a real TLS handshake, certificate verification against the test
# CA, and the IMAP greeting - not a bare TCP accept. A listening socket does
# not prove the certificate loaded, and the client refuses unverified TLS.
# LOGOUT is written so openssl stays connected long enough to read the greeting.
probe_imaps() {
  printf 'x LOGOUT\r\n' | openssl s_client -quiet \
    -connect "127.0.0.1:$IMAP_PORT" -servername localhost \
    -CAfile "$CERT" -verify_return_error 2>&1
}

echo "Waiting for Dovecot to serve IMAPS on 127.0.0.1:$IMAP_PORT..."
ready=0
for _ in $(seq 1 30); do
  probe="$(probe_imaps 2>/dev/null || true)"
  case "$probe" in
    *"* OK"*)
      ready=1
      break
      ;;
  esac
  sleep 1
done

if [ "$ready" != 1 ]; then
  echo "Dovecot did not become ready on 127.0.0.1:$IMAP_PORT" >&2
  echo "--- last TLS probe ---" >&2
  probe_imaps >&2 || true
  echo "--- docker logs $CONTAINER_NAME ---" >&2
  docker logs "$CONTAINER_NAME" >&2 2>&1 || true
  exit 1
fi
echo "Dovecot is ready"

# Same rigor for ManageSieve, and the same reason: the sieve client refuses a
# server that will not do STARTTLS, so the probe has to prove the upgrade
# happens and that the certificate verifies, not merely that the port answers.
probe_sieve() {
  printf 'LOGOUT\r\n' | openssl s_client -quiet \
    -connect "127.0.0.1:$SIEVE_PORT" -starttls sieve -servername localhost \
    -CAfile "$CERT" -verify_return_error 2>&1
}

echo "Waiting for Dovecot to serve ManageSieve on 127.0.0.1:$SIEVE_PORT..."
sieve_ready=0
for _ in $(seq 1 30); do
  probe="$(probe_sieve 2>/dev/null || true)"
  case "$probe" in
    *"TLS negotiation successful"*)
      sieve_ready=1
      break
      ;;
  esac
  sleep 1
done

if [ "$sieve_ready" != 1 ]; then
  echo "Dovecot did not serve ManageSieve on 127.0.0.1:$SIEVE_PORT" >&2
  echo "--- last STARTTLS probe ---" >&2
  probe_sieve >&2 || true
  echo "--- docker logs $CONTAINER_NAME ---" >&2
  docker logs "$CONTAINER_NAME" >&2 2>&1 || true
  exit 1
fi
echo "ManageSieve is ready"

# The two scripts test/integration/sieve.test.ts reads. doveadm writes them
# through Dovecot's own sieve storage rather than into the mail directory by
# hand, so the layout stays the image's business rather than this script's.
seed_script() {
  docker exec -i "$CONTAINER_NAME" /dovecot/bin/doveadm sieve put "$@" >/dev/null
}

printf 'require "fileinto";\nif header :contains "subject" "spam" { fileinto "Trash"; }\n' \
  | seed_script -u tester -a filters

# Deliberately past the 1 kB body cap the truncation test configures, so the
# client is proven to cap content the renderer will not.
{
  i=0
  while [ "$i" -lt 200 ]; do
    echo '# padding, so that this script is comfortably larger than one kilobyte'
    i=$((i + 1))
  done
  echo 'keep;'
} | seed_script -u tester bulky

echo "Seeded sieve scripts: filters (active), bulky"

cd "$PROJECT_DIR"
RUN_INTEGRATION=1 PYLOS_IMAP_PORT="$IMAP_PORT" PYLOS_SIEVE_PORT="$SIEVE_PORT" \
  npx vitest run test/integration
