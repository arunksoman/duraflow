// Package config loads server configuration from config/config.yaml (optional — see Load) with
// DURAFLOW_-prefixed environment variable overrides (e.g. DURAFLOW_DATABASE_DRIVER=postgres).
package config

import (
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
	v.SetDefault("database.dsn", "./data/duraflow.db")
	v.SetDefault("auth.jwtSecret", "dev-only-change-me")
	v.SetDefault("auth.tokenTTL", "24h")
	v.SetDefault("seedAdmin.email", "admin@duraflow.local")
	v.SetDefault("seedAdmin.password", "changeme123")
	v.SetDefault("seedAdmin.name", "Admin")
	v.SetDefault("temporal.address", "localhost:7233")
	v.SetDefault("temporal.zigflowBinary", "zigflow")
	v.SetDefault("temporal.workflowsDir", "./data/workflows")

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

	return &cfg, nil
}

func (c *ServerConfig) Addr() string {
	return fmt.Sprintf("%s:%d", c.Host, c.Port)
}
