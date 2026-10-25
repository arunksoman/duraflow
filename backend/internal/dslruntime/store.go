package dslruntime

import (
	"context"
	"errors"
	"sync"

	"gorm.io/gorm"

	"duraflow/backend/internal/models"
)

// DBStore reads DSL versions and workflow registrations from the shared database.
type DBStore struct {
	DB *gorm.DB
}

func (s DBStore) LoadDSL(ctx context.Context, hash string) (string, error) {
	var version models.DSLVersion
	err := s.DB.WithContext(ctx).Select("dsl").First(&version, "hash = ?", hash).Error
	if errors.Is(err, gorm.ErrRecordNotFound) {
		return "", ErrVersionNotFound
	}
	return version.DSL, err
}

// Directory answers "which DSL version currently defines workflow name N on task queue Q?" from
// memory, refreshed by the pool, with a database read on a miss. Its answers decide only which
// version a header-less run uses, or which version a `run: workflow` child is pinned to when it
// starts, so a few seconds of staleness after a save is harmless.
type Directory struct {
	db *gorm.DB

	mu      sync.RWMutex
	current map[registrationKey]string // -> current hash
}

type registrationKey struct {
	taskQueue string
	name      string
}

func NewDirectory(db *gorm.DB) *Directory {
	return &Directory{db: db, current: map[registrationKey]string{}}
}

// Lookup returns the current hash for a workflow name on a task queue. When two stored workflows
// register the same name on the same queue, the oldest wins, matching how runs were matched to
// workflows before versions existed.
func (d *Directory) Lookup(ctx context.Context, taskQueue, name string) (string, bool, error) {
	key := registrationKey{taskQueue: taskQueue, name: name}
	d.mu.RLock()
	hash, ok := d.current[key]
	d.mu.RUnlock()
	if ok {
		return hash, true, nil
	}

	var hashes []string
	err := d.db.WithContext(ctx).Table("workflow_registrations AS r").
		Select("w.current_hash").
		Joins("JOIN workflows w ON w.id = r.workflow_id").
		Where("r.task_queue = ? AND r.name = ? AND w.current_hash <> ''", taskQueue, name).
		Order("w.created_at").Limit(1).
		Pluck("w.current_hash", &hashes).Error
	if err != nil {
		return "", false, err
	}
	if len(hashes) == 0 {
		return "", false, nil
	}
	d.mu.Lock()
	d.current[key] = hashes[0]
	d.mu.Unlock()
	return hashes[0], true, nil
}

// Refresh reloads every registration in one query. Called by the pool on each refresh tick and
// whenever a workflow is saved.
func (d *Directory) Refresh(ctx context.Context) error {
	type row struct {
		TaskQueue   string
		Name        string
		CurrentHash string
	}
	var rows []row
	err := d.db.WithContext(ctx).Table("workflow_registrations AS r").
		Select("r.task_queue, r.name, w.current_hash").
		Joins("JOIN workflows w ON w.id = r.workflow_id").
		Where("w.current_hash <> ''").
		Order("w.created_at DESC").
		Scan(&rows).Error
	if err != nil {
		return err
	}
	next := make(map[registrationKey]string, len(rows))
	// Ordered newest first, so the oldest workflow's entry is written last and wins.
	for _, r := range rows {
		next[registrationKey{taskQueue: r.TaskQueue, name: r.Name}] = r.CurrentHash
	}
	d.mu.Lock()
	d.current = next
	d.mu.Unlock()
	return nil
}

// CurrentHashes returns the distinct current hashes the directory knows, for pre-warming builds.
func (d *Directory) CurrentHashes() []string {
	d.mu.RLock()
	defer d.mu.RUnlock()
	seen := map[string]struct{}{}
	out := []string{}
	for _, hash := range d.current {
		if _, ok := seen[hash]; !ok {
			seen[hash] = struct{}{}
			out = append(out, hash)
		}
	}
	return out
}
