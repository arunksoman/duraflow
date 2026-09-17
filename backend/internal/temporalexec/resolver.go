package temporalexec

import (
	"context"
	"errors"
	"fmt"
	"log"
	"regexp"
	"strings"
	"sync"
	"time"

	enumspb "go.temporal.io/api/enums/v1"
	workflowpb "go.temporal.io/api/workflow/v1"
	"gorm.io/gorm"

	"duraflow/backend/internal/events"
	"duraflow/backend/internal/models"
)

// A CloudEvent's `id` is the Temporal workflow execution it came from, which is only sometimes
// the execution the user started. zigflow runs `for`/`fork`/`try`/`catch` bodies as synthetic
// child workflows of these types, and `run: workflow` tasks as real ones:
//
//	<root>                        the Execution row's own id
//	<root>_for_0                  type workflow_for_<task>    — a scope within <root>
//	<root>_for_0_try              type workflow_try_<task>    — a scope within a scope
//	<parentRunId>_3               the user's own workflow type — a separate run entirely
//
// Only the last kind deserves its own Execution row. The others are *locations on the parent's
// canvas*, which this resolver expresses as a ScopePath the frontend maps onto its scope tree.
var syntheticScopeWorkflow = regexp.MustCompile(`^workflow_(for|fork|try|catch)_`)

const (
	maxParentDepth  = 32
	resolveTimeout  = 5 * time.Second
	sweepInterval   = 30 * time.Second
	resolveQueueCap = 1024
)

var errUnresolvable = errors.New("workflow execution has no duraflow ancestor")

// Resolution says which Execution row an event belongs to and where on that execution's canvas
// it happened.
type Resolution struct {
	ExecutionID     string
	RootExecutionID string
	ScopePath       string
}

// Resolver maps Temporal workflow execution ids to Executions by walking Temporal's parent
// chain, creating Execution rows for real child workflows as it discovers them, and publishing
// each resolved event to whoever is watching that run.
//
// It runs on its own goroutine precisely so the CloudEvents ingest handler can stay free of
// network calls: zigflow blocks a running workflow while it waits for that HTTP response.
type Resolver struct {
	db        *gorm.DB
	temporal  *LazyClient
	bus       *events.Broker
	retention int

	cache sync.Map // workflowExecutionID -> Resolution
	in    chan uint64

	// OnExecutionDiscovered is called once for each child Execution row this resolver creates,
	// so the caller can start watching it for completion. Set before Run.
	OnExecutionDiscovered func(models.Execution)

	warnedOnce sync.Map // workflowType -> struct{}, so an unknown child type logs once
}

func NewResolver(db *gorm.DB, temporal *LazyClient, bus *events.Broker, retention int) *Resolver {
	return &Resolver{
		db:        db,
		temporal:  temporal,
		bus:       bus,
		retention: retention,
		in:        make(chan uint64, resolveQueueCap),
	}
}

// Lookup answers from memory or the ref table only — never Temporal. The ingest handler uses it
// to stamp an event's owner inline when that's already known, which is the common case after the
// first event of a run.
func (r *Resolver) Lookup(wfExecID string) (Resolution, bool) {
	if v, ok := r.cache.Load(wfExecID); ok {
		return v.(Resolution), true
	}

	var ref models.WorkflowExecutionRef
	if err := r.db.First(&ref, "workflow_execution_id = ?", wfExecID).Error; err != nil {
		return Resolution{}, false
	}
	res := Resolution{ExecutionID: ref.ExecutionID, RootExecutionID: ref.RootExecutionID, ScopePath: ref.ScopePath}
	r.cache.Store(wfExecID, res)
	return res, true
}

// Enqueue asks for an event to be resolved, without blocking the caller. A dropped enqueue is
// harmless: the periodic sweep picks up anything still unresolved.
func (r *Resolver) Enqueue(seq uint64) {
	select {
	case r.in <- seq:
	default:
	}
}

// Run processes the resolve queue until ctx is cancelled. Start it once, from main.
func (r *Resolver) Run(ctx context.Context) {
	ticker := time.NewTicker(sweepInterval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			return
		case seq := <-r.in:
			r.resolveEvent(ctx, seq)
		case <-ticker.C:
			r.sweep(ctx)
			r.prune(ctx)
		}
	}
}

