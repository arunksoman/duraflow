package temporalexec

import (
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"gopkg.in/yaml.v3"

	"duraflow/backend/internal/config"
)

// The test binary doubles as a fake `zigflow` CLI: WorkerManager is pointed at os.Args[0] with
// fakeZigflowEnv set, and TestMain then behaves like `zigflow run` instead of running tests —
// it records its arguments, answers the health check, and waits to be killed.
const (
	fakeZigflowEnv     = "DURAFLOW_FAKE_ZIGFLOW_ARGS"
	fakeZigflowNoReady = "DURAFLOW_FAKE_ZIGFLOW_NOREADY"
)

func TestMain(m *testing.M) {
	if argsFile := os.Getenv(fakeZigflowEnv); argsFile != "" {
		runFakeZigflow(argsFile)
		return
	}
	os.Exit(m.Run())
}

func runFakeZigflow(argsFile string) {
	args := os.Args[1:]
	f, err := os.OpenFile(argsFile, os.O_APPEND|os.O_CREATE|os.O_WRONLY, 0o644)
	if err == nil {
		fmt.Fprintln(f, strings.Join(args, "\x1f"))
		_ = f.Close()
	}
	fmt.Println("fake zigflow worker up")

	if os.Getenv(fakeZigflowNoReady) == "" {
		for i, a := range args {
			if a == "--health-listen-address" && i+1 < len(args) {
				mux := http.NewServeMux()
				mux.HandleFunc("/readyz", func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(http.StatusOK) })
				go func() { _ = http.ListenAndServe(args[i+1], mux) }()
			}
		}
	}

	stop := make(chan os.Signal, 1)
	signal.Notify(stop, os.Interrupt)
	select {
	case <-stop:
	case <-time.After(time.Minute): // never outlive the test run
	}
	os.Exit(0)
}

// fakeManager returns a WorkerManager that spawns the fake zigflow, and the file its invocations
// are recorded in.
func fakeManager(t *testing.T, telemetry config.TelemetryConfig) (*WorkerManager, string) {
	t.Helper()
	argsFile := filepath.Join(t.TempDir(), "args.log")
	t.Setenv(fakeZigflowEnv, argsFile)
	m := NewWorkerManager(config.TemporalConfig{
		Address:       "temporal.test:7233",
		ZigflowBinary: os.Args[0],
		WorkflowsDir:  filepath.Join(t.TempDir(), "workflows"),
	}, telemetry)
	t.Cleanup(m.StopAll)
	return m, argsFile
}

func invocations(t *testing.T, argsFile string) [][]string {
	t.Helper()
	raw, err := os.ReadFile(argsFile)
	if err != nil {
		return nil
	}
	var out [][]string
	for _, line := range strings.Split(strings.TrimSpace(string(raw)), "\n") {
		if line != "" {
			out = append(out, strings.Split(strings.TrimRight(line, "\r"), "\x1f"))
		}
	}
	return out
}

func flagValue(args []string, name string) string {
	for i, a := range args {
		if a == name && i+1 < len(args) {
			return args[i+1]
		}
	}
	return ""
}

func TestNewWorkerManagerMissingBinary(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "nested", "workflows")
	m := NewWorkerManager(config.TemporalConfig{ZigflowBinary: "zigflow-definitely-not-installed", WorkflowsDir: dir}, config.TelemetryConfig{})
	if m.available {
		t.Error("manager should be unavailable without the binary")
	}
	if _, err := os.Stat(dir); err != nil {
		t.Errorf("workflows dir should still be created: %v", err)
	}
	// Sync is a no-op rather than an error when zigflow is missing.
	m.Sync("wf", "name", "document: {}")
	if _, err := os.Stat(m.filePath("wf")); !os.IsNotExist(err) {
		t.Error("unavailable manager should not write DSL files")
	}
}

