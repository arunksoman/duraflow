package api

import (
	"errors"
	"net/http"
	"testing"
	"time"

	"duraflow/backend/internal/dslhash"
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
	if wf.CurrentHash != dslhash.Of(wf.DSL) || wf.DSLError != "" {
		t.Fatalf("a DSL that builds should become the current version: %+v", wf)
	}
	var version models.DSLVersion
	if err := env.deps.DB.First(&version, "hash = ?", wf.CurrentHash).Error; err != nil || version.DSL != wf.DSL {
		t.Fatalf("DSL version not stored: %v %+v", err, version)
	}
	var names []string
	env.deps.DB.Model(&models.WorkflowRegistration{}).Where("workflow_id = ?", wf.ID).Pluck("name", &names)
	if len(names) != 1 || names[0] != "ordersType" {
		t.Errorf("registered names: %v", names)
	}

	var draft models.Workflow
	env.expect(http.MethodPost, "/api/projects/"+project.ID+"/workflows", map[string]string{"name": "draft"}, http.StatusCreated, &draft)
	if draft.CurrentHash != "" || draft.DSLError != "" {
		t.Errorf("a workflow without a DSL has no version and no error: %+v", draft)
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
	if updated.Version != 2 || updated.WorkflowType != "v2Type" || updated.TaskQueue != "v2-q" ||
		updated.CurrentHash == wf.CurrentHash || updated.CurrentHash == "" {
		t.Errorf("DSL change: %+v", updated)
	}
	env.deps.DB.Model(&models.WorkflowRegistration{}).Where("workflow_id = ?", wf.ID).Pluck("name", &names)
	if len(names) != 1 || names[0] != "v2Type" {
		t.Errorf("registrations should follow the current version: %v", names)
	}
	var versions int64
	env.deps.DB.Model(&models.DSLVersion{}).Count(&versions)
	if versions != 2 {
		t.Errorf("the previous version must be kept for runs still on it: %d versions", versions)
	}
	// A DSL that doesn't parse (normal mid-edit) is saved, clears the derived columns and leaves
	// the workflow without a runnable version.
	var broken models.Workflow
	env.expect(http.MethodPatch, "/api/workflows/"+wf.ID, map[string]string{"dsl": "document: [broken"}, http.StatusOK, &broken)
	if broken.Version != 3 || broken.WorkflowType != "" || broken.TaskQueue != "" ||
		broken.CurrentHash != "" || broken.DSLError == "" {
		t.Errorf("broken DSL: %+v", broken)
	}
	// One that parses but zigflow rejects keeps its header columns, so old runs still resolve.
	var invalid models.Workflow
	env.expect(http.MethodPatch, "/api/workflows/"+wf.ID,
		map[string]string{"dsl": "document:\n  dsl: 1.0.0\n  taskQueue: v2-q\n  workflowType: v2Type\ndo: []\n"},
		http.StatusOK, &invalid)
	if invalid.CurrentHash != "" || invalid.DSLError == "" || invalid.WorkflowType != "v2Type" {
		t.Errorf("invalid DSL: %+v", invalid)
	}
	env.deps.DB.Model(&models.WorkflowRegistration{}).Where("workflow_id = ?", wf.ID).Pluck("name", &names)
	if len(names) != 0 {
		t.Errorf("a workflow without a version registers nothing: %v", names)
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

	// A row whose heartbeat stopped is reported offline, and one gone for a day is removed.
	env.deps.DB.Model(&models.Worker{}).Where("identity = ?", "w1").
		Update("last_heartbeat_at", time.Now().Add(-time.Hour))
	env.mustCreate(&models.Worker{Identity: "old", TaskQueue: "q", Status: models.WorkerOnline,
		LastHeartbeatAt: time.Now().Add(-48 * time.Hour)})
	env.expect(http.MethodGet, "/api/workers", nil, http.StatusOK, &list)
	if len(list) != 2 || list[1].Identity != "w1" || list[1].Status != models.WorkerOffline {
		t.Errorf("stale heartbeat: %+v", list)
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

// scheduledDSL is a DSL on queue "q" with a five-minute schedule that starts its own workflow type.
// metadata adds lines to document.metadata.
func scheduledDSL(workflowType, metadata string) string {
	return testDSLWithMetadata(workflowType, "q", "    scheduleWorkflowName: "+workflowType+"\n"+metadata, scheduledBlock)
}

func TestSavingPublishesSchedulesPinnedToTheVersion(t *testing.T) {
	env := newTestEnv(t)
	project := env.seedProject("p")

	var wf models.Workflow
	env.expect(http.MethodPost, "/api/projects/"+project.ID+"/workflows",
		map[string]string{"name": "nightly", "dsl": scheduledDSL("nightly", "")}, http.StatusCreated, &wf)
	created := env.temporal.CreatedSchedules()
	if len(created) != 1 || created[0].ID != "zigflow_nightly" || created[0].WorkflowType != "nightly" ||
		created[0].TaskQueue != "q" || created[0].Hash != wf.CurrentHash {
		t.Fatalf("saving a scheduled DSL should publish its schedule pinned to the version: %+v (hash %s)",
			created, wf.CurrentHash)
	}

	// Renaming the schedule id drops the old schedule before publishing the new one.
	renamed := scheduledDSL("nightly", "    scheduleId: custom\n")
	env.expect(http.MethodPatch, "/api/workflows/"+wf.ID, map[string]string{"dsl": renamed}, http.StatusOK, &wf)
	if got := env.temporal.LiveSchedules(); len(got) != 1 || got[0] != "custom" {
		t.Fatalf("after renaming the schedule id, live schedules = %v", got)
	}

	// Same id, new cadence: zigflow replaces it, pinned to the new version.
	sameID := testDSLWithMetadata("nightly", "q", "    scheduleWorkflowName: nightly\n    scheduleId: custom\n", "schedule:\n  cron: \"0 0 * * *\"\n")
	env.expect(http.MethodPatch, "/api/workflows/"+wf.ID, map[string]string{"dsl": sameID}, http.StatusOK, &wf)
	created = env.temporal.CreatedSchedules()
	if last := created[len(created)-1]; last.ID != "custom" || last.Hash != wf.CurrentHash {
		t.Errorf("republished schedule: %+v, want pinned to %s", last, wf.CurrentHash)
	}

	// A DSL that doesn't build leaves the last good schedule running.
	env.expect(http.MethodPatch, "/api/workflows/"+wf.ID, map[string]string{"dsl": "document: [broken"}, http.StatusOK, nil)
	if got := env.temporal.LiveSchedules(); len(got) != 1 {
		t.Errorf("a broken draft should not touch the schedule, live = %v", got)
	}
	// Removing the schedule block retracts it.
	env.expect(http.MethodPatch, "/api/workflows/"+wf.ID,
		map[string]string{"dsl": testDSLWithMetadata("nightly", "q", "    scheduleId: custom\n", "")}, http.StatusOK, nil)
	if got := env.temporal.LiveSchedules(); len(got) != 0 {
		t.Errorf("removing the schedule block should cancel it, live = %v", got)
	}

	// Deleting the workflow cancels its schedule.
	env.expect(http.MethodPatch, "/api/workflows/"+wf.ID, map[string]string{"dsl": sameID}, http.StatusOK, nil)
	env.expect(http.MethodDelete, "/api/workflows/"+wf.ID, nil, http.StatusNoContent, nil)
	if got := env.temporal.LiveSchedules(); len(got) != 0 {
		t.Errorf("deleting the workflow should drop its schedule, live = %v", got)
	}
}

func TestBlankingTheDSLRetractsTheSchedule(t *testing.T) {
	env := newTestEnv(t)
	project := env.seedProject("p")
	var wf models.Workflow
	env.expect(http.MethodPost, "/api/projects/"+project.ID+"/workflows",
		map[string]string{"name": "blanked", "dsl": scheduledDSL("blanked", "")}, http.StatusCreated, &wf)
	var blanked models.Workflow
	env.expect(http.MethodPatch, "/api/workflows/"+wf.ID, map[string]string{"dsl": ""}, http.StatusOK, &blanked)
	if got := env.temporal.LiveSchedules(); len(got) != 0 {
		t.Errorf("a blank DSL should cancel the schedule, live = %v", got)
	}
	if blanked.CurrentHash != "" || blanked.DSLError != "" {
		t.Errorf("blank DSL: %+v", blanked)
	}
}

func TestBackfillDSLVersions(t *testing.T) {
	env := newTestEnv(t)
	project := env.seedProject("p")
	legacy := models.Workflow{ProjectID: project.ID, Name: "legacy", DSL: scheduledDSL("legacyType", "")}
	broken := models.Workflow{ProjectID: project.ID, Name: "broken", DSL: "document: ["}
	empty := models.Workflow{ProjectID: project.ID, Name: "empty"}
	for _, wf := range []*models.Workflow{&legacy, &broken, &empty} {
		env.mustCreate(wf)
	}

	BackfillDSLVersions(t.Context(), env.deps)

	get := func(id string) models.Workflow {
		var wf models.Workflow
		env.deps.DB.First(&wf, "id = ?", id)
		return wf
	}
	got := get(legacy.ID)
	if got.CurrentHash != dslhash.Of(legacy.DSL) || got.WorkflowType != "legacyType" || got.TaskQueue != "q" {
		t.Errorf("legacy workflow not given a version: %+v", got)
	}
	if created := env.temporal.CreatedSchedules(); len(created) != 1 || created[0].Hash != got.CurrentHash {
		t.Errorf("legacy schedule should be republished pinned: %+v", created)
	}
	if got := get(broken.ID); got.CurrentHash != "" || got.DSLError == "" {
		t.Errorf("broken workflow: %+v", got)
	}
	if got := get(empty.ID); got.CurrentHash != "" || got.DSLError != "" {
		t.Errorf("empty workflow touched: %+v", got)
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
