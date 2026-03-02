"use client";

import { useMemo, useState } from "react";
import { CopilotKit } from "@copilotkit/react-core";
import { CopilotChat } from "@copilotkit/react-ui";
import {
  useFrontendTools,
  type FrontendToolDefinition,
} from "@petri/agent-view";

function DemoPanel() {
  const [manualResult, setManualResult] = useState<unknown>(null);

  const tools = useMemo<FrontendToolDefinition[]>(
    () => [
      {
        name: "sum_numbers",
        description: "Add two numbers and return the sum.",
        parameters: [
          {
            name: "a",
            type: "number",
            description: "First number.",
            required: true,
          },
          {
            name: "b",
            type: "number",
            description: "Second number.",
            required: true,
          },
        ],
        handler: async ({ a, b }) => Number(a) + Number(b),
      },
      {
        name: "format_note",
        description: "Format a note into a normalized payload.",
        parameters: [
          {
            name: "title",
            type: "string",
            description: "Note title.",
            required: true,
          },
          {
            name: "body",
            type: "string",
            description: "Note content.",
            required: true,
          },
        ],
        handler: ({ title, body }) => ({
          title: String(title).trim(),
          body: String(body).trim(),
          updatedAt: new Date().toISOString(),
        }),
      },
    ],
    [],
  );

  const { runTool, isRunning, activeTools, lastCall, error, reset } =
    useFrontendTools({
      tools,
    });

  return (
    <section style={{ maxWidth: 1100, margin: "24px auto 0" }}>
      <h2 style={{ marginBottom: 8 }}>Minimal chat page</h2>
      <p style={{ marginTop: 0, color: "#4a5568" }}>
        This page is connected to <code>/api/copilotkit</code> and registers{" "}
        <code>sum_numbers</code> / <code>format_note</code> frontend tools.
      </p>

      <div className="agent-view-layout">
        <div className="agent-view-chat">
          <CopilotChat
            labels={{
              title: "Agent View Chat",
              initial:
                "Try: 'add 7 and 11', or ask me to normalize a short note.",
            }}
            instructions="You are the assistant for this demo page. Prefer calling the available tools: use `sum_numbers` for addition and `format_note` when asked to normalize note data."
          />
        </div>

        <aside
          style={{
            border: "1px solid #d7dfef",
            borderRadius: 12,
            background: "#ffffff",
            padding: 12,
          }}
        >
          <h3 style={{ marginTop: 0, marginBottom: 8 }}>Tool debug panel</h3>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
            <button
              type="button"
              onClick={async () => {
                const result = await runTool("sum_numbers", { a: 7, b: 11 });
                setManualResult(result);
              }}
              disabled={isRunning}
            >
              Run sum_numbers
            </button>
            <button
              type="button"
              onClick={async () => {
                const result = await runTool("format_note", {
                  title: "  PetriPlate  ",
                  body: "  frontend tools ready  ",
                });
                setManualResult(result);
              }}
              disabled={isRunning}
            >
              Run format_note
            </button>
            <button type="button" onClick={reset}>
              Reset state
            </button>
          </div>

          <pre
            style={{
              margin: 0,
              padding: 12,
              borderRadius: 8,
              background: "#0f172a",
              color: "#d8e0ff",
              overflowX: "auto",
              fontSize: 12,
              lineHeight: 1.4,
            }}
          >
            {JSON.stringify(
              {
                isRunning,
                activeTools,
                manualResult,
                lastCall,
                error,
              },
              null,
              2,
            )}
          </pre>
        </aside>
      </div>
    </section>
  );
}

export default function FrontendToolsDemo() {
  return (
    <CopilotKit runtimeUrl="/api/copilotkit">
      <DemoPanel />
    </CopilotKit>
  );
}
