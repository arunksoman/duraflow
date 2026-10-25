package dslruntime

import (
	"context"
	"log"
	"sort"
	"sync"
	"sync/atomic"
	"time"

	"github.com/zigflow/zigflow/pkg/interceptors"
	"github.com/zigflow/zigflow/pkg/zigflow/tasks"
	"go.temporal.io/sdk/activity"
	"go.temporal.io/sdk/client"
	"go.temporal.io/sdk/contrib/sysinfo"
	sdkinterceptor "go.temporal.io/sdk/interceptor"
	"go.temporal.io/sdk/worker"
	"go.temporal.io/sdk/workflow"
	"gorm.io/gorm"

	"duraflow/backend/internal/models"
)

// PoolOptions configures a Pool. Zero durations take the defaults noted on each field.
type PoolOptions struct {
	// Identity names this process on the Workers page and in Temporal's poller list.
	Identity string
	// Temporal returns the shared client; the pool retries it until Temporal is reachable.
	Temporal   func() (client.Client, error)
	DB         *gorm.DB
	Dispatcher *Dispatcher

	// RefreshInterval is how often the set of task queues is re-read (default 5s). A save also
	// triggers a refresh through Kick.
	RefreshInterval time.Duration
	// HeartbeatInterval is how often this process's Workers-page rows are touched (default 10s).
	HeartbeatInterval time.Duration
	// DeadlockDetectionTimeout must exceed a cache miss plus one CloudEvent delivery (default 10s).
	DeadlockDetectionTimeout time.Duration
	// StopTimeout lets in-flight activities finish on shutdown (default 10s, as zigflow run).
	StopTimeout time.Duration

	MaxConcurrentActivityExecutionSize     int
	MaxConcurrentWorkflowTaskExecutionSize int
}

// Pool runs one Temporal worker per task queue that any saved workflow, or any still-running
// execution, uses. Every worker can run every workflow on its queue at any version, so the pool is
// stateless: run as many copies, on as many hosts, as load requires.
type Pool struct {
	opts PoolOptions
	kick chan struct{}

	mu      sync.Mutex
	workers map[string]worker.Worker

	prewarming atomic.Bool
}

func NewPool(opts PoolOptions) *Pool {
	if opts.RefreshInterval <= 0 {
		opts.RefreshInterval = 5 * time.Second
	}
	if opts.HeartbeatInterval <= 0 {
		opts.HeartbeatInterval = 10 * time.Second
	}
	if opts.DeadlockDetectionTimeout <= 0 {
		opts.DeadlockDetectionTimeout = 10 * time.Second
	}
	if opts.StopTimeout <= 0 {
		opts.StopTimeout = 10 * time.Second
	}
	return &Pool{opts: opts, kick: make(chan struct{}, 1), workers: map[string]worker.Worker{}}
}

// Kick asks for an immediate refresh, e.g. after a save added a task queue. It never blocks.
func (p *Pool) Kick() {
	select {
	case p.kick <- struct{}{}:
	default:
	}
}

// TaskQueues lists the queues this process is polling.
func (p *Pool) TaskQueues() []string {
	p.mu.Lock()
	defer p.mu.Unlock()
	out := make([]string, 0, len(p.workers))
	for q := range p.workers {
		out = append(out, q)
	}
	sort.Strings(out)
	return out
}

// Run blocks until ctx is cancelled, then stops every worker.
func (p *Pool) Run(ctx context.Context) {
	temporalClient, ok := p.waitForTemporal(ctx)
	if !ok {
		return
	}

	refresh := time.NewTicker(p.opts.RefreshInterval)
	defer refresh.Stop()
	heartbeat := time.NewTicker(p.opts.HeartbeatInterval)
	defer heartbeat.Stop()

	p.refresh(ctx, temporalClient)
	p.heartbeat(ctx)
	for {
		select {
		case <-ctx.Done():
			p.stopAll()
			return
		case <-p.kick:
			p.refresh(ctx, temporalClient)
		case <-refresh.C:
			p.refresh(ctx, temporalClient)
		case <-heartbeat.C:
			p.heartbeat(ctx)
		}
	}
}

func (p *Pool) waitForTemporal(ctx context.Context) (client.Client, bool) {
	backoff := time.Second
	for {
		c, err := p.opts.Temporal()
		if err == nil {
			return c, true
		}
		log.Printf("[pool] Temporal not reachable, retrying in %s: %v", backoff, err)
		select {
		case <-ctx.Done():
			return nil, false
		case <-time.After(backoff):
		}
		backoff = min(backoff*2, 30*time.Second)
	}
}

// wantedQueues is every queue a saved workflow runs on, plus every queue a still-running execution
// is on, so moving a workflow to another queue (or deleting it) never strands an open run.
func (p *Pool) wantedQueues(ctx context.Context) (map[string]struct{}, error) {
	var fromWorkflows, fromRuns []string
	if err := p.opts.DB.WithContext(ctx).Model(&models.Workflow{}).
		Where("current_hash <> '' AND task_queue <> ''").
		Distinct().Pluck("task_queue", &fromWorkflows).Error; err != nil {
		return nil, err
	}
	if err := p.opts.DB.WithContext(ctx).Model(&models.Execution{}).
		Where("status = ? AND task_queue <> ''", models.ExecutionRunning).
		Distinct().Pluck("task_queue", &fromRuns).Error; err != nil {
		return nil, err
	}
	wanted := make(map[string]struct{}, len(fromWorkflows)+len(fromRuns))
	for _, q := range append(fromWorkflows, fromRuns...) {
		wanted[q] = struct{}{}
	}
	return wanted, nil
}

