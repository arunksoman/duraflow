package temporalexec

import (
	"context"
	"errors"
	"path/filepath"
	"testing"
	"time"

	commonpb "go.temporal.io/api/common/v1"
	enumspb "go.temporal.io/api/enums/v1"
	historypb "go.temporal.io/api/history/v1"
	workflowpb "go.temporal.io/api/workflow/v1"
	"google.golang.org/protobuf/types/known/timestamppb"
	"gorm.io/gorm"

	"duraflow/backend/internal/config"
	"duraflow/backend/internal/db"
	"duraflow/backend/internal/events"
	"duraflow/backend/internal/models"
	"duraflow/backend/internal/temporalexec/temporaltest"
)

type resolverFixture struct {
	db         *gorm.DB
	temporal   *temporaltest.Client
	bus        *events.Broker
	resolver   *Resolver
	discovered []models.Execution
}

func newResolverFixture(t *testing.T, retention int) *resolverFixture {
	t.Helper()
	conn, err := db.Open(config.DatabaseConfig{Driver: "sqlite", DSN: filepath.Join(t.TempDir(), "r.db")})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, _ := conn.DB()
	t.Cleanup(func() { _ = sqlDB.Close() })

	f := &resolverFixture{db: conn, temporal: temporaltest.New(), bus: events.NewBroker()}
	f.resolver = NewResolver(conn, NewStaticClient(f.temporal), f.bus, retention)
	f.resolver.OnExecutionDiscovered = func(e models.Execution) { f.discovered = append(f.discovered, e) }
	return f
}

func (f *resolverFixture) mustCreate(t *testing.T, v any) {
	t.Helper()
	if err := f.db.Create(v).Error; err != nil {
		t.Fatal(err)
	}
}

// rootRun stores a workflow and one root run of it, the way create-execution leaves them.
func (f *resolverFixture) rootRun(t *testing.T, id string, trigger models.ExecutionTrigger) models.Execution {
	t.Helper()
	wf := models.Workflow{ProjectID: "p", Name: "root-" + id, WorkflowType: "rootType", TaskQueue: "q"}
	f.mustCreate(t, &wf)
	e := models.Execution{
		Base: models.Base{ID: id}, WorkflowID: wf.ID, Status: models.ExecutionRunning,
		Trigger: trigger, StartedAt: time.Now(), TemporalRunID: "run-" + id,
	}
	f.mustCreate(t, &e)
	return e
}

func childInfo(id, parentID, workflowType, taskQueue string) *workflowpb.WorkflowExecutionInfo {
	info := &workflowpb.WorkflowExecutionInfo{
		Execution: &commonpb.WorkflowExecution{WorkflowId: id, RunId: "run-" + id},
		Type:      &commonpb.WorkflowType{Name: workflowType},
		TaskQueue: taskQueue,
	}
	if parentID != "" {
		info.ParentExecution = &commonpb.WorkflowExecution{WorkflowId: parentID}
	}
	return info
}

func TestResolveRootExecution(t *testing.T) {
	f := newResolverFixture(t, 0)
	f.rootRun(t, "root", models.TriggerManual)

	res, err := f.resolver.Resolve(t.Context(), "root")
	if err != nil {
		t.Fatal(err)
	}
	if res != (Resolution{ExecutionID: "root", RootExecutionID: "root"}) {
		t.Errorf("got %+v", res)
	}
	var ref models.WorkflowExecutionRef
	if err := f.db.First(&ref, "workflow_execution_id = ?", "root").Error; err != nil {
		t.Fatalf("resolution not persisted: %v", err)
	}
	if ref.TemporalRunID != "run-root" {
		t.Errorf("ref run id %q", ref.TemporalRunID)
	}
}

