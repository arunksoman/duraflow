package api

import (
	"context"
	"errors"
	"log"
	"net/http"
	"strings"
	"time"

	"github.com/danielgtaylor/huma/v2"
	commonpb "go.temporal.io/api/common/v1"
	"go.temporal.io/api/serviceerror"
	"go.temporal.io/api/workflowservice/v1"
	"go.temporal.io/sdk/client"
	"gorm.io/gorm"

	"duraflow/backend/internal/models"
)

// Deleting a run removes it completely: the Execution row, every child-workflow run it started,
// the recorded event timeline, the resolver's workflow-id cache, and (best-effort) Temporal's own
// history. A run is always deleted as a whole tree — a child run belongs to its root's timeline and
// can't be removed on its own.

type deleteExecutionInput struct {
	ID string `path:"id"`
	// Force terminates a still-running run in Temporal before deleting it.
	Force bool `query:"force"`
}

type deleteExecutionsInput struct {
	Body struct {
		IDs   []string `json:"ids" minItems:"1" maxItems:"500"`
		Force bool     `json:"force,omitempty"`
	}
}

type deleteExecutionsOutput struct {
	Body struct {
		Deleted int `json:"deleted"`
	}
}

var (
	errExecutionNotFound = errors.New("execution not found")
	errChildExecution    = errors.New("a child run can only be deleted with the run that started it")
	errStillRunning      = errors.New("run is still in progress — pass force to terminate and delete it")
)

// deleteExecutionTrees deletes each root run in ids along with everything it owns, returning how
// many root runs were deleted. It validates every id before touching anything, so a bad id in a
// bulk request deletes nothing.
func deleteExecutionTrees(ctx context.Context, deps *Deps, ids []string, force bool) (int, error) {
	var roots []models.Execution
	if err := deps.DB.WithContext(ctx).Where("id IN ?", ids).Find(&roots).Error; err != nil {
		return 0, err
	}
	if len(roots) != len(uniqueStrings(ids)) {
		return 0, errExecutionNotFound
	}

	rootIDs := make([]string, len(roots))
	for i, root := range roots {
		if root.ParentExecutionID != nil {
			return 0, errChildExecution
		}
		if root.Status == models.ExecutionRunning && !force {
			return 0, errStillRunning
		}
		rootIDs[i] = root.ID
	}

	// Everything belonging to these trees: child runs, and the synthetic for/fork/try workflows the
	// resolver recorded. Their Temporal ids are needed after the rows are gone.
	var tree []models.Execution
	if err := deps.DB.WithContext(ctx).Select("id", "temporal_run_id", "status").
		Where("id IN ? OR root_execution_id IN ?", rootIDs, rootIDs).Find(&tree).Error; err != nil {
		return 0, err
	}
	var refs []models.WorkflowExecutionRef
	if err := deps.DB.WithContext(ctx).Where("root_execution_id IN ?", rootIDs).Find(&refs).Error; err != nil {
		return 0, err
	}

	temporalClient, temporalErr := deps.Temporal.Get()

	// Stop running roots first, or the worker keeps emitting events into rows that no longer exist.
	// Temporal's default parent-close policy terminates their child workflows along with them.
	if temporalErr == nil {
		for _, root := range roots {
			if root.Status != models.ExecutionRunning {
				continue
			}
			err := temporalClient.TerminateWorkflow(ctx, root.ID, root.TemporalRunID, "deleted from DuraFlow")
			if err != nil && !isNotFound(err) {
				log.Printf("[execution:%s] terminating before delete: %v", root.ID, err)
			}
		}
	}

	treeIDs := make([]string, len(tree))
	for i, e := range tree {
		treeIDs[i] = e.ID
	}

	err := deps.DB.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		eventScope := tx.Where("execution_id IN ? OR root_execution_id IN ?", treeIDs, rootIDs)
		// Events the resolver hasn't attributed yet still carry their Temporal id; a root's own
		// id and its synthetic scopes' ids ("<root>_for_0") all share its prefix.
		for _, id := range rootIDs {
			eventScope = eventScope.Or(`execution_id = '' AND (workflow_execution_id = ? OR workflow_execution_id LIKE ? ESCAPE '\')`,
				id, escapeLike(id)+`\_%`)
		}
		if err := eventScope.Delete(&models.ExecutionEvent{}).Error; err != nil {
			return err
		}
		if err := tx.Where("root_execution_id IN ?", rootIDs).Delete(&models.WorkflowExecutionRef{}).Error; err != nil {
			return err
		}
		return tx.Where("id IN ?", treeIDs).Delete(&models.Execution{}).Error
	})
	if err != nil {
		return 0, err
	}

	deps.Resolver.Forget(rootIDs...)

	// Wake any open watch stream so it closes instead of waiting on a run that's gone.
	for _, id := range treeIDs {
		deps.Bus.Publish(id, models.ExecutionEvent{
			ExecutionID: id, WorkflowExecutionID: id, EventType: terminalMarkerEventType,
			OccurredAt: time.Now(), ReceivedAt: time.Now(),
		})
	}

	if temporalErr == nil {
		go purgeTemporalHistory(temporalClient, tree, refs)
	}
	return len(roots), nil
}

