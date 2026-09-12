package temporalexec

import (
	"bufio"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"gopkg.in/yaml.v3"

	"duraflow/backend/internal/config"
)

// TelemetryTokenHeader carries the shared secret from a spawned worker to this server's
// CloudEvents ingest endpoint. Defined here because WorkerManager writes it and api reads it.
const TelemetryTokenHeader = "X-Duraflow-Token"

// WorkerManager owns one `zigflow run -f <workflow>.yaml` subprocess per workflow that has a
// non-blank DSL — each such process is a Temporal worker registering that workflow's
// document.workflowType on its document.taskQueue. `zigflow run` has no hot-reload, so a DSL
// change means killing and restarting the process against the rewritten file.
type WorkerManager struct {
	binary          string
	workflowsDir    string
	temporalAddress string
	telemetry       config.TelemetryConfig
	available       bool

	mu      sync.Mutex
	workers map[string]*exec.Cmd
}

func NewWorkerManager(temporal config.TemporalConfig, telemetry config.TelemetryConfig) *WorkerManager {
	available := true
	if _, err := exec.LookPath(temporal.ZigflowBinary); err != nil {
		log.Printf(
			"zigflow binary %q not found on PATH — workflow execution workers will not start "+
				"(install: go install github.com/zigflow/zigflow@latest)",
			temporal.ZigflowBinary,
		)
		available = false
	}
	if err := os.MkdirAll(temporal.WorkflowsDir, 0o755); err != nil {
		log.Printf("creating workflows dir %s: %v", temporal.WorkflowsDir, err)
	}

	return &WorkerManager{
		binary:          temporal.ZigflowBinary,
		workflowsDir:    temporal.WorkflowsDir,
		temporalAddress: temporal.Address,
		telemetry:       telemetry,
		available:       available,
		workers:         map[string]*exec.Cmd{},
	}
}

func (m *WorkerManager) filePath(id string) string {
	return filepath.Join(m.workflowsDir, id+".yaml")
}

func (m *WorkerManager) cloudEventsPath(id string) string {
	return filepath.Join(m.workflowsDir, id+".cloudevents.yaml")
}

// cloudEventsConfig mirrors zigflow's `--cloudevents-config` file shape (pkg/cloudevents's
// Events/ClientConfig). Marshalled rather than templated because the target URL and token are
// values, not literals.
type cloudEventsConfig struct {
	Clients []cloudEventsClient `yaml:"clients"`
}

type cloudEventsClient struct {
	Name     string         `yaml:"name"`
	Protocol string         `yaml:"protocol"`
	Target   string         `yaml:"target"`
	Options  map[string]any `yaml:"options,omitempty"`
}

// writeCloudEventsConfig points a worker's CloudEvents emitter at this server's ingest endpoint,
// which is what makes per-task progress, input and output visible in the UI at all. Returns the
// config path, or "" when telemetry is disabled or the file couldn't be written (the worker then
// simply starts without it and the run shows no task detail).
func (m *WorkerManager) writeCloudEventsConfig(id, name string) string {
	if m.telemetry.SinkURL == "" {
		return ""
	}

	timeout := m.telemetry.Timeout
	if timeout <= 0 {
		timeout = time.Second
	}

	cfg := cloudEventsConfig{Clients: []cloudEventsClient{{
		Name:     "duraflow",
		Protocol: "http",
		Target:   m.telemetry.SinkURL,
		Options: map[string]any{
			"method":  "POST",
			"timeout": timeout.String(),
			"headers": map[string]string{TelemetryTokenHeader: m.telemetry.Token},
		},
	}}}

	raw, err := yaml.Marshal(cfg)
	if err != nil {
		log.Printf("[worker:%s] building cloudevents config: %v", name, err)
		return ""
	}

	path := m.cloudEventsPath(id)
	if err := os.WriteFile(path, raw, 0o600); err != nil {
		log.Printf("[worker:%s] writing cloudevents config: %v", name, err)
		return ""
	}
	return path
}

// Sync (re)starts the worker for a workflow after its DSL was created or changed. A blank DSL
// stops any running worker instead (nothing valid to register).
func (m *WorkerManager) Sync(id, name, dsl string) {
	if !m.available {
		return
	}
	if strings.TrimSpace(dsl) == "" {
		m.Stop(id)
		return
	}

	path := m.filePath(id)
	if err := os.WriteFile(path, []byte(dsl), 0o644); err != nil {
		log.Printf("[worker:%s] writing DSL file: %v", name, err)
		return
	}

	healthAddr, prefix := m.startLocked(id, name, path)
	if healthAddr == "" {
		return
	}

	// Every DSL save kills and respawns this process, and the UI's Run button saves before it
	// starts an execution. Returning before the new worker is polling Temporal means that first
	// run fails with "no worker registered for this task queue" — so block until it's up. Done
	// outside the lock: a slow worker must not stall every other workflow's sync.
	if err := waitForWorkerReady(healthAddr, workerReadyTimeout); err != nil {
		log.Printf("%s did not become ready: %v", prefix, err)
	}
}