func TestResolveSyntheticScopesNest(t *testing.T) {
	f := newResolverFixture(t, 0)
	f.rootRun(t, "root", models.TriggerManual)
	f.temporal.SetWorkflow("root_for_0", childInfo("root_for_0", "root", "workflow_for_loop", "q"))
	f.temporal.SetWorkflow("root_for_0_try", childInfo("root_for_0_try", "root_for_0", "workflow_try_guard", "q"))
	f.temporal.SetWorkflow("x-unrelated", childInfo("x-unrelated", "root", "workflow_fork_split", "q"))

	res, err := f.resolver.Resolve(t.Context(), "root_for_0_try")
	if err != nil {
		t.Fatal(err)
	}
	if res.ExecutionID != "root" || res.RootExecutionID != "root" || res.ScopePath != "for_0_try" {
		t.Errorf("nested scope: %+v", res)
	}
	if cached, ok := f.resolver.Lookup("root_for_0"); !ok || cached.ScopePath != "for_0" {
		t.Errorf("intermediate scope not cached: %+v %v", cached, ok)
	}

	// An id that doesn't extend its parent's yields no segment: the parent's own scope.
	res, err = f.resolver.Resolve(t.Context(), "x-unrelated")
	if err != nil {
		t.Fatal(err)
	}
	if res.ScopePath != "" {
		t.Errorf("unconventional id should map to the parent scope, got %q", res.ScopePath)
	}
	if len(f.discovered) != 0 {
		t.Error("scopes are not runs of their own")
	}
}

func TestResolveNamedWorkflowFromSwitch(t *testing.T) {
	f := newResolverFixture(t, 0)
	f.rootRun(t, "root", models.TriggerManual)
	f.temporal.SetWorkflow("root_for_0", childInfo("root_for_0", "root", "workflow_for_loop", "q"))
	f.temporal.SetWorkflow("run-x_3", childInfo("run-x_3", "root_for_0", "approve", "q"))

	res, err := f.resolver.Resolve(t.Context(), "run-x_3")
	if err != nil {
		t.Fatal(err)
	}
	if res.ExecutionID != "root" || res.ScopePath != "for_0_workflow_approve" {
		t.Errorf("named workflow: %+v", res)
	}
	var n int64
	f.db.Model(&models.Execution{}).Count(&n)
	if n != 1 {
		t.Errorf("a named workflow must not get its own run row, have %d rows", n)
	}
}

func TestResolveRealChildWorkflow(t *testing.T) {
	f := newResolverFixture(t, 0)
	f.rootRun(t, "root", models.TriggerScheduled)
	child := models.Workflow{ProjectID: "p", Name: "child", WorkflowType: "childType", TaskQueue: "q"}
	f.mustCreate(t, &child)
	f.temporal.SetWorkflow("root_for_0", childInfo("root_for_0", "root", "workflow_for_loop", "q"))
	f.temporal.SetWorkflow("kid", childInfo("kid", "root_for_0", "childType", "q"))
	f.temporal.Histories["root_for_0"] = []*historypb.HistoryEvent{
		{EventType: enumspb.EVENT_TYPE_WORKFLOW_EXECUTION_STARTED},
		startChildEvent(t, "someone-else", "otherTask"),
		startChildEvent(t, "kid", "callChild"),
	}

	res, err := f.resolver.Resolve(t.Context(), "kid")
	if err != nil {
		t.Fatal(err)
	}
	if res.ExecutionID != "kid" || res.RootExecutionID != "root" || res.ScopePath != "" {
		t.Errorf("child resolution: %+v", res)
	}

	var row models.Execution
	if err := f.db.First(&row, "id = ?", "kid").Error; err != nil {
		t.Fatalf("child execution row missing: %v", err)
	}
	if row.WorkflowID != child.ID || row.ParentExecutionID == nil || *row.ParentExecutionID != "root" ||
		row.RootExecutionID != "root" || row.ParentScopePath != "for_0" || row.ParentTaskName != "callChild" ||
		row.Trigger != models.TriggerScheduled || row.Status != models.ExecutionRunning || row.TemporalRunID != "run-kid" {
		t.Errorf("child row: %+v", row)
	}
	if len(f.discovered) != 1 || f.discovered[0].ID != "kid" {
		t.Errorf("OnExecutionDiscovered: %+v", f.discovered)
	}

	// Already-created children are returned as-is, without discovering them twice.
	again := f.resolver.ensureChildExecution(t.Context(), Resolution{ExecutionID: "root", RootExecutionID: "root"}, "root",
		models.Execution{Base: models.Base{ID: "kid"}})
	if again.ParentTaskName != "callChild" || len(f.discovered) != 1 {
		t.Errorf("ensureChildExecution should return the stored row: %+v", again)
	}
}

