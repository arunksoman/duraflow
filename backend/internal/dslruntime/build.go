// Package dslruntime runs Duraflow workflows inside Duraflow's own processes, using zigflow as a
// Go library instead of spawning one `zigflow run` process per workflow.
//
// A saved DSL is compiled once per process into a Build: the workflow and activity functions
// zigflow would have registered on a worker, keyed by name. A Pool of ordinary Temporal workers,
// one per task queue, registers a single dynamic workflow and a single dynamic activity handler.
// Each task carries the hash of the DSL its run started on (see package dslhash); the handler
// loads that Build from the Cache and calls the matching function. Any worker can therefore run
// any workflow at any version, and a save never restarts anything.
package dslruntime

import (
	"errors"
	"fmt"
	"sort"
	"strings"

	"github.com/open-workflow-specification/sdk-go/v4/model"
	"github.com/zigflow/zigflow/pkg/cloudevents"
	"github.com/zigflow/zigflow/pkg/utils"
	"github.com/zigflow/zigflow/pkg/zigflow"
	"github.com/zigflow/zigflow/pkg/zigflow/activities"
	"github.com/zigflow/zigflow/pkg/zigflow/tasks"
	"go.temporal.io/sdk/workflow"

	"duraflow/backend/internal/dslhash"
)

// Env is everything a build depends on besides the DSL text. It must be the same on every process
// that runs workflows, because a version is identified by its DSL hash alone.
type Env struct {
	// Validator is zigflow's struct validator, created once per process.
	Validator *utils.Validator
	// Envvars are the ZIGGY_-prefixed environment variables, exposed to expressions as $env.
	Envvars map[string]any
	// CloudEventsConfigPath points every build's emitter at the ingest endpoint. Empty disables
	// task telemetry, which only validation-only callers should do.
	CloudEventsConfigPath string
	// ContainerRuntime, ContainerNamespace and ContainerServiceAccount configure `run: container`
	// tasks, exactly as zigflow run's --container-runtime* flags do.
	ContainerRuntime        string
	ContainerNamespace      string
	ContainerServiceAccount string
}

// NewEnv creates an Env with a fresh zigflow validator.
func NewEnv() (*Env, error) {
	validator, err := utils.NewValidator()
	if err != nil {
		return nil, fmt.Errorf("creating zigflow validator: %w", err)
	}
	return &Env{Validator: validator, Envvars: map[string]any{}, ContainerRuntime: string(activities.ContainerRuntimeDocker)}, nil
}

// Build is one compiled DSL version.
type Build struct {
	Hash         string
	TaskQueue    string
	WorkflowType string
	// Doc is the loaded document, kept for publishing its schedule.
	Doc *model.Workflow

	workflows  map[string]tasks.TemporalWorkflowFunc
	activities map[string]any
}

// Workflow returns the function registered under a Temporal workflow type name.
func (b *Build) Workflow(name string) (tasks.TemporalWorkflowFunc, bool) {
	fn, ok := b.workflows[name]
	return fn, ok
}

// Activity returns the function registered under an activity name.
func (b *Build) Activity(name string) (any, bool) {
	fn, ok := b.activities[name]
	return fn, ok
}

// WorkflowNames lists every workflow name the DSL registers, sorted.
func (b *Build) WorkflowNames() []string {
	names := make([]string, 0, len(b.workflows))
	for name := range b.workflows {
		names = append(names, name)
	}
	sort.Strings(names)
	return names
}

// ErrBlankDSL is returned for a DSL with no content: nothing to run, which is not an error to show.
var ErrBlankDSL = errors.New("the DSL is blank")

// CompileError is a DSL zigflow rejects. Its message is meant for the person who wrote the DSL.
type CompileError struct {
	Err error
}

func (e *CompileError) Error() string { return e.Err.Error() }
func (e *CompileError) Unwrap() error { return e.Err }

