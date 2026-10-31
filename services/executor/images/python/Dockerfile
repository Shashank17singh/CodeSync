FROM python:3.12-alpine3.20@sha256:25849f9599e06dfe4d11b552e06f5ac4cc2ad342054eb81f7877e611f6f87c66
# Removes setuid binaries, so no-new-privileges is not the only thing stopping them.
RUN find / -xdev -perm /6000 -type f -exec chmod a-s {} + 2>/dev/null || true
USER 10001:10001