func startChildEvent(t *testing.T, childID, taskName string) *historypb.HistoryEvent {
	return &historypb.HistoryEvent{
		EventType: enumspb.EVENT_TYPE_START_CHILD_WORKFLOW_EXECUTION_INITIATED,
		Attributes: &historypb.HistoryEvent_StartChildWorkflowExecutionInitiatedEventAttributes{
			StartChildWorkflowExecutionInitiatedEventAttributes: &historypb.StartChildWorkflowExecutionInitiatedEventAttributes{
				WorkflowId: childID,
				Input:      payloads(t, "input", taskMeta(taskName)),
			},
		},
	}
}

func TestChildTaskNameNotFound(t *testing.T) {
	f := newResolverFixture(t, 0)
	f.temporal.Histories["parent"] = []*historypb.HistoryEvent{startChildEvent(t, "other", "x")}
	if got := f.resolver.childTaskName(t.Context(), "parent", "kid"); got != "" {
		t.Errorf("no matching start event: got %q", got)
	}
	f.temporal.Histories["parent"] = []*historypb.HistoryEvent{{
		EventType: enumspb.EVENT_TYPE_START_CHILD_WORKFLOW_EXECUTION_INITIATED,
		Attributes: &historypb.HistoryEvent_StartChildWorkflowExecutionInitiatedEventAttributes{
			StartChildWorkflowExecutionInitiatedEventAttributes: &historypb.StartChildWorkflowExecutionInitiatedEventAttributes{WorkflowId: "kid"},
		},
	}}
	if got := f.resolver.childTaskName(t.Context(), "parent", "kid"); got != "" {
		t.Errorf("start event without task metadata: got %q", got)
	}

	unreachable := NewResolver(f.db, NewLazyClient("127.0.0.1:1"), f.bus, 0)
	if got := unreachable.childTaskName(t.Context(), "parent", "kid"); got != "" {
		t.Errorf("unreachable Temporal: got %q", got)
	}
}

func TestResolveAdoptsScheduledRun(t *testing.T) {
	f := newResolverFixture(t, 0)
	wf := models.Workflow{ProjectID: "p", Name: "nightly", WorkflowType: "nightly", TaskQueue: "q"}
	f.mustCreate(t, &wf)
	started := time.Date(2026, 1, 2, 3, 4, 5, 0, time.UTC)
	info := childInfo("nightly-2026", "", "nightly", "q")
	info.StartTime = timestamppb.New(started)
	info.SearchAttributes = &commonpb.SearchAttributes{IndexedFields: map[string]*commonpb.Payload{
		scheduledBySearchAttribute: payload(t, "zigflow_nightly"),
	}}
	f.temporal.SetWorkflow("nightly-2026", info)

	res, err := f.resolver.Resolve(t.Context(), "nightly-2026")
	if err != nil {
		t.Fatal(err)
	}
	if res != (Resolution{ExecutionID: "nightly-2026", RootExecutionID: "nightly-2026"}) {
		t.Errorf("got %+v", res)
	}
	var row models.Execution
	if err := f.db.First(&row, "id = ?", "nightly-2026").Error; err != nil {
		t.Fatal(err)
	}
	if row.Trigger != models.TriggerScheduled || row.WorkflowID != wf.ID || !row.StartedAt.Equal(started) ||
		row.RootExecutionID != "nightly-2026" || row.Status != models.ExecutionRunning {
		t.Errorf("adopted row: %+v", row)
	}
	if len(f.discovered) != 1 {
		t.Error("adopted run needs a completion watcher")
	}

	// A concurrent second adoption re-reads the winner instead of failing.
	adopted, ok := f.resolver.adoptScheduledRun(t.Context(), "nightly-2026", info)
	if !ok || adopted.ID != "nightly-2026" {
		t.Errorf("re-adoption: %+v %v", adopted, ok)
	}
}

