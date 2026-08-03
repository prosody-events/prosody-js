# syntax=docker/dockerfile:1

FROM node:22-bookworm AS chef

RUN curl --proto '=https' --tlsv1.2 --silent --show-error --fail https://sh.rustup.rs \
      | sh -s -- -y \
    && /root/.cargo/bin/cargo install cargo-chef --version 0.1.77 --locked

ENV PATH="/root/.cargo/bin:${PATH}"
WORKDIR /workspace

FROM chef AS planner
COPY . .
RUN cargo chef prepare --recipe-path recipe.json

FROM chef AS builder
ARG RUST_TARGET
ARG RUSTFLAGS
ENV RUSTFLAGS="${RUSTFLAGS}"
ENV CC_aarch64_unknown_linux_gnu=aarch64-linux-gnu-gcc
ENV CXX_aarch64_unknown_linux_gnu=aarch64-linux-gnu-g++
ENV CARGO_TARGET_AARCH64_UNKNOWN_LINUX_GNU_LINKER=aarch64-linux-gnu-gcc

RUN apt-get update \
    && apt-get install -y --no-install-recommends cmake libcurl4-openssl-dev \
    && if [ "${RUST_TARGET}" = 'x86_64-unknown-linux-gnu' ]; then \
         apt-get install -y --no-install-recommends mold; \
       else \
         dpkg --add-architecture arm64 \
         && apt-get update \
         && apt-get install -y --no-install-recommends \
              gcc-aarch64-linux-gnu \
              g++-aarch64-linux-gnu \
              zlib1g-dev:arm64 \
              libcurl4-openssl-dev:arm64 \
         && mkdir -p /usr/aarch64-linux-gnu/include \
         && ln -sf /usr/include/aarch64-linux-gnu/curl /usr/aarch64-linux-gnu/include/curl; \
       fi \
    && rm -rf /var/lib/apt/lists/* \
    && rustup target add "${RUST_TARGET}"

COPY --from=planner /workspace/recipe.json recipe.json
RUN --mount=type=cache,target=/root/.cargo/registry \
    --mount=type=cache,target=/root/.cargo/git \
    --mount=type=cache,target=/workspace/target \
    cargo chef cook --release --target "${RUST_TARGET}" --recipe-path recipe.json

COPY package.json yarn.lock .yarnrc.yml ./
COPY .yarn .yarn
RUN --mount=type=cache,target=/root/.yarn/berry/cache yarn install --immutable

COPY . .
RUN --mount=type=cache,target=/root/.cargo/registry \
    --mount=type=cache,target=/root/.cargo/git \
    --mount=type=cache,target=/workspace/target \
    yarn build --target "${RUST_TARGET}" \
    && mkdir /output \
    && cp prosody.*.node bindings.js bindings.d.ts /output/

FROM scratch AS artifact
COPY --from=builder /output/ /
