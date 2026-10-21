FROM openeuler/openeuler:22.03-lts@sha256:ce16fc3edbd44ca0dcbc3d5c01f8e09242c7e73471f18b948d0add0f180d1a17 AS builder

RUN yum install -y gcc-c++ make python3 curl tar xz git ca-certificates && yum clean all
WORKDIR /tmp/node-download
RUN curl -fsS --retry 3 -O https://nodejs.org/dist/v22.20.0/node-v22.20.0-linux-x64.tar.xz \
    && curl -fsS --retry 3 -O https://nodejs.org/dist/v22.20.0/SHASUMS256.txt \
    && sha256sum --check --ignore-missing SHASUMS256.txt \
    && mkdir -p /opt/node \
    && tar -xJf node-v22.20.0-linux-x64.tar.xz --strip-components=1 -C /opt/node
ENV PATH=/opt/node/bin:$PATH
ENV ONNXRUNTIME_NODE_INSTALL=skip
WORKDIR /opt/paseo
COPY input-daemon/ packages/
COPY scripts/offline-openeuler/package.json install/package.json
COPY scripts/offline-openeuler/package-lock.json install/package-lock.json
RUN npm ci --prefix install --omit=dev --no-audit --no-fund \
    && install/node_modules/.bin/paseo --version
COPY scripts/offline-openeuler/paseo bin/paseo
COPY scripts/offline-openeuler/configure-relay-gateway.mjs bin/configure-relay-gateway.mjs
COPY scripts/offline-openeuler/verify-offline.mjs verify-offline.mjs
COPY scripts/offline-openeuler/README.txt README.txt
RUN chmod 755 bin/paseo bin/configure-relay-gateway.mjs \
    && cp packages/build-info.json build-info.json

# The check image has no compiler/toolchain packages added. Its only additions
# are the same Node version the target already has and the portable directory.
FROM openeuler/openeuler:22.03-lts@sha256:ce16fc3edbd44ca0dcbc3d5c01f8e09242c7e73471f18b948d0add0f180d1a17
COPY --from=builder /opt/node /opt/node
COPY --from=builder /opt/paseo /opt/paseo
ENV PATH=/opt/node/bin:/opt/paseo/bin:$PATH
ENTRYPOINT ["/opt/node/bin/node"]