func TestResolveRefusesUnknownRoots(t *testing.T) {
	f := newResolverFixture(t, 0)
	// No parent, not scheduled: someone else's workflow on the namespace.
	f.temporal.SetWorkflow("stranger", childInfo("stranger", "", "theirs", "q"))
	// Scheduled, but no stored workflow has that type.
	scheduled := childInfo("orphan", "", "unknownType", "q")
	scheduled.SearchAttributes = &commonpb.SearchAttributes{IndexedFields: map[string]*commonpb.Payload{
		scheduledBySearchAttribute: payload(t, "x"),
	}}
	f.temporal.SetWorkflow("orphan", scheduled)
	f.temporal.SetWorkflow("orphan2", scheduled)

	for _, id := range []string{"stranger", "orphan", "orphan2"} {
		if _, err := f.resolver.Resolve(t.Context(), id); !errors.Is(err, errUnresolvable) {
			t.Errorf("%s: want errUnresolvable, got %v", id, err)
		}
	}
	// Not described by Temporal at all.
	if _, err := f.resolver.Resolve(t.Context(), "missing"); err == nil {
		t.Error("unknown id resolved")
	}
	// A child whose parent can't be resolved can't be either.
	f.temporal.SetWorkflow("stranger_for_0", childInfo("stranger_for_0", "stranger", "workflow_for_x", "q"))
	if _, err := f.resolver.Resolve(t.Context(), "stranger_for_0"); err == nil {
		t.Error("child of an unknown root resolved")
	}
}

func TestResolveParentCycleIsBounded(t *testing.T) {
	f := newResolverFixture(t, 0)
	f.temporal.SetWorkflow("loop", childInfo("loop", "loop", "workflow_for_x", "q"))
	if _, err := f.resolver.Resolve(t.Context(), "loop"); err == nil {
		t.Error("a self-parented workflow should hit the depth limit")
	}
}

func TestResolveTemporalErrors(t *testing.T) {
	f := newResolverFixture(t, 0)
	f.temporal.DescribeErr = errors.New("boom")
	if _, err := f.resolver.Resolve(t.Context(), "x"); err == nil {
		t.Error("describe failure should surface")
	}

	unreachable := NewResolver(f.db, NewLazyClient("127.0.0.1:1"), f.bus, 0)
	if _, err := unreachable.Resolve(t.Context(), "x"); err == nil {
		t.Error("unreachable Temporal should surface")
	}
}

func TestFindWorkflow(t *testing.T) {
	f := newResolverFixture(t, 0)
	first := models.Workflow{ProjectID: "p", Name: "a", WorkflowType: "t", TaskQueue: "q1"}
	f.mustCreate(t, &first)
	f.mustCreate(t, &models.Workflow{ProjectID: "p", Name: "b", WorkflowType: "t", TaskQueue: "q2"})

	if _, ok := f.resolver.findWorkflow(t.Context(), "", "q1"); ok {
		t.Error("empty type should never match")
	}
	if wf, ok := f.resolver.findWorkflow(t.Context(), "t", "q2"); !ok || wf.Name != "b" {
		t.Errorf("type+queue: %+v %v", wf, ok)
	}
	if wf, ok := f.resolver.findWorkflow(t.Context(), "t", ""); !ok || wf.ID != first.ID {
		t.Errorf("type only should pick the first: %+v %v", wf, ok)
	}
	if _, ok := f.resolver.findWorkflow(t.Context(), "t", "q3"); ok {
		t.Error("wrong queue matched")
	}
}

