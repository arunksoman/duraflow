package dslruntime

import (
	"fmt"
	"sync"
	"sync/atomic"

	"github.com/nexus-rpc/sdk-go/nexus"
	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/worker"
	"go.temporal.io/sdk/workflow"
)

// zigflow's NewWorkflow registers a DSL's workflows and per-task activities on a worker.Worker.
// Duraflow hands it a captureWorker instead, which records what would have been registered, so a
// build becomes a plain value (name -> function) that the pool's dynamic handlers dispatch to.
//
// captureWorker is a comparable value holding only an id, never a pointer to the captured maps.
// zigflow remembers every (worker, activity name) pair it has registered in a package-level map
// that is never cleared (pkg/zigflow/tasks/activity_registration.go). Keying that map by a small
// value means each build leaves behind an id and a name, not the build itself.

var (
	captureSeq atomic.Uint64
	captures   sync.Map // uint64 -> *capture
)

type capture struct {
	mu         sync.Mutex
	workflows  map[string]any
	activities map[string]any
	err        error
}

type captureWorker struct {
	id uint64
}

var _ worker.Worker = captureWorker{}

func newCapture() (captureWorker, *capture) {
	c := &capture{workflows: map[string]any{}, activities: map[string]any{}}
	w := captureWorker{id: captureSeq.Add(1)}
	captures.Store(w.id, c)
	return w, c
}

// release drops the capture from the lookup map once the build has copied what it registered.
func (w captureWorker) release() {
	captures.Delete(w.id)
}

func (w captureWorker) target() *capture {
	v, ok := captures.Load(w.id)
	if !ok {
		panic(fmt.Sprintf("dslruntime: capture %d used after release", w.id))
	}
	return v.(*capture)
}

func (w captureWorker) RegisterWorkflowWithOptions(fn any, options workflow.RegisterOptions) {
	c := w.target()
	c.mu.Lock()
	defer c.mu.Unlock()
	if options.Name == "" {
		c.fail(fmt.Errorf("zigflow registered a workflow without a name"))
		return
	}
	if _, dup := c.workflows[options.Name]; dup {
		c.fail(fmt.Errorf("workflow name %q is registered twice", options.Name))
		return
	}
	c.workflows[options.Name] = fn
}

func (w captureWorker) RegisterActivityWithOptions(fn any, options activity.RegisterOptions) {
	c := w.target()
	c.mu.Lock()
	defer c.mu.Unlock()
	if options.Name == "" {
		c.fail(fmt.Errorf("zigflow registered an activity without a name"))
		return
	}
	c.activities[options.Name] = fn
}

func (c *capture) fail(err error) {
	if c.err == nil {
		c.err = err
	}
}

// The remaining worker.Worker methods are never called by zigflow's NewWorkflow. Each panics with
// its own name, so a zigflow upgrade that starts calling one fails loudly in Compile (which
// recovers the panic into an error) rather than silently registering nothing.

func (captureWorker) RegisterWorkflow(any) { panic("dslruntime: unexpected RegisterWorkflow call") }

func (captureWorker) RegisterDynamicWorkflow(any, workflow.DynamicRegisterOptions) {
	panic("dslruntime: unexpected RegisterDynamicWorkflow call")
}

func (captureWorker) RegisterActivity(any) { panic("dslruntime: unexpected RegisterActivity call") }

func (captureWorker) RegisterDynamicActivity(any, activity.DynamicRegisterOptions) {
	panic("dslruntime: unexpected RegisterDynamicActivity call")
}

func (captureWorker) RegisterNexusService(*nexus.Service) {
	panic("dslruntime: unexpected RegisterNexusService call")
}

func (captureWorker) Start() error { panic("dslruntime: unexpected Start call") }

func (captureWorker) Run(<-chan any) error { panic("dslruntime: unexpected Run call") }

func (captureWorker) Stop() { panic("dslruntime: unexpected Stop call") }
