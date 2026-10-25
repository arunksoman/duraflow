package api

import (
	"context"
	"log"

	"gorm.io/gorm"

	"duraflow/backend/internal/models"
)

// BackfillDSLVersions gives every stored workflow that has a DSL but no current version one: it
// compiles the DSL, stores the version and registrations, and republishes the schedule pinned to
// that version. It covers workflows saved before versions existed, and workflows whose DSL failed
// to build under an older zigflow. Run once at startup, by one copy at a time.
func BackfillDSLVersions(ctx context.Context, deps *Deps) {
	var workflows []models.Workflow
	if err := deps.DB.WithContext(ctx).Where("dsl <> '' AND (current_hash IS NULL OR current_hash = '')").
		Find(&workflows).Error; err != nil {
		log.Printf("[backfill] listing workflows without a DSL version: %v", err)
		return
	}
	built := 0
	for _, wf := range workflows {
		previousError := wf.DSLError
		build := compileWorkflowDSL(deps, &wf)
		if build == nil && wf.DSLError == previousError {
			continue // still the same failure; nothing to write
		}
		if err := deps.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
			return storeWorkflow(tx, &wf, build, false)
		}); err != nil {
			log.Printf("[backfill] storing workflow %s: %v", wf.ID, err)
			continue
		}
		if build != nil {
			built++
			publishWorkflowSchedule(ctx, deps, wf.DSL, wf, build)
		} else {
			log.Printf("[backfill] workflow %q (%s) does not build: %s", wf.Name, wf.ID, wf.DSLError)
		}
	}
	if built > 0 {
		log.Printf("[backfill] created DSL versions for %d workflow(s)", built)
		deps.workflowsChanged()
	}
}
