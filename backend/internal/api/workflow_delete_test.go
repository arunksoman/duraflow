package api

import (
	"net/http"
	"path/filepath"
	"testing"
	"time"

	"github.com/danielgtaylor/huma/v2/humatest"

	"duraflow/backend/internal/config"
	"duraflow/backend/internal/db"
	"duraflow/backend/internal/dslruntime"
	"duraflow/backend/internal/events"
	"duraflow/backend/internal/models"
	"duraflow/backend/internal/temporalexec"
)

func dslFor(workflowType string) string {
	return "document:\n  dsl: 1.0.0\n  taskQueue: shared-queue\n  workflowType: " + workflowType +
		"\n  version: 0.0.1\ndo:\n  - noop:\n      set:\n        a: 1\n"
}

func newDeleteTestAPI(t *testing.T) (humatest.TestAPI, *Deps) {
	t.Helper()
	conn, err := db.Open(config.DatabaseConfig{Driver: "sqlite", DSN: filepath.Join(t.TempDir(), "test.db")})
	if err != nil {
		t.Fatal(err)
	}
	// Close before t.TempDir's cleanup, or Windows refuses to remove the open database file.
	sqlDB, err := conn.DB()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = sqlDB.Close() })
	// Nothing listens on port 1: Temporal calls fail fast and are skipped, as when it's down.
	temporal := temporalexec.NewLazyClient("127.0.0.1:1")
	bus := events.NewBroker()
	dslEnv, err := dslruntime.NewEnv()
	if err != nil {
		t.Fatal(err)
	}
	deps := &Deps{
		DB:       conn,
		Temporal: temporal,
		Runtime:  dslruntime.NewCache(dslEnv, dslruntime.DBStore{DB: conn}, 0),
		Bus:      bus,
		Resolver: temporalexec.NewResolver(conn, temporal, bus, 0),
	}
	_, api := humatest.New(t)
	registerProjectRoutes(api, deps, "/api")
	registerWorkflowRoutes(api, deps, "/api")
	return api, deps
}

// seedWorkflow creates a saved workflow (with its DSL version and registrations) and a finished run
// (plus a child run and events), the way real use leaves them.
func seedWorkflow(t *testing.T, deps *Deps, projectID, name string) models.Workflow {
	t.Helper()
	must := func(err error) {
		t.Helper()
		if err != nil {
			t.Fatal(err)
		}
	}
	wf := models.Workflow{ProjectID: projectID, Name: name, DSL: dslFor(name + "-type")}
	build := compileWorkflowDSL(deps, &wf)
	if build == nil {
		t.Fatalf("seed DSL does not build: %s", wf.DSLError)
	}
	must(storeWorkflow(deps.DB, &wf, build, true))

	root := models.Execution{WorkflowID: wf.ID, Status: models.ExecutionCompleted, StartedAt: time.Now()}
	must(deps.DB.Create(&root).Error)
	must(deps.DB.Model(&root).Update("root_execution_id", root.ID).Error)
	child := models.Execution{
		WorkflowID: wf.ID, Status: models.ExecutionCompleted, StartedAt: time.Now(),
		ParentExecutionID: &root.ID, RootExecutionID: root.ID,
	}
	must(deps.DB.Create(&child).Error)
	for i, execID := range []string{root.ID, child.ID} {
		must(deps.DB.Create(&models.ExecutionEvent{
			ExecutionID: execID, RootExecutionID: root.ID, WorkflowExecutionID: execID,
			EventType: "dev.zigflow.task.completed", DedupeKey: execID + string(rune('a'+i)),
		}).Error)
	}
	return wf
}

func count(t *testing.T, deps *Deps, model any, query string, args ...any) int64 {
	t.Helper()
	var n int64
	if err := deps.DB.Model(model).Where(query, args...).Count(&n).Error; err != nil {
		t.Fatal(err)
	}
	return n
}

func TestDeleteWorkflowRemovesRunsAndRegistrations(t *testing.T) {
	api, deps := newDeleteTestAPI(t)
	project := models.Project{Name: "p"}
	deps.DB.Create(&project)
	doomed := seedWorkflow(t, deps, project.ID, "doomed")
	kept := seedWorkflow(t, deps, project.ID, "kept")

	if resp := api.Delete("/api/workflows/" + doomed.ID); resp.Code != http.StatusNoContent {
		t.Fatalf("delete workflow: status %d: %s", resp.Code, resp.Body.String())
	}

	checks := []struct {
		name  string
		model any
		query string
		want  int64
	}{
		{"workflow row", &models.Workflow{}, "id = ?", 0},
		{"runs", &models.Execution{}, "workflow_id = ?", 0},
	}
	for _, c := range checks {
		if got := count(t, deps, c.model, c.query, doomed.ID); got != c.want {
			t.Errorf("%s left for deleted workflow: %d", c.name, got)
		}
		if got := count(t, deps, c.model, c.query, kept.ID); got == 0 {
			t.Errorf("%s of the other workflow were deleted too", c.name)
		}
	}
	if got := count(t, deps, &models.ExecutionEvent{}, "1 = 1"); got != 2 {
		t.Errorf("events: want only the other workflow's 2 left, got %d", got)
	}
	if got := count(t, deps, &models.WorkflowRegistration{}, "workflow_id = ?", doomed.ID); got != 0 {
		t.Errorf("registrations left for deleted workflow: %d", got)
	}
	if got := count(t, deps, &models.WorkflowRegistration{}, "workflow_id = ?", kept.ID); got != 1 {
		t.Errorf("other workflow's registrations removed")
	}
	// Versions are content-addressed and may be shared, so they stay.
	if got := count(t, deps, &models.DSLVersion{}, "hash = ?", doomed.CurrentHash); got != 1 {
		t.Errorf("DSL version of the deleted workflow removed")
	}
}

func TestDeleteProjectCascadesToItsWorkflows(t *testing.T) {
	api, deps := newDeleteTestAPI(t)
	doomed := models.Project{Name: "doomed"}
	other := models.Project{Name: "other"}
	deps.DB.Create(&doomed)
	deps.DB.Create(&other)
	a := seedWorkflow(t, deps, doomed.ID, "a")
	b := seedWorkflow(t, deps, doomed.ID, "b")
	c := seedWorkflow(t, deps, other.ID, "c")

	if resp := api.Delete("/api/projects/" + doomed.ID); resp.Code != http.StatusNoContent {
		t.Fatalf("delete project: status %d: %s", resp.Code, resp.Body.String())
	}

	if got := count(t, deps, &models.Project{}, "id = ?", doomed.ID); got != 0 {
		t.Errorf("project row left")
	}
	if got := count(t, deps, &models.Workflow{}, "project_id = ?", doomed.ID); got != 0 {
		t.Errorf("workflows left: %d", got)
	}
	if got := count(t, deps, &models.Execution{}, "workflow_id IN ?", []string{a.ID, b.ID}); got != 0 {
		t.Errorf("runs left: %d", got)
	}
	if got := count(t, deps, &models.WorkflowRegistration{}, "workflow_id IN ?", []string{a.ID, b.ID}); got != 0 {
		t.Errorf("registrations left: %d", got)
	}
	if got := count(t, deps, &models.Execution{}, "workflow_id = ?", c.ID); got != 2 {
		t.Errorf("other project's runs: want 2, got %d", got)
	}

	if resp := api.Delete("/api/projects/" + doomed.ID); resp.Code != http.StatusNotFound {
		t.Errorf("deleting again: want 404, got %d", resp.Code)
	}
}