func (r *Resolver) resolveEvent(ctx context.Context, seq uint64) {
	var ev models.ExecutionEvent
	if err := r.db.WithContext(ctx).First(&ev, "seq = ?", seq).Error; err != nil {
		return
	}
	if ev.ExecutionID != "" {
		r.bus.Publish(ev.ExecutionID, ev)
		return
	}

	resolveCtx, cancel := context.WithTimeout(ctx, resolveTimeout)
	res, err := r.Resolve(resolveCtx, ev.WorkflowExecutionID)
	cancel()
	if err != nil {
		return // the sweep retries
	}

	ev.ExecutionID = res.ExecutionID
	ev.RootExecutionID = res.RootExecutionID
	ev.ScopePath = res.ScopePath
	if err := r.db.WithContext(ctx).Model(&models.ExecutionEvent{}).Where("seq = ?", seq).
		Updates(map[string]any{
			"execution_id":      res.ExecutionID,
			"root_execution_id": res.RootExecutionID,
			"scope_path":        res.ScopePath,
		}).Error; err != nil {
		log.Printf("[telemetry] persisting resolution for event %d: %v", seq, err)
		return
	}
	r.bus.Publish(res.ExecutionID, ev)
}

// sweep retries events the queue dropped or that failed to resolve while Temporal was briefly
// unreachable. Events are left unresolved rather than discarded, so nothing is ever lost.
func (r *Resolver) sweep(ctx context.Context) {
	var pending []models.ExecutionEvent
	if err := r.db.WithContext(ctx).
		Where("execution_id = '' AND received_at < ?", time.Now().Add(-5*time.Second)).
		Order("seq").Limit(500).Find(&pending).Error; err != nil {
		return
	}
	for _, ev := range pending {
		r.resolveEvent(ctx, ev.Seq)
	}
}

// prune keeps each execution's event log bounded — zigflow ships the whole workflow state in
// every event, so an unbounded log would dominate the database.
func (r *Resolver) prune(ctx context.Context) {
	if r.retention <= 0 {
		return
	}

	var executionIDs []string
	if err := r.db.WithContext(ctx).Model(&models.ExecutionEvent{}).
		Select("execution_id").Where("execution_id <> ''").
		Group("execution_id").Having("count(*) > ?", r.retention).
		Find(&executionIDs).Error; err != nil {
		return
	}

	for _, id := range executionIDs {
		var cutoff uint64
		if err := r.db.WithContext(ctx).Model(&models.ExecutionEvent{}).
			Select("seq").Where("execution_id = ?", id).
			Order("seq desc").Offset(r.retention).Limit(1).
			Scan(&cutoff).Error; err != nil || cutoff == 0 {
			continue
		}
		r.db.WithContext(ctx).Where("execution_id = ? AND seq <= ?", id, cutoff).
			Delete(&models.ExecutionEvent{})
	}
}

// Resolve walks upward from a Temporal workflow execution id until it reaches something duraflow
// knows about, creating child Execution rows on the way. Results are memoized in both the
// in-process cache and the workflow_execution_refs table, so each id costs at most one walk ever.
func (r *Resolver) Resolve(ctx context.Context, wfExecID string) (Resolution, error) {
	return r.resolve(ctx, wfExecID, 0)
}

func (r *Resolver) resolve(ctx context.Context, wfExecID string, depth int) (Resolution, error) {
	if res, ok := r.Lookup(wfExecID); ok {
		return res, nil
	}

	// A root run: create-execution starts the workflow with the Execution row's own id.
	var execution models.Execution
	if err := r.db.WithContext(ctx).First(&execution, "id = ?", wfExecID).Error; err == nil {
		root := execution.RootExecutionID
		if root == "" {
			root = execution.ID
		}
		res := Resolution{ExecutionID: execution.ID, RootExecutionID: root}
		r.remember(wfExecID, execution.TemporalRunID, res)
		return res, nil
	}

	if depth >= maxParentDepth {
		return Resolution{}, fmt.Errorf("parent chain deeper than %d for %q", maxParentDepth, wfExecID)
	}

	client, err := r.temporal.Get()
	if err != nil {
		return Resolution{}, err
	}
	desc, err := client.DescribeWorkflowExecution(ctx, wfExecID, "")
	if err != nil {
		return Resolution{}, err
	}

	info := desc.GetWorkflowExecutionInfo()
	parentID := info.GetParentExecution().GetWorkflowId()
	if parentID == "" {
		// A root run duraflow never started. The one kind worth adopting is a scheduled run: the
		// workflow's own DSL asked Temporal to start it, so it belongs in that workflow's run list
		// even though no create-execution call ever made a row for it.
		if adopted, ok := r.adoptScheduledRun(ctx, wfExecID, info); ok {
			res := Resolution{ExecutionID: adopted.ID, RootExecutionID: adopted.ID}
			r.remember(wfExecID, adopted.TemporalRunID, res)
			return res, nil
		}
		return Resolution{}, fmt.Errorf("%w: %s", errUnresolvable, wfExecID)
	}

	parentRes, err := r.resolve(ctx, parentID, depth+1)
	if err != nil {
		return Resolution{}, err
	}

	workflowType := info.GetType().GetName()
	runID := info.GetExecution().GetRunId()

	if !syntheticScopeWorkflow.MatchString(workflowType) {
		// Possibly a real `run: workflow` child. It only gets its own Execution row if we can
		// identify which stored workflow it is; otherwise it's most likely a switch-`then`
		// redirect (zigflow registers those under the target task's name), and inventing a run
		// for it would litter the executions list.
		if wf, ok := r.findWorkflow(ctx, workflowType, info.GetTaskQueue()); ok {
			child := r.ensureChildExecution(ctx, parentRes, parentID, models.Execution{
				Base:            models.Base{ID: wfExecID},
				WorkflowID:      wf.ID,
				WorkflowType:    workflowType,
				TemporalRunID:   runID,
				ParentScopePath: parentRes.ScopePath,
			})
			res := Resolution{ExecutionID: child.ID, RootExecutionID: child.RootExecutionID}
			r.remember(wfExecID, runID, res)
			return res, nil
		}
		if _, seen := r.warnedOnce.LoadOrStore(workflowType, struct{}{}); !seen {
			log.Printf(
				"[telemetry] workflow type %q under %s matches no stored workflow — "+
					"treating its tasks as part of the parent run",
				workflowType, parentID,
			)
		}
	}

	res := Resolution{
		ExecutionID:     parentRes.ExecutionID,
		RootExecutionID: parentRes.RootExecutionID,
		ScopePath:       joinScopePath(parentRes.ScopePath, scopeSegment(parentID, wfExecID)),
	}
	r.remember(wfExecID, runID, res)
	return res, nil
}