func (p *Pool) refresh(ctx context.Context, temporalClient client.Client) {
	if err := p.opts.Dispatcher.Directory.Refresh(ctx); err != nil && ctx.Err() == nil {
		log.Printf("[pool] refreshing workflow registrations: %v", err)
	}
	wanted, err := p.wantedQueues(ctx)
	if err != nil {
		if ctx.Err() == nil {
			log.Printf("[pool] listing task queues: %v", err)
		}
		return
	}

	p.mu.Lock()
	var stopped []string
	for q, w := range p.workers {
		if _, keep := wanted[q]; !keep {
			delete(p.workers, q)
			stopped = append(stopped, q)
			go w.Stop()
		}
	}
	var started []string
	for q := range wanted {
		if _, running := p.workers[q]; running {
			continue
		}
		w := p.newWorker(temporalClient, q)
		if err := w.Start(); err != nil {
			log.Printf("[pool] starting worker for task queue %q: %v", q, err)
			continue
		}
		p.workers[q] = w
		started = append(started, q)
	}
	p.mu.Unlock()

	for _, q := range started {
		log.Printf("[pool] polling task queue %q", q)
	}
	for _, q := range stopped {
		log.Printf("[pool] stopped polling task queue %q", q)
		p.setStatus(ctx, q, models.WorkerOffline)
	}
	if len(started) > 0 {
		p.heartbeat(ctx)
	}
	p.prewarm()
}

func (p *Pool) newWorker(temporalClient client.Client, taskQueue string) worker.Worker {
	autoscaling := worker.NewPollerBehaviorAutoscaling(worker.PollerBehaviorAutoscalingOptions{})
	w := worker.New(temporalClient, taskQueue, worker.Options{
		Identity:                               p.opts.Identity,
		WorkflowTaskPollerBehavior:             autoscaling,
		ActivityTaskPollerBehavior:             autoscaling,
		WorkerStopTimeout:                      p.opts.StopTimeout,
		DeadlockDetectionTimeout:               p.opts.DeadlockDetectionTimeout,
		MaxConcurrentActivityExecutionSize:     p.opts.MaxConcurrentActivityExecutionSize,
		MaxConcurrentWorkflowTaskExecutionSize: p.opts.MaxConcurrentWorkflowTaskExecutionSize,
		SysInfoProvider:                        sysinfo.SysInfoProvider(),
		Interceptors: []sdkinterceptor.WorkerInterceptor{
			interceptors.NewLoggerInterceptor(),
			p.opts.Dispatcher.Interceptor(),
		},
	})
	// zigflow's shared activities are plain functions with fixed names, the same for every
	// version, so they are registered statically, exactly as zigflow run does.
	for _, a := range tasks.ActivitiesList() {
		w.RegisterActivity(a)
	}
	w.RegisterDynamicWorkflow(p.opts.Dispatcher.Workflow, workflow.DynamicRegisterOptions{})
	w.RegisterDynamicActivity(p.opts.Dispatcher.Activity, activity.DynamicRegisterOptions{})
	return w
}

// prewarm compiles every current version in the background, so the first run after a save on
// another copy does not pay the compile inside its first workflow task.
func (p *Pool) prewarm() {
	if !p.prewarming.CompareAndSwap(false, true) {
		return
	}
	hashes := p.opts.Dispatcher.Directory.CurrentHashes()
	if len(hashes) > p.opts.Dispatcher.Cache.max {
		// They can't all stay cached, so each pass would evict what it just built and recompile
		// everything every refresh; leave compiling to the runs themselves.
		p.prewarming.Store(false)
		return
	}
	go func() {
		defer p.prewarming.Store(false)
		for _, hash := range hashes {
			if _, ok := p.opts.Dispatcher.Cache.Peek(hash); ok {
				continue
			}
			ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
			if _, err := p.opts.Dispatcher.Cache.Get(ctx, hash); err != nil {
				log.Printf("[pool] pre-building DSL version %s: %v", shortHash(hash), err)
			}
			cancel()
		}
	}()
}

func (p *Pool) heartbeat(ctx context.Context) {
	for _, q := range p.TaskQueues() {
		p.setStatus(ctx, q, models.WorkerOnline)
	}
}

// setStatus upserts this process's row for one task queue on the Workers page.
func (p *Pool) setStatus(ctx context.Context, taskQueue string, status models.WorkerStatus) {
	if p.opts.Identity == "" {
		return
	}
	now := time.Now()
	res := p.opts.DB.WithContext(ctx).Model(&models.Worker{}).
		Where("identity = ? AND task_queue = ?", p.opts.Identity, taskQueue).
		Updates(map[string]any{"status": status, "last_heartbeat_at": now, "updated_at": now})
	if res.Error != nil {
		log.Printf("[pool] recording worker heartbeat: %v", res.Error)
		return
	}
	if res.RowsAffected == 0 {
		row := models.Worker{Identity: p.opts.Identity, TaskQueue: taskQueue, Status: status, LastHeartbeatAt: now}
		if err := p.opts.DB.WithContext(ctx).Create(&row).Error; err != nil {
			log.Printf("[pool] recording worker heartbeat: %v", err)
		}
	}
}

func (p *Pool) stopAll() {
	p.mu.Lock()
	workers := p.workers
	p.workers = map[string]worker.Worker{}
	p.mu.Unlock()

	var wg sync.WaitGroup
	for q, w := range workers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			w.Stop()
		}()
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
		p.setStatus(ctx, q, models.WorkerOffline)
		cancel()
	}
	wg.Wait()
}

func shortHash(hash string) string {
	if len(hash) > 12 {
		return hash[:12]
	}
	return hash
}
