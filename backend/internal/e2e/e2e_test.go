// Package e2e runs the whole backend — API, resolver, completion watchers and the worker pool —
// against a real Temporal server. It is skipped unless DURAFLOW_E2E_TEMPORAL names one:
//
//	temporal server start-dev --headless --port 7299
//	DURAFLOW_E2E_TEMPORAL=localhost:7299 go test ./internal/e2e/ -v
//
// Each test uses its own task queue, so a long-lived dev server can be reused.
package e2e

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/rs/zerolog"

	"duraflow/backend/internal/api"
	"duraflow/backend/internal/auth"
	"duraflow/backend/internal/config"
	"duraflow/backend/internal/db"
	"duraflow/backend/internal/dslruntime"
	"duraflow/backend/internal/events"
	"duraflow/backend/internal/models"
	"duraflow/backend/internal/temporalexec"
)

const telemetryToken = "e2e-token"

type stack struct {
	t        *testing.T
	deps     *api.Deps
	server   *httptest.Server
	token    string
	address  string
	ctx      context.Context
	poolStop context.CancelFunc
	poolDone chan struct{}
	queue    string
}

func newStack(t *testing.T) *stack {
	t.Helper()
	address := os.Getenv("DURAFLOW_E2E_TEMPORAL")
	if address == "" {
		t.Skip("DURAFLOW_E2E_TEMPORAL is not set")
	}
	zerolog.SetGlobalLevel(zerolog.WarnLevel)

	conn, err := db.Open(config.DatabaseConfig{Driver: "sqlite",
		DSN: filepath.Join(t.TempDir(), "e2e.db") + "?_pragma=journal_mode(WAL)&_pragma=busy_timeout(5000)"})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, _ := conn.DB()

	cfg := &config.Config{
		Server:    config.ServerConfig{BasePath: "/api"},
		Auth:      config.AuthConfig{JWTSecret: "e2e-secret", TokenTTL: time.Hour},
		Telemetry: config.TelemetryConfig{Token: telemetryToken, MaxEventBytes: 65536},
		Worker:    config.WorkerConfig{HeartbeatInterval: time.Second},
	}
	temporal := temporalexec.NewLazyClientWithOptions(temporalexec.ClientOptions(address, "default", "e2e-api"))
	env, err := dslruntime.NewEnv()
	if err != nil {
		t.Fatal(err)
	}
	cache := dslruntime.NewCache(env, dslruntime.DBStore{DB: conn}, 0)
	bus := events.NewBroker()
	resolver := temporalexec.NewResolver(conn, temporal, bus, 0)
	deps := &api.Deps{Cfg: cfg, DB: conn, Temporal: temporal, Runtime: cache, Bus: bus, Resolver: resolver}
	resolver.OnExecutionDiscovered = func(e models.Execution) { deps.WatchExecution(e.ID) }

	server := httptest.NewServer(api.NewRouter(deps))
	path, err := dslruntime.WriteCloudEventsConfig(t.TempDir(), server.URL+"/api/internal/zigflow/events", telemetryToken, 2*time.Second)
	if err != nil {
		t.Fatal(err)
	}
	env.CloudEventsConfigPath = path

	ctx, cancel := context.WithCancel(context.Background())
	go resolver.Run(ctx)

	s := &stack{t: t, deps: deps, server: server, address: address, ctx: ctx,
		queue: "e2e-" + uuid.NewString()[:8]}
	s.startPool("pool-a", cache)

	t.Cleanup(func() {
		s.stopPool()
		cancel()
		server.Close()
		temporal.Close()
		_ = sqlDB.Close()
	})

	hash, _ := auth.HashPassword("password123")
	user := models.User{Email: "e2e@example.com", PasswordHash: hash, Name: "E2E", Role: models.RoleAdmin}
	if err := conn.Create(&user).Error; err != nil {
		t.Fatal(err)
	}
	s.token, _, _ = auth.IssueToken(cfg.Auth.JWTSecret, user.ID, time.Hour)
	return s
}

// startPool runs a worker pool the way a worker-role process does, with its own Temporal client
// (as a separate process would have).
func (s *stack) startPool(identity string, cache *dslruntime.Cache) {
	client := temporalexec.NewLazyClientWithOptions(temporalexec.ClientOptions(s.address, "default", identity))
	pool := dslruntime.NewPool(dslruntime.PoolOptions{
		Identity:          identity,
		Temporal:          client.Get,
		DB:                s.deps.DB,
		Dispatcher:        &dslruntime.Dispatcher{Cache: cache, Directory: dslruntime.NewDirectory(s.deps.DB)},
		RefreshInterval:   300 * time.Millisecond,
		HeartbeatInterval: time.Second,
		StopTimeout:       time.Second,
	})
	ctx, cancel := context.WithCancel(s.ctx)
	done := make(chan struct{})
	go func() {
		defer close(done)
		defer client.Close()
		pool.Run(ctx)
	}()
	s.poolStop, s.poolDone = cancel, done
}