// scopeSegment recovers the scope label zigflow encodes in a synthetic child's workflow id —
// "for_0", "try", "catch", "fork_<branch>". An id that doesn't follow the convention yields "",
// which the frontend treats as "unknown scope" and falls back to matching on task name alone.
func scopeSegment(parentID, childID string) string {
	if rest, ok := strings.CutPrefix(childID, parentID+"_"); ok {
		return rest
	}
	return ""
}

func joinScopePath(parent, segment string) string {
	switch {
	case segment == "":
		return parent
	case parent == "":
		return segment
	default:
		return parent + "_" + segment
	}
}

func (r *Resolver) findWorkflow(ctx context.Context, workflowType, taskQueue string) (models.Workflow, bool) {
	if workflowType == "" {
		return models.Workflow{}, false
	}

	var matches []models.Workflow
	query := r.db.WithContext(ctx).Where("workflow_type = ?", workflowType)
	if taskQueue != "" {
		query = query.Where("task_queue = ?", taskQueue)
	}
	if err := query.Find(&matches).Error; err != nil || len(matches) == 0 {
		return models.Workflow{}, false
	}
	// More than one workflow can legitimately declare the same type on the same queue; the first
	// by creation order is as good a guess as any, and the run is still fully viewable either way.
	return matches[0], true
}

// scheduledBySearchAttribute is the system search attribute Temporal stamps on every workflow a
// schedule starts. Only its presence matters here, so the payload is never decoded.
const scheduledBySearchAttribute = "TemporalScheduledById"

// adoptScheduledRun creates the Execution row for a run Temporal started from a workflow's own
// `schedule:` block. It's the counterpart of create-execution for runs nobody asked for
// interactively: without it, every scheduled run's events would sit unresolved forever and the
// executions list would show only manual runs.
//
// Runs that merely have no parent are left alone — an unrecognised root is far more likely to be
// something else on the same Temporal namespace than a run of ours.
func (r *Resolver) adoptScheduledRun(
	ctx context.Context,
	wfExecID string,
	info *workflowpb.WorkflowExecutionInfo,
) (models.Execution, bool) {
	if _, scheduled := info.GetSearchAttributes().GetIndexedFields()[scheduledBySearchAttribute]; !scheduled {
		return models.Execution{}, false
	}

	workflowType := info.GetType().GetName()
	wf, ok := r.findWorkflow(ctx, workflowType, info.GetTaskQueue())
	if !ok {
		if _, seen := r.warnedOnce.LoadOrStore(workflowType, struct{}{}); !seen {
			log.Printf(
				"[telemetry] scheduled run %s of workflow type %q matches no stored workflow — ignoring",
				wfExecID, workflowType,
			)
		}
		return models.Execution{}, false
	}

	startedAt := time.Now()
	if t := info.GetStartTime(); t != nil {
		startedAt = t.AsTime()
	}
	execution := models.Execution{
		Base:            models.Base{ID: wfExecID},
		WorkflowID:      wf.ID,
		WorkflowType:    workflowType,
		TemporalRunID:   info.GetExecution().GetRunId(),
		RootExecutionID: wfExecID,
		Trigger:         models.TriggerScheduled,
		Status:          models.ExecutionRunning,
		StartedAt:       startedAt,
	}

	if err := r.db.WithContext(ctx).Create(&execution).Error; err != nil {
		// Two events from the same scheduled run can race here; whoever lost re-reads the winner.
		var existing models.Execution
		if err := r.db.WithContext(ctx).First(&existing, "id = ?", wfExecID).Error; err == nil {
			return existing, true
		}
		log.Printf("[telemetry] creating scheduled execution %s: %v", wfExecID, err)
		return models.Execution{}, false
	}

	// Nothing else is waiting on this run, so without a watcher it would stay `running` forever.
	if r.OnExecutionDiscovered != nil {
		r.OnExecutionDiscovered(execution)
	}
	return execution, true
}

