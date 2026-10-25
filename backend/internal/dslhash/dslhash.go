// Package dslhash names a saved DSL version by the SHA-256 of its text and carries that name with
// a run, in a Temporal header, so every task of the run executes the DSL it started with.
//
// It is a leaf package on purpose: both the Temporal client wiring (temporalexec) and the worker
// pool (dslruntime) install its propagator, and neither may import the other.
package dslhash

import (
	"context"
	"crypto/sha256"
	"encoding/hex"

	"go.temporal.io/sdk/converter"
	"go.temporal.io/sdk/workflow"
)

// HeaderKey is the Temporal header that carries the DSL hash from a run's starter (the API, a
// schedule, or a parent workflow) to its workflow tasks, child workflows and activities.
const HeaderKey = "duraflow-dsl-hash"

type contextKey struct{}

// Of returns the version name of a DSL text.
func Of(dsl string) string {
	sum := sha256.Sum256([]byte(dsl))
	return hex.EncodeToString(sum[:])
}

// With returns a context whose Temporal calls (start workflow, create schedule) pin the run to hash.
// An empty hash leaves ctx unchanged, so nothing is pinned.
func With(ctx context.Context, hash string) context.Context {
	if hash == "" {
		return ctx
	}
	return context.WithValue(ctx, contextKey{}, hash)
}

// From returns the hash carried by ctx, or "" when there is none.
func From(ctx context.Context) string {
	hash, _ := ctx.Value(contextKey{}).(string)
	return hash
}

// WithWorkflow is With for workflow code: child workflows, activities and continue-as-new started
// from the returned context carry hash.
func WithWorkflow(ctx workflow.Context, hash string) workflow.Context {
	if hash == "" {
		return ctx
	}
	return workflow.WithValue(ctx, contextKey{}, hash)
}

// FromWorkflow returns the hash carried by a workflow context, or "".
func FromWorkflow(ctx workflow.Context) string {
	hash, _ := ctx.Value(contextKey{}).(string)
	return hash
}

// NewPropagator returns the context propagator that moves the hash in and out of Temporal headers.
// Install it on every Temporal client duraflow creates.
func NewPropagator() workflow.ContextPropagator {
	return propagator{}
}

type propagator struct{}

func (propagator) Inject(ctx context.Context, writer workflow.HeaderWriter) error {
	return write(From(ctx), writer)
}

func (propagator) InjectFromWorkflow(ctx workflow.Context, writer workflow.HeaderWriter) error {
	return write(FromWorkflow(ctx), writer)
}

func (propagator) Extract(ctx context.Context, reader workflow.HeaderReader) (context.Context, error) {
	hash, err := read(reader)
	if err != nil {
		return ctx, err
	}
	return With(ctx, hash), nil
}

func (propagator) ExtractToWorkflow(ctx workflow.Context, reader workflow.HeaderReader) (workflow.Context, error) {
	hash, err := read(reader)
	if err != nil {
		return ctx, err
	}
	return WithWorkflow(ctx, hash), nil
}

// write sets the header only when there is a hash, so an unpinned start stays unpinned instead of
// carrying an empty value.
func write(hash string, writer workflow.HeaderWriter) error {
	if hash == "" {
		return nil
	}
	payload, err := converter.GetDefaultDataConverter().ToPayload(hash)
	if err != nil {
		return err
	}
	writer.Set(HeaderKey, payload)
	return nil
}

func read(reader workflow.HeaderReader) (string, error) {
	payload, ok := reader.Get(HeaderKey)
	if !ok {
		return "", nil
	}
	var hash string
	if err := converter.GetDefaultDataConverter().FromPayload(payload, &hash); err != nil {
		return "", err
	}
	return hash, nil
}