func TestLookupReadsRefTableAndForget(t *testing.T) {
	f := newResolverFixture(t, 0)
	if _, ok := f.resolver.Lookup("x"); ok {
		t.Fatal("empty resolver found something")
	}
	f.mustCreate(t, &models.WorkflowExecutionRef{
		WorkflowExecutionID: "x_for_0", ExecutionID: "x", RootExecutionID: "x", ScopePath: "for_0",
	})
	res, ok := f.resolver.Lookup("x_for_0")
	if !ok || res.ScopePath != "for_0" {
		t.Fatalf("ref table not consulted: %+v %v", res, ok)
	}
	f.resolver.remember("y", "run-y", Resolution{ExecutionID: "y", RootExecutionID: "y"})

	f.resolver.Forget("x")
	if _, ok := f.resolver.cache.Load("x_for_0"); ok {
		t.Error("Forget left a cached entry of the forgotten tree")
	}
	if _, ok := f.resolver.cache.Load("y"); !ok {
		t.Error("Forget dropped another tree's entry")
	}
}

func storeEvent(t *testing.T, f *resolverFixture, ev models.ExecutionEvent) models.ExecutionEvent {
	t.Helper()
	if ev.DedupeKey == "" {
		ev.DedupeKey = ev.WorkflowExecutionID + ev.EventType + ev.TaskName + time.Now().String()
	}
	if ev.EventType == "" {
		ev.EventType = models.EventTaskCompleted
	}
	f.mustCreate(t, &ev)
	return ev
}

func TestResolveEventPersistsAndPublishes(t *testing.T) {
	f := newResolverFixture(t, 0)
	f.rootRun(t, "root", models.TriggerManual)
	f.temporal.SetWorkflow("root_try", childInfo("root_try", "root", "workflow_try_x", "q"))
	sub := f.bus.Subscribe("root")
	defer sub.Close()

	pending := storeEvent(t, f, models.ExecutionEvent{WorkflowExecutionID: "root_try", TaskName: "a"})
	f.resolver.resolveEvent(t.Context(), pending.Seq)

	var stored models.ExecutionEvent
	f.db.First(&stored, "seq = ?", pending.Seq)
	if stored.ExecutionID != "root" || stored.RootExecutionID != "root" || stored.ScopePath != "try" {
		t.Errorf("resolution not persisted: %+v", stored)
	}
	select {
	case ev := <-sub.C:
		if ev.Seq != pending.Seq || ev.ScopePath != "try" {
			t.Errorf("published %+v", ev)
		}
	default:
		t.Error("resolved event not published")
	}

	// Already-resolved events are just republished.
	known := storeEvent(t, f, models.ExecutionEvent{WorkflowExecutionID: "root", ExecutionID: "root", TaskName: "b"})
	f.resolver.resolveEvent(t.Context(), known.Seq)
	if ev := <-sub.C; ev.Seq != known.Seq {
		t.Errorf("published %+v", ev)
	}

	// Unresolvable ones stay pending; unknown seqs are ignored.
	lost := storeEvent(t, f, models.ExecutionEvent{WorkflowExecutionID: "nobody", TaskName: "c"})
	f.resolver.resolveEvent(t.Context(), lost.Seq)
	f.resolver.resolveEvent(t.Context(), 99999)
	var stillPending models.ExecutionEvent
	f.db.First(&stillPending, "seq = ?", lost.Seq)
	if stillPending.ExecutionID != "" {
		t.Errorf("unresolvable event attributed to %q", stillPending.ExecutionID)
	}
	if len(sub.C) != 0 {
		t.Error("unexpected publish")
	}
}

func TestSweepRetriesOnlyStalePendingEvents(t *testing.T) {
	f := newResolverFixture(t, 0)
	f.rootRun(t, "root", models.TriggerManual)
	stale := storeEvent(t, f, models.ExecutionEvent{WorkflowExecutionID: "root", TaskName: "old", ReceivedAt: time.Now().Add(-time.Minute)})
	fresh := storeEvent(t, f, models.ExecutionEvent{WorkflowExecutionID: "root", TaskName: "new", ReceivedAt: time.Now()})

	f.resolver.sweep(t.Context())

	var got models.ExecutionEvent
	f.db.First(&got, "seq = ?", stale.Seq)
	if got.ExecutionID != "root" {
		t.Error("stale pending event not resolved by the sweep")
	}
	var notYet models.ExecutionEvent
	f.db.First(&notYet, "seq = ?", fresh.Seq)
	if notYet.ExecutionID != "" {
		t.Error("fresh events are left to the queue, not the sweep")
	}
}

