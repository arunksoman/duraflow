package api

import (
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"strings"
	"testing"
	"time"

	commonpb "go.temporal.io/api/common/v1"
	enumspb "go.temporal.io/api/enums/v1"
	workflowpb "go.temporal.io/api/workflow/v1"
	"google.golang.org/protobuf/types/known/timestamppb"
	"gorm.io/datatypes"

	"duraflow/backend/internal/models"
	"duraflow/backend/internal/temporalexec"
	"duraflow/backend/internal/temporalexec/temporaltest"
)

func closedWorkflow(id string, status enumspb.WorkflowExecutionStatus, closedAt time.Time) *workflowpb.WorkflowExecutionInfo {
	return &workflowpb.WorkflowExecutionInfo{
		Execution: &commonpb.WorkflowExecution{WorkflowId: id},
		Status:    status,
		CloseTime: timestamppb.New(closedAt),
	}
}

func TestCreateExecution(t *testing.T) {
	env := newTestEnv(t)
	project := env.seedProject("p")
	wf := env.seedWorkflowRow(project.ID, "orders", testDSL("ordersType", "orders-q", ""))
	env.temporal.DefaultResult = temporaltest.Result{Value: map[string]any{"ok": true}}

	var created executionDTO
	env.expect(http.MethodPost, "/api/workflows/"+wf.ID+"/executions", map[string]any{}, http.StatusCreated, &created)
	if created.Status != models.ExecutionRunning || created.Trigger != models.TriggerManual ||
		created.WorkflowName != "orders" || created.RootExecutionID != created.ID || created.TemporalRunID != "run-"+created.ID {
		t.Errorf("created: %+v", created)
	}
	started := env.temporal.Started()
	if len(started) != 1 || started[0].ID != created.ID || started[0].TaskQueue != "orders-q" || started[0].WorkflowType != "ordersType" {
		t.Fatalf("temporal start: %+v", started)
	}
	// The run is pinned to the version current when it started, through the dslhash header.
	if started[0].Hash != wf.CurrentHash || wf.CurrentHash == "" {
		t.Errorf("run pinned to %q, want the current version %q", started[0].Hash, wf.CurrentHash)
	}
	if row, _ := env.execution(created.ID); row.TaskQueue != "orders-q" {
		t.Errorf("execution task queue %q: the pool needs it to keep polling the queue", row.TaskQueue)
	}
	// No input means {} — never null, which fails a schema requiring an object.
	if input, ok := started[0].Input.(map[string]any); !ok || input == nil || len(input) != 0 {
		t.Errorf("default input: %#v", started[0].Input)
	}

	// The completion watcher records the result in the background.
	eventually(t, "run to complete", func() bool {
		ex, _ := env.execution(created.ID)
		return ex.Status == models.ExecutionCompleted
	})
	ex, _ := env.execution(created.ID)
	if string(ex.Output) != `{"ok":true}` || ex.CompletedAt == nil {
		t.Errorf("terminal result: output %s completedAt %v", ex.Output, ex.CompletedAt)
	}

	var scheduled executionDTO
	env.expect(http.MethodPost, "/api/workflows/"+wf.ID+"/executions",
		map[string]any{"input": map[string]any{"n": 1}, "trigger": "scheduled"}, http.StatusCreated, &scheduled)
	if scheduled.Trigger != models.TriggerScheduled || scheduled.Input["n"] != float64(1) {
		t.Errorf("explicit trigger and input: %+v", scheduled)
	}
	if resp := env.request(http.MethodPost, "/api/workflows/"+wf.ID+"/executions", map[string]any{"trigger": "cron"}); resp.Status != http.StatusUnprocessableEntity {
		t.Errorf("unknown trigger: %d", resp.Status)
	}
}

