package api

import (
	"context"
	"encoding/json"
	"log"
	"net/http"
	"sync"
	"time"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/sse"
	"github.com/google/uuid"
	enumspb "go.temporal.io/api/enums/v1"
	"go.temporal.io/sdk/client"
	"gopkg.in/yaml.v3"

	"duraflow/backend/internal/models"
	"duraflow/backend/internal/temporalexec"
)

// executionDTO mirrors the frontend's Execution type (src/lib/types/index.ts)
// exactly, decoding the model's raw JSON columns into plain maps for the API.
type executionDTO struct {
	ID                string                 `json:"id"`
	WorkflowID        string                 `json:"workflowId"`
	WorkflowName      string                 `json:"workflowName"`
	Status            models.ExecutionStatus `json:"status"`
	StartedAt         time.Time              `json:"startedAt"`
	CompletedAt       *time.Time             `json:"completedAt,omitempty"`
	Input             map[string]any         `json:"input,omitempty"`
	Output            any                    `json:"output,omitempty"`
	ParentExecutionID *string                `json:"parentExecutionId,omitempty"`
	TemporalRunID     string                 `json:"temporalRunId,omitempty"`
	Error             string                 `json:"error,omitempty"`
	WorkflowType      string                 `json:"workflowType,omitempty"`
	RootExecutionID   string                 `json:"rootExecutionId,omitempty"`
	ParentTaskName    string                 `json:"parentTaskName,omitempty"`
	ParentScopePath   string                 `json:"parentScopePath,omitempty"`
}

func toExecutionDTO(e models.Execution, workflowName string) executionDTO {
	dto := executionDTO{
		ID:                e.ID,
		WorkflowID:        e.WorkflowID,
		WorkflowName:      workflowName,
		Status:            e.Status,
		StartedAt:         e.StartedAt,
		CompletedAt:       e.CompletedAt,
		ParentExecutionID: e.ParentExecutionID,
		TemporalRunID:     e.TemporalRunID,
		Error:             e.Error,
		WorkflowType:      e.WorkflowType,
		RootExecutionID:   e.RootExecutionID,
		ParentTaskName:    e.ParentTaskName,
		ParentScopePath:   e.ParentScopePath,
	}
	if len(e.Input) > 0 {
		_ = json.Unmarshal(e.Input, &dto.Input)
	}
	if len(e.Output) > 0 {
		// A workflow's `$output` is whatever the last task produced — frequently a string or an
		// array, not an object — so this stays `any` rather than the map the rest of the app uses.
		_ = json.Unmarshal(e.Output, &dto.Output)
	}
	return dto
}

// executionEventDTO is one entry of a run's timeline, as streamed and as replayed. It mirrors
// the frontend's ExecutionEvent type.
type executionEventDTO struct {
	Seq                 uint64          `json:"seq"`
	ExecutionID         string          `json:"executionId"`
	RootExecutionID     string          `json:"rootExecutionId,omitempty"`
	WorkflowExecutionID string          `json:"workflowExecutionId"`
	ScopePath           string          `json:"scopePath,omitempty"`
	EventType           string          `json:"eventType"`
	TaskName            string          `json:"taskName,omitempty"`
	Attempt             int             `json:"attempt,omitempty"`
	OccurredAt          time.Time       `json:"occurredAt"`
	Data                json.RawMessage `json:"data,omitempty"`
	Truncated           bool            `json:"truncated,omitempty"`
}

func toExecutionEventDTO(e models.ExecutionEvent) executionEventDTO {
	return executionEventDTO{
		Seq:                 e.Seq,
		ExecutionID:         e.ExecutionID,
		RootExecutionID:     e.RootExecutionID,
		WorkflowExecutionID: e.WorkflowExecutionID,
		ScopePath:           e.ScopePath,
		EventType:           e.EventType,
		TaskName:            e.TaskName,
		Attempt:             e.Attempt,
		OccurredAt:          e.OccurredAt,
		Data:                json.RawMessage(e.Data),
		Truncated:           e.Truncated,
	}
}

func workflowName(deps *Deps, ctx context.Context, workflowID string) string {
	var workflow models.Workflow
	deps.DB.WithContext(ctx).Select("name").First(&workflow, "id = ?", workflowID)
	return workflow.Name
}

