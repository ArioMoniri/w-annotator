# Build context is this directory: docker build -t w-relay relay/
FROM rust:1-alpine AS build
RUN apk add --no-cache musl-dev
WORKDIR /src
COPY Cargo.toml ./
COPY src ./src
COPY tests ./tests
RUN cargo build --release --bin w-relay \
 && strip target/release/w-relay

FROM scratch
COPY --from=build /src/target/release/w-relay /w-relay
ENV PORT=8787
EXPOSE 8787
USER 65534:65534
ENTRYPOINT ["/w-relay", "--host", "0.0.0.0"]