func TestSyncStartsWorkerWithTelemetryAndUniquePorts(t *testing.T) {
	m, argsFile := fakeManager(t, config.TelemetryConfig{
		SinkURL: "http://127.0.0.1:8000/api/internal/zigflow/events",
		Token:   "tok",
		Timeout: 250 * time.Millisecond,
	})

	m.Sync("wf-a", "a", "document: {a: 1}\n")
	m.Sync("wf-b", "b", "document: {b: 1}\n")

	calls := invocations(t, argsFile)
	if len(calls) != 2 {
		t.Fatalf("want 2 worker starts, got %d: %v", len(calls), calls)
	}
	first := calls[0]
	if first[0] != "run" || flagValue(first, "-f") != m.filePath("wf-a") {
		t.Errorf("unexpected args: %v", first)
	}
	if flagValue(first, "--temporal-address") != "temporal.test:7233" {
		t.Errorf("temporal address not passed: %v", first)
	}
	if flagValue(calls[0], "--health-listen-address") == flagValue(calls[1], "--health-listen-address") ||
		flagValue(calls[0], "--metrics-listen-address") == flagValue(calls[1], "--metrics-listen-address") {
		t.Error("each worker needs its own metrics/health ports")
	}

	dsl, err := os.ReadFile(m.filePath("wf-a"))
	if err != nil || string(dsl) != "document: {a: 1}\n" {
		t.Errorf("DSL file: %q, %v", dsl, err)
	}

	eventsPath := flagValue(first, "--cloudevents-config")
	if eventsPath != m.cloudEventsPath("wf-a") {
		t.Fatalf("cloudevents config not passed: %v", first)
	}
	raw, err := os.ReadFile(eventsPath)
	if err != nil {
		t.Fatal(err)
	}
	var cfg cloudEventsConfig
	if err := yaml.Unmarshal(raw, &cfg); err != nil {
		t.Fatal(err)
	}
	if len(cfg.Clients) != 1 || cfg.Clients[0].Target != "http://127.0.0.1:8000/api/internal/zigflow/events" ||
		cfg.Clients[0].Protocol != "http" || cfg.Clients[0].Options["timeout"] != "250ms" {
		t.Errorf("cloudevents config: %+v", cfg)
	}
	headers, _ := cfg.Clients[0].Options["headers"].(map[string]any)
	if headers[TelemetryTokenHeader] != "tok" {
		t.Errorf("token header missing: %+v", headers)
	}

	m.mu.Lock()
	running := len(m.workers)
	m.mu.Unlock()
	if running != 2 {
		t.Errorf("want 2 tracked workers, got %d", running)
	}
}

func TestSyncWithoutTelemetrySkipsCloudEvents(t *testing.T) {
	m, argsFile := fakeManager(t, config.TelemetryConfig{})
	m.Sync("wf", "wf", "document: {}\n")
	calls := invocations(t, argsFile)
	if len(calls) != 1 {
		t.Fatalf("want 1 start, got %v", calls)
	}
	if flagValue(calls[0], "--cloudevents-config") != "" {
		t.Error("no sink URL means no cloudevents config")
	}
	if _, err := os.Stat(m.cloudEventsPath("wf")); !os.IsNotExist(err) {
		t.Error("cloudevents file written without a sink")
	}
}

func TestCloudEventsConfigDefaultsTimeout(t *testing.T) {
	m, _ := fakeManager(t, config.TelemetryConfig{SinkURL: "http://sink"})
	path := m.writeCloudEventsConfig("wf", "wf")
	raw, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(raw), "timeout: 1s") {
		t.Errorf("zero timeout should default to 1s:\n%s", raw)
	}
}

func TestCloudEventsConfigUnwritable(t *testing.T) {
	m, _ := fakeManager(t, config.TelemetryConfig{SinkURL: "http://sink"})
	m.workflowsDir = filepath.Join(t.TempDir(), "missing", "dir")
	if path := m.writeCloudEventsConfig("wf", "wf"); path != "" {
		t.Errorf("want empty path when the file can't be written, got %q", path)
	}
	// Writing the DSL fails the same way, and Sync gives up quietly.
	m.Sync("wf", "wf", "document: {}\n")
	if len(m.workers) != 0 {
		t.Error("worker started without its DSL file")
	}
}