// reconcileStatus checks a still-"running" execution against Temporal and, if the workflow has
// actually closed, persists the real terminal status/output/completedAt. Nothing in this backend
// ever polls Temporal on its own or receives a callback, so without this an execution's status
// would otherwise stay "running" in the database forever once created (see create-execution).
// A no-op for executions that are already in a terminal status, or if Temporal can't be reached.
func reconcileStatus(ctx context.Context, deps *Deps, execution models.Execution) models.Execution {
	if execution.Status != models.ExecutionRunning {
		return execution
	}

	temporalClient, err := deps.Temporal.Get()
	if err != nil {
		return execution
	}

	desc, err := temporalClient.DescribeWorkflowExecution(ctx, execution.ID, execution.TemporalRunID)
	if err != nil {
		return execution
	}

	status := desc.GetWorkflowExecutionInfo().GetStatus()
	if status == enumspb.WORKFLOW_EXECUTION_STATUS_RUNNING || status == enumspb.WORKFLOW_EXECUTION_STATUS_UNSPECIFIED {
		return execution
	}

	completedAt := time.Now()
	if closeTime := desc.GetWorkflowExecutionInfo().GetCloseTime(); closeTime != nil {
		completedAt = closeTime.AsTime()
	}

	var result any
	err = temporalClient.GetWorkflow(ctx, execution.ID, execution.TemporalRunID).Get(ctx, &result)
	applyTerminalResult(&execution, temporalexec.MapWorkflowStatus(status), completedAt, result, err)

	if err := deps.DB.WithContext(ctx).Save(&execution).Error; err != nil {
		return execution
	}
	return execution
}

// applyTerminalResult writes the outcome of a closed workflow onto an execution: its status,
// close time, and either the workflow's `$output` or the failure message. The message is the
// single most useful thing to show after a failed run and was previously never stored.
//
// `status` comes from Temporal's own view of the closed workflow and wins; `runErr` only supplies
// the message. The two disagree in a case worth not getting wrong: a workflow that completed with
// a result this client can't decode returns an error from Get while being a perfectly successful
// run. Only a status Temporal couldn't tell us falls back to inferring failure from the error.
func applyTerminalResult(
	execution *models.Execution,
	status models.ExecutionStatus,
	completedAt time.Time,
	result any,
	runErr error,
) {
	execution.Status = status
	execution.CompletedAt = &completedAt

	if runErr != nil {
		execution.Error = runErr.Error()
		if execution.Status == models.ExecutionRunning {
			execution.Status = models.ExecutionFailed
		}
		return
	}

	execution.Error = ""
	if result != nil {
		if outputJSON, err := json.Marshal(result); err == nil {
			execution.Output = outputJSON
		}
	}
}

// watchTerminal blocks on a running workflow until Temporal reports it closed, then persists the
// outcome and tells watchers. One goroutine per running execution: nothing else in this backend
// learns that a workflow finished, so without it an execution's status stays "running" forever
// and the UI's run panel never resolves.
func watchTerminal(deps *Deps, executionID string) {
	// Every reconnecting watcher asks for one of these; one per execution is enough.
	if _, alreadyWatching := terminalWatches.LoadOrStore(executionID, struct{}{}); alreadyWatching {
		return
	}
	defer terminalWatches.Delete(executionID)

	temporalClient, err := deps.Temporal.Get()
	if err != nil {
		return
	}

	ctx := context.Background()
	var execution models.Execution
	if err := deps.DB.WithContext(ctx).First(&execution, "id = ?", executionID).Error; err != nil {
		return
	}
	if execution.Status != models.ExecutionRunning {
		return
	}

	var result any
	runErr := temporalClient.GetWorkflow(ctx, execution.ID, execution.TemporalRunID).Get(ctx, &result)

	// Temporal's own view of the close is authoritative; only fall back to inferring from the
	// error if it can't be reached at all.
	status := models.ExecutionCompleted
	if runErr != nil {
		status = models.ExecutionFailed
	}
	completedAt := time.Now()
	if desc, err := temporalClient.DescribeWorkflowExecution(ctx, execution.ID, execution.TemporalRunID); err == nil {
		info := desc.GetWorkflowExecutionInfo()
		status = temporalexec.MapWorkflowStatus(info.GetStatus())
		if closeTime := info.GetCloseTime(); closeTime != nil {
			completedAt = closeTime.AsTime()
		}
	}

	// Re-read: the resolver may have filled in fields while the workflow was running.
	if err := deps.DB.WithContext(ctx).First(&execution, "id = ?", executionID).Error; err != nil {
		return
	}
	applyTerminalResult(&execution, status, completedAt, result, runErr)
	if err := deps.DB.WithContext(ctx).Save(&execution).Error; err != nil {
		log.Printf("[execution:%s] persisting terminal status: %v", executionID, err)
		return
	}

	deps.Bus.Publish(executionID, models.ExecutionEvent{
		ExecutionID:         executionID,
		WorkflowExecutionID: executionID,
		EventType:           terminalMarkerEventType,
		OccurredAt:          completedAt,
		ReceivedAt:          time.Now(),
	})
}

