package api

import (
	"errors"
	"net/http"
	"testing"

	"duraflow/backend/internal/models"
	"duraflow/backend/internal/temporalexec"
)

func TestProjectCRUD(t *testing.T) {
	env := newTestEnv(t)

	var created models.Project
	env.expect(http.MethodPost, "/api/projects", map[string]string{"name": "Billing", "description": "money"},
		http.StatusCreated, &created)
	if created.ID == "" || created.Name != "Billing" || created.Description != "money" {
		t.Fatalf("created: %+v", created)
	}
	env.seedWorkflowRow(created.ID, "a", "")
	env.seedWorkflowRow(created.ID, "b", "")
	env.seedProject("Empty")

	var list []models.Project
	env.expect(http.MethodGet, "/api/projects", nil, http.StatusOK, &list)
	if len(list) != 2 {
		t.Fatalf("list: %+v", list)
	}
	counts := map[string]int{}
	for _, p := range list {
		counts[p.Name] = p.WorkflowCount
	}
	if counts["Billing"] != 2 || counts["Empty"] != 0 {
		t.Errorf("workflow counts: %v", counts)
	}

	var got models.Project
	env.expect(http.MethodGet, "/api/projects/"+created.ID, nil, http.StatusOK, &got)
	if got.WorkflowCount != 2 {
		t.Errorf("get: %+v", got)
	}

	var renamed models.Project
	env.expect(http.MethodPatch, "/api/projects/"+created.ID, map[string]string{"name": "Payments"}, http.StatusOK, &renamed)
	if renamed.Name != "Payments" || renamed.Description != "money" || renamed.WorkflowCount != 2 {
		t.Errorf("rename should keep the description: %+v", renamed)
	}
	var cleared models.Project
	env.expect(http.MethodPatch, "/api/projects/"+created.ID, map[string]string{"description": ""}, http.StatusOK, &cleared)
	if cleared.Description != "" || cleared.Name != "Payments" {
		t.Errorf("clearing description: %+v", cleared)
	}

	for _, method := range []string{http.MethodGet, http.MethodPatch, http.MethodDelete} {
		var body any
		if method == http.MethodPatch {
			body = map[string]string{"name": "x"}
		}
		if resp := env.request(method, "/api/projects/missing", body); resp.Status != http.StatusNotFound {
			t.Errorf("%s missing project: %d", method, resp.Status)
		}
	}
	if resp := env.request(http.MethodPost, "/api/projects", map[string]string{"description": "no name"}); resp.Status != http.StatusUnprocessableEntity {
		t.Errorf("create without name: %d", resp.Status)
	}
}

