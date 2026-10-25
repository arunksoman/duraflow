// Package temporalexec is the backend's Temporal client wiring and run-telemetry resolver.
package temporalexec

import (
	"fmt"
	"log/slog"
	"os"
	"sync"

	"github.com/zigflow/zigflow/pkg/ctxpropagator"
	"go.temporal.io/sdk/client"
	sdklog "go.temporal.io/sdk/log"
	"go.temporal.io/sdk/workflow"

	"duraflow/backend/internal/dslhash"
)

// LazyClient dials Temporal on first use rather than at startup, so the backend still boots
// when Temporal isn't up yet (common in dev — it just fails the first execution attempt).
type LazyClient struct {
	options client.Options

	mu     sync.Mutex
	client client.Client
}

// ClientOptions returns the options every Duraflow Temporal client uses. Both context propagators
// matter: dslhash pins each run to the DSL version it started on, and zigflow's own propagator
// carries values its workflows pass between parent and child, as `zigflow run` sets up.
//
// The SDK's logger (which workflow code, zigflow's included, logs through) is filtered to warnings
// and above; its default logs every workflow task at debug.
func ClientOptions(address, namespace, identity string) client.Options {
	return client.Options{
		HostPort:  address,
		Namespace: namespace,
		Identity:  identity,
		Logger:    sdklog.NewStructuredLogger(slog.New(slog.NewTextHandler(os.Stderr, &slog.HandlerOptions{Level: slog.LevelWarn}))),
		ContextPropagators: []workflow.ContextPropagator{
			dslhash.NewPropagator(),
			ctxpropagator.NewContextPropagator(),
		},
	}
}

func NewLazyClient(address string) *LazyClient {
	return NewLazyClientWithOptions(ClientOptions(address, "", ""))
}

func NewLazyClientWithOptions(options client.Options) *LazyClient {
	return &LazyClient{options: options}
}

// NewStaticClient wraps an already-connected client instead of dialing one — how tests stand a
// fake Temporal in for the real thing.
func NewStaticClient(c client.Client) *LazyClient {
	return &LazyClient{client: c}
}

func (l *LazyClient) Get() (client.Client, error) {
	l.mu.Lock()
	defer l.mu.Unlock()

	if l.client != nil {
		return l.client, nil
	}

	c, err := client.Dial(l.options)
	if err != nil {
		return nil, fmt.Errorf("connecting to temporal at %s: %w", l.options.HostPort, err)
	}
	l.client = c
	return c, nil
}

func (l *LazyClient) Close() {
	l.mu.Lock()
	defer l.mu.Unlock()

	if l.client != nil {
		l.client.Close()
		l.client = nil
	}
}