// terminalMarkerEventType is published on the bus (never stored) purely to wake a watching SSE
// handler once the execution has closed.
const terminalMarkerEventType = "__duraflow.terminal"

// terminalWatches keeps watchTerminal to one goroutine per execution, since every SSE reconnect
// and every page load asks for one.
var terminalWatches sync.Map

// watchDone is the SSE stream's terminal message — sent exactly once, right before the stream
// closes, once the workflow itself has finished (successfully or not).
type watchDone struct {
	Done   bool                   `json:"done"`
	Status models.ExecutionStatus `json:"status,omitempty"`
	Error  string                 `json:"error,omitempty"`
}

// statusEvent tells a watcher the run's current status without waiting for it to end — sent once
// on connect, so a page that attaches to an already-finished run renders correctly.
type statusEvent struct {
	Status models.ExecutionStatus `json:"status"`
	Error  string                 `json:"error,omitempty"`
}

// refetchEvent asks the client to re-read the event log from the given sequence, because this
// connection fell too far behind for the broker to keep buffering.
type refetchEvent struct {
	AfterSeq uint64 `json:"afterSeq"`
}

// dslDocumentHeader extracts just the `document.taskQueue`/`document.workflowType` fields a
// Temporal client needs to start an execution — the same fields the zigflow-engine's DSL header
// requires (see frontend's zigflow.schema.json), parsed here without pulling in the full engine.
type dslDocumentHeader struct {
	Document struct {
		TaskQueue    string `yaml:"taskQueue"`
		WorkflowType string `yaml:"workflowType"`
	} `yaml:"document"`
}

func parseDSLHeader(dsl string) (taskQueue, workflowType string, err error) {
	var doc dslDocumentHeader
	if err := yaml.Unmarshal([]byte(dsl), &doc); err != nil {
		return "", "", err
	}
	return doc.Document.TaskQueue, doc.Document.WorkflowType, nil
}

// ParseDSLHeader exposes parseDSLHeader for startup-time backfills in cmd/server.
func ParseDSLHeader(dsl string) (taskQueue, workflowType string, err error) {
	return parseDSLHeader(dsl)
}

// WatchExecutionUntilClosed blocks until the given execution's Temporal workflow closes, then
// persists its terminal status/output/error and notifies watchers. Exported so startup and the
// child-workflow resolver can attach watchers to runs they didn't start.
func WatchExecutionUntilClosed(deps *Deps, executionID string) {
	watchTerminal(deps, executionID)
}

const (
	// maxEventPageSize bounds both the /events endpoint and the backlog a watcher replays.
	maxEventPageSize = 5000
	// watchHeartbeat keeps an idle SSE stream alive through proxies while a slow task runs.
	watchHeartbeat = 20 * time.Second
)

// loadExecutionEvents reads an execution's recorded timeline in receive order. Only resolved
// events are returned — an event whose owning execution isn't known yet would have nowhere to go.
func loadExecutionEvents(
	ctx context.Context, deps *Deps, executionID string, afterSeq uint64, limit int,
) ([]models.ExecutionEvent, error) {
	var events []models.ExecutionEvent
	err := deps.DB.WithContext(ctx).
		Where("execution_id = ? AND seq > ?", executionID, afterSeq).
		Order("seq").Limit(limit).Find(&events).Error
	return events, err
}