func TestWorkflowCRUD(t *testing.T) {
	env := newTestEnv(t)
	project := env.seedProject("p")

	if resp := env.request(http.MethodPost, "/api/projects/missing/workflows", map[string]string{"name": "x"}); resp.Status != http.StatusNotFound {
		t.Errorf("create in missing project: %d", resp.Status)
	}

	var wf models.Workflow
	env.expect(http.MethodPost, "/api/projects/"+project.ID+"/workflows",
		map[string]string{"name": "orders", "description": "d", "dsl": testDSL("ordersType", "orders-q", "")},
		http.StatusCreated, &wf)
	if wf.WorkflowType != "ordersType" || wf.TaskQueue != "orders-q" || wf.Version != 1 {
		t.Fatalf("created: %+v", wf)
	}
	var worker models.Worker
	if err := env.deps.DB.First(&worker, "identity = ? AND task_queue = ?", "orders", "orders-q").Error; err != nil {
		t.Fatalf("worker row not registered: %v", err)
	}
	if worker.Status != models.WorkerOnline {
		t.Errorf("worker status %q", worker.Status)
	}

	var draft models.Workflow
	env.expect(http.MethodPost, "/api/projects/"+project.ID+"/workflows", map[string]string{"name": "draft"}, http.StatusCreated, &draft)
	var n int64
	env.deps.DB.Model(&models.Worker{}).Where("identity = ?", "draft").Count(&n)
	if n != 0 {
		t.Error("a workflow without a DSL should not get a worker row")
	}

	var list []models.Workflow
	env.expect(http.MethodGet, "/api/projects/"+project.ID+"/workflows", nil, http.StatusOK, &list)
	if len(list) != 2 {
		t.Errorf("list: %+v", list)
	}
	env.expect(http.MethodGet, "/api/projects/other/workflows", nil, http.StatusOK, &list)
	if len(list) != 0 {
		t.Errorf("other project's list: %+v", list)
	}

	var got models.Workflow
	env.expect(http.MethodGet, "/api/workflows/"+wf.ID, nil, http.StatusOK, &got)
	if got.Name != "orders" || got.DSL != wf.DSL {
		t.Errorf("get: %+v", got)
	}

	// Renaming without touching the DSL keeps the version.
	var updated models.Workflow
	env.expect(http.MethodPatch, "/api/workflows/"+wf.ID, map[string]string{"name": "orders2", "description": "new"}, http.StatusOK, &updated)
	if updated.Version != 1 || updated.Name != "orders2" || updated.Description != "new" {
		t.Errorf("rename: %+v", updated)
	}
	// Re-sending the same DSL is not a change either.
	env.expect(http.MethodPatch, "/api/workflows/"+wf.ID, map[string]string{"dsl": wf.DSL}, http.StatusOK, &updated)
	if updated.Version != 1 {
		t.Errorf("unchanged DSL bumped the version to %d", updated.Version)
	}
	env.expect(http.MethodPatch, "/api/workflows/"+wf.ID, map[string]string{"dsl": testDSL("v2Type", "v2-q", "")}, http.StatusOK, &updated)
	if updated.Version != 2 || updated.WorkflowType != "v2Type" || updated.TaskQueue != "v2-q" {
		t.Errorf("DSL change: %+v", updated)
	}
	// A DSL that doesn't parse (normal mid-edit) clears the derived columns.
	var broken models.Workflow
	env.expect(http.MethodPatch, "/api/workflows/"+wf.ID, map[string]string{"dsl": "document: [broken"}, http.StatusOK, &broken)
	if broken.Version != 3 || broken.WorkflowType != "" || broken.TaskQueue != "" {
		t.Errorf("broken DSL: %+v", broken)
	}

	for _, method := range []string{http.MethodGet, http.MethodPatch, http.MethodDelete} {
		var body any
		if method == http.MethodPatch {
			body = map[string]string{"name": "x"}
		}
		if resp := env.request(method, "/api/workflows/missing", body); resp.Status != http.StatusNotFound {
			t.Errorf("%s missing workflow: %d", method, resp.Status)
		}
	}
}

func TestStopWorkerRegistrationMarksOffline(t *testing.T) {
	env := newTestEnv(t)
	wf := env.seedWorkflowRow("p", "w", testDSL("t", "q", ""))
	syncWorkerRegistration(env.deps, t.Context(), wf)
	stopWorkerRegistration(env.deps, t.Context(), wf)

	var worker models.Worker
	if err := env.deps.DB.First(&worker, "identity = ?", "w").Error; err != nil {
		t.Fatal(err)
	}
	if worker.Status != models.WorkerOffline {
		t.Errorf("status %q", worker.Status)
	}

	// No task queue, nothing to record.
	stopWorkerRegistration(env.deps, t.Context(), models.Workflow{Base: models.Base{ID: "x"}, Name: "x", DSL: "nope: ["})
	var n int64
	env.deps.DB.Model(&models.Worker{}).Count(&n)
	if n != 1 {
		t.Errorf("worker rows: %d", n)
	}
}

