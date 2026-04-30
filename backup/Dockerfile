FROM postgres:16-alpine
# Add GPG for encrypted backups; busybox-suid provides crontab support.
RUN apk add --no-cache gnupg busybox-suid