// mustLoadEvents is the best-effort variant used while closing a stream, where a read failure
// shouldn't stop the client from being told the run finished.
func mustLoadEvents(ctx context.Context, deps *Deps, executionID string, afterSeq uint64) []models.ExecutionEvent {
	events, err := loadExecutionEvents(ctx, deps, executionID, afterSeq, maxEventPageSize)
	if err != nil {
		return nil
	}
	return events
}

type listExecutionsInput struct {
	WorkflowID string `path:"id"`
	// RootsOnly hides child-workflow runs, which have their own rows but belong to a parent's
	// timeline rather than the top-level list.
	RootsOnly bool `query:"rootsOnly" default:"true"`
}

type watchExecutionInput struct {
	ID string `path:"id"`
	// AfterSeq resumes a dropped connection without replaying what the client already has.
	AfterSeq uint64 `query:"afterSeq"`
}

type listExecutionEventsInput struct {
	ID       string `path:"id"`
	AfterSeq uint64 `query:"afterSeq"`
	Limit    int    `query:"limit"`
}

type listExecutionEventsOutput struct {
	Body struct {
		Events  []executionEventDTO `json:"events"`
		NextSeq uint64              `json:"nextSeq"`
		HasMore bool                `json:"hasMore"`
	}
}

type listExecutionsOutput struct {
	Body []executionDTO
}

type executionIDInput struct {
	ID string `path:"id"`
}

type executionOutput struct {
	Body executionDTO
}

type createExecutionInput struct {
	WorkflowID string `path:"id"`
	Body       struct {
		Input map[string]any `json:"input,omitempty"`
	}
}

type updateExecutionInput struct {
	ID   string `path:"id"`
	Body struct {
		Status *models.ExecutionStatus `json:"status,omitempty"`
		Output map[string]any          `json:"output,omitempty"`
	}
}

