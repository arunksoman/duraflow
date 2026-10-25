package e2e

import (
	"bufio"
	"context"
	"database/sql"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/google/uuid"
	_ "github.com/jackc/pgx/v5/stdlib"

	"duraflow/backend/internal/app"
	"duraflow/backend/internal/config"
	"duraflow/backend/internal/models"
)

// copyHandle is one running backend process.
type copyHandle struct {
	name   string
	app    *app.App
	url    string
	cancel context.CancelFunc
	done   chan struct{}
}

func (c *copyHandle) stop() {
	c.cancel()
	<-c.done
}

// multiCopy runs several backend copies against one Postgres schema and one Temporal server, the
// way a scaled-out deployment does. Skipped unless both DURAFLOW_E2E_TEMPORAL and
// DURAFLOW_TEST_POSTGRES are set.
type multiCopy struct {
	t        *testing.T
	temporal string
	dsn      string
	queue    string
	apiURL   string // where worker copies send CloudEvents
	copies   []*copyHandle
}

func newMultiCopy(t *testing.T) *multiCopy {
	t.Helper()
	temporal, base := os.Getenv("DURAFLOW_E2E_TEMPORAL"), os.Getenv("DURAFLOW_TEST_POSTGRES")
	if temporal == "" || base == "" {
		t.Skip("DURAFLOW_E2E_TEMPORAL and DURAFLOW_TEST_POSTGRES must both be set")
	}

	// A schema of its own, so the test starts from an empty database.
	schema := "e2e_" + strings.ReplaceAll(uuid.NewString()[:8], "-", "")
	admin, err := sql.Open("pgx", base)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := admin.Exec("CREATE SCHEMA " + schema); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		_, _ = admin.Exec("DROP SCHEMA " + schema + " CASCADE")
		_ = admin.Close()
	})
	sep := "?"
	if strings.Contains(base, "?") {
		sep = "&"
	}
	m := &multiCopy{t: t, temporal: temporal, dsn: base + sep + "search_path=" + schema, queue: "mc-" + strings.TrimPrefix(schema, "e2e_")}
	t.Cleanup(func() {
		for _, c := range m.copies {
			c.cancel()
		}
		for _, c := range m.copies {
			<-c.done
		}
	})
	return m
}

