# Minimal image that just runs the Temporal CLI's dev server (embedded SQLite, no external DB) —
# the same tool `dev.ps1` used to download for local, non-Docker dev.
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
		curl \
		ca-certificates \
	&& rm -rf /var/lib/apt/lists/*

RUN set -eux; \
	arch="$(dpkg --print-architecture)"; \
	case "$arch" in \
		amd64) temporal_arch=amd64 ;; \
		arm64) temporal_arch=arm64 ;; \
		*) echo "unsupported architecture: $arch" >&2; exit 1 ;; \
	esac; \
	version="$(curl -fsSL https://api.github.com/repos/temporalio/cli/releases/latest | grep -m1 '"tag_name"' | cut -d'"' -f4 | sed 's/^v//')"; \
	curl -fsSL -o /tmp/temporal-cli.tar.gz \
		"https://github.com/temporalio/cli/releases/download/v${version}/temporal_cli_${version}_linux_${temporal_arch}.tar.gz"; \
	tar -xzf /tmp/temporal-cli.tar.gz -C /usr/local/bin temporal; \
	rm /tmp/temporal-cli.tar.gz; \
	temporal --version

EXPOSE 7233 8233

CMD ["temporal", "server", "start-dev", "--ip", "0.0.0.0"]
