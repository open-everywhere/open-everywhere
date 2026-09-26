FROM node:24-alpine

RUN apk add --no-cache squid openssl wget ca-certificates \
  && ln -sf "$(command -v node)" /usr/bin/node \
  && mkdir -p /opt/oe-egress/control /var/lib/squid /opt/oe-egress/ca

WORKDIR /opt/oe-egress

COPY squid.conf tier-b.conf gen-ca.sh install-ca.sh entrypoint.sh ./
COPY control/ ./control/
RUN chmod +x gen-ca.sh install-ca.sh entrypoint.sh

EXPOSE 3128 8080

ENTRYPOINT ["/bin/sh", "/opt/oe-egress/entrypoint.sh"]