// purgeTemporalHistory removes the deleted runs' workflow histories from Temporal. Best-effort:
// a run already past Temporal's retention period is simply gone, and a failure here leaves only
// history nobody in DuraFlow can reach any more.
func purgeTemporalHistory(temporalClient client.Client, tree []models.Execution, refs []models.WorkflowExecutionRef) {
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()

	seen := make(map[string]struct{})
	targets := make([]*commonpb.WorkflowExecution, 0, len(tree)+len(refs))
	add := func(workflowID, runID string) {
		if _, dup := seen[workflowID]; dup || workflowID == "" {
			return
		}
		seen[workflowID] = struct{}{}
		targets = append(targets, &commonpb.WorkflowExecution{WorkflowId: workflowID, RunId: runID})
	}
	for _, e := range tree {
		add(e.ID, e.TemporalRunID)
	}
	for _, ref := range refs {
		add(ref.WorkflowExecutionID, ref.TemporalRunID)
	}

	for _, target := range targets {
		_, err := temporalClient.WorkflowService().DeleteWorkflowExecution(ctx, &workflowservice.DeleteWorkflowExecutionRequest{
			Namespace:         client.DefaultNamespace,
			WorkflowExecution: target,
		})
		if err != nil && !isNotFound(err) {
			log.Printf("[execution:%s] deleting Temporal history: %v", target.WorkflowId, err)
		}
	}
}

func deleteErrorToHuma(err error) error {
	switch {
	case errors.Is(err, errExecutionNotFound):
		return huma.Error404NotFound(err.Error())
	case errors.Is(err, errChildExecution):
		return huma.Error422UnprocessableEntity(err.Error())
	case errors.Is(err, errStillRunning):
		return huma.Error409Conflict(err.Error())
	default:
		return huma.Error500InternalServerError("failed to delete execution", err)
	}
}

func isNotFound(err error) bool {
	var notFound *serviceerror.NotFound
	return errors.As(err, &notFound)
}

func escapeLike(s string) string {
	return strings.NewReplacer(`\`, `\\`, `%`, `\%`, `_`, `\_`).Replace(s)
}

func uniqueStrings(values []string) []string {
	seen := make(map[string]struct{}, len(values))
	out := make([]string, 0, len(values))
	for _, v := range values {
		if _, dup := seen[v]; !dup {
			seen[v] = struct{}{}
			out = append(out, v)
		}
	}
	return out
}

func registerExecutionDeleteRoutes(api huma.API, deps *Deps, base string) {
	huma.Register(api, huma.Operation{
		OperationID:   "delete-execution",
		Method:        http.MethodDelete,
		Path:          base + "/executions/{id}",
		Summary:       "Delete a run, its child runs, its event log and its Temporal history",
		Tags:          []string{"Executions"},
		Security:      authSecurity(),
		DefaultStatus: http.StatusNoContent,
		Errors:        []int{404, 409, 422},
	}, func(ctx context.Context, in *deleteExecutionInput) (*struct{}, error) {
		if _, err := deleteExecutionTrees(ctx, deps, []string{in.ID}, in.Force); err != nil {
			return nil, deleteErrorToHuma(err)
		}
		return nil, nil
	})

	huma.Register(api, huma.Operation{
		OperationID: "delete-executions",
		Method:      http.MethodPost,
		Path:        base + "/executions/delete",
		Summary:     "Delete several runs at once — all or nothing",
		Tags:        []string{"Executions"},
		Security:    authSecurity(),
		Errors:      []int{404, 409, 422},
	}, func(ctx context.Context, in *deleteExecutionsInput) (*deleteExecutionsOutput, error) {
		deleted, err := deleteExecutionTrees(ctx, deps, in.Body.IDs, in.Body.Force)
		if err != nil {
			return nil, deleteErrorToHuma(err)
		}
		out := &deleteExecutionsOutput{}
		out.Body.Deleted = deleted
		return out, nil
	})
}
