package dslruntime

import (
	"container/list"
	"context"
	"errors"
	"fmt"
	"sync"
)

// ErrVersionNotFound means no DSL is stored under a hash. A run pinned to such a hash can never
// make progress, so the dispatcher fails it rather than retrying forever.
var ErrVersionNotFound = errors.New("no DSL version is stored under this hash")

// Store loads DSL text by hash. Implemented over the dsl_versions table by DBStore.
type Store interface {
	LoadDSL(ctx context.Context, hash string) (string, error)
}

// Cache holds compiled builds by hash, so a version is compiled at most once per process while it
// stays in use. Builds are small (closures over a parsed document), and eviction only costs a
// rebuild on the next task that needs the version.
type Cache struct {
	env   *Env
	store Store
	max   int

	mu       sync.Mutex
	entries  map[string]*list.Element
	order    *list.List // front = most recently used; values are *Build
	inflight map[string]*pendingBuild
}

type pendingBuild struct {
	done  chan struct{}
	build *Build
	err   error
}

// NewCache returns a cache that compiles with env and loads missing versions from store. max <= 0
// means 512 builds.
func NewCache(env *Env, store Store, max int) *Cache {
	if max <= 0 {
		max = 512
	}
	return &Cache{
		env:      env,
		store:    store,
		max:      max,
		entries:  map[string]*list.Element{},
		order:    list.New(),
		inflight: map[string]*pendingBuild{},
	}
}

// Env returns the build environment this cache compiles with.
func (c *Cache) Env() *Env { return c.env }

// Compile builds a DSL and keeps the result, so the first run after a save does not rebuild it.
func (c *Cache) Compile(dsl string) (*Build, error) {
	build, err := Compile(dsl, c.env)
	if err != nil {
		return nil, err
	}
	c.Put(build)
	return build, nil
}

// Put stores a build.
func (c *Cache) Put(build *Build) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.putLocked(build)
}

// Peek returns a cached build without loading anything.
func (c *Cache) Peek(hash string) (*Build, bool) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if el, ok := c.entries[hash]; ok {
		c.order.MoveToFront(el)
		return el.Value.(*Build), true
	}
	return nil, false
}

// Get returns the build for hash, loading and compiling it on a miss. Concurrent misses for the
// same hash share one load. Errors are ErrVersionNotFound, a *CompileError, or a store error (the
// only kind worth retrying).
func (c *Cache) Get(ctx context.Context, hash string) (*Build, error) {
	if hash == "" {
		return nil, ErrVersionNotFound
	}

	c.mu.Lock()
	if el, ok := c.entries[hash]; ok {
		c.order.MoveToFront(el)
		c.mu.Unlock()
		return el.Value.(*Build), nil
	}
	if p, ok := c.inflight[hash]; ok {
		c.mu.Unlock()
		select {
		case <-p.done:
			return p.build, p.err
		case <-ctx.Done():
			return nil, ctx.Err()
		}
	}
	p := &pendingBuild{done: make(chan struct{})}
	c.inflight[hash] = p
	c.mu.Unlock()

	p.build, p.err = c.load(ctx, hash)

	c.mu.Lock()
	delete(c.inflight, hash)
	if p.err == nil {
		c.putLocked(p.build)
	}
	c.mu.Unlock()
	close(p.done)
	return p.build, p.err
}

func (c *Cache) load(ctx context.Context, hash string) (*Build, error) {
	dsl, err := c.store.LoadDSL(ctx, hash)
	if err != nil {
		return nil, err
	}
	build, err := Compile(dsl, c.env)
	if err != nil {
		if errors.Is(err, ErrBlankDSL) {
			return nil, ErrVersionNotFound
		}
		return nil, err
	}
	if build.Hash != hash {
		return nil, fmt.Errorf("stored DSL for %s hashes to %s", hash, build.Hash)
	}
	return build, nil
}

func (c *Cache) putLocked(build *Build) {
	if el, ok := c.entries[build.Hash]; ok {
		el.Value = build
		c.order.MoveToFront(el)
		return
	}
	c.entries[build.Hash] = c.order.PushFront(build)
	for c.order.Len() > c.max {
		oldest := c.order.Back()
		c.order.Remove(oldest)
		delete(c.entries, oldest.Value.(*Build).Hash)
	}
}
