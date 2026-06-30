# Claude Prompts for DuraFlow - Durable Workflow Builder

**Project Overview**  
A visual workflow builder built with **SvelteKit + Svelte 5 Runes**, using **SvelteFlow** for the canvas and **Zigflow DSL** (on top of Temporal.io) for the backend execution.

---

## 1. High-Level Project Setup Prompt (Use this FIRST)

```prompt
You are an expert full-stack Svelte developer specializing in Svelte 5 (runes syntax), SvelteKit (latest version), SvelteFlow (@xyflow/svelte), DaisyUI + Tailwind, and Lucide icons (@lucide/svelte). Build a professional Workflow Builder called "DuraFlow".

Core tech stack:
- SvelteKit with Svelte 5 runes ($state, $derived, $effect, $props, etc.)
- SvelteFlow for the node-based workflow editor (use latest version with runes support: nodes/edges as $state.raw)
- DaisyUI for components + Tailwind
- Lucide icons
- TypeScript
- Assume a backend REST API (you will suggest best-practice specs)
- You have to support both light and dark theme.
- I wanted to follow flat UI style

App structure:
- Login page (This app will have different kinds of user roles like designer who designs the flows, admin, business user - who can only see dashboards and end output)
- Landing/Dashboard (projects)
- Project detail (list of workflows)
- Workflow Builder (main canvas with Zigflow nodes)
- Worker status page
- Scheduling page
- Executions / Runs history (with data inspection and child workflow navigation)

Key requirements:
- Support hierarchical/child workflows
- Import/Export full workflows (including children) as YAML
- Nodes: Task, Call, Do, For, Fork, Listen, Raise, Run, Set, Switch, Try, Wait, ChildWorkflow
- Use latest Svelte 5 runes syntax everywhere
- Clean, modern UI with DaisyUI

First, output:
- Full project setup commands (SvelteKit + Tailwind + DaisyUI + SvelteFlow + Lucide)
- Recommended folder structure
- Global TypeScript types (Project, Workflow, Node, Execution, etc.)
- Suggested REST API specs (endpoints with examples) for auth, projects, workflows, executions, workers, etc.
- Reusable components plan

You can refer zigflow documentation or MCP:
- https://zigflow.dev/docs/dsl/tasks/intro
- https://zigflow.dev/docs/dsl/tasks/call
- https://zigflow.dev/docs/dsl/tasks/do
- https://zigflow.dev/docs/dsl/tasks/for
- https://zigflow.dev/docs/dsl/tasks/fork
- https://zigflow.dev/docs/dsl/tasks/listen
- https://zigflow.dev/docs/dsl/tasks/raise
- https://zigflow.dev/docs/dsl/tasks/run
- https://zigflow.dev/docs/dsl/tasks/set
- https://zigflow.dev/docs/dsl/tasks/switch
- https://zigflow.dev/docs/dsl/tasks/try
- https://zigflow.dev/docs/dsl/tasks/wait
- https://zigflow.dev/docs/concepts/glossary/#child-workflow

Wait for my confirmation before creating individual pages.