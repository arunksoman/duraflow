// Package config loads server configuration from config/config.yaml with
// DURAFLOW_-prefixed environment variable overrides (e.g. DURAFLOW_DATABASE_DRIVER=postgres).
package config

import (
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

// Load reads backend/config/config.yaml relative to the working directory,
// applying DURAFLOW_* environment overrides on top.
func Load() (*Config, error) {
	v := viper.New()
	v.SetConfigName("config")
	v.SetConfigType("yaml")
	v.AddConfigPath("./config")
	v.AddConfigPath("../config")

	v.SetEnvPrefix("duraflow")
	v.SetEnvKeyReplacer(strings.NewReplacer(".", "_"))
	v.AutomaticEnv()

	if err := v.ReadInConfig(); err != nil {
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
