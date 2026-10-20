package api

import (
	"bufio"
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"duraflow/backend/internal/auth"
	"duraflow/backend/internal/config"
	"duraflow/backend/internal/db"
	"duraflow/backend/internal/events"
	"duraflow/backend/internal/models"
	"duraflow/backend/internal/temporalexec"
	"duraflow/backend/internal/temporalexec/temporaltest"
)

// testEnv is the whole API served over real HTTP — router, auth middleware and all — against a
// temp SQLite database, a fake Temporal and a worker manager with no zigflow binary to spawn.
type testEnv struct {
	t        *testing.T
	deps     *Deps
	temporal *temporaltest.Client
	server   *httptest.Server
	user     models.User
	token    string
}

const testTelemetryToken = "telemetry-token"

func newTestEnv(t *testing.T) *testEnv {
	return newTestEnvWith(t, nil)
}

// newTestEnvWith builds a testEnv; a nil lazy client means "use the fake Temporal".
func newTestEnvWith(t *testing.T, lazy *temporalexec.LazyClient) *testEnv {
	t.Helper()
	conn, err := db.Open(config.DatabaseConfig{Driver: "sqlite", DSN: filepath.Join(t.TempDir(), "api.db")})
	if err != nil {
		t.Fatal(err)
	}
	sqlDB, err := conn.DB()
	if err != nil {
		t.Fatal(err)
	}

	fake := temporaltest.New()
	if lazy == nil {
		lazy = temporalexec.NewStaticClient(fake)
	}
	cfg := &config.Config{
		Server: config.ServerConfig{BasePath: "/api/", AllowedOrigins: []string{"http://app.test"}},
		Auth:   config.AuthConfig{JWTSecret: "test-secret", TokenTTL: time.Hour},
		Telemetry: config.TelemetryConfig{
			Token: testTelemetryToken, MaxEventBytes: 4096,
		},
	}
	bus := events.NewBroker()
	deps := &Deps{
		Cfg:      cfg,
		DB:       conn,
		Temporal: lazy,
		Workers: temporalexec.NewWorkerManager(
			config.TemporalConfig{ZigflowBinary: "zigflow-not-installed", WorkflowsDir: t.TempDir()},
			config.TelemetryConfig{},
		),
		Bus:      bus,
		Resolver: temporalexec.NewResolver(conn, lazy, bus, 0),
	}

	server := httptest.NewServer(NewRouter(deps))
	env := &testEnv{t: t, deps: deps, temporal: fake, server: server}
	t.Cleanup(func() {
		server.Close()
		// Release anything still parked on a gated workflow result before the DB goes away.
		if fake.Gate != nil {
			select {
			case <-fake.Gate:
			default:
				close(fake.Gate)
			}
		}
		_ = sqlDB.Close()
	})

	hash, err := auth.HashPassword("password123")
	if err != nil {
		t.Fatal(err)
	}
	env.user = models.User{Email: "ada@example.com", PasswordHash: hash, Name: "Ada", Role: models.RoleAdmin}
	env.mustCreate(&env.user)
	env.token, _, err = auth.IssueToken(cfg.Auth.JWTSecret, env.user.ID, time.Hour)
	if err != nil {
		t.Fatal(err)
	}
	return env
}

func (e *testEnv) mustCreate(v any) {
	e.t.Helper()
	if err := e.deps.DB.Create(v).Error; err != nil {
		e.t.Fatal(err)
	}
}

type response struct {
	Status int
	Header http.Header
	Body   []byte
}

func (r response) decode(t *testing.T, out any) {
	t.Helper()
	if err := json.Unmarshal(r.Body, out); err != nil {
		t.Fatalf("decoding %s: %v", r.Body, err)
	}
}

