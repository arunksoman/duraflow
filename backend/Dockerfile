# One image for every role: the server binary embeds zigflow as a Go library (see
# internal/dslruntime), so there is no zigflow CLI to install. DURAFLOW_ROLES picks what a container
# runs: "api,worker" (the default, single process), "api" or "worker".
FROM golang:1.27-alpine AS build

WORKDIR /src
ENV CGO_ENABLED=0

COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN go build -o /out/server ./cmd/server

FROM alpine:3.20

RUN apk add --no-cache ca-certificates

COPY --from=build /out/server /usr/local/bin/server
# No config/ here on purpose — there is no config file in the repo. Load() has built-in
# defaults, and docker-compose.yml sets every value that actually needs to differ (secrets,
# temporal.address, roles) via DURAFLOW_* env vars, so changing them doesn't require rebuilding
# this image. Drop a config/config.yaml back in locally if you want a file instead of env vars for
# `go run` — Load() still reads one if present.

WORKDIR /app
EXPOSE 8000

CMD ["server"]
