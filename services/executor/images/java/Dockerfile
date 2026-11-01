FROM eclipse-temurin:21-jdk-alpine@sha256:b78a1d385da875588e21207f07dddf9a1418849971ae857fb24c8f3a7d441a72
# Removes setuid binaries, so no-new-privileges is not the only thing stopping them.
RUN find / -xdev -perm /6000 -type f -exec chmod a-s {} + 2>/dev/null || true
# The sandbox sets its own PATH, which does not include the JDK's folder.
RUN ln -s /opt/java/openjdk/bin/java /opt/java/openjdk/bin/javac /usr/local/bin/
USER 10001:10001