func (s *stack) stopPool() {
	if s.poolStop != nil {
		s.poolStop()
		<-s.poolDone
		s.poolStop = nil
	}
}

func (s *stack) request(method, path string, body any, out any) int {
	s.t.Helper()
	return s.requestTo(s.server.URL, method, path, body, out)
}

func (s *stack) requestTo(base, method, path string, body any, out any) int {
	s.t.Helper()
	var reader io.Reader
	if body != nil {
		raw, _ := json.Marshal(body)
		reader = bytes.NewReader(raw)
	}
	req, _ := http.NewRequest(method, base+path, reader)
	req.Header.Set("Authorization", "Bearer "+s.token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		s.t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	if out != nil && resp.StatusCode < 300 {
		if err := json.Unmarshal(raw, out); err != nil {
			s.t.Fatalf("%s %s: decoding %s: %v", method, path, raw, err)
		}
	}
	if resp.StatusCode >= 300 {
		s.t.Logf("%s %s -> %d %s", method, path, resp.StatusCode, raw)
	}
	return resp.StatusCode
}

func (s *stack) project() string {
	var p models.Project
	if code := s.request(http.MethodPost, "/api/projects", map[string]string{"name": "e2e"}, &p); code != http.StatusCreated {
		s.t.Fatalf("create project: %d", code)
	}
	return p.ID
}

func (s *stack) createWorkflow(projectID, name, dsl string) models.Workflow {
	s.t.Helper()
	var wf models.Workflow
	if code := s.request(http.MethodPost, "/api/projects/"+projectID+"/workflows",
		map[string]string{"name": name, "dsl": dsl}, &wf); code != http.StatusCreated {
		s.t.Fatalf("create workflow: %d", code)
	}
	if wf.CurrentHash == "" {
		s.t.Fatalf("workflow %s did not build: %s", name, wf.DSLError)
	}
	return wf
}

func (s *stack) saveDSL(id, dsl string) models.Workflow {
	s.t.Helper()
	var wf models.Workflow
	if code := s.request(http.MethodPatch, "/api/workflows/"+id, map[string]string{"dsl": dsl}, &wf); code != http.StatusOK {
		s.t.Fatalf("save workflow: %d", code)
	}
	if wf.CurrentHash == "" {
		s.t.Fatalf("workflow did not build: %s", wf.DSLError)
	}
	return wf
}

type execution struct {
	ID                string         `json:"id"`
	Status            string         `json:"status"`
	Output            any            `json:"output"`
	Error             string         `json:"error"`
	Trigger           string         `json:"trigger"`
	ParentExecutionID *string        `json:"parentExecutionId"`
	Input             map[string]any `json:"input"`
}

func (s *stack) run(workflowID string, input map[string]any) execution {
	s.t.Helper()
	var ex execution
	if code := s.request(http.MethodPost, "/api/workflows/"+workflowID+"/executions",
		map[string]any{"input": input}, &ex); code != http.StatusCreated {
		s.t.Fatalf("start run: %d", code)
	}
	return ex
}

func (s *stack) waitClosed(id string, timeout time.Duration) execution {
	s.t.Helper()
	deadline := time.Now().Add(timeout)
	for {
		var ex execution
		s.request(http.MethodGet, "/api/executions/"+id, nil, &ex)
		if ex.Status != "" && ex.Status != string(models.ExecutionRunning) {
			return ex
		}
		if time.Now().After(deadline) {
			s.t.Fatalf("run %s still %q after %s", id, ex.Status, timeout)
		}
		time.Sleep(200 * time.Millisecond)
	}
}

func (s *stack) events(id string) []models.ExecutionEvent {
	var out struct {
		Events []models.ExecutionEvent `json:"events"`
	}
	s.request(http.MethodGet, "/api/executions/"+id+"/events", nil, &out)
	return out.Events
}

func outputJSON(ex execution) string {
	raw, _ := json.Marshal(ex.Output)
	return string(raw)
}

func dslHeader(workflowType, queue string) string {
	return fmt.Sprintf(`document:
  dsl: 1.0.0
  taskQueue: %s
  workflowType: %s
  version: 0.0.1
  metadata:
    activityOptions:
      startToCloseTimeout:
        seconds: 30
`, queue, workflowType)
}

// A run with sets, a fork (child workflows), and an HTTP call (a per-task activity) completes on
// the pool, and its task events reach the API.
func TestWorkflowRunsOnThePool(t *testing.T) {
	s := newStack(t)
	var hits atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		hits.Add(1)
		_, _ = w.Write([]byte(`{"pong":true}`))
	}))
	defer target.Close()

	dsl := dslHeader("orders", s.queue) + fmt.Sprintf(`do:
  - greet:
      set:
        message: ${ "hello " + $input.name }
  - parallel:
      fork:
        compete: false
        branches:
          - left:
              set:
                side: left
          - right:
              set:
                side: right
  - ping:
      call: http
      with:
        method: get
        endpoint: %s/ping
  - done:
      set:
        message: ${ $data.message }
        finished: true
`, target.URL)
	wf := s.createWorkflow(s.project(), "orders", dsl)

	ex := s.run(wf.ID, map[string]any{"name": "ada"})
	closed := s.waitClosed(ex.ID, 60*time.Second)
	if closed.Status != string(models.ExecutionCompleted) {
		t.Fatalf("run %s: %s", closed.Status, closed.Error)
	}
	if !strings.Contains(outputJSON(closed), "finished") {
		t.Errorf("output: %s", outputJSON(closed))
	}
	if hits.Load() == 0 {
		t.Error("the HTTP task never ran")
	}

	// Task events arrive asynchronously; wait for the fork branches' events to be resolved onto
	// this run with a scope path.
	deadline := time.Now().Add(20 * time.Second)
	for {
		evs := s.events(ex.ID)
		tasks := map[string]bool{}
		scoped := false
		for _, ev := range evs {
			tasks[ev.TaskName] = true
			if ev.ScopePath != "" {
				scoped = true
			}
		}
		if tasks["greet"] && tasks["ping"] && tasks["done"] && scoped {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("events never complete: %d events, tasks %v, scoped %v", len(evs), tasks, scoped)
		}
		time.Sleep(300 * time.Millisecond)
	}
}