// Compile validates and builds a DSL the same way `zigflow run --validate` does: JSON-schema
// validation, load, the empty workflowType/taskQueue guards, struct validation, the CloudEvents
// emitter, and finally zigflow's own builder, which also rejects duplicate workflow names and
// non-deterministic expressions.
func Compile(dsl string, env *Env) (build *Build, err error) {
	if strings.TrimSpace(dsl) == "" {
		return nil, ErrBlankDSL
	}

	// zigflow reports some build failures by panicking; a bad DSL must never take a process down.
	defer func() {
		if r := recover(); r != nil {
			build, err = nil, &CompileError{Err: fmt.Errorf("zigflow failed to build the workflow: %v", r)}
		}
	}()

	raw := []byte(dsl)
	if err := zigflow.ValidateBytes(raw); err != nil {
		return nil, &CompileError{Err: err}
	}
	doc, err := zigflow.LoadFromBytes(raw)
	if err != nil {
		return nil, &CompileError{Err: err}
	}
	if doc.Document.Name == "" {
		return nil, &CompileError{Err: errors.New("document.workflowType must not be empty")}
	}
	if doc.Document.Namespace == "" {
		return nil, &CompileError{Err: errors.New("document.taskQueue must not be empty")}
	}
	if err := validateStruct(env.Validator, doc); err != nil {
		return nil, err
	}

	events, err := cloudevents.Load(env.CloudEventsConfigPath, env.Validator, doc)
	if err != nil {
		// A broken emitter config is the operator's problem, not the DSL author's.
		return nil, fmt.Errorf("loading the CloudEvents config: %w", err)
	}

	// TaskOpts carries per-document state (the registered-name map behind zigflow's duplicate
	// check), so it must be new for every build.
	taskOpts := &tasks.TaskOpts{Run: &tasks.RunTaskOpts{
		Namespace:      env.ContainerNamespace,
		Runtime:        activities.ContainerRuntime(env.ContainerRuntime),
		ServiceAccount: env.ContainerServiceAccount,
	}}

	capWorker, captured := newCapture()
	defer capWorker.release()

	if err := zigflow.NewWorkflow(capWorker, doc, env.Envvars, events, nil, taskOpts); err != nil {
		return nil, &CompileError{Err: err}
	}

	captured.mu.Lock()
	defer captured.mu.Unlock()
	if captured.err != nil {
		return nil, &CompileError{Err: captured.err}
	}

	build = &Build{
		Hash:         dslhash.Of(dsl),
		TaskQueue:    doc.Document.Namespace,
		WorkflowType: doc.Document.Name,
		Doc:          doc,
		workflows:    make(map[string]tasks.TemporalWorkflowFunc, len(captured.workflows)),
		activities:   make(map[string]any, len(captured.activities)),
	}
	for name, fn := range captured.workflows {
		wf, ok := asWorkflowFunc(fn)
		if !ok {
			return nil, fmt.Errorf("zigflow registered workflow %q with unexpected type %T", name, fn)
		}
		build.workflows[name] = wf
	}
	for name, fn := range captured.activities {
		build.activities[name] = fn
	}
	if _, ok := build.workflows[build.WorkflowType]; !ok && len(build.workflows) == 0 {
		return nil, &CompileError{Err: errors.New("the DSL does not define any workflow")}
	}
	return build, nil
}

func asWorkflowFunc(fn any) (tasks.TemporalWorkflowFunc, bool) {
	switch f := fn.(type) {
	case tasks.TemporalWorkflowFunc:
		return f, true
	case func(workflow.Context, any, *utils.State) (any, error):
		return f, true
	}
	return nil, false
}

func validateStruct(validator *utils.Validator, doc *model.Workflow) error {
	results, err := validator.ValidateStruct(doc)
	if err != nil {
		return fmt.Errorf("running zigflow validation: %w", err)
	}
	if len(results) == 0 {
		return nil
	}
	messages := make([]string, 0, len(results))
	for _, r := range results {
		if r.Key != "" {
			messages = append(messages, r.Key+": "+r.Message)
		} else {
			messages = append(messages, r.Message)
		}
	}
	return &CompileError{Err: fmt.Errorf("validation failed: %s", strings.Join(messages, "; "))}
}
