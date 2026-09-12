// Package config loads server configuration from config/config.yaml (optional — see Load) with
// DURAFLOW_-prefixed environment variable overrides (e.g. DURAFLOW_DATABASE_DRIVER=postgres).
package config

import (
	"crypto/rand"
	"encoding/hex"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/spf13/viper"
)

type Config struct {
	Server    ServerConfig    `mapstructure:"server"`
	Database  DatabaseConfig  `mapstructure:"database"`
	Auth      AuthConfig      `mapstructure:"auth"`
	SeedAdmin SeedAdminConfig `mapstructure:"seedAdmin"`
	Temporal  TemporalConfig  `mapstructure:"temporal"`
	Telemetry TelemetryConfig `mapstructure:"telemetry"`
}

type ServerConfig struct {
	Host           string   `mapstructure:"host"`
	Port           int      `mapstructure:"port"`
	BasePath       string   `mapstructure:"basePath"`
	AllowedOrigins []string `mapstructure:"allowedOrigins"`
}

type DatabaseConfig struct {
	Driver string `mapstructure:"driver"`
	DSN    string `mapstructure:"dsn"`
}

type AuthConfig struct {
	JWTSecret string        `mapstructure:"jwtSecret"`
	TokenTTL  time.Duration `mapstructure:"tokenTTL"`
}

type SeedAdminConfig struct {
	Email    string `mapstructure:"email"`
	Password string `mapstructure:"password"`
	Name     string `mapstructure:"name"`
}

type TemporalConfig struct {
	// Address of the Temporal frontend gRPC service, e.g. localhost:7233.
	Address string `mapstructure:"address"`
	// ZigflowBinary is the `zigflow` executable to run — a bare name resolves via PATH.
	ZigflowBinary string `mapstructure:"zigflowBinary"`
	// WorkflowsDir is where each workflow's DSL is materialized to a YAML file for `zigflow run -f`.
	WorkflowsDir string `mapstructure:"workflowsDir"`
}

// TelemetryConfig controls the CloudEvents channel every spawned `zigflow run` worker reports
// task-level progress on. zigflow emits one CloudEvent per task lifecycle moment
// (dev.zigflow.task.started/completed/faulted/…) when given `--cloudevents-config`; this server
// hosts the receiving sink, which is how the UI knows which nodes ran, with what input, and why
// one failed. Emission happens inline in the workflow goroutine and is *not* replay-guarded, so
// the timeout must stay small and the sink handler cheap.
type TelemetryConfig struct {
	// SinkURL is the absolute URL workers POST CloudEvents to. Left empty it is derived at
	// startup from Server.Port/Server.BasePath on the loopback interface.
	SinkURL string `mapstructure:"sinkURL"`
	// Token is the shared secret workers send as X-Duraflow-Token. Left empty a random one is
	// generated per boot — workers are spawned by this process, so they always get the current value.
	Token string `mapstructure:"token"`
	// Timeout bounds a single event delivery. Every workflow task waits on it, so keep it low.
	Timeout time.Duration `mapstructure:"timeout"`
	// MaxEventBytes caps a stored event's payload; zigflow ships the whole workflow state in
	// every event, which otherwise dominates the database.
	MaxEventBytes int `mapstructure:"maxEventBytes"`
	// RetentionPerExecution caps how many events are kept per execution, newest wins.
	RetentionPerExecution int `mapstructure:"retentionPerExecution"`
}

// Load applies, in increasing precedence: built-in defaults (below) — enough on their own to
// boot the app, and all the Docker image needs since docker-compose.yml sets the values that
// matter as DURAFLOW_* env vars — then backend/config/config.yaml if present (convenient for
// local `go run`, but entirely optional, unlike before), then DURAFLOW_* env var overrides.
func Load() (*Config, error) {
	v := viper.New()
	v.SetConfigName("config")
	v.SetConfigType("yaml")
	v.AddConfigPath("./config")
	v.AddConfigPath("../config")

	v.SetDefault("server.host", "0.0.0.0")
	v.SetDefault("server.port", 8000)
	v.SetDefault("server.basePath", "/api")
	v.SetDefault("server.allowedOrigins", []string{"http://localhost:5173"})
	v.SetDefault("database.driver", "sqlite")
	// WAL + a busy timeout are not optional once telemetry is on: workers write a steady stream
	// of events while the API reads concurrently, and the default rollback journal turns that
	// into "database is locked" almost immediately.
	v.SetDefault("database.dsn", "./data/duraflow.db?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)")
	v.SetDefault("auth.jwtSecret", "dev-only-change-me")
	v.SetDefault("auth.tokenTTL", "24h")
	v.SetDefault("seedAdmin.email", "admin@duraflow.local")
	v.SetDefault("seedAdmin.password", "changeme123")
	v.SetDefault("seedAdmin.name", "Admin")
	v.SetDefault("temporal.address", "localhost:7233")
	v.SetDefault("temporal.zigflowBinary", "zigflow")
	v.SetDefault("temporal.workflowsDir", "./data/workflows")
	v.SetDefault("telemetry.timeout", "1s")
	v.SetDefault("telemetry.maxEventBytes", 65536)
	v.SetDefault("telemetry.retentionPerExecution", 2000)

	v.SetEnvPrefix("duraflow")
	v.SetEnvKeyReplacer(strings.NewReplacer(".", "_"))
	v.AutomaticEnv()

	var notFound viper.ConfigFileNotFoundError
	if err := v.ReadInConfig(); err != nil && !errors.As(err, &notFound) {
		return nil, fmt.Errorf("reading config: %w", err)
	}

	var cfg Config
	if err := v.Unmarshal(&cfg); err != nil {
		return nil, fmt.Errorf("parsing config: %w", err)
	}

	if err := cfg.deriveTelemetryDefaults(); err != nil {
		return nil, err
	}

	return &cfg, nil
}

// deriveTelemetryDefaults fills in the two telemetry fields that can't be static defaults: the
// sink URL depends on the server's own port/base path, and the shared token is generated fresh
// per boot unless one was configured. Loopback is deliberate — `zigflow run` workers are child
// processes of this server, so they always share its network namespace.
func (c *Config) deriveTelemetryDefaults() error {
	if c.Telemetry.SinkURL == "" {
		c.Telemetry.SinkURL = fmt.Sprintf(
			"http://127.0.0.1:%d%s/internal/zigflow/events",
			c.Server.Port, strings.TrimSuffix(c.Server.BasePath, "/"),
		)
	}
	if c.Telemetry.Token == "" {
		buf := make([]byte, 32)
		if _, err := rand.Read(buf); err != nil {
			return fmt.Errorf("generating telemetry token: %w", err)
		}
		c.Telemetry.Token = hex.EncodeToString(buf)
	}
	return nil
}

func (c *ServerConfig) Addr() string {
	return fmt.Sprintf("%s:%d", c.Host, c.Port)
}