func TestCreateExecutionErrors(t *testing.T) {
	env := newTestEnv(t)
	project := env.seedProject("p")
	draft := env.seedWorkflowRow(project.ID, "draft", "")
	headerless := env.seedWorkflowRow(project.ID, "headerless", "document:\n  dsl: 1.0.0\ndo: []\n")
	ready := env.seedWorkflowRow(project.ID, "ready", testDSL("t", "q", ""))

	invalid := env.seedWorkflowRow(project.ID, "invalid", "document:\n  dsl: 1.0.0\n  taskQueue: q\n  workflowType: bad\ndo: []\n")

	cases := []struct {
		name   string
		id     string
		status int
	}{
		{"missing workflow", "missing", http.StatusNotFound},
		{"no DSL", draft.ID, http.StatusUnprocessableEntity},
		{"no task queue", headerless.ID, http.StatusUnprocessableEntity},
		{"DSL zigflow rejects", invalid.ID, http.StatusUnprocessableEntity},
	}
	for _, c := range cases {
		if resp := env.request(http.MethodPost, "/api/workflows/"+c.id+"/executions", map[string]any{}); resp.Status != c.status {
			t.Errorf("%s: %d, want %d", c.name, resp.Status, c.status)
		}
	}

	// The refusal carries zigflow's reason, which the builder shows next to the Run button.
	resp := env.request(http.MethodPost, "/api/workflows/"+invalid.ID+"/executions", map[string]any{})
	if !strings.Contains(string(resp.Body), "can't be run") {
		t.Errorf("refusal should explain why: %s", resp.Body)
	}

	env.temporal.ExecuteErr = errors.New("no worker polling")
	if resp := env.request(http.MethodPost, "/api/workflows/"+ready.ID+"/executions", map[string]any{}); resp.Status != http.StatusBadGateway {
		t.Errorf("start failure: %d", resp.Status)
	}
	var n int64
	env.deps.DB.Model(&models.Execution{}).Count(&n)
	if n != 0 {
		t.Error("a run Temporal refused must not be recorded")
	}

	down := newTestEnvWith(t, temporalexec.NewLazyClient("127.0.0.1:1"))
	p := down.seedProject("p")
	wf := down.seedWorkflowRow(p.ID, "w", testDSL("t", "q", ""))
	if resp := down.request(http.MethodPost, "/api/workflows/"+wf.ID+"/executions", map[string]any{}); resp.Status != http.StatusBadGateway {
		t.Errorf("temporal unreachable: %d", resp.Status)
	}
}

func TestListWorkflowExecutions(t *testing.T) {
	env := newTestEnv(t)
	wf := env.seedWorkflowRow("p", "w", "")
	older := env.seedExecution(wf.ID, withStartedAt(time.Now().Add(-time.Hour)))
	newer := env.seedExecution(wf.ID)
	env.seedExecution(wf.ID, withParent(newer))
	env.seedExecution(env.seedWorkflowRow("p", "other", "").ID)

	var roots []executionDTO
	env.expect(http.MethodGet, "/api/workflows/"+wf.ID+"/executions", nil, http.StatusOK, &roots)
	if len(roots) != 2 || roots[0].ID != newer.ID || roots[1].ID != older.ID || roots[0].WorkflowName != "w" {
		t.Errorf("roots, newest first: %+v", roots)
	}
	var all []executionDTO
	env.expect(http.MethodGet, "/api/workflows/"+wf.ID+"/executions?rootsOnly=false", nil, http.StatusOK, &all)
	if len(all) != 3 {
		t.Errorf("with children: %d", len(all))
	}
}

