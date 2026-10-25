package dslruntime

import (
	"context"
	"errors"
	"fmt"
	"reflect"
	"time"

	"github.com/zigflow/zigflow/pkg/utils"
	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/converter"
	"go.temporal.io/sdk/interceptor"
	"go.temporal.io/sdk/temporal"
	"go.temporal.io/sdk/workflow"

	"duraflow/backend/internal/dslhash"
)

// ErrTypeBrokenVersion fails a run whose DSL version can no longer be built (for example after a
// zigflow upgrade tightened validation). Retrying can't fix it, and the message says what broke.
const ErrTypeBrokenVersion = "DuraflowBrokenVersion"

// ErrTypeActivityNotRegistered is the retryable failure for an activity no Duraflow workflow
// defines, mirroring what a statically registered worker reports for an unknown activity type.
const ErrTypeActivityNotRegistered = "DuraflowActivityNotRegistered"

// errUnknownWorkflow means no saved Duraflow workflow defines the requested workflow type on this
// queue. The task may belong to another worker sharing the queue (a user's own Go worker started
// by a `run: workflow` task, say), so the dispatcher fails only the workflow task, exactly as a
// statically registered worker does for a type it doesn't know: Temporal retries it, and a worker
// that knows the type can take it.
var errUnknownWorkflow = errors.New("no saved Duraflow workflow defines this workflow type")

// loadTimeout bounds a cache miss (database read plus compile) inside a workflow task. It must stay
// below the worker's DeadlockDetectionTimeout.
const loadTimeout = 5 * time.Second

// Dispatcher is the pool's dynamic workflow and activity handler.
type Dispatcher struct {
	Cache     *Cache
	Directory *Directory
}

// resolve picks the build a task runs on.
//
//  1. The run's hash header, when that version defines the requested name. This covers every run
//     Duraflow starts (API, schedules) and every child a run starts from its own document.
//  2. Otherwise the version that currently defines the name on this task queue. This covers runs
//     started before versions existed and runs started by other Temporal clients. Such runs follow
//     the latest save, which is how every run behaved when each workflow had its own process.
//
// Errors that retrying cannot fix come back as non-retryable application errors; anything else
// (the database is down) comes back as is, for the caller to retry.
func (d *Dispatcher) resolve(ctx context.Context, hash, taskQueue, name string) (*Build, error) {
	if hash != "" {
		build, err := d.Cache.Get(ctx, hash)
		switch {
		case err == nil:
			if _, ok := build.Workflow(name); ok {
				return build, nil
			}
		case isPermanent(err):
			// Fall through: the current version may still define this name.
		default:
			return nil, err
		}
	}

	current, ok, err := d.Directory.Lookup(ctx, taskQueue, name)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, fmt.Errorf("%w: %q on task queue %q", errUnknownWorkflow, name, taskQueue)
	}
	build, err := d.Cache.Get(ctx, current)
	if err != nil {
		if isPermanent(err) {
			return nil, temporal.NewNonRetryableApplicationError(
				fmt.Sprintf("the saved DSL for %q cannot be built: %v", name, err), ErrTypeBrokenVersion, err)
		}
		return nil, err
	}
	if _, ok := build.Workflow(name); !ok {
		return nil, fmt.Errorf("%w: %q on task queue %q", errUnknownWorkflow, name, taskQueue)
	}
	return build, nil
}

func isPermanent(err error) bool {
	var compileErr *CompileError
	return errors.Is(err, ErrVersionNotFound) || errors.As(err, &compileErr)
}

func isApplicationError(err error) bool {
	var appErr *temporal.ApplicationError
	return errors.As(err, &appErr)
}

// Workflow is registered with RegisterDynamicWorkflow. It looks up the zigflow function for the
// task's workflow type in the run's DSL version and calls it with the decoded arguments: one for a
// run started by the API or a schedule (input), two for a child (input, state).
func (d *Dispatcher) Workflow(ctx workflow.Context, args converter.EncodedValues) (any, error) {
	info := workflow.GetInfo(ctx)
	name := info.WorkflowType.Name

	loadCtx, cancel := context.WithTimeout(context.Background(), loadTimeout)
	build, err := d.resolve(loadCtx, dslhash.FromWorkflow(ctx), info.TaskQueueName, name)
	cancel()
	if err != nil {
		if isApplicationError(err) {
			return nil, err // fails the run with a message the user can act on
		}
		// An unknown type (possibly another worker's), or the database timed out: fail this
		// workflow task so Temporal retries it, instead of failing a run that may be fine.
		panic(fmt.Errorf("loading the DSL for workflow %q: %w", name, err))
	}

	fn, _ := build.Workflow(name)
	var input any
	var state *utils.State
	if err := args.Get(&input, &state); err != nil {
		return nil, temporal.NewNonRetryableApplicationError(
			fmt.Sprintf("decoding the arguments of workflow %q: %v", name, err), "DuraflowBadArguments", err)
	}

	// Everything this run starts from here on (children, activities, continue-as-new) carries the
	// version it actually runs, which may differ from its header when rule 2 above applied.
	return fn(dslhash.WithWorkflow(ctx, build.Hash), input, state)
}

// Activity is registered with RegisterDynamicActivity. zigflow's per-task activities are its
// shared HTTP, gRPC and container functions registered under a per-task name, so the run's DSL
// version only decides which of those functions a name maps to.
func (d *Dispatcher) Activity(ctx context.Context, args converter.EncodedValues) (any, error) {
	info := activity.GetInfo(ctx)
	name := info.ActivityType.Name

	fn, err := d.activityFunc(ctx, dslhash.From(ctx), info.TaskQueue, info.WorkflowType.Name, name)
	if err != nil {
		return nil, err
	}
	return invokeActivity(ctx, fn, args)
}