func TestWorkers(t *testing.T) {
	env := newTestEnv(t)

	var w models.Worker
	env.expect(http.MethodPost, "/api/workers", map[string]string{"identity": "w1", "taskQueue": "q"}, http.StatusOK, &w)
	if w.ID == "" || w.Status != models.WorkerOnline {
		t.Fatalf("registered: %+v", w)
	}
	upsertWorker(env.deps, t.Context(), "w1", "q", models.WorkerDraining)
	var again models.Worker
	env.expect(http.MethodPost, "/api/workers", map[string]string{"identity": "w1", "taskQueue": "q"}, http.StatusOK, &again)
	if again.ID != w.ID || again.Status != models.WorkerOnline || !again.LastHeartbeatAt.After(w.LastHeartbeatAt) {
		t.Errorf("heartbeat should update the same row: %+v vs %+v", again, w)
	}
	env.expect(http.MethodPost, "/api/workers", map[string]string{"identity": "w2", "taskQueue": "q"}, http.StatusOK, nil)

	var list []models.Worker
	env.expect(http.MethodGet, "/api/workers", nil, http.StatusOK, &list)
	if len(list) != 2 || list[0].Identity != "w2" {
		t.Errorf("list should be newest heartbeat first: %+v", list)
	}

	upsertWorker(env.deps, t.Context(), "", "q", models.WorkerOnline)
	upsertWorker(env.deps, t.Context(), "w", "", models.WorkerOnline)
	env.expect(http.MethodGet, "/api/workers", nil, http.StatusOK, &list)
	if len(list) != 2 {
		t.Error("blank identity or queue must not be recorded")
	}
	if resp := env.request(http.MethodPost, "/api/workers", map[string]string{"identity": "w3"}); resp.Status != http.StatusUnprocessableEntity {
		t.Errorf("missing taskQueue: %d", resp.Status)
	}
}

const scheduledBlock = "schedule:\n  every:\n    minutes: 5\n"

func TestUpdateWorkflowDropsRenamedSchedule(t *testing.T) {
	env := newTestEnv(t)
	project := env.seedProject("p")
	original := testDSL("nightly", "q", "") + scheduledBlock
	wf := env.seedWorkflowRow(project.ID, "nightly", original)

	renamed := "document:\n  workflowType: nightly\n  taskQueue: q\n  metadata:\n    scheduleId: custom\n" + scheduledBlock + "do: []\n"
	env.expect(http.MethodPatch, "/api/workflows/"+wf.ID, map[string]string{"dsl": renamed}, http.StatusOK, nil)
	if got := env.temporal.DeletedSchedules(); len(got) != 1 || got[0] != "zigflow_nightly" {
		t.Fatalf("renaming the schedule id should drop the old one, deleted %v", got)
	}

	// Same id, new cadence: zigflow replaces it itself.
	sameID := "document:\n  workflowType: nightly\n  taskQueue: q\n  metadata:\n    scheduleId: custom\nschedule:\n  cron: \"0 0 * * *\"\ndo: []\n"
	env.expect(http.MethodPatch, "/api/workflows/"+wf.ID, map[string]string{"dsl": sameID}, http.StatusOK, nil)
	if got := env.temporal.DeletedSchedules(); len(got) != 1 {
		t.Errorf("unchanged id should not be deleted here, deleted %v", got)
	}

	// Deleting the workflow cancels its schedule.
	env.expect(http.MethodDelete, "/api/workflows/"+wf.ID, nil, http.StatusNoContent, nil)
	if got := env.temporal.DeletedSchedules(); len(got) != 2 || got[1] != "custom" {
		t.Errorf("deleting the workflow should drop its schedule, deleted %v", got)
	}
}

func TestScheduleDeletionIsBestEffort(t *testing.T) {
	env := newTestEnv(t)
	ctx := t.Context()

	deleteTemporalSchedule(ctx, env.deps, "")
	dropRenamedWorkflowSchedule(ctx, env.deps, testDSL("a", "q", ""), testDSL("b", "q", ""))
	dropWorkflowSchedule(ctx, env.deps, testDSL("a", "q", ""))
	if got := env.temporal.DeletedSchedules(); len(got) != 0 {
		t.Errorf("unscheduled DSLs deleted %v", got)
	}

	env.temporal.DeleteScheduleErr = errors.New("not found")
	dropWorkflowSchedule(ctx, env.deps, testDSL("a", "q", "")+scheduledBlock) // logged, not fatal

	unreachable := newTestEnvWith(t, temporalexec.NewLazyClient("127.0.0.1:1"))
	dropWorkflowSchedule(ctx, unreachable.deps, testDSL("a", "q", "")+scheduledBlock)
}