func TestListAllExecutionsFiltersAndPages(t *testing.T) {
	env := newTestEnv(t)
	billing := env.seedProject("Billing")
	ops := env.seedProject("Ops")
	invoice := env.seedWorkflowRow(billing.ID, "invoice", "")
	backup := env.seedWorkflowRow(ops.ID, "backup", "")

	base := time.Date(2026, 3, 1, 12, 0, 0, 0, time.UTC)
	a := env.seedExecution(invoice.ID, withStartedAt(base))
	b := env.seedExecution(invoice.ID, withStartedAt(base.Add(time.Hour)), withStatus(models.ExecutionFailed))
	c := env.seedExecution(backup.ID, withStartedAt(base.Add(2*time.Hour)), withTrigger(models.TriggerScheduled))
	env.seedExecution(backup.ID, withStartedAt(base.Add(3*time.Hour)), withParent(c))

	list := func(query string) ([]string, int64) {
		t.Helper()
		var out struct {
			Items []executionDTO `json:"items"`
			Total int64          `json:"total"`
		}
		env.expect(http.MethodGet, "/api/executions"+query, nil, http.StatusOK, &out)
		ids := make([]string, len(out.Items))
		for i, item := range out.Items {
			ids[i] = item.ID
		}
		return ids, out.Total
	}
	same := func(got []string, want ...string) bool {
		if len(got) != len(want) {
			return false
		}
		for i := range got {
			if got[i] != want[i] {
				return false
			}
		}
		return true
	}

	if ids, total := list(""); !same(ids, c.ID, b.ID, a.ID) || total != 3 {
		t.Errorf("default: %v total %d", ids, total)
	}
	if ids, total := list("?rootsOnly=false"); len(ids) != 4 || total != 4 {
		t.Errorf("with children: %v total %d", ids, total)
	}
	if ids, _ := list("?workflowId=" + invoice.ID); !same(ids, b.ID, a.ID) {
		t.Errorf("by workflow: %v", ids)
	}
	if ids, _ := list("?projectId=" + ops.ID); !same(ids, c.ID) {
		t.Errorf("by project: %v", ids)
	}
	if ids, _ := list("?trigger=scheduled"); !same(ids, c.ID) {
		t.Errorf("by trigger: %v", ids)
	}
	if ids, _ := list("?status=failed"); !same(ids, b.ID) {
		t.Errorf("by status: %v", ids)
	}
	window := "?from=" + url.QueryEscape(base.Add(30*time.Minute).Format(time.RFC3339)) +
		"&to=" + url.QueryEscape(base.Add(90*time.Minute).Format(time.RFC3339))
	if ids, _ := list(window); !same(ids, b.ID) {
		t.Errorf("by time window: %v", ids)
	}
	if ids, total := list("?limit=1&offset=1"); !same(ids, b.ID) || total != 3 {
		t.Errorf("paging: %v total %d", ids, total)
	}

	var out struct {
		Items []executionDTO `json:"items"`
	}
	env.expect(http.MethodGet, "/api/executions?projectId="+billing.ID, nil, http.StatusOK, &out)
	if out.Items[0].WorkflowName != "invoice" || out.Items[0].ProjectName != "Billing" || out.Items[0].ProjectID != billing.ID {
		t.Errorf("names not joined: %+v", out.Items[0])
	}

	for _, bad := range []string{"?trigger=cron", "?from=yesterday", "?to=2026-13-01", "?limit=0", "?limit=501", "?offset=-1"} {
		if resp := env.request(http.MethodGet, "/api/executions"+bad, nil); resp.Status != http.StatusUnprocessableEntity {
			t.Errorf("%s: %d", bad, resp.Status)
		}
	}
}