// A run keeps the DSL it started on after a save; the next run uses the new one.
func TestRunsKeepTheirVersionAcrossSaves(t *testing.T) {
	s := newStack(t)
	versioned := func(label string) string {
		return dslHeader("pinned", s.queue) + fmt.Sprintf(`do:
  - pause:
      wait:
        seconds: 4
  - result:
      set:
        version: %s
`, label)
	}
	wf := s.createWorkflow(s.project(), "pinned", versioned("one"))

	first := s.run(wf.ID, nil)
	time.Sleep(1500 * time.Millisecond) // let the first run reach its wait
	updated := s.saveDSL(wf.ID, versioned("two"))
	if updated.CurrentHash == wf.CurrentHash {
		t.Fatal("the save did not create a new version")
	}
	second := s.run(wf.ID, nil)

	a := s.waitClosed(first.ID, 60*time.Second)
	b := s.waitClosed(second.ID, 60*time.Second)
	if a.Status != "completed" || b.Status != "completed" {
		t.Fatalf("statuses %s (%s) / %s (%s)", a.Status, a.Error, b.Status, b.Error)
	}
	if !strings.Contains(outputJSON(a), `"one"`) {
		t.Errorf("the in-flight run switched DSL: %s", outputJSON(a))
	}
	if !strings.Contains(outputJSON(b), `"two"`) {
		t.Errorf("the new run did not use the new DSL: %s", outputJSON(b))
	}
}

// A `run: workflow` task that starts another stored workflow runs that workflow's current
// version, and the child gets its own execution row linked to the parent.
func TestRunWorkflowStartsAnotherStoredWorkflow(t *testing.T) {
	s := newStack(t)
	project := s.project()
	s.createWorkflow(project, "child", dslHeader("child-wf", s.queue)+`do:
  - answer:
      set:
        answer: 42
`)
	parent := s.createWorkflow(project, "parent", dslHeader("parent-wf", s.queue)+`do:
  - callChild:
      run:
        workflow:
          type: child-wf
  - after:
      set:
        parentDone: true
`)

	ex := s.run(parent.ID, nil)
	closed := s.waitClosed(ex.ID, 60*time.Second)
	if closed.Status != "completed" {
		t.Fatalf("parent run %s: %s", closed.Status, closed.Error)
	}

	deadline := time.Now().Add(20 * time.Second)
	for {
		var children []execution
		s.request(http.MethodGet, "/api/executions/"+ex.ID+"/children", nil, &children)
		if len(children) == 1 {
			child := s.waitClosed(children[0].ID, 30*time.Second)
			if child.Status != "completed" || !strings.Contains(outputJSON(child), "42") {
				t.Errorf("child run: %s %s %s", child.Status, outputJSON(child), child.Error)
			}
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("child execution never recorded (%d children)", len(children))
		}
		time.Sleep(300 * time.Millisecond)
	}
}

