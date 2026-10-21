package api

import (
	"errors"
	"net/http"
	"slices"
	"testing"

	"go.temporal.io/api/serviceerror"

	"duraflow/backend/internal/models"
	"duraflow/backend/internal/temporalexec"
)

// runTree seeds a root run with a child run, a synthetic scope, resolved and unresolved events and
// resolver refs — everything deleting the root has to take with it.
type runTree struct {
	root, child models.Execution
}

func (e *testEnv) seedRunTree(workflowID string, opts ...execOpt) runTree {
	e.t.Helper()
	root := e.seedExecution(workflowID, opts...)
	child := e.seedExecution(workflowID, withParent(root))
	e.seedEvent(models.ExecutionEvent{ExecutionID: root.ID, RootExecutionID: root.ID, WorkflowExecutionID: root.ID})
	e.seedEvent(models.ExecutionEvent{ExecutionID: child.ID, RootExecutionID: root.ID, WorkflowExecutionID: child.ID})
	// Not yet resolved: matched by Temporal id prefix.
	e.seedEvent(models.ExecutionEvent{WorkflowExecutionID: root.ID + "_for_0"})
	e.seedEvent(models.ExecutionEvent{WorkflowExecutionID: root.ID})
	e.mustCreate(&models.WorkflowExecutionRef{
		WorkflowExecutionID: root.ID + "_for_0", TemporalRunID: "r", ExecutionID: root.ID, RootExecutionID: root.ID, ScopePath: "for_0",
	})
	return runTree{root: root, child: child}
}

func (e *testEnv) countWhere(model any, query string, args ...any) int64 {
	e.t.Helper()
	var n int64
	if err := e.deps.DB.Model(model).Where(query, args...).Count(&n).Error; err != nil {
		e.t.Fatal(err)
	}
	return n
}

func (e *testEnv) assertTreeGone(tree runTree) {
	e.t.Helper()
	ids := []string{tree.root.ID, tree.child.ID}
	if n := e.countWhere(&models.Execution{}, "id IN ?", ids); n != 0 {
		e.t.Errorf("%d runs left", n)
	}
	if n := e.countWhere(&models.ExecutionEvent{},
		"execution_id IN ? OR root_execution_id = ? OR workflow_execution_id LIKE ?", ids, tree.root.ID, tree.root.ID+"%"); n != 0 {
		e.t.Errorf("%d events left", n)
	}
	if n := e.countWhere(&models.WorkflowExecutionRef{}, "root_execution_id = ?", tree.root.ID); n != 0 {
		e.t.Errorf("%d refs left", n)
	}
}

func TestDeleteExecutionTree(t *testing.T) {
	env := newTestEnv(t)
	wf := env.seedWorkflowRow("p", "w", "")
	doomed := env.seedRunTree(wf.ID)
	kept := env.seedRunTree(wf.ID)
	// Resolve the scope through the cache, to check Forget.
	if _, ok := env.deps.Resolver.Lookup(doomed.root.ID + "_for_0"); !ok {
		t.Fatal("ref not loaded into the resolver")
	}
	sub := env.deps.Bus.Subscribe(doomed.child.ID)
	defer sub.Close()

	env.expect(http.MethodDelete, "/api/executions/"+doomed.root.ID, nil, http.StatusNoContent, nil)

	env.assertTreeGone(doomed)
	if n := env.countWhere(&models.Execution{}, "root_execution_id = ?", kept.root.ID); n != 2 {
		t.Errorf("other tree's runs: %d", n)
	}
	if n := env.countWhere(&models.ExecutionEvent{},
		"root_execution_id = ? OR workflow_execution_id LIKE ?", kept.root.ID, kept.root.ID+"%"); n != 4 {
		t.Errorf("other tree's events: %d", n)
	}
	if _, ok := env.deps.Resolver.Lookup(doomed.root.ID + "_for_0"); ok {
		t.Error("resolver still remembers the deleted tree")
	}
	select {
	case ev := <-sub.C:
		if ev.EventType != terminalMarkerEventType {
			t.Errorf("published %+v", ev)
		}
	default:
		t.Error("open watch streams of the tree were not woken")
	}

	eventually(t, "Temporal history purge", func() bool { return len(env.temporal.DeletedHistories()) == 3 })
	purged := env.temporal.DeletedHistories()
	for _, id := range []string{doomed.root.ID, doomed.child.ID, doomed.root.ID + "_for_0"} {
		if !slices.Contains(purged, id) {
			t.Errorf("history of %s not purged: %v", id, purged)
		}
	}
	if len(env.temporal.Terminated()) != 0 {
		t.Error("a finished run should not be terminated")
	}
}

