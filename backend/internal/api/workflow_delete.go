package api

import (
	"context"
	"fmt"

	"gorm.io/gorm"

	"duraflow/backend/internal/models"
)

// Deleting a workflow removes everything that only exists because of it: its runs (each as a whole
// tree, with its event log and Temporal history — see deleteExecutionTrees), the Temporal schedule
// its DSL published, and its registered workflow names. A run still in progress is terminated
// rather than refused, since nothing could start its workflow again. Its DSL versions stay: they
// are immutable, shared by content with any workflow that has the same DSL, and tiny. Deleting a
// project does the same for every workflow in it.
//
// Child runs this workflow contributed to *another* workflow's run are left alone: they belong to
// that root run's timeline and go when it does.

// executionDeleteBatch keeps each deleteExecutionTrees call's IN (...) lists well inside database
// bind-parameter limits for workflows with a long run history.
const executionDeleteBatch = 500

func deleteWorkflowCascade(ctx context.Context, deps *Deps, workflow models.Workflow) error {
	var rootIDs []string
	if err := deps.DB.WithContext(ctx).Model(&models.Execution{}).
		Where("workflow_id = ? AND parent_execution_id IS NULL", workflow.ID).
		Pluck("id", &rootIDs).Error; err != nil {
		return fmt.Errorf("listing runs: %w", err)
	}
	for start := 0; start < len(rootIDs); start += executionDeleteBatch {
		end := min(start+executionDeleteBatch, len(rootIDs))
		if _, err := deleteExecutionTrees(ctx, deps, rootIDs[start:end], true); err != nil {
			return fmt.Errorf("deleting runs: %w", err)
		}
	}

	err := deps.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		if err := tx.Where("workflow_id = ?", workflow.ID).Delete(&models.WorkflowRegistration{}).Error; err != nil {
			return fmt.Errorf("deleting workflow registrations: %w", err)
		}
		if err := tx.Delete(&models.Workflow{}, "id = ?", workflow.ID).Error; err != nil {
			return fmt.Errorf("deleting workflow: %w", err)
		}
		return nil
	})
	if err != nil {
		return err
	}

	// Nothing would ever run what the schedule starts, so retract it. See workflow_schedule.go.
	dropWorkflowSchedule(ctx, deps, workflow.DSL)
	// Worker pools stop polling the workflow's task queue once nothing else uses it.
	deps.workflowsChanged()
	return nil
}
