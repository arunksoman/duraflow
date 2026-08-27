# Both the backend server and the zigflow CLI must live in this same image — the backend spawns
# `zigflow run` as a subprocess (os/exec), not over the network.
FROM golang:1.26-alpine AS build

WORKDIR /src
ENV CGO_ENABLED=0

COPY go.mod go.sum ./
RUN go mod download

COPY . .
RUN go build -o /out/server ./cmd/server
RUN go install github.com/zigflow/zigflow@latest && cp "$(go env GOPATH)/bin/zigflow" /out/zigflow

FROM alpine:3.20

RUN apk add --no-cache ca-certificates

COPY --from=build /out/server /usr/local/bin/server
COPY --from=build /out/zigflow /usr/local/bin/zigflow
COPY config /app/config

WORKDIR /app
EXPOSE 8000

CMD ["server"]