// Losing the pool process mid-run doesn't lose the run: another pool process, with an empty
// cache, picks it up and finishes it on the same version.
func TestAnotherPoolProcessFinishesARun(t *testing.T) {
	s := newStack(t)
	wf := s.createWorkflow(s.project(), "failover", dslHeader("failover", s.queue)+`do:
  - pause:
      wait:
        seconds: 3
  - result:
      set:
        survived: true
`)
	ex := s.run(wf.ID, nil)
	time.Sleep(time.Second)
	s.stopPool()

	env, _ := dslruntime.NewEnv()
	env.CloudEventsConfigPath = s.deps.Runtime.Env().CloudEventsConfigPath
	s.startPool("pool-b", dslruntime.NewCache(env, dslruntime.DBStore{DB: s.deps.DB}, 0))

	closed := s.waitClosed(ex.ID, 90*time.Second)
	if closed.Status != "completed" || !strings.Contains(outputJSON(closed), "survived") {
		t.Fatalf("run after failover: %s %s %s", closed.Status, outputJSON(closed), closed.Error)
	}

	var workers []models.Worker
	s.request(http.MethodGet, "/api/workers", nil, &workers)
	seen := map[string]models.WorkerStatus{}
	for _, w := range workers {
		if w.TaskQueue == s.queue {
			seen[w.Identity] = w.Status
		}
	}
	if seen["pool-a"] != models.WorkerOffline || seen["pool-b"] != models.WorkerOnline {
		t.Errorf("workers page: %v", seen)
	}
}

// A schedule saved in the DSL starts runs on the pool, each recorded as a scheduled execution;
// deleting the workflow retracts the schedule.
func TestScheduledRunsAreRecorded(t *testing.T) {
	s := newStack(t)
	wfType := "sched-" + s.queue
	dsl := fmt.Sprintf(`document:
  dsl: 1.0.0
  taskQueue: %s
  workflowType: %s
  version: 0.0.1
  metadata:
    scheduleWorkflowName: %s
schedule:
  every:
    seconds: 2
do:
  - tick:
      set:
        ticked: true
`, s.queue, wfType, wfType)
	wf := s.createWorkflow(s.project(), "scheduled", dsl)

	deadline := time.Now().Add(45 * time.Second)
	var found *execution
	for found == nil {
		var page struct {
			Items []execution `json:"items"`
		}
		s.request(http.MethodGet, "/api/executions?workflowId="+wf.ID+"&trigger=scheduled", nil, &page)
		for i := range page.Items {
			if page.Items[i].Trigger == "scheduled" {
				found = &page.Items[i]
				break
			}
		}
		if found == nil {
			if time.Now().After(deadline) {
				t.Fatal("no scheduled run was recorded")
			}
			time.Sleep(500 * time.Millisecond)
		}
	}
	closed := s.waitClosed(found.ID, 30*time.Second)
	if closed.Status != "completed" {
		t.Errorf("scheduled run: %s %s", closed.Status, closed.Error)
	}

	if code := s.request(http.MethodDelete, "/api/workflows/"+wf.ID, nil, nil); code != http.StatusNoContent {
		t.Fatalf("delete: %d", code)
	}
	client, err := s.deps.Temporal.Get()
	if err != nil {
		t.Fatal(err)
	}
	if _, err := client.ScheduleClient().GetHandle(context.Background(), "zigflow_"+wfType).Describe(context.Background()); err == nil {
		t.Error("the schedule survived deleting its workflow")
	}
}

// Runs of many workflows on one queue all execute on one pool, concurrently.
func TestManyWorkflowsShareOnePool(t *testing.T) {
	s := newStack(t)
	project := s.project()
	const n = 8
	var wg sync.WaitGroup
	ids := make([]string, n)
	for i := range n {
		wf := s.createWorkflow(project, fmt.Sprintf("wf-%d", i), dslHeader(fmt.Sprintf("many-%d", i), s.queue)+fmt.Sprintf(`do:
  - only:
      set:
        index: %d
`, i))
		ids[i] = wf.ID
	}
	results := make([]execution, n)
	for i, id := range ids {
		wg.Go(func() {
			ex := s.run(id, nil)
			results[i] = s.waitClosed(ex.ID, 60*time.Second)
		})
	}
	wg.Wait()
	for i, r := range results {
		if r.Status != "completed" || !strings.Contains(outputJSON(r), fmt.Sprintf(`"index":%d`, i)) {
			t.Errorf("workflow %d: %s %s %s", i, r.Status, outputJSON(r), r.Error)
		}
	}
}
