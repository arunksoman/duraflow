package dslruntime

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"duraflow/backend/internal/dslhash"
)

const forkDSL = `document:
  dsl: 1.0.0
  taskQueue: pool-test
  workflowType: greet
  version: 0.0.1
do:
  - hello:
      set:
        message: ${ "hi " + $input.name }
  - parallel:
      fork:
        compete: false
        branches:
          - left:
              set:
                side: left
          - right:
              set:
                side: right
  - done:
      set:
        message: ${ $data.message }
`

func testEnv(t *testing.T) *Env {
	t.Helper()
	env, err := NewEnv()
	if err != nil {
		t.Fatal(err)
	}
	return env
}

func TestCompileRegistersEveryWorkflowTheDocumentDefines(t *testing.T) {
	build, err := Compile(forkDSL, testEnv(t))
	if err != nil {
		t.Fatalf("compile: %v", err)
	}
	if build.Hash != dslhash.Of(forkDSL) {
		t.Fatalf("hash = %s, want the DSL's SHA-256", build.Hash)
	}
	if build.TaskQueue != "pool-test" || build.WorkflowType != "greet" {
		t.Fatalf("header = %q/%q", build.TaskQueue, build.WorkflowType)
	}
	if _, ok := build.Workflow("greet"); !ok {
		t.Fatalf("document workflow not registered; got %v", build.WorkflowNames())
	}
	if len(build.WorkflowNames()) < 2 {
		t.Fatalf("expected the fork branches to register child workflows, got %v", build.WorkflowNames())
	}
}

func TestCompileExampleDSLs(t *testing.T) {
	for _, name := range []string{"basic.yaml", "switch.yaml"} {
		t.Run(name, func(t *testing.T) {
			raw, err := os.ReadFile(filepath.Join("..", "..", "..", "example", name))
			if err != nil {
				t.Skipf("example not available: %v", err)
			}
			build, err := Compile(string(raw), testEnv(t))
			if err != nil {
				t.Fatalf("compile: %v", err)
			}
			if _, ok := build.Workflow(build.WorkflowType); !ok {
				t.Fatalf("document workflow %q missing from %v", build.WorkflowType, build.WorkflowNames())
			}
		})
	}
}

func TestCompileKeepsBuildsIndependent(t *testing.T) {
	// Two versions of one workflow register activities under the same per-task names. zigflow's
	// global "already registered" map must not make the second build skip them.
	const v1 = `document:
  dsl: 1.0.0
  taskQueue: pool-test
  workflowType: fetch
  version: 0.0.1
do:
  - get:
      call: http
      with:
        method: get
        endpoint: https://example.com/one
`
	v2 := v1[:len(v1)-len("one\n")] + "two\n"
	env := testEnv(t)
	first, err := Compile(v1, env)
	if err != nil {
		t.Fatal(err)
	}
	second, err := Compile(v2, env)
	if err != nil {
		t.Fatal(err)
	}
	if len(first.activities) == 0 || len(second.activities) == 0 {
		t.Fatalf("activities: first %d, second %d — the second build skipped registration",
			len(first.activities), len(second.activities))
	}
	if first.Hash == second.Hash {
		t.Fatal("different DSLs produced one hash")
	}
}

func TestCompileRejectsBadDSL(t *testing.T) {
	env := testEnv(t)
	if _, err := Compile("   \n", env); !errors.Is(err, ErrBlankDSL) {
		t.Fatalf("blank DSL: err = %v, want ErrBlankDSL", err)
	}
	var compileErr *CompileError
	if _, err := Compile("document: {dsl: 1.0.0}\ndo: []\n", env); !errors.As(err, &compileErr) {
		t.Fatalf("invalid DSL: err = %v, want *CompileError", err)
	}
	if _, err := Compile("{{{", env); !errors.As(err, &compileErr) {
		t.Fatalf("unparseable DSL: err = %v, want *CompileError", err)
	}
}

type mapStore map[string]string

func (m mapStore) LoadDSL(_ context.Context, hash string) (string, error) {
	dsl, ok := m[hash]
	if !ok {
		return "", ErrVersionNotFound
	}
	return dsl, nil
}

func TestCacheLoadsMissingVersionsOnce(t *testing.T) {
	hash := dslhash.Of(forkDSL)
	cache := NewCache(testEnv(t), mapStore{hash: forkDSL}, 2)

	first, err := cache.Get(context.Background(), hash)
	if err != nil {
		t.Fatal(err)
	}
	second, err := cache.Get(context.Background(), hash)
	if err != nil {
		t.Fatal(err)
	}
	if first != second {
		t.Fatal("a cached version was compiled twice")
	}
	if _, err := cache.Get(context.Background(), "missing"); !errors.Is(err, ErrVersionNotFound) {
		t.Fatalf("missing version: err = %v", err)
	}
}
