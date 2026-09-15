# Both the backend server and the zigflow CLI must live in this same image — the backend spawns
# `zigflow run` as a subprocess (os/exec), not over the network.
FROM golang:1.27-alpine AS build

WORKDIR /src
ENV CGO_ENABLED=0

COPY go.mod go.sum ./
RUN go mod download
RUN mkdir -p /out && go install github.com/zigflow/zigflow@latest && cp "$(go env GOPATH)/bin/zigflow" /out/zigflow

COPY . .
RUN go build -o /out/server ./cmd/server

FROM alpine:3.20

RUN apk add --no-cache ca-certificates

COPY --from=build /out/server /usr/local/bin/server
COPY --from=build /out/zigflow /usr/local/bin/zigflow
# No config/ here on purpose — there is no config file in the repo. Load() has built-in
# defaults, and docker-compose.yml sets every value that actually needs to differ (secrets,
# temporal.address) via DURAFLOW_* env vars, so changing them doesn't require rebuilding this
# image. Drop a config/config.yaml back in locally if you want a file instead of env vars for
# `go run` — Load() still reads one if present.

WORKDIR /app
EXPOSE 8000

CMD ["server"]