func TestGetExecutionReconcilesWithTemporal(t *testing.T) {
	env := newTestEnv(t)
	wf := env.seedWorkflowRow("p", "w", "")
	closedAt := time.Date(2026, 2, 2, 2, 2, 2, 0, time.UTC)

	finished := env.seedExecution(wf.ID, withStatus(models.ExecutionRunning))
	env.temporal.SetWorkflow(finished.ID, closedWorkflow(finished.ID, enumspb.WORKFLOW_EXECUTION_STATUS_COMPLETED, closedAt))
	env.temporal.Results[finished.ID] = temporaltest.Result{Value: "done"}

	failed := env.seedExecution(wf.ID, withStatus(models.ExecutionRunning))
	env.temporal.SetWorkflow(failed.ID, closedWorkflow(failed.ID, enumspb.WORKFLOW_EXECUTION_STATUS_FAILED, closedAt))
	env.temporal.Results[failed.ID] = temporaltest.Result{Err: errors.New("task exploded")}

	stillRunning := env.seedExecution(wf.ID, withStatus(models.ExecutionRunning))
	env.temporal.SetWorkflow(stillRunning.ID, &workflowpb.WorkflowExecutionInfo{Status: enumspb.WORKFLOW_EXECUTION_STATUS_RUNNING})

	unknown := env.seedExecution(wf.ID, withStatus(models.ExecutionRunning))
	done := env.seedExecution(wf.ID, withStatus(models.ExecutionCancelled))

	var got executionDTO
	env.expect(http.MethodGet, "/api/executions/"+finished.ID, nil, http.StatusOK, &got)
	if got.Status != models.ExecutionCompleted || got.Output != "done" || !got.CompletedAt.Equal(closedAt) || got.WorkflowName != "w" {
		t.Errorf("completed: %+v", got)
	}
	if stored, _ := env.execution(finished.ID); stored.Status != models.ExecutionCompleted {
		t.Error("reconciled status not persisted")
	}

	got = executionDTO{}
	env.expect(http.MethodGet, "/api/executions/"+failed.ID, nil, http.StatusOK, &got)
	if got.Status != models.ExecutionFailed || got.Error != "task exploded" {
		t.Errorf("failed: %+v", got)
	}

	for _, id := range []string{stillRunning.ID, unknown.ID} {
		got = executionDTO{}
		env.expect(http.MethodGet, "/api/executions/"+id, nil, http.StatusOK, &got)
		if got.Status != models.ExecutionRunning {
			t.Errorf("%s should stay running: %+v", id, got)
		}
	}
	got = executionDTO{}
	env.expect(http.MethodGet, "/api/executions/"+done.ID, nil, http.StatusOK, &got)
	if got.Status != models.ExecutionCancelled {
		t.Errorf("terminal runs are not re-checked: %+v", got)
	}

	if resp := env.request(http.MethodGet, "/api/executions/missing", nil); resp.Status != http.StatusNotFound {
		t.Errorf("missing: %d", resp.Status)
	}

	down := newTestEnvWith(t, temporalexec.NewLazyClient("127.0.0.1:1"))
	running := down.seedExecution(down.seedWorkflowRow("p", "w", "").ID, withStatus(models.ExecutionRunning))
	got = executionDTO{}
	down.expect(http.MethodGet, "/api/executions/"+running.ID, nil, http.StatusOK, &got)
	if got.Status != models.ExecutionRunning {
		t.Errorf("unreachable Temporal leaves the run as is: %+v", got)
	}
}

func TestUpdateExecution(t *testing.T) {
	env := newTestEnv(t)
	wf := env.seedWorkflowRow("p", "w", "")
	ex := env.seedExecution(wf.ID, withStatus(models.ExecutionRunning))

	var got executionDTO
	env.expect(http.MethodPatch, "/api/executions/"+ex.ID,
		map[string]any{"status": "failed", "output": map[string]any{"why": "manual"}}, http.StatusOK, &got)
	if got.Status != models.ExecutionFailed || got.CompletedAt == nil || got.WorkflowName != "w" {
		t.Errorf("update: %+v", got)
	}
	if out, _ := got.Output.(map[string]any); out["why"] != "manual" {
		t.Errorf("output: %#v", got.Output)
	}
	firstCompletion := *got.CompletedAt

	got = executionDTO{}
	env.expect(http.MethodPatch, "/api/executions/"+ex.ID, map[string]any{"status": "cancelled"}, http.StatusOK, &got)
	if !got.CompletedAt.Equal(firstCompletion) {
		t.Error("completedAt should not move once set")
	}
	got = executionDTO{}
	env.expect(http.MethodPatch, "/api/executions/"+ex.ID, map[string]any{"status": "running"}, http.StatusOK, &got)
	if got.Status != models.ExecutionRunning {
		t.Errorf("back to running: %+v", got)
	}

	if resp := env.request(http.MethodPatch, "/api/executions/missing", map[string]any{"status": "failed"}); resp.Status != http.StatusNotFound {
		t.Errorf("missing: %d", resp.Status)
	}
}

