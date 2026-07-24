ARG TOMCAT_IMAGE=tomcat:10.1-jdk17-temurin
FROM ${TOMCAT_IMAGE}

ARG CMDBUILD_WAR_FILE=artifacts/cmdbuild-4.2.0.war
ARG CMDBUILD_WAR_SHA256

COPY ${CMDBUILD_WAR_FILE} /tmp/cmdbuild.war

RUN test -n "${CMDBUILD_WAR_SHA256}" \
    && printf '%s  %s\n' "${CMDBUILD_WAR_SHA256}" /tmp/cmdbuild.war | sha256sum -c - \
    && apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends ca-certificates curl \
    && curl -fsSL https://www.postgresql.org/media/keys/ACCC4CF8.asc -o /usr/share/keyrings/postgresql.asc \
    && printf '%s\n' 'deb [signed-by=/usr/share/keyrings/postgresql.asc] http://apt.postgresql.org/pub/repos/apt noble-pgdg main' > /etc/apt/sources.list.d/pgdg.list \
    && apt-get update \
    && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends postgresql-client-17 \
    && rm -rf /var/lib/apt/lists/* \
    && mkdir -p /usr/local/tomcat/webapps/cmdbuild /var/lib/cmdbuild42 \
    && cd /usr/local/tomcat/webapps/cmdbuild \
    && jar xf /tmp/cmdbuild.war \
    && chmod 0755 cmdbuild.sh \
    && rm /tmp/cmdbuild.war

RUN useradd --system --uid 10001 --create-home --home-dir /home/cmdbuild cmdbuild \
    && chown -R cmdbuild:cmdbuild /usr/local/tomcat/conf /usr/local/tomcat/logs /usr/local/tomcat/temp /usr/local/tomcat/webapps /usr/local/tomcat/work /var/lib/cmdbuild42

COPY entrypoint.sh /usr/local/bin/cmdbuild42-entrypoint
RUN chmod 0755 /usr/local/bin/cmdbuild42-entrypoint

EXPOSE 8080
USER cmdbuild
ENTRYPOINT ["/usr/local/bin/cmdbuild42-entrypoint"]
CMD ["catalina.sh", "run"]
