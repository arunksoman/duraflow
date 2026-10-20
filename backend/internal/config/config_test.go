package config

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

// writeConfigFile puts a config/config.yaml under dir, where Load looks for one.
func writeConfigFile(t *testing.T, dir, contents string) {
	t.Helper()
	if err := os.Mkdir(filepath.Join(dir, "config"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "config", "config.yaml"), []byte(contents), 0o644); err != nil {
		t.Fatal(err)
	}
}

func TestLoadDefaults(t *testing.T) {
	t.Chdir(t.TempDir())
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Server.Port != 8000 || cfg.Server.BasePath != "/api" || cfg.Server.Addr() != "0.0.0.0:8000" {
		t.Errorf("server defaults: %+v", cfg.Server)
	}
	if cfg.Database.Driver != "sqlite" || cfg.Temporal.Address != "localhost:7233" {
		t.Errorf("database/temporal defaults: %+v %+v", cfg.Database, cfg.Temporal)
	}
	if cfg.Auth.TokenTTL != 24*time.Hour || cfg.Telemetry.Timeout != time.Second {
		t.Errorf("durations: ttl %v timeout %v", cfg.Auth.TokenTTL, cfg.Telemetry.Timeout)
	}
	if cfg.Telemetry.SinkURL != "http://127.0.0.1:8000/api/internal/zigflow/events" {
		t.Errorf("derived sink URL: %q", cfg.Telemetry.SinkURL)
	}
	if len(cfg.Telemetry.Token) != 64 {
		t.Errorf("generated token should be 32 hex bytes, got %q", cfg.Telemetry.Token)
	}
}

func TestLoadGeneratesFreshTokenEachBoot(t *testing.T) {
	t.Chdir(t.TempDir())
	a, _ := Load()
	b, _ := Load()
	if a.Telemetry.Token == b.Telemetry.Token {
		t.Error("two boots share a telemetry token")
	}
}

func TestLoadEnvOverrides(t *testing.T) {
	t.Chdir(t.TempDir())
	t.Setenv("DURAFLOW_SERVER_PORT", "9100")
	t.Setenv("DURAFLOW_SERVER_BASEPATH", "/v2/")
	t.Setenv("DURAFLOW_TELEMETRY_TOKEN", "fixed")
	t.Setenv("DURAFLOW_TEMPORAL_ADDRESS", "temporal:7233")
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Server.Port != 9100 || cfg.Temporal.Address != "temporal:7233" {
		t.Errorf("env not applied: %+v %+v", cfg.Server, cfg.Temporal)
	}
	if cfg.Telemetry.Token != "fixed" {
		t.Errorf("configured token replaced: %q", cfg.Telemetry.Token)
	}
	if cfg.Telemetry.SinkURL != "http://127.0.0.1:9100/v2/internal/zigflow/events" {
		t.Errorf("sink URL should trim the base path's trailing slash: %q", cfg.Telemetry.SinkURL)
	}
}

func TestLoadConfigFile(t *testing.T) {
	dir := t.TempDir()
	t.Chdir(dir)
	writeConfigFile(t, dir, "server:\n  port: 7000\ntelemetry:\n  sinkURL: http://sink/events\n")
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Server.Port != 7000 || cfg.Telemetry.SinkURL != "http://sink/events" {
		t.Errorf("file not applied: port %d sink %q", cfg.Server.Port, cfg.Telemetry.SinkURL)
	}
}

func TestLoadEnvBeatsConfigFile(t *testing.T) {
	dir := t.TempDir()
	t.Chdir(dir)
	writeConfigFile(t, dir, "server:\n  port: 7000\n")
	t.Setenv("DURAFLOW_SERVER_PORT", "7001")
	cfg, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if cfg.Server.Port != 7001 {
		t.Errorf("env should override file, got port %d", cfg.Server.Port)
	}
}

func TestLoadMalformedConfigFile(t *testing.T) {
	dir := t.TempDir()
	t.Chdir(dir)
	writeConfigFile(t, dir, "server: [unclosed")
	if _, err := Load(); err == nil {
		t.Error("malformed config file accepted")
	}
}

func TestLoadUnparseableValue(t *testing.T) {
	t.Chdir(t.TempDir())
	t.Setenv("DURAFLOW_AUTH_TOKENTTL", "forever")
	if _, err := Load(); err == nil {
		t.Error("invalid duration accepted")
	}
}
