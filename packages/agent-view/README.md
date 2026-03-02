# @petri/agent-view

Lightweight React helpers around `@copilotkit/react-core`.

This package provides `useFrontendTools`, a small hook that:

- registers multiple CopilotKit frontend tools in one place
- tracks running tool calls and last call result
- exposes a `runTool(name, args)` helper for manual invocation

## Install (workspace)

```bash
npx pnpm --filter @petri/agent-view install
```

## Quick usage

```tsx
import { useMemo } from "react";
import { useFrontendTools, type FrontendToolDefinition } from "@petri/agent-view";

const tools = useMemo<FrontendToolDefinition[]>(
  () => [
    {
      name: "sum_numbers",
      description: "Add two numbers",
      parameters: [
        { name: "a", type: "number", required: true },
        { name: "b", type: "number", required: true },
      ],
      handler: async ({ a, b }) => Number(a) + Number(b),
    },
  ],
  [],
);

const { runTool, isRunning, activeTools, lastCall, error } = useFrontendTools({
  tools,
});
```

## Hook return value

- `runTool(name, args)`: run one tool handler manually
- `isRunning` and `activeTools`: current running state
- `lastCall`: last call snapshot (success/failure, args, result/error)
- `error`: last call error
- `reset()`: clear `lastCall` and `error`

## Important constraint

`tools` length and order must stay stable after first render.
Use `useMemo` for the `tools` array.

## Example

See `examples/basic-next` for a Next.js App Router demo:

```bash
npx pnpm --filter @petri/agent-view-example dev
```
