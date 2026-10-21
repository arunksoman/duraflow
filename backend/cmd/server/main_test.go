package main

import (
	"path/filepath"
	"testing"
	"time"

	"gorm.io/gorm"

	"duraflow/backend/internal/api"
	"duraflow/backend/internal/auth"
	"duraflow/backend/internal/config"
	"duraflow/backend/internal/db"
	"duraflow/backend/internal/events"
	"duraflow/backend/internal/models"
	"duraflow/backend/internal/temporalexec"
	"duraflow/backend/internal/temporalexec/temporaltest"
)

func openTestDB(t *testing.T) *gorm.DB {
	t.Helper()
	conn, err := db.Open(config.DatabaseConfig{Driver: "sqlite", DSN: filepath.Join(t.TempDir(), "main.db")})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, _ := conn.DB()
	t.Cleanup(func() { _ = sqlDB.Close() })
	return conn
}

func TestSeedAdminOnlyOnEmptyDatabase(t *testing.T) {
	conn := openTestDB(t)
	cfg := &config.Config{SeedAdmin: config.SeedAdminConfig{Email: "admin@x", Password: "pw123456", Name: "Admin"}}

	if err := seedAdmin(cfg, conn); err != nil {
		t.Fatal(err)
	}
	var admin models.User
	if err := conn.First(&admin, "email = ?", "admin@x").Error; err != nil {
		t.Fatal(err)
	}
	if admin.Role != models.RoleAdmin || !auth.CheckPassword(admin.PasswordHash, "pw123456") {
		t.Errorf("admin: %+v", admin)
	}

	cfg.SeedAdmin.Email = "second@x"
	if err := seedAdmin(cfg, conn); err != nil {
		t.Fatal(err)
	}
	var n int64
	conn.Model(&models.User{}).Count(&n)
	if n != 1 {
		t.Errorf("seeding again should be a no-op, have %d users", n)
	}
}

func TestSeedAdminFailsWithoutUsersTable(t *testing.T) {
	conn := openTestDB(t)
	if err := conn.Migrator().DropTable(&models.User{}); err != nil {
		t.Fatal(err)
	}
	if err := seedAdmin(&config.Config{}, conn); err == nil {
		t.Error("missing users table should fail")
	}
}

func TestBackfillWorkflowHeaders(t *testing.T) {
	conn := openTestDB(t)
	legacy := models.Workflow{ProjectID: "p", Name: "legacy",
		DSL: "document:\n  taskQueue: q\n  workflowType: legacyType\ndo: []\n"}
	broken := models.Workflow{ProjectID: "p", Name: "broken", DSL: "document: ["}
	headerless := models.Workflow{ProjectID: "p", Name: "headerless", DSL: "do: []\n"}
	current := models.Workflow{ProjectID: "p", Name: "current", DSL: "document:\n  taskQueue: q2\n  workflowType: new\n",
		WorkflowType: "keep", TaskQueue: "keep-q"}
	for _, wf := range []*models.Workflow{&legacy, &broken, &headerless, &current} {
		if err := conn.Create(wf).Error; err != nil {
			t.Fatal(err)
		}
	}

	backfillWorkflowHeaders(conn)

	get := func(id string) models.Workflow {
		var wf models.Workflow
		conn.First(&wf, "id = ?", id)
		return wf
	}
	if got := get(legacy.ID); got.WorkflowType != "legacyType" || got.TaskQueue != "q" {
		t.Errorf("legacy not backfilled: %+v", got)
	}
	if got := get(broken.ID); got.WorkflowType != "" {
		t.Errorf("broken DSL backfilled: %+v", got)
	}
	if got := get(headerless.ID); got.WorkflowType != "" {
		t.Errorf("headerless DSL backfilled: %+v", got)
	}
	if got := get(current.ID); got.WorkflowType != "keep" {
		t.Errorf("already-filled row overwritten: %+v", got)
	}
}

func TestStartWorkflowWorkersWithoutZigflow(t *testing.T) {
	conn := openTestDB(t)
	conn.Create(&models.Workflow{ProjectID: "p", Name: "w", DSL: "document: {}\n"})
	workers := temporalexec.NewWorkerManager(
		config.TemporalConfig{ZigflowBinary: "zigflow-not-installed", WorkflowsDir: t.TempDir()},
		config.TelemetryConfig{},
	)
	startWorkflowWorkers(conn, workers) // no binary: nothing to start, and nothing breaks
}

func TestResumeRunningExecutions(t *testing.T) {
	conn := openTestDB(t)
	fake := temporaltest.New()
	fake.DefaultResult = temporaltest.Result{Value: "ok"}
	lazy := temporalexec.NewStaticClient(fake)
	bus := events.NewBroker()
	deps := &api.Deps{DB: conn, Temporal: lazy, Bus: bus, Resolver: temporalexec.NewResolver(conn, lazy, bus, 0)}

	running := models.Execution{WorkflowID: "w", Status: models.ExecutionRunning, StartedAt: time.Now()}
	finished := models.Execution{WorkflowID: "w", Status: models.ExecutionFailed, StartedAt: time.Now()}
	conn.Create(&running)
	conn.Create(&finished)

	resumeRunningExecutions(conn, deps)

	deadline := time.Now().Add(5 * time.Second)
	for {
		var got models.Execution
		conn.First(&got, "id = ?", running.ID)
		if got.Status == models.ExecutionCompleted {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("resumed run never closed: %+v", got)
		}
		time.Sleep(10 * time.Millisecond)
	}
	var stillFailed models.Execution
	conn.First(&stillFailed, "id = ?", finished.ID)
	if stillFailed.Status != models.ExecutionFailed {
		t.Error("finished runs must not be touched")
	}
}
