FROM eclipse-temurin:21-jdk-alpine@sha256:b78a1d385da875588e21207f07dddf9a1418849971ae857fb24c8f3a7d441a72
ENV PMD_VERSION=7.29.0
RUN apk add --no-cache python3 py3-pip nodejs npm cppcheck=2.14.0-r0 unzip curl \
  && pip install --break-system-packages ruff==0.17.3 lizard==1.24.3 \
  && npm install -g eslint@10.14.0 @eslint/js@10.14.0 \
  && curl -fsSL -o /tmp/pmd.zip "https://github.com/pmd/pmd/releases/download/pmd_releases%2F${PMD_VERSION}/pmd-dist-${PMD_VERSION}-bin.zip" \
  && unzip -q /tmp/pmd.zip -d /opt \
  && ln -s "/opt/pmd-bin-${PMD_VERSION}/bin/pmd" /usr/local/bin/pmd \
  && rm /tmp/pmd.zip \
  && apk del curl unzip
COPY eslint.config.mjs /opt/analysis/eslint.config.mjs
# Removes setuid binaries, so no-new-privileges is not the only thing stopping them.
RUN find / -xdev -perm /6000 -type f -exec chmod a-s {} + 2>/dev/null || true
USER 10001:10001
