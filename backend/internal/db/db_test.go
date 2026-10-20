package db

import (
	"path/filepath"
	"testing"

	"duraflow/backend/internal/config"
	"duraflow/backend/internal/models"
)

func TestOpenSQLiteMigrates(t *testing.T) {
	// An empty driver means sqlite.
	conn, err := Open(config.DatabaseConfig{Driver: "", DSN: filepath.Join(t.TempDir(), "t.db")})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, _ := conn.DB()
	t.Cleanup(func() { _ = sqlDB.Close() })

	for _, m := range []any{
		&models.User{}, &models.Project{}, &models.Workflow{}, &models.Execution{},
		&models.Worker{}, &models.ExecutionEvent{}, &models.WorkflowExecutionRef{},
	} {
		if !conn.Migrator().HasTable(m) {
			t.Errorf("table for %T not migrated", m)
		}
	}
	if !conn.Migrator().HasColumn(&models.Execution{}, "run_trigger") {
		t.Error("executions.run_trigger column missing")
	}

	p := models.Project{Name: "p"}
	if err := conn.Create(&p).Error; err != nil {
		t.Fatal(err)
	}
	if p.ID == "" {
		t.Error("BeforeCreate did not assign a UUID")
	}
}

func TestOpenRejectsUnknownDriver(t *testing.T) {
	if _, err := Open(config.DatabaseConfig{Driver: "mysql"}); err == nil {
		t.Error("unknown driver accepted")
	}
}

func TestOpenPostgresUnreachable(t *testing.T) {
	_, err := Open(config.DatabaseConfig{
		Driver: "postgres",
		DSN:    "host=127.0.0.1 port=1 user=x dbname=x sslmode=disable connect_timeout=1",
	})
	if err == nil {
		t.Error("expected connection error")
	}
}
