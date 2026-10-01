# Nightly database backups and dev snapshots (V2-PLAN.md §7.3, §7.5): pg_dump from the same major
# version as the server, uploaded with rclone. rclone is the official build, the same version as in
# infra/server.Dockerfile: Debian's package (1.60) got "501 Not Implemented" from R2 on uploads.
FROM postgres:18 AS rclone
ARG RCLONE_VERSION=1.75.0
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl unzip \
  && ARCH="$(dpkg --print-architecture)" \
  && curl -fsSL -o /tmp/rclone.zip "https://downloads.rclone.org/v${RCLONE_VERSION}/rclone-v${RCLONE_VERSION}-linux-${ARCH}.zip" \
  && unzip -j /tmp/rclone.zip '*/rclone' -d /usr/local/bin

FROM postgres:18
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY --from=rclone /usr/local/bin/rclone /usr/local/bin/rclone
COPY backup.sh /usr/local/bin/backup.sh
USER postgres
CMD ["/usr/local/bin/backup.sh"]
