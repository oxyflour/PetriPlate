import { useCallback, useMemo, useState } from "react";
import { type FrontendAction, useFrontendTool } from "@copilotkit/react-core";

type FrontendToolParameters = FrontendAction<any>["parameters"];
type FrontendToolRenderer = FrontendAction<any>["render"];
type FrontendToolAvailability = "enabled" | "disabled";

export type FrontendToolHandler = (
  args: Record<string, unknown>,
) => unknown | Promise<unknown>;

export interface FrontendToolDefinition {
  name: string;
  description?: string;
  parameters?: FrontendToolParameters;
  available?: FrontendToolAvailability;
  followUp?: boolean;
  render?: FrontendToolRenderer;
  handler?: FrontendToolHandler;
}

export interface FrontendToolCallSnapshot {
  toolName: string;
  args: Record<string, unknown>;
  startedAt: number;
  endedAt: number;
  succeeded: boolean;
  result?: unknown;
  error?: unknown;
}

export interface UseFrontendToolsOptions {
  tools: FrontendToolDefinition[];
  dependencies?: readonly unknown[];
}

export interface UseFrontendToolsResult {
  activeTools: string[];
  isRunning: boolean;
  lastCall: FrontendToolCallSnapshot | null;
  error: unknown;
  runTool: (name: string, args?: Record<string, unknown>) => Promise<unknown>;
  reset: () => void;
}

function findDuplicateToolName(toolNames: string[]): string | undefined {
  const seen = new Set<string>();

  for (const toolName of toolNames) {
    if (seen.has(toolName)) {
      return toolName;
    }
    seen.add(toolName);
  }

  return undefined;
}

function assertStableToolOrder(
  initialToolNames: string[],
  tools: FrontendToolDefinition[],
): void {
  if (initialToolNames.length !== tools.length) {
    throw new Error(
      "useFrontendTools requires a stable tools array length after first render.",
    );
  }

  for (const [index, tool] of tools.entries()) {
    if (initialToolNames[index] !== tool.name) {
      throw new Error(
        "useFrontendTools requires stable tool order. Wrap your tools with useMemo().",
      );
    }
  }
}

function toSerializableError(error: unknown): unknown {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
    };
  }
  return error;
}

export function useFrontendTools(
  options: UseFrontendToolsOptions,
): UseFrontendToolsResult {
  const { tools, dependencies = [] } = options;

  const [initialToolNames] = useState(() => tools.map((tool) => tool.name));
  const duplicateToolName = useMemo(
    () => findDuplicateToolName(initialToolNames),
    [initialToolNames],
  );

  if (duplicateToolName) {
    throw new Error(`Duplicate tool name "${duplicateToolName}" is not allowed.`);
  }

  assertStableToolOrder(initialToolNames, tools);

  const toolsByName = useMemo(
    () => new Map(tools.map((tool) => [tool.name, tool])),
    [tools],
  );

  const [runningCounters, setRunningCounters] = useState<Record<string, number>>(
    {},
  );
  const [lastCall, setLastCall] = useState<FrontendToolCallSnapshot | null>(
    null,
  );
  const [error, setError] = useState<unknown>(null);

  const beginCall = useCallback((toolName: string) => {
    setRunningCounters((current) => {
      const next = { ...current };
      next[toolName] = (next[toolName] ?? 0) + 1;
      return next;
    });
  }, []);

  const finishCall = useCallback((toolName: string) => {
    setRunningCounters((current) => {
      const next = { ...current };
      const remaining = (next[toolName] ?? 0) - 1;

      if (remaining <= 0) {
        delete next[toolName];
      } else {
        next[toolName] = remaining;
      }

      return next;
    });
  }, []);

  const invokeTool = useCallback(
    async (
      tool: FrontendToolDefinition,
      args: Record<string, unknown> = {},
    ): Promise<unknown> => {
      if (!tool.handler) {
        throw new Error(`Tool "${tool.name}" does not define a handler.`);
      }

      const startedAt = Date.now();
      beginCall(tool.name);
      setError(null);

      try {
        const result = await tool.handler(args);
        setLastCall({
          toolName: tool.name,
          args,
          startedAt,
          endedAt: Date.now(),
          succeeded: true,
          result,
        });
        return result;
      } catch (caughtError) {
        const normalizedError = toSerializableError(caughtError);
        setError(normalizedError);
        setLastCall({
          toolName: tool.name,
          args,
          startedAt,
          endedAt: Date.now(),
          succeeded: false,
          error: normalizedError,
        });
        throw caughtError;
      } finally {
        finishCall(tool.name);
      }
    },
    [beginCall, finishCall],
  );

  const wrappedTools = useMemo(
    () =>
      tools.map((tool) => ({
        ...tool,
        handler: tool.handler
          ? async (args: Record<string, unknown>) => invokeTool(tool, args)
          : undefined,
      })),
    [tools, invokeTool],
  );

  for (const wrappedTool of wrappedTools) {
    useFrontendTool(
      {
        name: wrappedTool.name,
        description: wrappedTool.description,
        parameters: wrappedTool.parameters,
        followUp: wrappedTool.followUp,
        render: wrappedTool.render,
        available: wrappedTool.available,
        handler: wrappedTool.handler,
      },
      [wrappedTool.handler, wrappedTool.render, ...dependencies],
    );
  }

  const runTool = useCallback(
    async (
      name: string,
      args: Record<string, unknown> = {},
    ): Promise<unknown> => {
      const tool = toolsByName.get(name);

      if (!tool) {
        throw new Error(`Unknown tool "${name}".`);
      }

      return invokeTool(tool, args);
    },
    [invokeTool, toolsByName],
  );

  const reset = useCallback(() => {
    setError(null);
    setLastCall(null);
  }, []);

  const activeTools = useMemo(() => Object.keys(runningCounters), [runningCounters]);

  return {
    activeTools,
    isRunning: activeTools.length > 0,
    lastCall,
    error,
    runTool,
    reset,
  };
}