func TestSyncRestartsAndBlankDSLStops(t *testing.T) {
	m, argsFile := fakeManager(t, config.TelemetryConfig{SinkURL: "http://sink"})
	m.Sync("wf", "wf", "document: {v: 1}\n")
	m.mu.Lock()
	firstPid := m.workers["wf"].Process.Pid
	m.mu.Unlock()

	m.Sync("wf", "wf", "document: {v: 2}\n")
	if n := len(invocations(t, argsFile)); n != 2 {
		t.Fatalf("a DSL change should respawn the worker, got %d starts", n)
	}
	m.mu.Lock()
	secondPid := m.workers["wf"].Process.Pid
	m.mu.Unlock()
	if firstPid == secondPid {
		t.Error("worker process was not replaced")
	}

	m.Sync("wf", "wf", "   \n")
	if _, ok := m.workers["wf"]; ok {
		t.Error("blank DSL should stop the worker")
	}
	for _, p := range []string{m.filePath("wf"), m.cloudEventsPath("wf")} {
		if _, err := os.Stat(p); !os.IsNotExist(err) {
			t.Errorf("%s left behind", p)
		}
	}
}

func TestStopUnknownAndStopAll(t *testing.T) {
	m, _ := fakeManager(t, config.TelemetryConfig{})
	m.Stop("never-started")
	m.Sync("a", "a", "document: {}\n")
	m.Sync("b", "b", "document: {}\n")
	m.StopAll()
	if len(m.workers) != 0 {
		t.Errorf("StopAll left %d workers", len(m.workers))
	}
}

func TestSyncStartFailure(t *testing.T) {
	m, _ := fakeManager(t, config.TelemetryConfig{})
	m.binary = filepath.Join(t.TempDir(), "gone") // available was decided at construction
	m.Sync("wf", "wf", "document: {}\n")
	if len(m.workers) != 0 {
		t.Error("a worker that failed to start must not be tracked")
	}
}

func TestWaitForWorkerReady(t *testing.T) {
	ok := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/readyz" {
			t.Errorf("polled %s", r.URL.Path)
		}
	}))
	defer ok.Close()
	if err := waitForWorkerReady(strings.TrimPrefix(ok.URL, "http://"), time.Second); err != nil {
		t.Errorf("ready server: %v", err)
	}

	// A 4xx still means something is answering; only 5xx and no answer count as not ready.
	notFound := httptest.NewServer(http.NotFoundHandler())
	defer notFound.Close()
	if err := waitForWorkerReady(strings.TrimPrefix(notFound.URL, "http://"), time.Second); err != nil {
		t.Errorf("404 should count as ready: %v", err)
	}

	failing := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.WriteHeader(http.StatusServiceUnavailable)
	}))
	defer failing.Close()
	if err := waitForWorkerReady(strings.TrimPrefix(failing.URL, "http://"), 300*time.Millisecond); err == nil {
		t.Error("503 should not count as ready")
	}

	addr, _ := freeLoopbackAddr()
	if err := waitForWorkerReady(addr, 200*time.Millisecond); err == nil {
		t.Error("nothing listening should time out")
	}
}

func TestFreeLoopbackAddr(t *testing.T) {
	addr, err := freeLoopbackAddr()
	if err != nil {
		t.Fatal(err)
	}
	host, port, err := net.SplitHostPort(addr)
	if err != nil || host != "127.0.0.1" || port == "0" {
		t.Fatalf("got %q", addr)
	}
	// Released again, so the worker can bind it.
	l, err := net.Listen("tcp", addr)
	if err != nil {
		t.Fatalf("port not released: %v", err)
	}
	_ = l.Close()
}

func TestPrefixedWriterLogsLines(t *testing.T) {
	w := prefixedWriter("[test]")
	done := make(chan struct{})
	go func() {
		_, _ = w.Write([]byte("one\ntwo\n"))
		close(done)
	}()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("write blocked: nothing is draining the pipe")
	}
	_ = w.Close()
}