// request sends an authenticated JSON request. headers may override or blank out Authorization.
func (e *testEnv) request(method, path string, body any, headers ...string) response {
	e.t.Helper()
	var reader io.Reader
	switch b := body.(type) {
	case nil:
	case []byte:
		reader = bytes.NewReader(b)
	case string:
		reader = strings.NewReader(b)
	default:
		raw, err := json.Marshal(b)
		if err != nil {
			e.t.Fatal(err)
		}
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequest(method, e.server.URL+path, reader)
	if err != nil {
		e.t.Fatal(err)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	req.Header.Set("Authorization", "Bearer "+e.token)
	for i := 0; i+1 < len(headers); i += 2 {
		if headers[i+1] == "" {
			req.Header.Del(headers[i])
		} else {
			req.Header.Set(headers[i], headers[i+1])
		}
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	defer resp.Body.Close()
	raw, _ := io.ReadAll(resp.Body)
	return response{Status: resp.StatusCode, Header: resp.Header, Body: raw}
}

// expect sends a request, fails the test unless it answers wantStatus, and decodes into out.
func (e *testEnv) expect(method, path string, body any, wantStatus int, out any) response {
	e.t.Helper()
	resp := e.request(method, path, body)
	if resp.Status != wantStatus {
		e.t.Fatalf("%s %s: status %d, want %d: %s", method, path, resp.Status, wantStatus, resp.Body)
	}
	if out != nil {
		resp.decode(e.t, out)
	}
	return resp
}

// seedProject and seedWorkflowRow write rows directly, skipping the handlers.
func (e *testEnv) seedProject(name string) models.Project {
	e.t.Helper()
	p := models.Project{Name: name}
	e.mustCreate(&p)
	return p
}

func (e *testEnv) seedWorkflowRow(projectID, name, dsl string) models.Workflow {
	e.t.Helper()
	wf := models.Workflow{ProjectID: projectID, Name: name, Version: 1, DSL: dsl}
	applyDSLHeader(&wf)
	e.mustCreate(&wf)
	return wf
}

type execOpt func(*models.Execution)

func withStatus(s models.ExecutionStatus) execOpt { return func(e *models.Execution) { e.Status = s } }
func withTrigger(tr models.ExecutionTrigger) execOpt {
	return func(e *models.Execution) { e.Trigger = tr }
}
func withStartedAt(t time.Time) execOpt { return func(e *models.Execution) { e.StartedAt = t } }
func withParent(parent models.Execution) execOpt {
	return func(e *models.Execution) {
		e.ParentExecutionID = &parent.ID
		e.RootExecutionID = parent.RootExecutionID
	}
}

// seedExecution stores a run with a fresh id. Ids are unique per test on purpose: watchTerminal
// de-duplicates by id through a package-level map shared by every test.
func (e *testEnv) seedExecution(workflowID string, opts ...execOpt) models.Execution {
	e.t.Helper()
	id := uuid.NewString()
	ex := models.Execution{
		Base: models.Base{ID: id}, WorkflowID: workflowID, Status: models.ExecutionCompleted,
		Trigger: models.TriggerManual, StartedAt: time.Now(), RootExecutionID: id, TemporalRunID: "run-" + id,
	}
	for _, opt := range opts {
		opt(&ex)
	}
	e.mustCreate(&ex)
	return ex
}

func (e *testEnv) seedEvent(ev models.ExecutionEvent) models.ExecutionEvent {
	e.t.Helper()
	if ev.EventType == "" {
		ev.EventType = models.EventTaskCompleted
	}
	if ev.DedupeKey == "" {
		ev.DedupeKey = uuid.NewString()
	}
	if ev.ReceivedAt.IsZero() {
		ev.ReceivedAt = time.Now()
	}
	e.mustCreate(&ev)
	return ev
}

func (e *testEnv) execution(id string) (models.Execution, bool) {
	var ex models.Execution
	err := e.deps.DB.First(&ex, "id = ?", id).Error
	return ex, err == nil
}

// eventually polls cond until it holds, for effects of background goroutines.
func eventually(t *testing.T, what string, cond func() bool) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for !cond() {
		if time.Now().After(deadline) {
			t.Fatalf("timed out waiting for %s", what)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func testDSL(workflowType, taskQueue string, extra string) string {
	return "document:\n  dsl: 1.0.0\n  namespace: default\n  name: " + workflowType +
		"\n  version: 0.0.1\n  taskQueue: " + taskQueue + "\n  workflowType: " + workflowType + "\n" + extra +
		"do:\n  - noop:\n      set:\n        a: 1\n"
}

type sseMessage struct {
	Event string
	Data  json.RawMessage
}

// openStream starts an SSE request and returns a channel of its messages, closed at end of stream.
func (e *testEnv) openStream(path string) <-chan sseMessage {
	e.t.Helper()
	req, _ := http.NewRequest(http.MethodGet, e.server.URL+path, nil)
	req.Header.Set("Authorization", "Bearer "+e.token)
	req.Header.Set("Accept", "text/event-stream")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		e.t.Fatal(err)
	}
	if resp.StatusCode != http.StatusOK {
		e.t.Fatalf("stream %s: status %d", path, resp.StatusCode)
	}
	out := make(chan sseMessage, 64)
	go func() {
		defer close(out)
		defer resp.Body.Close()
		scanner := bufio.NewScanner(resp.Body)
		scanner.Buffer(make([]byte, 1<<20), 1<<20)
		var msg sseMessage
		for scanner.Scan() {
			line := scanner.Text()
			switch {
			case strings.HasPrefix(line, "event:"):
				msg.Event = strings.TrimSpace(strings.TrimPrefix(line, "event:"))
			case strings.HasPrefix(line, "data:"):
				msg.Data = json.RawMessage(strings.TrimSpace(strings.TrimPrefix(line, "data:")))
			case line == "" && msg.Data != nil:
				out <- msg
				msg = sseMessage{}
			}
		}
	}()
	return out
}

// collect reads stream messages until it closes.
func collect(t *testing.T, stream <-chan sseMessage) []sseMessage {
	t.Helper()
	var all []sseMessage
	timeout := time.After(10 * time.Second)
	for {
		select {
		case msg, ok := <-stream:
			if !ok {
				return all
			}
			all = append(all, msg)
		case <-timeout:
			t.Fatalf("stream did not end; got %+v", all)
		}
	}
}

func next(t *testing.T, stream <-chan sseMessage) sseMessage {
	t.Helper()
	select {
	case msg, ok := <-stream:
		if !ok {
			t.Fatal("stream ended early")
		}
		return msg
	case <-time.After(10 * time.Second):
		t.Fatal("no stream message")
	}
	return sseMessage{}
}