// startLocked spawns the worker process and returns its health address plus the log prefix, or
// ("", "") if it couldn't be started.
func (m *WorkerManager) startLocked(id, name, path string) (healthAddr, prefix string) {
	m.mu.Lock()
	defer m.mu.Unlock()
	m.stopLocked(id)

	// Each `zigflow run` process starts its own Prometheus metrics server (:9090) and health
	// server (:3000) by default — fine for one worker, but every worker beyond the first on the
	// same host would fail to bind them and crash (fatal, not just a warning). Give each an
	// OS-assigned free port instead; nothing scrapes these in dev.
	metricsAddr, err := freeLoopbackAddr()
	if err != nil {
		log.Printf("[worker:%s] picking a metrics port: %v", name, err)
		return "", ""
	}
	healthAddr, err = freeLoopbackAddr()
	if err != nil {
		log.Printf("[worker:%s] picking a health-check port: %v", name, err)
		return "", ""
	}

	args := []string{
		"run", "-f", path,
		"--temporal-address", m.temporalAddress,
		"--metrics-listen-address", metricsAddr,
		"--health-listen-address", healthAddr,
	}
	if eventsPath := m.writeCloudEventsConfig(id, name); eventsPath != "" {
		args = append(args, "--cloudevents-config", eventsPath)
	}

	prefix = fmt.Sprintf("[worker:%s]", name)
	cmd := exec.Command(m.binary, args...)
	stdout := prefixedWriter(prefix)
	stderr := prefixedWriter(prefix)
	cmd.Stdout = stdout
	cmd.Stderr = stderr

	if err := cmd.Start(); err != nil {
		log.Printf("%s failed to start: %v", prefix, err)
		_ = stdout.Close()
		_ = stderr.Close()
		return "", ""
	}
	log.Printf("%s started (pid %d)", prefix, cmd.Process.Pid)
	m.workers[id] = cmd

	go func() {
		_ = cmd.Wait()
		_ = stdout.Close()
		_ = stderr.Close()
	}()

	return healthAddr, prefix
}

const (
	workerReadyTimeout  = 15 * time.Second
	workerReadyInterval = 100 * time.Millisecond
)

// waitForWorkerReady polls the health server zigflow starts on healthAddr until it answers.
// A worker that never answers isn't treated as fatal — it may still come up moments later, and
// failing the surrounding DSL save over it would be worse than a slow first run.
func waitForWorkerReady(healthAddr string, timeout time.Duration) error {
	client := &http.Client{Timeout: workerReadyInterval * 5}
	url := "http://" + healthAddr + "/readyz"
	deadline := time.Now().Add(timeout)

	for {
		resp, err := client.Get(url)
		if err == nil {
			_ = resp.Body.Close()
			if resp.StatusCode < 500 {
				return nil
			}
		}
		if time.Now().After(deadline) {
			return fmt.Errorf("health check %s not answering after %s", url, timeout)
		}
		time.Sleep(workerReadyInterval)
	}
}

// Stop kills a workflow's worker process, if any, and removes the files spawned for it.
func (m *WorkerManager) Stop(id string) {
	m.mu.Lock()
	m.stopLocked(id)
	m.mu.Unlock()

	_ = os.Remove(m.filePath(id))
	_ = os.Remove(m.cloudEventsPath(id))
}

func (m *WorkerManager) stopLocked(id string) {
	cmd, ok := m.workers[id]
	if !ok {
		return
	}
	delete(m.workers, id)
	if cmd.Process != nil {
		_ = cmd.Process.Kill()
	}
}

// StopAll kills every running worker — call on shutdown so no `zigflow run` processes linger.
func (m *WorkerManager) StopAll() {
	m.mu.Lock()
	defer m.mu.Unlock()
	for id, cmd := range m.workers {
		if cmd.Process != nil {
			_ = cmd.Process.Kill()
		}
		delete(m.workers, id)
	}
}

// freeLoopbackAddr returns "127.0.0.1:<port>" for an OS-assigned free port, by briefly binding
// and releasing a listener — there's a small race if something else grabs the port before the
// caller does, but that's an acceptable risk for a dev-grade metrics endpoint nothing scrapes.
func freeLoopbackAddr() (string, error) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return "", err
	}
	defer l.Close()
	return l.Addr().String(), nil
}

// prefixedWriter logs each line written to it, prefixed, via a pipe — safe to hand to
// exec.Cmd.Stdout/Stderr directly. The caller must Close it once the process exits.
func prefixedWriter(prefix string) *io.PipeWriter {
	pr, pw := io.Pipe()
	go func() {
		scanner := bufio.NewScanner(pr)
		scanner.Buffer(make([]byte, 64*1024), 1024*1024)
		for scanner.Scan() {
			log.Printf("%s %s", prefix, scanner.Text())
		}
	}()
	return pw
}