func (m *multiCopy) start(name string, roles ...string) *copyHandle {
	m.t.Helper()
	cfg := &config.Config{
		RoleSet:   roles,
		Roles:     strings.Join(roles, ","),
		Server:    config.ServerConfig{Host: "127.0.0.1", Port: 0, BasePath: "/api"},
		Database:  config.DatabaseConfig{Driver: "postgres", DSN: m.dsn},
		Auth:      config.AuthConfig{JWTSecret: "shared-secret", TokenTTL: time.Hour},
		SeedAdmin: config.SeedAdminConfig{Email: "admin@duraflow.local", Password: "changeme123", Name: "Admin"},
		Temporal:  config.TemporalConfig{Address: m.temporal, Namespace: "default"},
		Telemetry: config.TelemetryConfig{Token: "shared-token", Timeout: 2 * time.Second, MaxEventBytes: 65536},
		Worker: config.WorkerConfig{
			Identity: name, RefreshInterval: 500 * time.Millisecond, HeartbeatInterval: time.Second,
			StopTimeout: time.Second, EnvPrefix: "ZIGGY", ContainerRuntime: "docker", LogLevel: "warn",
		},
	}
	if cfg.HasRole(config.RoleWorker) {
		cfg.Telemetry.SinkURL = m.apiURL + "/api/internal/zigflow/events"
	}
	a, err := app.New(context.Background(), cfg)
	if err != nil {
		m.t.Fatalf("starting %s: %v", name, err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	c := &copyHandle{name: name, app: a, url: "http://" + a.Addr(), cancel: cancel, done: make(chan struct{})}
	go func() {
		defer close(c.done)
		if err := a.Run(ctx); err != nil {
			m.t.Errorf("%s: %v", name, err)
		}
	}()
	m.copies = append(m.copies, c)
	return c
}

func (m *multiCopy) login(c *copyHandle) string {
	m.t.Helper()
	var out struct {
		Token string `json:"token"`
	}
	if code := call(m.t, c.url, "", http.MethodPost, "/api/auth/login",
		map[string]string{"email": "admin@duraflow.local", "password": "changeme123"}, &out); code != http.StatusOK {
		m.t.Fatalf("login on %s: %d", c.name, code)
	}
	return out.Token
}

func call(t *testing.T, base, token, method, path string, body, out any) int {
	t.Helper()
	s := &stack{t: t, server: nil, token: token}
	return s.requestTo(base, method, path, body, out)
}

// watch opens an execution's SSE stream and returns its messages as "event:data" strings.
func watch(t *testing.T, base, token, id string) <-chan string {
	t.Helper()
	req, _ := http.NewRequest(http.MethodGet, base+"/api/executions/"+id+"/watch", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Accept", "text/event-stream")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	out := make(chan string, 256)
	go func() {
		defer close(out)
		defer resp.Body.Close()
		scanner := bufio.NewScanner(resp.Body)
		scanner.Buffer(make([]byte, 1<<20), 1<<20)
		event := ""
		for scanner.Scan() {
			line := scanner.Text()
			switch {
			case strings.HasPrefix(line, "event:"):
				event = strings.TrimSpace(strings.TrimPrefix(line, "event:"))
			case strings.HasPrefix(line, "data:"):
				out <- event + ":" + strings.TrimSpace(strings.TrimPrefix(line, "data:"))
			}
		}
	}()
	return out
}

func TestScaledOutDeployment(t *testing.T) {
	m := newMultiCopy(t)
	apiA := m.start("api-a", config.RoleAPI)
	m.apiURL = apiA.url
	apiB := m.start("api-b", config.RoleAPI)
	m.start("worker-1", config.RoleWorker)
	m.start("worker-2", config.RoleWorker)

	// A token issued by one copy works on another: they share the JWT secret.
	token := m.login(apiA)
	var p models.Project
	if code := call(t, apiB.url, token, http.MethodPost, "/api/projects", map[string]string{"name": "scaled"}, &p); code != http.StatusCreated {
		t.Fatalf("create project on copy B with copy A's token: %d", code)
	}

	dsl := dslHeader("scaled", m.queue) + `do:
  - first:
      set:
        step: 1
  - pause:
      wait:
        seconds: 3
  - last:
      set:
        step: 2
        done: true
`
	var wf models.Workflow
	if code := call(t, apiA.url, token, http.MethodPost, "/api/projects/"+p.ID+"/workflows",
		map[string]string{"name": "scaled", "dsl": dsl}, &wf); code != http.StatusCreated || wf.CurrentHash == "" {
		t.Fatalf("create workflow: %d %s", code, wf.DSLError)
	}

	// Started on copy B, watched live on copy A.
	var ex execution
	if code := call(t, apiB.url, token, http.MethodPost, "/api/workflows/"+wf.ID+"/executions",
		map[string]any{}, &ex); code != http.StatusCreated {
		t.Fatalf("start run on copy B: %d", code)
	}
	stream := watch(t, apiA.url, token, ex.ID)
	sawTask, sawDone := false, false
	timeout := time.After(60 * time.Second)
	for !sawDone {
		select {
		case msg, ok := <-stream:
			if !ok {
				t.Fatal("stream closed before the run finished")
			}
			if strings.HasPrefix(msg, "event:") && strings.Contains(msg, `"taskName":"last"`) {
				sawTask = true
			}
			if strings.HasPrefix(msg, "done:") {
				sawDone = true
				if !strings.Contains(msg, `"status":"completed"`) {
					t.Errorf("done message: %s", msg)
				}
			}
		case <-timeout:
			t.Fatal("the run never finished on the stream")
		}
	}
	if !sawTask {
		t.Error("copy A's stream never carried the task events that copy B's run produced")
	}

	// Exactly one api copy leads the once-only jobs.
	leaders := 0
	var leader, follower *copyHandle
	for _, c := range []*copyHandle{apiA, apiB} {
		if c.app.Leading() {
			leaders++
			leader = c
		} else {
			follower = c
		}
	}
	if leaders != 1 {
		t.Fatalf("%d api copies lead the jobs", leaders)
	}

	// The leader goes away mid-run: the other copy takes over and records the run's completion.
	if code := call(t, follower.url, token, http.MethodPost, "/api/workflows/"+wf.ID+"/executions",
		map[string]any{}, &ex); code != http.StatusCreated {
		t.Fatalf("start second run: %d", code)
	}
	leader.stop()
	deadline := time.Now().Add(30 * time.Second)
	for !follower.app.Leading() {
		if time.Now().After(deadline) {
			t.Fatal("the remaining api copy did not take over the jobs")
		}
		time.Sleep(200 * time.Millisecond)
	}
	// Read the row directly: GET /executions/{id} reconciles with Temporal by itself, and this
	// must prove the new leader's completion watcher recorded the result.
	deadline = time.Now().Add(60 * time.Second)
	for {
		var got models.Execution
		follower.app.Deps.DB.First(&got, "id = ?", ex.ID)
		if got.Status == models.ExecutionCompleted {
			break
		}
		if time.Now().After(deadline) {
			t.Fatalf("run never recorded as completed after the leader left: %q %s", got.Status, got.Error)
		}
		time.Sleep(300 * time.Millisecond)
	}

	// Saves from several copies at once are serialised: no lost version bump.
	var wg sync.WaitGroup
	for i := range 4 {
		wg.Go(func() {
			next := strings.Replace(dsl, "step: 2", fmt.Sprintf("step: %d", 10+i), 1)
			call(t, follower.url, token, http.MethodPatch, "/api/workflows/"+wf.ID, map[string]string{"dsl": next}, nil)
		})
	}
	wg.Wait()
	var saved models.Workflow
	call(t, follower.url, token, http.MethodGet, "/api/workflows/"+wf.ID, nil, &saved)
	if saved.Version != 5 {
		t.Errorf("four concurrent saves: version %d, want 5", saved.Version)
	}

	// Both worker copies poll the queue and show on the Workers page.
	var workers []models.Worker
	call(t, follower.url, token, http.MethodGet, "/api/workers", nil, &workers)
	online := map[string]bool{}
	for _, w := range workers {
		if w.TaskQueue == m.queue && w.Status == models.WorkerOnline {
			online[w.Identity] = true
		}
	}
	if !online["worker-1"] || !online["worker-2"] {
		raw, _ := json.Marshal(workers)
		t.Errorf("workers page: %s", raw)
	}
}