func TestListExecutionEventsPages(t *testing.T) {
	env := newTestEnv(t)
	ex := env.seedExecution(env.seedWorkflowRow("p", "w", "").ID)
	var seqs []uint64
	for i := 0; i < 5; i++ {
		ev := env.seedEvent(models.ExecutionEvent{
			ExecutionID: ex.ID, RootExecutionID: ex.ID, WorkflowExecutionID: ex.ID,
			TaskName: fmt.Sprintf("t%d", i), Data: datatypes.JSON(`{"i":1}`),
		})
		seqs = append(seqs, ev.Seq)
	}
	env.seedEvent(models.ExecutionEvent{WorkflowExecutionID: ex.ID}) // unresolved: never listed

	var page listExecutionEventsOutput
	env.expect(http.MethodGet, "/api/executions/"+ex.ID+"/events?limit=2", nil, http.StatusOK, &page.Body)
	if len(page.Body.Events) != 2 || !page.Body.HasMore || page.Body.NextSeq != seqs[1] {
		t.Fatalf("first page: %+v", page.Body)
	}
	if string(page.Body.Events[0].Data) != `{"i":1}` || page.Body.Events[0].TaskName != "t0" {
		t.Errorf("event payload: %+v", page.Body.Events[0])
	}

	page = listExecutionEventsOutput{}
	env.expect(http.MethodGet, fmt.Sprintf("/api/executions/%s/events?afterSeq=%d", ex.ID, seqs[1]), nil, http.StatusOK, &page.Body)
	if len(page.Body.Events) != 3 || page.Body.HasMore || page.Body.NextSeq != seqs[4] {
		t.Errorf("rest: %+v", page.Body)
	}

	page = listExecutionEventsOutput{}
	env.expect(http.MethodGet, "/api/executions/nobody/events", nil, http.StatusOK, &page.Body)
	if len(page.Body.Events) != 0 || page.Body.HasMore || page.Body.NextSeq != 0 {
		t.Errorf("empty: %+v", page.Body)
	}
}

func TestListChildExecutions(t *testing.T) {
	env := newTestEnv(t)
	parentWF := env.seedWorkflowRow("p", "parent", "")
	childWF := env.seedWorkflowRow("p", "child", "")
	root := env.seedExecution(parentWF.ID)
	second := env.seedExecution(childWF.ID, withParent(root), withStartedAt(time.Now().Add(time.Minute)))
	first := env.seedExecution(childWF.ID, withParent(root))

	var children []executionDTO
	env.expect(http.MethodGet, "/api/executions/"+root.ID+"/children", nil, http.StatusOK, &children)
	if len(children) != 2 || children[0].ID != first.ID || children[1].ID != second.ID || children[0].WorkflowName != "child" {
		t.Errorf("children, oldest first: %+v", children)
	}
	if *children[0].ParentExecutionID != root.ID {
		t.Errorf("parent id: %+v", children[0])
	}
}

func TestWatchFinishedExecutionReplaysAndCloses(t *testing.T) {
	env := newTestEnv(t)
	ex := env.seedExecution(env.seedWorkflowRow("p", "w", "").ID, withStatus(models.ExecutionFailed))
	env.deps.DB.Model(&ex).Update("error", "boom")
	a := env.seedEvent(models.ExecutionEvent{ExecutionID: ex.ID, WorkflowExecutionID: ex.ID, TaskName: "a"})
	b := env.seedEvent(models.ExecutionEvent{ExecutionID: ex.ID, WorkflowExecutionID: ex.ID, TaskName: "b"})

	msgs := collect(t, env.openStream("/api/executions/"+ex.ID+"/watch"))
	if len(msgs) != 4 {
		t.Fatalf("want 2 events + status + done, got %+v", msgs)
	}
	var first executionEventDTO
	_ = json.Unmarshal(msgs[0].Data, &first)
	if msgs[0].Event != "event" || first.Seq != a.Seq {
		t.Errorf("first: %+v", msgs[0])
	}
	var status statusEvent
	_ = json.Unmarshal(msgs[2].Data, &status)
	if msgs[2].Event != "status" || status.Status != models.ExecutionFailed || status.Error != "boom" {
		t.Errorf("status: %+v", msgs[2])
	}
	var done watchDone
	_ = json.Unmarshal(msgs[3].Data, &done)
	if msgs[3].Event != "done" || !done.Done || done.Status != models.ExecutionFailed {
		t.Errorf("done: %+v", msgs[3])
	}

	// Resuming after b replays nothing.
	msgs = collect(t, env.openStream(fmt.Sprintf("/api/executions/%s/watch?afterSeq=%d", ex.ID, b.Seq)))
	if len(msgs) != 2 || msgs[0].Event != "status" {
		t.Errorf("resume: %+v", msgs)
	}

	msgs = collect(t, env.openStream("/api/executions/missing/watch"))
	if len(msgs) != 1 || msgs[0].Event != "done" {
		t.Errorf("missing run: %+v", msgs)
	}
}

