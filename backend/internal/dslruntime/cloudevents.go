package dslruntime

import (
	"fmt"
	"os"
	"path/filepath"
	"time"

	"gopkg.in/yaml.v3"
)

// TelemetryTokenHeader carries the shared secret from a workflow's CloudEvents emitter to the
// ingest endpoint (api/telemetry.go).
const TelemetryTokenHeader = "X-Duraflow-Token"

// cloudEventsConfig mirrors zigflow's CloudEvents config file (pkg/cloudevents Events/ClientConfig).
type cloudEventsConfig struct {
	Clients []cloudEventsClient `yaml:"clients"`
}

type cloudEventsClient struct {
	Name     string         `yaml:"name"`
	Protocol string         `yaml:"protocol"`
	Target   string         `yaml:"target"`
	Options  map[string]any `yaml:"options,omitempty"`
}

// WriteCloudEventsConfig writes the emitter config every build in this process uses, pointing at
// the ingest endpoint, and returns its path. zigflow only reads this config from a file. An empty
// sinkURL disables task telemetry and returns "".
func WriteCloudEventsConfig(dir, sinkURL, token string, timeout time.Duration) (string, error) {
	if sinkURL == "" {
		return "", nil
	}
	if timeout <= 0 {
		timeout = time.Second
	}
	cfg := cloudEventsConfig{Clients: []cloudEventsClient{{
		Name:     "duraflow",
		Protocol: "http",
		Target:   sinkURL,
		Options: map[string]any{
			"method":  "POST",
			"timeout": timeout.String(),
			"headers": map[string]string{TelemetryTokenHeader: token},
		},
	}}}
	raw, err := yaml.Marshal(cfg)
	if err != nil {
		return "", fmt.Errorf("building the CloudEvents config: %w", err)
	}

	if dir == "" {
		dir = os.TempDir()
	}
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", fmt.Errorf("creating %s: %w", dir, err)
	}
	path := filepath.Join(dir, fmt.Sprintf("duraflow-cloudevents-%d.yaml", os.Getpid()))
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		return "", fmt.Errorf("writing the CloudEvents config: %w", err)
	}
	return path, nil
}