func TestPruneKeepsNewestPerExecution(t *testing.T) {
	f := newResolverFixture(t, 2)
	var seqs []uint64
	for i := 0; i < 5; i++ {
		seqs = append(seqs, storeEvent(t, f, models.ExecutionEvent{WorkflowExecutionID: "a", ExecutionID: "a", TaskName: string(rune('a' + i))}).Seq)
	}
	storeEvent(t, f, models.ExecutionEvent{WorkflowExecutionID: "b", ExecutionID: "b", TaskName: "only"})
	storeEvent(t, f, models.ExecutionEvent{WorkflowExecutionID: "u", TaskName: "u1"})
	storeEvent(t, f, models.ExecutionEvent{WorkflowExecutionID: "u", TaskName: "u2"})
	storeEvent(t, f, models.ExecutionEvent{WorkflowExecutionID: "u", TaskName: "u3"})

	f.resolver.prune(t.Context())

	var kept []uint64
	f.db.Model(&models.ExecutionEvent{}).Where("execution_id = ?", "a").Order("seq").Pluck("seq", &kept)
	if len(kept) != 2 || kept[0] != seqs[3] || kept[1] != seqs[4] {
		t.Errorf("kept %v, want the newest two of %v", kept, seqs)
	}
	var n int64
	f.db.Model(&models.ExecutionEvent{}).Where("execution_id IN ('b', '')").Count(&n)
	if n != 4 {
		t.Errorf("prune touched executions under the limit or unresolved events: %d left", n)
	}

	unbounded := newResolverFixture(t, 0)
	storeEvent(t, unbounded, models.ExecutionEvent{WorkflowExecutionID: "a", ExecutionID: "a", TaskName: "1"})
	unbounded.resolver.prune(t.Context())
	unbounded.db.Model(&models.ExecutionEvent{}).Count(&n)
	if n != 1 {
		t.Error("retention 0 means keep everything")
	}
}

func TestRunProcessesQueueUntilCancelled(t *testing.T) {
	f := newResolverFixture(t, 0)
	f.rootRun(t, "root", models.TriggerManual)
	sub := f.bus.Subscribe("root")
	defer sub.Close()

	ctx, cancel := context.WithCancel(t.Context())
	done := make(chan struct{})
	go func() {
		f.resolver.Run(ctx)
		close(done)
	}()

	ev := storeEvent(t, f, models.ExecutionEvent{WorkflowExecutionID: "root", TaskName: "a"})
	f.resolver.Enqueue(ev.Seq)
	select {
	case got := <-sub.C:
		if got.Seq != ev.Seq {
			t.Errorf("got %+v", got)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("queued event never resolved")
	}

	cancel()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Run did not stop on cancel")
	}
}

func TestEnqueueNeverBlocks(t *testing.T) {
	f := newResolverFixture(t, 0)
	finished := make(chan struct{})
	go func() {
		for i := 0; i < resolveQueueCap+10; i++ {
			f.resolver.Enqueue(uint64(i))
		}
		close(finished)
	}()
	select {
	case <-finished:
	case <-time.After(5 * time.Second):
		t.Fatal("Enqueue blocked on a full queue")
	}
}

func TestScopePathHelpers(t *testing.T) {
	if got := scopeSegment("p", "p_for_0"); got != "for_0" {
		t.Errorf("scopeSegment = %q", got)
	}
	if got := scopeSegment("p", "q_for_0"); got != "" {
		t.Errorf("scopeSegment of an unrelated id = %q", got)
	}
	cases := []struct{ parent, seg, want string }{
		{"", "", ""}, {"a", "", "a"}, {"", "b", "b"}, {"a", "b", "a_b"},
	}
	for _, c := range cases {
		if got := joinScopePath(c.parent, c.seg); got != c.want {
			t.Errorf("joinScopePath(%q, %q) = %q, want %q", c.parent, c.seg, got, c.want)
		}
	}
	if namedWorkflowSegment("approve") != "workflow_approve" {
		t.Error("namedWorkflowSegment")
	}
}