func TestDeleteExecutionLikePatternIsEscaped(t *testing.T) {
	env := newTestEnv(t)
	wf := env.seedWorkflowRow("p", "w", "")
	// "a_" would match "ab..." if the underscore weren't escaped.
	doomed := env.seedExecution(wf.ID)
	env.deps.DB.Model(&models.Execution{}).Where("id = ?", doomed.ID).Updates(map[string]any{"id": "a_", "root_execution_id": "a_"})
	env.seedEvent(models.ExecutionEvent{WorkflowExecutionID: "abc_for_0"})
	env.seedEvent(models.ExecutionEvent{WorkflowExecutionID: "a__for_0"})

	env.expect(http.MethodDelete, "/api/executions/a_", nil, http.StatusNoContent, nil)
	if n := env.countWhere(&models.ExecutionEvent{}, "workflow_execution_id = ?", "abc_for_0"); n != 1 {
		t.Error("an unrelated run's events matched the LIKE pattern")
	}
	if n := env.countWhere(&models.ExecutionEvent{}, "workflow_execution_id = ?", "a__for_0"); n != 0 {
		t.Error("the run's own scope events were left")
	}
}

func TestDeleteExecutionRefusals(t *testing.T) {
	env := newTestEnv(t)
	wf := env.seedWorkflowRow("p", "w", "")
	tree := env.seedRunTree(wf.ID)
	running := env.seedExecution(wf.ID, withStatus(models.ExecutionRunning))

	cases := []struct {
		name string
		path string
		want int
	}{
		{"missing", "/api/executions/missing", http.StatusNotFound},
		{"child", "/api/executions/" + tree.child.ID, http.StatusUnprocessableEntity},
		{"running without force", "/api/executions/" + running.ID, http.StatusConflict},
	}
	for _, c := range cases {
		if resp := env.request(http.MethodDelete, c.path, nil); resp.Status != c.want {
			t.Errorf("%s: %d, want %d", c.name, resp.Status, c.want)
		}
	}
	if n := env.countWhere(&models.Execution{}, "1 = 1"); n != 3 {
		t.Errorf("refused deletes removed rows: %d left", n)
	}
}

func TestDeleteRunningExecutionWithForceTerminatesIt(t *testing.T) {
	env := newTestEnv(t)
	wf := env.seedWorkflowRow("p", "w", "")
	running := env.seedExecution(wf.ID, withStatus(models.ExecutionRunning))
	alreadyGone := env.seedExecution(wf.ID, withStatus(models.ExecutionRunning))

	env.expect(http.MethodDelete, "/api/executions/"+running.ID+"?force=true", nil, http.StatusNoContent, nil)
	if got := env.temporal.Terminated(); len(got) != 1 || got[0] != running.ID {
		t.Errorf("terminated %v", got)
	}

	// Temporal no longer knowing the run is fine; any other failure is logged, not fatal.
	env.temporal.TerminateErr = serviceerror.NewNotFound("gone")
	env.expect(http.MethodDelete, "/api/executions/"+alreadyGone.ID+"?force=true", nil, http.StatusNoContent, nil)
	env.temporal.TerminateErr = errors.New("unavailable")
	other := env.seedExecution(wf.ID, withStatus(models.ExecutionRunning))
	env.expect(http.MethodDelete, "/api/executions/"+other.ID+"?force=true", nil, http.StatusNoContent, nil)
	if n := env.countWhere(&models.Execution{}, "1 = 1"); n != 0 {
		t.Errorf("%d runs left", n)
	}
}

