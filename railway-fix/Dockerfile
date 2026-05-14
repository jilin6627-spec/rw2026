FROM alpine:3.21.3
ENV NODE_VERSION=18.20.8
RUN addgroup -g 1000 node && adduser -u 1000 -G node -s /bin/sh -D node && \
    apk add --no-cache libstdc++ curl && \
    ARCH= OPENSSL_ARCH='linux*' && alpineArch="$(apk --print-arch)" && \
    case "${alpineArch##*-}" in \
      x86_64) ARCH='x64' CHECKSUM="2c75d5d562d3ffc049ca1bbea65b68ae6bd0ec50ed04b1f606e065eaf35e8599";;
      x86) OPENSSL_ARCH=linux-elf;;
      aarch64) OPENSSL_ARCH=linux-aarch64;;
      arm*) OPENSSL_ARCH=linux-armv4;;
      ppc64le) OPENSSL_ARCH=linux-ppc64le;;
      s390x) OPENSSL_ARCH=linux-s390x;;
    esac && \
    if [ -n "${CHECKSUM}" ]; then \
      set -eu; \
      curl -fsSLO --compressed "https://unofficial-builds.nodejs.org/download/release/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${ARCH}-musl.tar.xz"; \
      echo "${CHECKSUM}  node-v${NODE_VERSION}-linux-${ARCH}-musl.tar.xz" | sha256sum -c - && \
      tar -xJf "node-v${NODE_VERSION}-linux-${ARCH}-musl.tar.xz" -C /usr/local --strip-components=1 --no-same-owner && \
      ln -s /usr/local/bin/node /usr/local/bin/nodejs; \
    else echo "Unsupported arch" && exit 1; fi
RUN mkdir -p /app/tmp && chown -R node:node /app
WORKDIR /app
USER node
COPY --chown=node:node tmp/xray /app/tmp/xray
COPY --chown=node:node tmp/xray-config.json.template /app/tmp/config.json.template
COPY --chown=node:node index_official.js .
COPY --chown=node:node docker-entrypoint.sh /usr/local/bin/docker-entrypoint.sh
RUN chmod +x /usr/local/bin/docker-entrypoint.sh /app/tmp/xray
ENV PORT=3000 NODE_ENV=production FILE_PATH=/app/tmp
ENTRYPOINT ["docker-entrypoint.sh"]
CMD ["node", "index_official.js"]
EXPOSE 3000
