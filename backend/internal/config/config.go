// Package config loads server configuration from config/config.yaml (optional — see Load) with
// DURAFLOW_-prefixed environment variable overrides (e.g. DURAFLOW_DATABASE_DRIVER=postgres).
package config

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"os"
	"slices"
	"strings"
	"time"

	"github.com/spf13/viper"
)

// Roles a process can take. One binary serves every role; DURAFLOW_ROLES picks which ones a copy
// runs. The default runs both, which is the single-process mode `docker compose up` uses.
const (
	// RoleAPI serves REST, live run streams and CloudEvents ingest, and competes for the jobs
	// lock (completion watchers, resolver sweeps). Any number of copies.
	RoleAPI = "api"
	// RoleWorker runs the worker pool that executes workflows. Any number of copies.
	RoleWorker = "worker"
)

type Config struct {
	// Roles is a comma- or space-separated list of RoleAPI and RoleWorker, parsed into RoleSet.
	Roles     string          `mapstructure:"roles"`
	RoleSet   []string        `mapstructure:"-"`
	Server    ServerConfig    `mapstructure:"server"`
	Database  DatabaseConfig  `mapstructure:"database"`
	Auth      AuthConfig      `mapstructure:"auth"`
	SeedAdmin SeedAdminConfig `mapstructure:"seedAdmin"`
	Temporal  TemporalConfig  `mapstructure:"temporal"`
	Telemetry TelemetryConfig `mapstructure:"telemetry"`
	Worker    WorkerConfig    `mapstructure:"worker"`
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
	// Namespace every workflow runs in.
	Namespace string `mapstructure:"namespace"`
}

// WorkerConfig tunes the worker pool (the RoleWorker role): Temporal workers, one per task queue,
// that run every saved workflow through zigflow as a library. See internal/dslruntime.
type WorkerConfig struct {
	// Identity names this process on the Workers page and in Temporal. Defaults to <host>:<pid>.
	Identity string `mapstructure:"identity"`
	// RefreshInterval is how often the pool re-reads which task queues to poll.
	RefreshInterval time.Duration `mapstructure:"refreshInterval"`
	// HeartbeatInterval is how often the pool touches its Workers-page rows. A row not touched
	// for three intervals is shown offline.
	HeartbeatInterval time.Duration `mapstructure:"heartbeatInterval"`
	// DeadlockDetectionTimeout bounds one workflow task. It must exceed a DSL cache miss plus one
	// CloudEvent delivery, because zigflow's emitter blocks the workflow while it sends.
	DeadlockDetectionTimeout time.Duration `mapstructure:"deadlockDetectionTimeout"`
	// StopTimeout lets in-flight activities finish on shutdown.
	StopTimeout time.Duration `mapstructure:"stopTimeout"`
	// MaxConcurrentActivities and MaxConcurrentWorkflowTasks cap work per task queue per process.
	// 0 keeps the Temporal SDK defaults.
	MaxConcurrentActivities    int `mapstructure:"maxConcurrentActivities"`
	MaxConcurrentWorkflowTasks int `mapstructure:"maxConcurrentWorkflowTasks"`
	// CacheSize is how many compiled DSL versions each process keeps.
	CacheSize int `mapstructure:"cacheSize"`
	// EnvPrefix selects the environment variables exposed to DSL expressions as $env (prefix
	// stripped), as zigflow run's --env-prefix does. Must match on every copy.
	EnvPrefix string `mapstructure:"envPrefix"`
	// ContainerRuntime ("docker" or "kubernetes"), ContainerNamespace and
	// ContainerServiceAccount configure `run: container` tasks, as zigflow run's flags do.
	ContainerRuntime        string `mapstructure:"containerRuntime"`
	ContainerNamespace      string `mapstructure:"containerNamespace"`
	ContainerServiceAccount string `mapstructure:"containerServiceAccount"`
	// LogLevel is zigflow's own log level: trace, debug, info, warn or error.
	LogLevel string `mapstructure:"logLevel"`
}

