FROM debian:bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends nginx libnginx-mod-rtmp gettext-base ca-certificates \
  && rm -rf /var/lib/apt/lists/*
COPY nginx.conf.template /etc/nginx/slot1-rtmp.conf.template
ENV NGINX_RUN_DIR=/run/nginx-rtmp \
    INGEST_RTMP_PORT=1935
EXPOSE 1935
# Render the hook address and secret into the config, then run in the foreground.
CMD ["/bin/sh", "-c", "mkdir -p \"$NGINX_RUN_DIR\" && envsubst '${SLOT1_HOOK_BASE} ${INGEST_HOOK_SECRET} ${INGEST_RTMP_PORT} ${NGINX_RUN_DIR}' < /etc/nginx/slot1-rtmp.conf.template > /etc/nginx/slot1-rtmp.conf && exec nginx -c /etc/nginx/slot1-rtmp.conf -g 'daemon off;'"]