func (d *Dispatcher) activityFunc(ctx context.Context, hash, taskQueue, workflowType, name string) (any, error) {
	if hash != "" {
		build, err := d.Cache.Get(ctx, hash)
		if err == nil {
			if fn, ok := build.Activity(name); ok {
				return fn, nil
			}
		} else if !isPermanent(err) {
			return nil, err
		}
	}
	// An activity scheduled before versions existed has no header: use the version that currently
	// defines the workflow that scheduled it.
	notRegistered := temporal.NewApplicationError(
		fmt.Sprintf("no saved Duraflow workflow defines activity %q", name), ErrTypeActivityNotRegistered)
	build, err := d.resolve(ctx, "", taskQueue, workflowType)
	if errors.Is(err, errUnknownWorkflow) {
		return nil, notRegistered
	}
	if err != nil {
		return nil, err
	}
	fn, ok := build.Activity(name)
	if !ok {
		return nil, notRegistered
	}
	return fn, nil
}

var (
	contextType = reflect.TypeOf((*context.Context)(nil)).Elem()
	errorType   = reflect.TypeOf((*error)(nil)).Elem()
)

// invokeActivity calls an activity function the way the SDK would call it if it were registered
// statically: an optional leading context.Context, the remaining parameters decoded from the
// task's payloads, and a result of (T, error), error, T or nothing.
func invokeActivity(ctx context.Context, fn any, args converter.EncodedValues) (any, error) {
	fv := reflect.ValueOf(fn)
	ft := fv.Type()
	if ft.Kind() != reflect.Func {
		return nil, fmt.Errorf("activity is a %s, not a function", ft.Kind())
	}

	in := make([]reflect.Value, 0, ft.NumIn())
	first := 0
	if ft.NumIn() > 0 && ft.In(0).Implements(contextType) {
		in = append(in, reflect.ValueOf(ctx))
		first = 1
	}
	ptrs := make([]any, 0, ft.NumIn()-first)
	vals := make([]reflect.Value, 0, ft.NumIn()-first)
	for i := first; i < ft.NumIn(); i++ {
		v := reflect.New(ft.In(i))
		vals = append(vals, v)
		ptrs = append(ptrs, v.Interface())
	}
	if len(ptrs) > 0 {
		if err := args.Get(ptrs...); err != nil {
			return nil, temporal.NewNonRetryableApplicationError(
				fmt.Sprintf("decoding activity arguments: %v", err), "DuraflowBadArguments", err)
		}
	}
	for _, v := range vals {
		in = append(in, v.Elem())
	}

	out := fv.Call(in)
	switch len(out) {
	case 0:
		return nil, nil
	case 1:
		if ft.Out(0).Implements(errorType) {
			return nil, asError(out[0])
		}
		return out[0].Interface(), nil
	default:
		return out[0].Interface(), asError(out[len(out)-1])
	}
}

func asError(v reflect.Value) error {
	if !v.IsValid() || v.IsNil() {
		return nil
	}
	return v.Interface().(error)
}

// Interceptor pins a `run: workflow` child to the current version of the workflow it targets.
//
// A child inherits its parent's hash header, which is right for children the parent's own document
// defines (fork branches, switch redirects). A `run: workflow` task can instead start another
// stored workflow, which the parent's version knows nothing about. Rather than have that child
// resolve its version on every workflow task (and change version mid-run after a save), the
// parent's ExecuteChildWorkflow call is intercepted and the child is started with the target's
// current hash in its header. Headers are not part of replay determinism, so reading the directory
// here is safe.
func (d *Dispatcher) Interceptor() interceptor.WorkerInterceptor {
	return &workerInterceptor{d: d}
}

type workerInterceptor struct {
	interceptor.WorkerInterceptorBase
	d *Dispatcher
}

func (w *workerInterceptor) InterceptWorkflow(
	_ workflow.Context, next interceptor.WorkflowInboundInterceptor,
) interceptor.WorkflowInboundInterceptor {
	in := &inboundInterceptor{d: w.d}
	in.Next = next
	return in
}

type inboundInterceptor struct {
	interceptor.WorkflowInboundInterceptorBase
	d *Dispatcher
}

func (i *inboundInterceptor) Init(outbound interceptor.WorkflowOutboundInterceptor) error {
	out := &outboundInterceptor{d: i.d}
	out.Next = outbound
	return i.Next.Init(out)
}

type outboundInterceptor struct {
	interceptor.WorkflowOutboundInterceptorBase
	d *Dispatcher
}

func (o *outboundInterceptor) ExecuteChildWorkflow(
	ctx workflow.Context, childWorkflowType string, args ...any,
) workflow.ChildWorkflowFuture {
	return o.Next.ExecuteChildWorkflow(o.d.pinChild(ctx, childWorkflowType), childWorkflowType, args...)
}

func (d *Dispatcher) pinChild(ctx workflow.Context, childType string) workflow.Context {
	hash := dslhash.FromWorkflow(ctx)
	lookupCtx, cancel := context.WithTimeout(context.Background(), loadTimeout)
	defer cancel()
	if build, err := d.Cache.Get(lookupCtx, hash); err == nil {
		if _, defined := build.Workflow(childType); defined {
			return ctx
		}
	}
	taskQueue := workflow.GetChildWorkflowOptions(ctx).TaskQueue
	if taskQueue == "" {
		taskQueue = workflow.GetInfo(ctx).TaskQueueName
	}
	target, ok, err := d.Directory.Lookup(lookupCtx, taskQueue, childType)
	if err != nil || !ok || target == hash {
		return ctx
	}
	return dslhash.WithWorkflow(ctx, target)
}