func TestWatchRunningExecutionStreamsUntilClosed(t *testing.T) {
	env := newTestEnv(t)
	env.temporal.Gate = make(chan struct{})
	env.temporal.DefaultResult = temporaltest.Result{Value: "result"}
	ex := env.seedExecution(env.seedWorkflowRow("p", "w", "").ID, withStatus(models.ExecutionRunning))
	backlog := env.seedEvent(models.ExecutionEvent{ExecutionID: ex.ID, WorkflowExecutionID: ex.ID, TaskName: "a"})

	stream := env.openStream("/api/executions/" + ex.ID + "/watch")
	if msg := next(t, stream); msg.Event != "event" {
		t.Fatalf("backlog: %+v", msg)
	}
	if msg := next(t, stream); msg.Event != "status" {
		t.Fatalf("status: %+v", msg)
	}

	// The handler subscribes before replaying the backlog, so it's listening by now. Send a live
	// event, a duplicate of the backlog (skipped), then one that lands just before the close.
	live := env.seedEvent(models.ExecutionEvent{ExecutionID: ex.ID, WorkflowExecutionID: ex.ID, TaskName: "b"})
	env.deps.Bus.Publish(ex.ID, live)
	msg := next(t, stream)
	var got executionEventDTO
	_ = json.Unmarshal(msg.Data, &got)
	if msg.Event != "event" || got.Seq != live.Seq {
		t.Fatalf("live event: %+v", msg)
	}
	env.deps.Bus.Publish(ex.ID, backlog)
	tail := env.seedEvent(models.ExecutionEvent{ExecutionID: ex.ID, WorkflowExecutionID: ex.ID, TaskName: "c"})

	close(env.temporal.Gate) // the workflow finishes
	rest := collect(t, stream)
	if len(rest) != 2 {
		t.Fatalf("want the tail event then done, got %+v", rest)
	}
	_ = json.Unmarshal(rest[0].Data, &got)
	if rest[0].Event != "event" || got.Seq != tail.Seq {
		t.Errorf("tail: %+v", rest[0])
	}
	var done watchDone
	_ = json.Unmarshal(rest[1].Data, &done)
	if rest[1].Event != "done" || done.Status != models.ExecutionCompleted {
		t.Errorf("done: %+v", rest[1])
	}
}

func TestWatchTerminal(t *testing.T) {
	env := newTestEnv(t)
	wf := env.seedWorkflowRow("p", "w", "")

	t.Run("records status Temporal reports", func(t *testing.T) {
		ex := env.seedExecution(wf.ID, withStatus(models.ExecutionRunning))
		closedAt := time.Date(2026, 5, 5, 5, 5, 5, 0, time.UTC)
		env.temporal.SetWorkflow(ex.ID, closedWorkflow(ex.ID, enumspb.WORKFLOW_EXECUTION_STATUS_TERMINATED, closedAt))
		env.temporal.Results[ex.ID] = temporaltest.Result{Err: errors.New("terminated by operator")}
		sub := env.deps.Bus.Subscribe(ex.ID)
		defer sub.Close()

		WatchExecutionUntilClosed(env.deps, ex.ID)

		got, _ := env.execution(ex.ID)
		if got.Status != models.ExecutionTerminated || got.Error != "terminated by operator" || !got.CompletedAt.Equal(closedAt) {
			t.Errorf("stored: %+v", got)
		}
		select {
		case ev := <-sub.C:
			if ev.EventType != terminalMarkerEventType {
				t.Errorf("published %+v", ev)
			}
		default:
			t.Error("watchers not woken")
		}
	})

	t.Run("infers failure when Temporal can't describe it", func(t *testing.T) {
		ex := env.seedExecution(wf.ID, withStatus(models.ExecutionRunning))
		env.temporal.Results[ex.ID] = temporaltest.Result{Err: errors.New("lost")}
		watchTerminal(env.deps, ex.ID)
		if got, _ := env.execution(ex.ID); got.Status != models.ExecutionFailed {
			t.Errorf("stored: %+v", got)
		}
	})

	t.Run("no-ops", func(t *testing.T) {
		finished := env.seedExecution(wf.ID, withStatus(models.ExecutionCompleted))
		watchTerminal(env.deps, finished.ID)
		watchTerminal(env.deps, "missing")

		// Already being watched elsewhere.
		dup := env.seedExecution(wf.ID, withStatus(models.ExecutionRunning))
		terminalWatches.Store(dup.ID, struct{}{})
		watchTerminal(env.deps, dup.ID)
		terminalWatches.Delete(dup.ID)
		if got, _ := env.execution(dup.ID); got.Status != models.ExecutionRunning {
			t.Error("a second watcher should not act")
		}

		down := newTestEnvWith(t, temporalexec.NewLazyClient("127.0.0.1:1"))
		running := down.seedExecution(down.seedWorkflowRow("p", "w", "").ID, withStatus(models.ExecutionRunning))
		watchTerminal(down.deps, running.ID)
		if got, _ := down.execution(running.ID); got.Status != models.ExecutionRunning {
			t.Error("unreachable Temporal should leave the run alone")
		}
	})

	t.Run("deleted while waiting is not resurrected", func(t *testing.T) {
		gated := newTestEnv(t)
		gated.temporal.Gate = make(chan struct{})
		ex := gated.seedExecution(gated.seedWorkflowRow("p", "w", "").ID, withStatus(models.ExecutionRunning))
		done := make(chan struct{})
		go func() {
			watchTerminal(gated.deps, ex.ID)
			close(done)
		}()
		eventually(t, "watcher to start", func() bool {
			_, watching := terminalWatches.Load(ex.ID)
			return watching
		})
		gated.deps.DB.Delete(&models.Execution{}, "id = ?", ex.ID)
		close(gated.temporal.Gate)
		<-done
		if _, exists := gated.execution(ex.ID); exists {
			t.Error("deleted run was re-inserted")
		}
	})
}