func TestBulkDeleteIsAllOrNothing(t *testing.T) {
	env := newTestEnv(t)
	wf := env.seedWorkflowRow("p", "w", "")
	a := env.seedRunTree(wf.ID)
	b := env.seedRunTree(wf.ID)

	if resp := env.request(http.MethodPost, "/api/executions/delete",
		map[string]any{"ids": []string{a.root.ID, "missing"}}); resp.Status != http.StatusNotFound {
		t.Fatalf("one bad id: %d", resp.Status)
	}
	if n := env.countWhere(&models.Execution{}, "id = ?", a.root.ID); n != 1 {
		t.Fatal("a failed bulk delete removed a valid run")
	}

	var out struct {
		Deleted int `json:"deleted"`
	}
	env.expect(http.MethodPost, "/api/executions/delete",
		map[string]any{"ids": []string{a.root.ID, b.root.ID, a.root.ID}}, http.StatusOK, &out)
	if out.Deleted != 2 {
		t.Errorf("deleted %d", out.Deleted)
	}
	env.assertTreeGone(a)
	env.assertTreeGone(b)

	if resp := env.request(http.MethodPost, "/api/executions/delete", map[string]any{"ids": []string{}}); resp.Status != http.StatusUnprocessableEntity {
		t.Errorf("empty id list: %d", resp.Status)
	}
}

func TestDeleteWithTemporalDown(t *testing.T) {
	env := newTestEnvWith(t, temporalexec.NewLazyClient("127.0.0.1:1"))
	wf := env.seedWorkflowRow("p", "w", "")
	tree := env.seedRunTree(wf.ID, withStatus(models.ExecutionRunning))

	env.expect(http.MethodDelete, "/api/executions/"+tree.root.ID+"?force=true", nil, http.StatusNoContent, nil)
	env.assertTreeGone(tree)
}

func TestPurgeHistoryToleratesFailures(t *testing.T) {
	env := newTestEnv(t)
	env.temporal.DeleteHistoryErr = serviceerror.NewNotFound("expired")
	purgeTemporalHistory(env.temporal, []models.Execution{{Base: models.Base{ID: "a"}}}, nil)
	env.temporal.DeleteHistoryErr = errors.New("unavailable")
	purgeTemporalHistory(env.temporal, []models.Execution{{Base: models.Base{ID: "a"}}},
		[]models.WorkflowExecutionRef{{WorkflowExecutionID: "a"}, {WorkflowExecutionID: ""}})
	if len(env.temporal.DeletedHistories()) != 0 {
		t.Error("failed deletes recorded")
	}

	env.temporal.DeleteHistoryErr = nil
	purgeTemporalHistory(env.temporal, []models.Execution{{Base: models.Base{ID: "a"}}},
		[]models.WorkflowExecutionRef{{WorkflowExecutionID: "a"}, {WorkflowExecutionID: "a_try"}})
	if got := env.temporal.DeletedHistories(); len(got) != 2 {
		t.Errorf("each workflow id should be purged exactly once: %v", got)
	}
}

func TestDeleteHelpers(t *testing.T) {
	if got := escapeLike(`a_b%c\d`); got != `a\_b\%c\\d` {
		t.Errorf("escapeLike = %q", got)
	}
	if got := uniqueStrings([]string{"a", "b", "a", "c", "b"}); !slices.Equal(got, []string{"a", "b", "c"}) {
		t.Errorf("uniqueStrings = %v", got)
	}
	if !isNotFound(serviceerror.NewNotFound("x")) || isNotFound(errors.New("x")) {
		t.Error("isNotFound")
	}
	if err := deleteErrorToHuma(errors.New("db down")); err == nil {
		t.Error("unknown errors map to 500")
	}
}