// TelemetryConfig controls the CloudEvents channel every workflow reports task-level progress on.
// zigflow emits one CloudEvent per task lifecycle moment (dev.zigflow.task.started/completed/
// faulted/…); the API hosts the receiving sink, which is how the UI knows which nodes ran, with
// what input, and why one failed. Emission happens inline in the workflow goroutine and is *not*
// replay-guarded, so the timeout must stay small and the sink handler cheap.
type TelemetryConfig struct {
	// SinkURL is the absolute URL workflows POST CloudEvents to. Left empty it is derived from
	// Server.Port/Server.BasePath on the loopback interface, which only works when the process
	// also runs the api role. A worker-only copy must point it at the API, on an internal
	// address rather than the public load balancer.
	SinkURL string `mapstructure:"sinkURL"`
	// Token is the shared secret workflows send as X-Duraflow-Token. Left empty it is derived from
	// auth.jwtSecret, which every copy already shares, so all copies agree without extra config.
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
// local `go run`, but entirely optional), then DURAFLOW_* env var overrides.
func Load() (*Config, error) {
	v := viper.New()
	v.SetConfigName("config")
	v.SetConfigType("yaml")
	v.AddConfigPath("./config")
	v.AddConfigPath("../config")

	v.SetDefault("roles", RoleAPI+","+RoleWorker)
	v.SetDefault("server.host", "0.0.0.0")
	v.SetDefault("server.port", 8000)
	v.SetDefault("server.basePath", "/api")
	v.SetDefault("server.allowedOrigins", []string{"http://localhost:5173"})
	v.SetDefault("database.driver", "sqlite")
	// WAL + a busy timeout are not optional once telemetry is on: workflows write a steady stream
	// of events while the API reads concurrently, and the default rollback journal turns that
	// into "database is locked" almost immediately.
	v.SetDefault("database.dsn", "./data/duraflow.db?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)")
	v.SetDefault("auth.jwtSecret", "dev-only-change-me")
	v.SetDefault("auth.tokenTTL", "24h")
	v.SetDefault("seedAdmin.email", "admin@duraflow.local")
	v.SetDefault("seedAdmin.password", "changeme123")
	v.SetDefault("seedAdmin.name", "Admin")
	v.SetDefault("temporal.address", "localhost:7233")
	v.SetDefault("temporal.namespace", "default")
	v.SetDefault("worker.identity", "")
	v.SetDefault("worker.refreshInterval", "5s")
	v.SetDefault("worker.heartbeatInterval", "10s")
	v.SetDefault("worker.deadlockDetectionTimeout", "10s")
	v.SetDefault("worker.stopTimeout", "10s")
	v.SetDefault("worker.maxConcurrentActivities", 0)
	v.SetDefault("worker.maxConcurrentWorkflowTasks", 0)
	v.SetDefault("worker.cacheSize", 512)
	v.SetDefault("worker.envPrefix", "ZIGGY")
	v.SetDefault("worker.containerRuntime", "docker")
	v.SetDefault("worker.containerNamespace", "")
	v.SetDefault("worker.containerServiceAccount", "")
	v.SetDefault("worker.logLevel", "warn")
	// Empty, and filled in by deriveDefaults — but declared, because viper's Unmarshal only
	// consults DURAFLOW_* env vars for keys it already knows about.
	v.SetDefault("telemetry.sinkURL", "")
	v.SetDefault("telemetry.token", "")
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

	if err := cfg.parseRoles(); err != nil {
		return nil, err
	}
	// Validate before deriving defaults: a derived loopback sink URL would hide a missing one.
	if err := cfg.validate(); err != nil {
		return nil, err
	}
	cfg.deriveDefaults()

	return &cfg, nil
}

// parseRoles splits Roles on commas and whitespace and rejects anything unknown.
func (c *Config) parseRoles() error {
	fields := strings.FieldsFunc(c.Roles, func(r rune) bool {
		return r == ',' || r == ' ' || r == '\t' || r == '\n'
	})
	c.RoleSet = nil
	for _, f := range fields {
		role := strings.ToLower(f)
		switch role {
		case RoleAPI, RoleWorker:
			if !slices.Contains(c.RoleSet, role) {
				c.RoleSet = append(c.RoleSet, role)
			}
		default:
			return fmt.Errorf("roles: unknown role %q (want %q and/or %q)", f, RoleAPI, RoleWorker)
		}
	}
	if len(c.RoleSet) == 0 {
		return fmt.Errorf("roles: at least one of %q or %q is required", RoleAPI, RoleWorker)
	}
	return nil
}

// HasRole reports whether this process runs role.
func (c *Config) HasRole(role string) bool {
	return slices.Contains(c.RoleSet, role)
}

// SingleProcess reports whether this process runs every role, the only mode SQLite supports.
func (c *Config) SingleProcess() bool {
	return c.HasRole(RoleAPI) && c.HasRole(RoleWorker)
}

func (c *Config) validate() error {
	if !c.SingleProcess() && c.Database.Driver != "postgres" {
		return fmt.Errorf("roles %q: running the api and worker roles in separate processes "+
			"requires database.driver=postgres", c.Roles)
	}
	if !c.HasRole(RoleAPI) && c.Telemetry.SinkURL == "" {
		return errors.New("telemetry.sinkURL is required when a process runs the worker role " +
			"without the api role: point it at the API's /internal/zigflow/events endpoint")
	}
	return nil
}

// deriveDefaults fills in the values that can't be static defaults. The token is derived from the
// JWT secret rather than generated, so every copy of the backend computes the same one.
func (c *Config) deriveDefaults() {
	if c.Telemetry.SinkURL == "" {
		c.Telemetry.SinkURL = fmt.Sprintf(
			"http://127.0.0.1:%d%s/internal/zigflow/events",
			c.Server.Port, strings.TrimSuffix(c.Server.BasePath, "/"),
		)
	}
	if c.Telemetry.Token == "" {
		mac := hmac.New(sha256.New, []byte(c.Auth.JWTSecret))
		mac.Write([]byte("duraflow telemetry token"))
		c.Telemetry.Token = hex.EncodeToString(mac.Sum(nil))
	}
	if c.Worker.Identity == "" {
		host, err := os.Hostname()
		if err != nil || host == "" {
			host = "worker"
		}
		c.Worker.Identity = fmt.Sprintf("%s:%d", host, os.Getpid())
	}
}

func (c *ServerConfig) Addr() string {
	return fmt.Sprintf("%s:%d", c.Host, c.Port)
}
