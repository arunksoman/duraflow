package temporalexec

import (
	"bufio"
	"fmt"
	"io"
	"log"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
)

// WorkerManager owns one `zigflow run -f <workflow>.yaml` subprocess per workflow that has a
// non-blank DSL — each such process is a Temporal worker registering that workflow's
// document.workflowType on its document.taskQueue. `zigflow run` has no hot-reload, so a DSL
// change means killing and restarting the process against the rewritten file.
type WorkerManager struct {
	binary       string
	workflowsDir string
	available    bool

	mu      sync.Mutex
	workers map[string]*exec.Cmd
}

func NewWorkerManager(binary, workflowsDir string) *WorkerManager {
	available := true
	if _, err := exec.LookPath(binary); err != nil {
		log.Printf(
			"zigflow binary %q not found on PATH — workflow execution workers will not start "+
				"(install: go install github.com/zigflow/zigflow@latest)",
			binary,
		)
		available = false
	}
	if err := os.MkdirAll(workflowsDir, 0o755); err != nil {
		log.Printf("creating workflows dir %s: %v", workflowsDir, err)
	}

	return &WorkerManager{
		binary:       binary,
		workflowsDir: workflowsDir,
		available:    available,
		workers:      map[string]*exec.Cmd{},
	}
}

func (m *WorkerManager) filePath(id string) string {
	return filepath.Join(m.workflowsDir, id+".yaml")
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

	m.mu.Lock()
	defer m.mu.Unlock()
	m.stopLocked(id)

	prefix := fmt.Sprintf("[worker:%s]", name)
	cmd := exec.Command(m.binary, "run", "-f", path)
	stdout := prefixedWriter(prefix)
	stderr := prefixedWriter(prefix)
	cmd.Stdout = stdout
	cmd.Stderr = stderr

	if err := cmd.Start(); err != nil {
		log.Printf("%s failed to start: %v", prefix, err)
		_ = stdout.Close()
		_ = stderr.Close()
		return
	}
	log.Printf("%s started (pid %d)", prefix, cmd.Process.Pid)
	m.workers[id] = cmd

	go func() {
		_ = cmd.Wait()
		_ = stdout.Close()
		_ = stderr.Close()
	}()
}

// Stop kills a workflow's worker process, if any, and removes its DSL file.
func (m *WorkerManager) Stop(id string) {
	m.mu.Lock()
	m.stopLocked(id)
	m.mu.Unlock()

	_ = os.Remove(m.filePath(id))
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
