ARG BASE_IMAGE=golang:1.25.11-alpine@sha256:523c3effe300580ed375e43f43b1c9b091b68e935a7c3a92bfcc4e7ed55b18c2

FROM ${BASE_IMAGE}

ARG CUSTOM_CA_REQUIRED=false
ARG APK_REPOSITORIES_REQUIRED=false

USER root

COPY customer-ca/ /tmp/customer-ca/
COPY apk-repositories /tmp/apk-repositories

RUN set -eu; \
  if [ "$CUSTOM_CA_REQUIRED" = 'true' ]; then \
    test -n "$(find /tmp/customer-ca -type f \( -name '*.crt' -o -name '*.pem' \) -print -quit)"; \
    mkdir -p /usr/local/share/ca-certificates /etc/ssl/certs; \
    find /tmp/customer-ca -type f \( -name '*.crt' -o -name '*.pem' \) -exec cp {} /usr/local/share/ca-certificates/ \;; \
    for certificate in /usr/local/share/ca-certificates/*.crt /usr/local/share/ca-certificates/*.pem; do \
      [ -e "$certificate" ] || continue; \
      grep -c -- '-----BEGIN CERTIFICATE-----' "$certificate" | grep -qx '1'; \
    done; \
    for certificate in /usr/local/share/ca-certificates/*.pem; do \
      [ -e "$certificate" ] || continue; \
      cp "$certificate" "${certificate%.pem}.crt"; \
    done; \
    cat /usr/local/share/ca-certificates/*.crt >> /etc/ssl/cert.pem; \
  fi; \
  if [ "$APK_REPOSITORIES_REQUIRED" = 'true' ]; then \
    test -s /tmp/apk-repositories; \
    install -m 0644 /tmp/apk-repositories /etc/apk/repositories; \
  fi; \
  apk add --no-cache ca-certificates; \
  update-ca-certificates

USER root
