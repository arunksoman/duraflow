package coord

import (
	"context"
	"database/sql"
	"os"
	"sync/atomic"
	"testing"
	"time"

	_ "github.com/jackc/pgx/v5/stdlib"
)

// These tests need a Postgres server: DURAFLOW_TEST_POSTGRES=postgres://user:pass@host:port/db
func testPostgres(t *testing.T) *Postgres {
	t.Helper()
	dsn := os.Getenv("DURAFLOW_TEST_POSTGRES")
	if dsn == "" {
		t.Skip("DURAFLOW_TEST_POSTGRES is not set")
	}
	db, err := sql.Open("pgx", dsn)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = db.Close() })
	return NewPostgres(dsn, db)
}

func TestPostgresNotifyReachesEveryCopy(t *testing.T) {
	a, b := testPostgres(t), testPostgres(t)
	gotA, gotB := make(chan string, 1), make(chan string, 1)
	a.Listen("duraflow_test", func(p string) { gotA <- p })
	b.Listen("duraflow_test", func(p string) { gotB <- p })
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	a.Start(ctx)
	b.Start(ctx)
	time.Sleep(500 * time.Millisecond) // both LISTENs are in place

	if err := a.Notify(ctx, "duraflow_test", "hello"); err != nil {
		t.Fatal(err)
	}
	for name, ch := range map[string]chan string{"sender": gotA, "other copy": gotB} {
		select {
		case p := <-ch:
			if p != "hello" {
				t.Errorf("%s got %q", name, p)
			}
		case <-time.After(5 * time.Second):
			t.Errorf("%s never got the notification", name)
		}
	}
}

func TestPostgresElectsOneLeaderAndFailsOver(t *testing.T) {
	a, b := testPostgres(t), testPostgres(t)
	var leaders atomic.Int32
	var maxLeaders atomic.Int32
	led := make(chan string, 4)
	lead := func(name string) func(context.Context) {
		return func(ctx context.Context) {
			n := leaders.Add(1)
			for {
				m := maxLeaders.Load()
				if n <= m || maxLeaders.CompareAndSwap(m, n) {
					break
				}
			}
			led <- name
			<-ctx.Done()
			leaders.Add(-1)
		}
	}

	ctxA, cancelA := context.WithCancel(context.Background())
	ctxB, cancelB := context.WithCancel(context.Background())
	defer cancelB()
	go a.Run(ctxA, lead("a"))
	first := <-led
	go b.Run(ctxB, lead("b"))
	time.Sleep(2 * time.Second)
	if maxLeaders.Load() != 1 {
		t.Fatalf("%d copies led at once", maxLeaders.Load())
	}
	if first != "a" {
		t.Fatalf("expected a to lead first, got %s", first)
	}

	cancelA() // a's process goes away; its session ends and releases the lock
	select {
	case next := <-led:
		if next != "b" {
			t.Errorf("failover went to %s", next)
		}
	case <-time.After(20 * time.Second):
		t.Fatal("no copy took over leadership")
	}
	if maxLeaders.Load() != 1 {
		t.Errorf("%d copies led at once", maxLeaders.Load())
	}
}

func TestPostgresLockExcludesOtherCopies(t *testing.T) {
	a, b := testPostgres(t), testPostgres(t)
	ctx := context.Background()
	unlock, err := a.Lock(ctx, "workflow:x")
	if err != nil {
		t.Fatal(err)
	}

	acquired := make(chan func(), 1)
	go func() {
		u, err := b.Lock(ctx, "workflow:x")
		if err != nil {
			t.Error(err)
			return
		}
		acquired <- u
	}()
	select {
	case <-acquired:
		t.Fatal("a second copy took a held lock")
	case <-time.After(500 * time.Millisecond):
	}

	other, err := b.Lock(ctx, "workflow:y")
	if err != nil {
		t.Fatal(err)
	}
	other()

	unlock()
	select {
	case u := <-acquired:
		u()
	case <-time.After(5 * time.Second):
		t.Fatal("the lock was never released to the waiting copy")
	}
}

func TestMemoryLockHonoursContext(t *testing.T) {
	m := NewMemory()
	unlock, err := m.Lock(context.Background(), "k")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if _, err := m.Lock(ctx, "k"); err == nil {
		t.Fatal("took a held lock")
	}
	unlock()
	again, err := m.Lock(context.Background(), "k")
	if err != nil {
		t.Fatal(err)
	}
	again()
}
