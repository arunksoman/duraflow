package coord

import (
	"context"
	"database/sql"
	"database/sql/driver"
	"fmt"
	"log"
	"sync"
	"time"

	"github.com/jackc/pgx/v5"
)

// Advisory-lock key classes. Postgres' two-key advisory locks keep these apart from any lock
// another application takes on the same database with the one-key form.
const (
	lockClassLeader int32 = 0x44460001 // "DF" + 1: the jobs leader
	lockClassKeyed  int32 = 0x44460002 // "DF" + 2: Locker keys, hashed with hashtext()
	leaderKey       int32 = 1
)

const (
	reconnectMin  = time.Second
	reconnectMax  = 30 * time.Second
	leaderRetry   = 5 * time.Second
	leaderPing    = 5 * time.Second
	leaderPingMax = 3 * time.Second
)

// Postgres implements Notifier, Elector and Locker on one database. Notify and Lock use the shared
// connection pool; LISTEN and the leader lock each hold one dedicated connection, because both are
// tied to a session.
type Postgres struct {
	dsn string
	db  *sql.DB

	mu        sync.RWMutex
	handlers  map[string][]func(string)
	reconnect []func()
	started   bool
}

func NewPostgres(dsn string, db *sql.DB) *Postgres {
	return &Postgres{dsn: dsn, db: db, handlers: map[string][]func(string){}}
}

func (p *Postgres) Notify(ctx context.Context, channel, payload string) error {
	_, err := p.db.ExecContext(ctx, "SELECT pg_notify($1, $2)", channel, payload)
	return err
}

// Listen must be called before Start.
func (p *Postgres) Listen(channel string, handler func(string)) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.started {
		panic("coord: Listen called after Start")
	}
	p.handlers[channel] = append(p.handlers[channel], handler)
}

func (p *Postgres) OnReconnect(handler func()) {
	p.mu.Lock()
	defer p.mu.Unlock()
	p.reconnect = append(p.reconnect, handler)
}

// Start runs the LISTEN loop until ctx is done, reconnecting with backoff.
func (p *Postgres) Start(ctx context.Context) {
	p.mu.Lock()
	p.started = true
	channels := make([]string, 0, len(p.handlers))
	for ch := range p.handlers {
		channels = append(channels, ch)
	}
	p.mu.Unlock()
	if len(channels) == 0 {
		return
	}

	go func() {
		backoff := reconnectMin
		connectedBefore := false
		for ctx.Err() == nil {
			err := p.listen(ctx, channels, func() {
				backoff = reconnectMin
				if connectedBefore {
					p.mu.RLock()
					handlers := append([]func(){}, p.reconnect...)
					p.mu.RUnlock()
					for _, h := range handlers {
						h()
					}
				}
				connectedBefore = true
			})
			if ctx.Err() != nil {
				return
			}
			log.Printf("[coord] LISTEN connection lost, reconnecting in %s: %v", backoff, err)
			select {
			case <-ctx.Done():
				return
			case <-time.After(backoff):
			}
			backoff = min(backoff*2, reconnectMax)
		}
	}()
}

func (p *Postgres) listen(ctx context.Context, channels []string, connected func()) error {
	conn, err := pgx.Connect(ctx, p.dsn)
	if err != nil {
		return err
	}
	defer conn.Close(context.Background())

	for _, ch := range channels {
		if _, err := conn.Exec(ctx, "LISTEN "+pgx.Identifier{ch}.Sanitize()); err != nil {
			return fmt.Errorf("LISTEN %s: %w", ch, err)
		}
	}
	connected()

	for {
		n, err := conn.WaitForNotification(ctx)
		if err != nil {
			return err
		}
		p.mu.RLock()
		handlers := p.handlers[n.Channel]
		p.mu.RUnlock()
		for _, h := range handlers {
			h(n.Payload)
		}
	}
}

// Run competes for the leader lock. The lock lives on a dedicated session, so it is released the
// moment that session ends, and the leader pings it so a dead connection ends leadership too.
func (p *Postgres) Run(ctx context.Context, lead func(ctx context.Context)) {
	for ctx.Err() == nil {
		p.tryLead(ctx, lead)
		select {
		case <-ctx.Done():
			return
		case <-time.After(leaderRetry):
		}
	}
}

func (p *Postgres) tryLead(ctx context.Context, lead func(ctx context.Context)) {
	conn, err := pgx.Connect(ctx, p.dsn)
	if err != nil {
		log.Printf("[coord] leader election: %v", err)
		return
	}
	defer conn.Close(context.Background())

	var acquired bool
	if err := conn.QueryRow(ctx, "SELECT pg_try_advisory_lock($1, $2)", lockClassLeader, leaderKey).
		Scan(&acquired); err != nil {
		log.Printf("[coord] leader election: %v", err)
		return
	}
	if !acquired {
		return
	}

	log.Printf("[coord] this copy is now the jobs leader")
	leadCtx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	go func() {
		defer close(done)
		lead(leadCtx)
	}()

	ticker := time.NewTicker(leaderPing)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			cancel()
			<-done
			return
		case <-done:
			cancel()
			return
		case <-ticker.C:
			pingCtx, pingCancel := context.WithTimeout(ctx, leaderPingMax)
			err := conn.Ping(pingCtx)
			pingCancel()
			if err != nil {
				log.Printf("[coord] lost the leader lock connection: %v", err)
				cancel()
				<-done
				return
			}
		}
	}
}

// Lock takes a session advisory lock on a connection pinned for the lock's lifetime.
func (p *Postgres) Lock(ctx context.Context, key string) (func(), error) {
	conn, err := p.db.Conn(ctx)
	if err != nil {
		return nil, err
	}
	if _, err := conn.ExecContext(ctx, "SELECT pg_advisory_lock($1, hashtext($2))", lockClassKeyed, key); err != nil {
		_ = conn.Close()
		return nil, err
	}
	return func() {
		unlockCtx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		defer cancel()
		if _, err := conn.ExecContext(unlockCtx, "SELECT pg_advisory_unlock($1, hashtext($2))", lockClassKeyed, key); err != nil {
			log.Printf("[coord] releasing lock %q: %v", key, err)
			// Closing a pooled connection does not end its session, so make sure it is discarded.
			_ = conn.Raw(func(any) error { return driver.ErrBadConn })
		}
		_ = conn.Close()
	}, nil
}