func registerExecutionRoutes(api huma.API, deps *Deps, base string) {
	huma.Register(api, huma.Operation{
		OperationID: "list-executions",
		Method:      http.MethodGet,
		Path:        base + "/workflows/{id}/executions",
		Summary:     "List a workflow's executions",
		Tags:        []string{"Executions"},
		Security:    authSecurity(),
	}, func(ctx context.Context, in *listExecutionsInput) (*listExecutionsOutput, error) {
		query := deps.DB.WithContext(ctx).Where("workflow_id = ?", in.WorkflowID)
		if in.RootsOnly {
			query = query.Where("parent_execution_id IS NULL")
		}

		var executions []models.Execution
		if err := query.Order("started_at desc").Find(&executions).Error; err != nil {
			return nil, huma.Error500InternalServerError("failed to list executions", err)
		}
		name := workflowName(deps, ctx, in.WorkflowID)
		dtos := make([]executionDTO, len(executions))
		for i, e := range executions {
			dtos[i] = toExecutionDTO(e, name)
		}
		return &listExecutionsOutput{Body: dtos}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID:   "create-execution",
		Method:        http.MethodPost,
		Path:          base + "/workflows/{id}/executions",
		Summary:       "Start a workflow execution",
		Tags:          []string{"Executions"},
		Security:      authSecurity(),
		DefaultStatus: http.StatusCreated,
		Errors:        []int{404, 422, 502},
	}, func(ctx context.Context, in *createExecutionInput) (*executionOutput, error) {
		var wf models.Workflow
		if err := deps.DB.WithContext(ctx).First(&wf, "id = ?", in.WorkflowID).Error; err != nil {
			return nil, huma.Error404NotFound("workflow not found")
		}

		taskQueue, workflowType, err := parseDSLHeader(wf.DSL)
		if err != nil || taskQueue == "" || workflowType == "" {
			return nil, huma.Error422UnprocessableEntity(
				"workflow has no valid document.taskQueue/document.workflowType to run — save a DSL first",
			)
		}

		temporalClient, err := deps.Temporal.Get()
		if err != nil {
			return nil, huma.Error502BadGateway("temporal is unreachable", err)
		}

		// A caller that omits `input` leaves this as a nil Go map, which the Temporal SDK's data
		// converter serializes as JSON `null` — a workflow whose `input.schema` requires `type:
		// object` (the common case; every workflow's Start node can declare one) then fails
		// immediately with a schema validation error, before any task even runs. Default to an
		// empty object instead, since "no input provided" should mean "{}", never "null".
		workflowInput := in.Body.Input
		if workflowInput == nil {
			workflowInput = map[string]any{}
		}

		inputJSON, _ := json.Marshal(workflowInput)
		execution := models.Execution{
			Base:       models.Base{ID: uuid.NewString()},
			WorkflowID: in.WorkflowID,
			Status:     models.ExecutionRunning,
			StartedAt:  time.Now(),
			Input:      inputJSON,
		}

		run, err := temporalClient.ExecuteWorkflow(
			ctx,
			client.StartWorkflowOptions{ID: execution.ID, TaskQueue: taskQueue},
			workflowType,
			workflowInput,
		)
		if err != nil {
			return nil, huma.Error502BadGateway(
				"failed to start the Temporal execution — is a zigflow worker running for this workflow?",
				err,
			)
		}
		execution.TemporalRunID = run.GetRunID()

		execution.RootExecutionID = execution.ID
		if err := deps.DB.WithContext(ctx).Create(&execution).Error; err != nil {
			return nil, huma.Error500InternalServerError("failed to create execution", err)
		}

		go watchTerminal(deps, execution.ID)
		return &executionOutput{Body: toExecutionDTO(execution, wf.Name)}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "get-execution",
		Method:      http.MethodGet,
		Path:        base + "/executions/{id}",
		Summary:     "Get an execution",
		Tags:        []string{"Executions"},
		Security:    authSecurity(),
		Errors:      []int{404},
	}, func(ctx context.Context, in *executionIDInput) (*executionOutput, error) {
		var execution models.Execution
		if err := deps.DB.WithContext(ctx).First(&execution, "id = ?", in.ID).Error; err != nil {
			return nil, huma.Error404NotFound("execution not found")
		}
		execution = reconcileStatus(ctx, deps, execution)
		return &executionOutput{Body: toExecutionDTO(execution, workflowName(deps, ctx, execution.WorkflowID))}, nil
	})

	sse.Register(api, huma.Operation{
		OperationID: "watch-execution",
		Method:      http.MethodGet,
		Path:        base + "/executions/{id}/watch",
		Summary:     "Stream live per-task progress for a running execution",
		Tags:        []string{"Executions"},
		Security:    authSecurity(),
	}, map[string]any{
		"event":   executionEventDTO{},
		"status":  statusEvent{},
		"refetch": refetchEvent{},
		"done":    watchDone{},
	}, func(ctx context.Context, in *watchExecutionInput, send sse.Sender) {
		var execution models.Execution
		if err := deps.DB.WithContext(ctx).First(&execution, "id = ?", in.ID).Error; err != nil {
			_ = send.Data(watchDone{Done: true, Status: models.ExecutionFailed, Error: "execution not found"})
			return
		}

		// Subscribe before reading the backlog, or events landing between the two are lost. The
		// overlap that creates is handled by skipping anything at or below maxSeq afterwards.
		subscription := deps.Bus.Subscribe(in.ID)
		defer subscription.Close()

		maxSeq := in.AfterSeq
		backlog, err := loadExecutionEvents(ctx, deps, in.ID, maxSeq, maxEventPageSize)
		if err != nil {
			_ = send.Data(watchDone{Done: true, Status: execution.Status, Error: "failed to read the event log"})
			return
		}
		for _, ev := range backlog {
			if err := send.Data(toExecutionEventDTO(ev)); err != nil {
				return // client disconnected
			}
			maxSeq = ev.Seq
		}

		_ = send.Data(statusEvent{Status: execution.Status, Error: execution.Error})
		if execution.Status != models.ExecutionRunning {
			_ = send.Data(watchDone{Done: true, Status: execution.Status, Error: execution.Error})
			return
		}

		// Nothing else in this process learns that a workflow closed, so make sure something is
		// waiting on it — watchTerminal is a no-op for an execution already being watched out.
		go watchTerminal(deps, in.ID)

		heartbeat := time.NewTicker(watchHeartbeat)
		defer heartbeat.Stop()

		for {
			select {
			case <-ctx.Done():
				return

			case ev := <-subscription.C:
				if subscription.Lagged() {
					subscription.ResetLagged()
					_ = send.Data(refetchEvent{AfterSeq: maxSeq})
				}
				if ev.EventType == terminalMarkerEventType {
					var latest models.Execution
					if err := deps.DB.WithContext(ctx).First(&latest, "id = ?", in.ID).Error; err == nil {
						execution = latest
					}
					// Drain whatever the resolver published just before the close marker.
					for _, tail := range mustLoadEvents(ctx, deps, in.ID, maxSeq) {
						_ = send.Data(toExecutionEventDTO(tail))
						maxSeq = tail.Seq
					}
					_ = send.Data(watchDone{Done: true, Status: execution.Status, Error: execution.Error})
					return
				}
				if ev.Seq <= maxSeq {
					continue
				}
				if err := send.Data(toExecutionEventDTO(ev)); err != nil {
					return
				}
				maxSeq = ev.Seq

			case <-heartbeat.C:
				// Keeps proxies from closing an idle stream during a long-running task.
				if err := send.Data(statusEvent{Status: execution.Status}); err != nil {
					return
				}
			}
		}
	})

	huma.Register(api, huma.Operation{
		OperationID: "list-execution-events",
		Method:      http.MethodGet,
		Path:        base + "/executions/{id}/events",
		Summary:     "Read an execution's recorded task events",
		Tags:        []string{"Executions"},
		Security:    authSecurity(),
	}, func(ctx context.Context, in *listExecutionEventsInput) (*listExecutionEventsOutput, error) {
		limit := in.Limit
		if limit <= 0 || limit > maxEventPageSize {
			limit = maxEventPageSize
		}

		// One extra row tells us whether another page exists without a second count query.
		events, err := loadExecutionEvents(ctx, deps, in.ID, in.AfterSeq, limit+1)
		if err != nil {
			return nil, huma.Error500InternalServerError("failed to read the event log", err)
		}

		out := listExecutionEventsOutput{}
		out.Body.HasMore = len(events) > limit
		if out.Body.HasMore {
			events = events[:limit]
		}
		out.Body.Events = make([]executionEventDTO, len(events))
		for i, ev := range events {
			out.Body.Events[i] = toExecutionEventDTO(ev)
			out.Body.NextSeq = ev.Seq
		}
		return &out, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "list-child-executions",
		Method:      http.MethodGet,
		Path:        base + "/executions/{id}/children",
		Summary:     "List the child-workflow runs started by an execution",
		Tags:        []string{"Executions"},
		Security:    authSecurity(),
	}, func(ctx context.Context, in *executionIDInput) (*listExecutionsOutput, error) {
		var children []models.Execution
		if err := deps.DB.WithContext(ctx).Where("parent_execution_id = ?", in.ID).
			Order("started_at").Find(&children).Error; err != nil {
			return nil, huma.Error500InternalServerError("failed to list child executions", err)
		}

		dtos := make([]executionDTO, len(children))
		for i, child := range children {
			dtos[i] = toExecutionDTO(child, workflowName(deps, ctx, child.WorkflowID))
		}
		return &listExecutionsOutput{Body: dtos}, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "update-execution",
		Method:      http.MethodPatch,
		Path:        base + "/executions/{id}",
		Summary:     "Update an execution's status/output",
		Tags:        []string{"Executions"},
		Security:    authSecurity(),
		Errors:      []int{404},
	}, func(ctx context.Context, in *updateExecutionInput) (*executionOutput, error) {
		var execution models.Execution
		if err := deps.DB.WithContext(ctx).First(&execution, "id = ?", in.ID).Error; err != nil {
			return nil, huma.Error404NotFound("execution not found")
		}

		if in.Body.Status != nil {
			execution.Status = *in.Body.Status
			if execution.Status != models.ExecutionRunning && execution.CompletedAt == nil {
				now := time.Now()
				execution.CompletedAt = &now
			}
		}
		if in.Body.Output != nil {
			outputJSON, _ := json.Marshal(in.Body.Output)
			execution.Output = outputJSON
		}

		if err := deps.DB.WithContext(ctx).Save(&execution).Error; err != nil {
			return nil, huma.Error500InternalServerError("failed to update execution", err)
		}
		return &executionOutput{Body: toExecutionDTO(execution, workflowName(deps, ctx, execution.WorkflowID))}, nil
	})
}