func TestApplyTerminalResult(t *testing.T) {
	at := time.Now()
	cases := []struct {
		name       string
		status     models.ExecutionStatus
		result     any
		err        error
		wantStatus models.ExecutionStatus
		wantErr    string
		wantOutput string
	}{
		{"completed with output", models.ExecutionCompleted, []any{1, 2}, nil, models.ExecutionCompleted, "", "[1,2]"},
		{"failed keeps message", models.ExecutionFailed, nil, errors.New("bad"), models.ExecutionFailed, "bad", ""},
		{"undecodable result of a completed run stays completed", models.ExecutionCompleted, nil, errors.New("decode"), models.ExecutionCompleted, "decode", ""},
		{"unknown status with error is a failure", models.ExecutionRunning, nil, errors.New("x"), models.ExecutionFailed, "x", ""},
		{"unknown status with result is a success", models.ExecutionRunning, "ok", nil, models.ExecutionCompleted, "", `"ok"`},
		{"unmarshalable output is skipped", models.ExecutionCompleted, make(chan int), nil, models.ExecutionCompleted, "", ""},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			ex := models.Execution{Error: "stale"}
			applyTerminalResult(&ex, c.status, at, c.result, c.err)
			if ex.Status != c.wantStatus || ex.Error != c.wantErr || string(ex.Output) != c.wantOutput || !ex.CompletedAt.Equal(at) {
				t.Errorf("got status %q error %q output %s", ex.Status, ex.Error, ex.Output)
			}
		})
	}
}

func TestExecutionDTO(t *testing.T) {
	dto := toExecutionDTO(models.Execution{
		Input:  datatypes.JSON(`{"a":1}`),
		Output: datatypes.JSON(`"plain string"`),
	}, "w")
	if dto.Trigger != models.TriggerManual {
		t.Error("rows predating triggers read as manual")
	}
	if dto.Input["a"] != float64(1) || dto.Output != "plain string" || dto.WorkflowName != "w" {
		t.Errorf("dto: %+v", dto)
	}
}

func TestParseDSLHeader(t *testing.T) {
	q, wt, err := parseDSLHeader(testDSL("t", "q", ""))
	if err != nil || q != "q" || wt != "t" {
		t.Errorf("got (%q, %q, %v)", q, wt, err)
	}
	if _, _, err := parseDSLHeader("document: ["); err == nil {
		t.Error("invalid YAML accepted")
	}
}