// ensureChildExecution records a `run: workflow` child as a run in its own right, linked back to
// the task on the parent's canvas that started it, so the UI can offer a drill-down from that node.
func (r *Resolver) ensureChildExecution(
	ctx context.Context,
	parentRes Resolution,
	parentWorkflowID string,
	child models.Execution,
) models.Execution {
	var existing models.Execution
	if err := r.db.WithContext(ctx).First(&existing, "id = ?", child.ID).Error; err == nil {
		return existing
	}

	parentExecutionID := parentRes.ExecutionID
	child.ParentExecutionID = &parentExecutionID
	child.RootExecutionID = parentRes.RootExecutionID
	child.Trigger = models.TriggerManual
	var root models.Execution
	if err := r.db.WithContext(ctx).Select("run_trigger").First(&root, "id = ?", parentRes.RootExecutionID).Error; err == nil && root.Trigger != "" {
		child.Trigger = root.Trigger
	}
	child.Status = models.ExecutionRunning
	child.StartedAt = time.Now()
	child.ParentTaskName = r.childTaskName(ctx, parentWorkflowID, child.ID)

	if err := r.db.WithContext(ctx).Create(&child).Error; err != nil {
		// Another goroutine may have just created it; re-read rather than fail the resolution.
		if err := r.db.WithContext(ctx).First(&existing, "id = ?", child.ID).Error; err == nil {
			return existing
		}
		log.Printf("[telemetry] creating child execution %s: %v", child.ID, err)
		return child
	}

	if r.OnExecutionDiscovered != nil {
		r.OnExecutionDiscovered(child)
	}
	return child
}

// childTaskName finds which DSL task in the parent started this child, by locating the
// StartChildWorkflowExecutionInitiated event that named it. Without this the UI knows a child ran
// but not which node to hang the link off.
func (r *Resolver) childTaskName(ctx context.Context, parentWorkflowID, childWorkflowID string) string {
	client, err := r.temporal.Get()
	if err != nil {
		return ""
	}

	iter := client.GetWorkflowHistory(ctx, parentWorkflowID, "", false, enumspb.HISTORY_EVENT_FILTER_TYPE_ALL_EVENT)
	for iter.HasNext() {
		ev, err := iter.Next()
		if err != nil {
			return ""
		}
		if ev.GetEventType() != enumspb.EVENT_TYPE_START_CHILD_WORKFLOW_EXECUTION_INITIATED {
			continue
		}
		attrs := ev.GetStartChildWorkflowExecutionInitiatedEventAttributes()
		if attrs.GetWorkflowId() != childWorkflowID {
			continue
		}
		if name, ok := ExtractTaskName(ev.GetUserMetadata().GetSummary(), attrs.GetInput()); ok {
			return name
		}
		return ""
	}
	return ""
}

// Forget drops every cached resolution belonging to a deleted run tree, so a late event from it
// can't be attributed to an Execution row that no longer exists.
func (r *Resolver) Forget(rootExecutionIDs ...string) {
	roots := make(map[string]struct{}, len(rootExecutionIDs))
	for _, id := range rootExecutionIDs {
		roots[id] = struct{}{}
	}
	r.cache.Range(func(key, value any) bool {
		if _, ok := roots[value.(Resolution).RootExecutionID]; ok {
			r.cache.Delete(key)
		}
		return true
	})
}

func (r *Resolver) remember(wfExecID, runID string, res Resolution) {
	r.cache.Store(wfExecID, res)
	ref := models.WorkflowExecutionRef{
		WorkflowExecutionID: wfExecID,
		TemporalRunID:       runID,
		ExecutionID:         res.ExecutionID,
		RootExecutionID:     res.RootExecutionID,
		ScopePath:           res.ScopePath,
		CreatedAt:           time.Now(),
	}
	if err := r.db.Save(&ref).Error; err != nil {
		log.Printf("[telemetry] caching resolution for %s: %v", wfExecID, err)
	}
}
