// Package temporaltest is an in-memory stand-in for the Temporal client, for tests only. It covers
// exactly the calls duraflow makes; anything else panics through the embedded nil interface, so a
// new call site shows up as a test failure rather than a silent no-op.
package temporaltest

import (
	"context"
	"encoding/json"
	"errors"
	"sync"

	enumspb "go.temporal.io/api/enums/v1"
	historypb "go.temporal.io/api/history/v1"
	"go.temporal.io/api/serviceerror"
	workflowpb "go.temporal.io/api/workflow/v1"
	"go.temporal.io/api/workflowservice/v1"
	"go.temporal.io/sdk/client"
	"google.golang.org/grpc"
)

// Started records one ExecuteWorkflow call.
type Started struct {
	ID           string
	TaskQueue    string
	WorkflowType string
	Input        any
}

// Result is what GetWorkflow(...).Get returns for a workflow.
type Result struct {
	Value any
	Err   error
}

// Client is a fake client.Client. Configure the exported maps before use; read the recorded slices
// afterwards (through the accessor methods, since some calls come from background goroutines).
type Client struct {
	client.Client

	mu sync.Mutex

	// Workflows is what DescribeWorkflowExecution returns, keyed by workflow id. A missing id
	// answers with serviceerror.NotFound.
	Workflows map[string]*workflowpb.WorkflowExecutionInfo
	// DescribeErr, when set, fails every DescribeWorkflowExecution.
	DescribeErr error
	// Histories is what GetWorkflowHistory iterates, keyed by workflow id.
	Histories map[string][]*historypb.HistoryEvent
	// Results is what a workflow's run returns, keyed by workflow id. A missing id returns
	// DefaultResult.
	Results       map[string]Result
	DefaultResult Result
	// Gate, when non-nil, makes every WorkflowRun.Get wait until it's closed (or ctx ends) —
	// a workflow that's still running.
	Gate chan struct{}
	// ExecuteErr, when set, fails ExecuteWorkflow.
	ExecuteErr error
	// TerminateErr, DeleteHistoryErr and DeleteScheduleErr fail the matching call.
	TerminateErr      error
	DeleteHistoryErr  error
	DeleteScheduleErr error

	started          []Started
	terminated       []string
	deletedHistories []string
	deletedSchedules []string
}

func New() *Client {
	return &Client{
		Workflows: map[string]*workflowpb.WorkflowExecutionInfo{},
		Histories: map[string][]*historypb.HistoryEvent{},
		Results:   map[string]Result{},
	}
}

func (c *Client) Started() []Started {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]Started(nil), c.started...)
}

func (c *Client) Terminated() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]string(nil), c.terminated...)
}

func (c *Client) DeletedHistories() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]string(nil), c.deletedHistories...)
}

func (c *Client) DeletedSchedules() []string {
	c.mu.Lock()
	defer c.mu.Unlock()
	return append([]string(nil), c.deletedSchedules...)
}

// SetWorkflow registers (or replaces) what DescribeWorkflowExecution reports for an id.
func (c *Client) SetWorkflow(id string, info *workflowpb.WorkflowExecutionInfo) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.Workflows[id] = info
}

func (c *Client) DescribeWorkflowExecution(
	_ context.Context, workflowID, _ string,
) (*workflowservice.DescribeWorkflowExecutionResponse, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.DescribeErr != nil {
		return nil, c.DescribeErr
	}
	info, ok := c.Workflows[workflowID]
	if !ok {
		return nil, serviceerror.NewNotFound("workflow not found: " + workflowID)
	}
	return &workflowservice.DescribeWorkflowExecutionResponse{WorkflowExecutionInfo: info}, nil
}

func (c *Client) GetWorkflowHistory(
	_ context.Context, workflowID, _ string, _ bool, _ enumspb.HistoryEventFilterType,
) client.HistoryEventIterator {
	c.mu.Lock()
	defer c.mu.Unlock()
	return &historyIterator{events: c.Histories[workflowID]}
}

