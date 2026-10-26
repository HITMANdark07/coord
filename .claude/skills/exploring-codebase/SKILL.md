---
name: exploring-codebase
description: "Use for any structural question about the codebase — who calls X, what extends Y, where is Z used, what handles route foo. Routes through the graph instead of grep or file reads."
---

# Exploring the Codebase

## Overview

Structural questions about a codebase have a single right answer that can be derived from the graph. Grep gives string matches; file reads give whatever happens to live in the file you opened. The graph carries the actual edges — calls, imports, extends, annotations, parent-child — and resolves them faster and more accurately than text search.

This skill calls the `query_graph`, `find_node`, and `trace_flow` MCP tools.

## When to use

Any question about relationships in code:

- **Callers / callees** — who calls X? what does X call?
- **Class hierarchy** — what extends Y? what does Y extend?
- **Imports** — who imports module Z? what does Z import?
- **Annotations** — what is annotated with `Controller`? what annotations does this class carry?
- **Routes / endpoints / handlers** — what handles route `/foo`? what middleware runs on it?
- **Flows** — what runs when this endpoint is hit? what's in the call chain from request to response?
- **Where is X used** — every reference to X across the repo

If the answer requires walking edges, use this skill. If it requires reading a function body to interpret what code does, you may need to fall back to file reads, but only AFTER querying the graph for the names and locations.

## Tool selection

The three tools cover different shapes of question. Pick the right one first.

### `query_graph` — search by name or partial phrase

Use first, almost always. Returns ranked hits with 1-hop neighbors (callers, callees, parent class, declared annotations).

Good for:
- "Who calls `processPayment`?"
- "Where is `User` used?"
- "Find anything related to billing reconciliation"
- "What extends `BaseHandler`?"

The query takes a name or phrase. Hits include `qualified_name`, `file`, `line`, plus immediate neighbors. Cite `file:line` from the result when answering the user.

### `find_node` — resolve a specific qualified_name

Use when you already have a fully-qualified handle and just need its file:line and direct edges. Faster than `query_graph` when the input is exact.

Good for:
- Confirming a symbol exists at the path the user mentioned
- Following up on a `query_graph` hit to grab one more hop of context
- Verifying a symbol referenced in a plan is still in the codebase

### `trace_flow` — multi-hop call traversal

Use when the question is about an end-to-end flow: "what runs from A to B." Returns the chain of calls with the annotations on each step (so you can see middlewares, guards, decorators applied along the path).

Good for:
- "What runs when a POST to `/reports/summary` arrives?"
- "Trace from controller method down to the database call"
- "What's the call chain from this hook firing?"

The output is a path. Each step is a node with file:line and any annotations on it. Use this when middlewares matter — `query_graph` can find the entry but won't show you the cross-cutting concerns applied in between.

## Procedure

1. **Parse the user's question.** Extract the noun phrases and the relationship type (caller, callee, extends, handler-of, etc.).
2. **Pick a tool.** Default to `query_graph`. Use `find_node` if you have an exact qualified_name. Use `trace_flow` for multi-hop flows.
3. **Run the query.** Capture every hit, including its `file:line`.
4. **Answer with citations.** Every claim about the code should carry a `file:line` so the user can navigate. "The `/reports/summary` endpoint is handled by `ReportsController.summary` at `src/controllers/reports.ext:42`." Plain prose with citations beats prose without.
5. **Fall back to file reads only when needed.** The graph carries names, locations, edges. It does NOT carry function bodies, comments, or formatting. If the user asks "what does `processPayment` actually do," you query the graph for the location, then `Read` the file at that location to see the body. Don't read the file before knowing where to read.

## Anti-patterns

**Grep first, graph second.** Wrong order. Grep gives string matches that include comments, strings, irrelevant occurrences. The graph gives semantic edges. Start with the graph.

**Read a directory tree to "get oriented."** Slow and noisy. Run `query_graph` on the noun phrase from the user's question instead. Two seconds, ranked results.

**Answer without citations.** "I think it's in the controllers folder" is not an answer. "It's at `src/controllers/reports.ext:42`" is.

**Use `trace_flow` for a single-hop question.** Overkill. `query_graph` returns the single hop directly with less ceremony. Reserve `trace_flow` for the genuinely multi-hop cases.

**Skip the graph because the question feels small.** "Where is the User type defined?" goes through `query_graph` just like the bigger questions. The cost is the same; the answer is more reliable.

## When the graph doesn't have the answer

Some questions can't be answered from edges alone:
- "Why is this code written this way?" — usually requires the function body, comments, or git history.
- "Is this safe?" — semantic judgment, not a graph query.
- "How fast is this?" — needs profiling, not graph traversal.

For these, the graph still helps you locate the relevant code, but you'll need to read the body or check other sources. Use the graph to find the where; use file reads or other tools to interpret the what.

## Pairing with `filing-knowledge`

After you answer a non-trivial structural question — one that took multiple graph queries, or revealed a pattern the user didn't know about — consider proposing it to the `filing-knowledge` skill. The next session shouldn't have to re-derive the answer; it should look it up in `.neatcode/memory/`.
