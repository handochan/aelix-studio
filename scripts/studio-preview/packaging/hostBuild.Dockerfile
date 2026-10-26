FROM docker.io/library/node:22-bullseye@sha256:959fa6e5c12f4b08f58808f953c7a6a05f1f72629b57ef3a648b8809362fdad9 AS node-driver
FROM docker.io/library/rust:1.95.0-bullseye@sha256:28afaeb8445f2a2e7d878bd34ed39ba02bb517efb29986188cbd59b7cf4f2fdf
COPY --from=node-driver /usr/local/bin/node /usr/local/bin/node
RUN printf '%s\n' \
    'deb [check-valid-until=no] https://snapshot.debian.org/archive/debian/20260801T000000Z/ bullseye main' \
    'deb [check-valid-until=no] https://snapshot.debian.org/archive/debian-security/20260801T000000Z/ bullseye-security main' \
    > /etc/apt/sources.list \
    && rm -f /etc/apt/sources.list.d/* \
    && apt-get -o Acquire::Check-Valid-Until=false update \
    && apt-get install -y --no-install-recommends clang libclang-dev cmake \
    && rm -rf /var/lib/apt/lists/* \
    && chmod -R a+rwX /usr/local/cargo /usr/local/rustup
ARG STUDIO_RECIPE_SHA
LABEL org.aelix.host-build.recipe=${STUDIO_RECIPE_SHA}