func (c *Client) ExecuteWorkflow(
	_ context.Context, options client.StartWorkflowOptions, workflow any, args ...any,
) (client.WorkflowRun, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.ExecuteErr != nil {
		return nil, c.ExecuteErr
	}
	workflowType, _ := workflow.(string)
	var input any
	if len(args) > 0 {
		input = args[0]
	}
	c.started = append(c.started, Started{
		ID: options.ID, TaskQueue: options.TaskQueue, WorkflowType: workflowType, Input: input,
	})
	return &workflowRun{c: c, id: options.ID, runID: "run-" + options.ID}, nil
}

func (c *Client) GetWorkflow(_ context.Context, workflowID, runID string) client.WorkflowRun {
	return &workflowRun{c: c, id: workflowID, runID: runID}
}

func (c *Client) TerminateWorkflow(_ context.Context, workflowID, _, _ string, _ ...any) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.TerminateErr != nil {
		return c.TerminateErr
	}
	c.terminated = append(c.terminated, workflowID)
	return nil
}

func (c *Client) WorkflowService() workflowservice.WorkflowServiceClient {
	return &workflowService{c: c}
}

func (c *Client) ScheduleClient() client.ScheduleClient {
	return &scheduleClient{c: c}
}

func (c *Client) Close() {}

type workflowRun struct {
	client.WorkflowRun
	c         *Client
	id, runID string
}

func (r *workflowRun) GetID() string    { return r.id }
func (r *workflowRun) GetRunID() string { return r.runID }

func (r *workflowRun) Get(ctx context.Context, valuePtr any) error {
	r.c.mu.Lock()
	gate := r.c.Gate
	r.c.mu.Unlock()
	if gate != nil {
		select {
		case <-gate:
		case <-ctx.Done():
			return ctx.Err()
		}
	}

	r.c.mu.Lock()
	result, ok := r.c.Results[r.id]
	if !ok {
		result = r.c.DefaultResult
	}
	r.c.mu.Unlock()

	if result.Err != nil {
		return result.Err
	}
	if result.Value == nil || valuePtr == nil {
		return nil
	}
	// Round-trip through JSON, as Temporal's data converter does.
	raw, err := json.Marshal(result.Value)
	if err != nil {
		return err
	}
	return json.Unmarshal(raw, valuePtr)
}

type historyIterator struct {
	events []*historypb.HistoryEvent
	next   int
}

func (it *historyIterator) HasNext() bool { return it.next < len(it.events) }

func (it *historyIterator) Next() (*historypb.HistoryEvent, error) {
	if !it.HasNext() {
		return nil, errors.New("no more events")
	}
	ev := it.events[it.next]
	it.next++
	return ev, nil
}

type workflowService struct {
	workflowservice.WorkflowServiceClient
	c *Client
}

func (s *workflowService) DeleteWorkflowExecution(
	_ context.Context, in *workflowservice.DeleteWorkflowExecutionRequest, _ ...grpc.CallOption,
) (*workflowservice.DeleteWorkflowExecutionResponse, error) {
	s.c.mu.Lock()
	defer s.c.mu.Unlock()
	if s.c.DeleteHistoryErr != nil {
		return nil, s.c.DeleteHistoryErr
	}
	s.c.deletedHistories = append(s.c.deletedHistories, in.GetWorkflowExecution().GetWorkflowId())
	return &workflowservice.DeleteWorkflowExecutionResponse{}, nil
}

type scheduleClient struct {
	client.ScheduleClient
	c *Client
}

func (s *scheduleClient) GetHandle(_ context.Context, scheduleID string) client.ScheduleHandle {
	return &scheduleHandle{c: s.c, id: scheduleID}
}

type scheduleHandle struct {
	client.ScheduleHandle
	c  *Client
	id string
}

func (h *scheduleHandle) GetID() string { return h.id }

func (h *scheduleHandle) Delete(context.Context) error {
	h.c.mu.Lock()
	defer h.c.mu.Unlock()
	if h.c.DeleteScheduleErr != nil {
		return h.c.DeleteScheduleErr
	}
	h.c.deletedSchedules = append(h.c.deletedSchedules, h.id)
	return nil
}
