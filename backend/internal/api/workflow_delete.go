package api

import (
	"context"
	"fmt"

	"gorm.io/gorm"

	"duraflow/backend/internal/models"
)

// Deleting a workflow removes everything that only exists because of it: its runs (each as a whole
// tree, with its event log and Temporal history — see deleteExecutionTrees), its schedules, its
// worker process and DSL files, and its row on the Workers page. A run still in progress is
// terminated rather than refused, since the worker it runs on is being stopped anyway. Deleting a
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
		if err := tx.Where("workflow_id = ?", workflow.ID).Delete(&models.Schedule{}).Error; err != nil {
			return fmt.Errorf("deleting schedules: %w", err)
		}
		if err := tx.Delete(&models.Workflow{}, "id = ?", workflow.ID).Error; err != nil {
			return fmt.Errorf("deleting workflow: %w", err)
		}
		return nil
	})
	if err != nil {
		return err
	}

	removeWorkerRegistration(deps, ctx, workflow)
	return nil
}

// removeWorkerRegistration stops a deleted workflow's worker and drops its Workers-page row — unlike
// stopWorkerRegistration, which leaves an offline row for a workflow that still exists. Rows are
// keyed by workflow name and task queue, so one still used by another workflow is kept.
func removeWorkerRegistration(deps *Deps, ctx context.Context, workflow models.Workflow) {
	deps.Workers.Stop(workflow.ID)

	taskQueue, _, err := parseDSLHeader(workflow.DSL)
	if err != nil || taskQueue == "" {
		return
	}
	var sharing int64
	deps.DB.WithContext(ctx).Model(&models.Workflow{}).
		Where("name = ? AND task_queue = ?", workflow.Name, taskQueue).Count(&sharing)
	if sharing > 0 {
		return
	}
	_ = deps.DB.WithContext(ctx).
		Where("identity = ? AND task_queue = ?", workflow.Name, taskQueue).
		Delete(&models.Worker{}).Error
}
