Create the workflow builder at /projects/[projectId]/workflows/[workflowId]/builder/+page.svelte using SvelteFlow.

Requirements:
- Left sidebar node palette (all Zigflow task types + ChildWorkflow node)
- Drag & drop canvas
- Custom node components for each task type
- Node inspector (right sidebar)
- Toolbar (Save, Validate, Export YAML, Run, Schedule)
- Support for child workflow navigation
- Import / Export full YAML (including children)
- Use $state.raw for nodes and edges