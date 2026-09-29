# Nightly database backups and dev snapshots (V2-PLAN.md §7.3, §7.5): pg_dump from the same major
# version as the server, uploaded with rclone.
FROM postgres:18
RUN apt-get update && apt-get install -y --no-install-recommends rclone ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY backup.sh /usr/local/bin/backup.sh
USER postgres
CMD ["/usr/local/bin/backup.sh"]
