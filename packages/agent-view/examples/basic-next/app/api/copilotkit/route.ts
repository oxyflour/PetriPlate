import {
  CopilotRuntime,
  OpenAIAdapter,
  copilotRuntimeNextJSAppRouterEndpoint,
  type CopilotRuntimeChatCompletionRequest,
  type CopilotRuntimeChatCompletionResponse,
  type CopilotServiceAdapter,
} from "@copilotkit/runtime";

const FALLBACK_REPLY_PREFIX =
  "Local echo mode is active (OPENAI_API_KEY is not set).";

function createId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }

  return `id_${Date.now()}_${Math.random().toString(16).slice(2)}`;
}

function extractLatestUserMessage(
  request: CopilotRuntimeChatCompletionRequest,
): string | null {
  for (let index = request.messages.length - 1; index >= 0; index -= 1) {
    const message = request.messages[index] as {
      role?: unknown;
      content?: unknown;
    };

    if (message.role !== "user") {
      continue;
    }

    if (typeof message.content === "string" && message.content.trim().length > 0) {
      return message.content.trim();
    }
  }

  return null;
}

class LocalEchoAdapter implements CopilotServiceAdapter {
  provider = "local";
  model = "echo";

  get name() {
    return "LocalEchoAdapter";
  }

  async process(
    request: CopilotRuntimeChatCompletionRequest,
  ): Promise<CopilotRuntimeChatCompletionResponse> {
    const threadId = request.threadId ?? createId();
    const latestUserMessage = extractLatestUserMessage(request);
    const reply = latestUserMessage
      ? `${FALLBACK_REPLY_PREFIX}\n\nYou said: "${latestUserMessage}".\n\nSet OPENAI_API_KEY in .env.local to enable real LLM responses.`
      : `${FALLBACK_REPLY_PREFIX}\n\nSend a message to verify the chat pipeline.`;

    request.eventSource.stream(async (eventStream$) => {
      const messageId = createId();
      eventStream$.sendTextMessageStart({ messageId });
      eventStream$.sendTextMessageContent({ messageId, content: reply });
      eventStream$.sendTextMessageEnd({ messageId });
    });

    return { threadId };
  }
}

function createServiceAdapter(): CopilotServiceAdapter {
  if (process.env.OPENAI_API_KEY && process.env.OPENAI_API_KEY.trim().length > 0) {
    return new OpenAIAdapter({
      model: process.env.OPENAI_MODEL || "gpt-4o-mini",
    });
  }

  return new LocalEchoAdapter();
}

const copilotRuntime = new CopilotRuntime();
const serviceAdapter = createServiceAdapter();

const { handleRequest } = copilotRuntimeNextJSAppRouterEndpoint({
  endpoint: "/api/copilotkit",
  runtime: copilotRuntime,
  serviceAdapter,
});

export const runtime = "nodejs";

export async function GET(request: Request): Promise<Response> {
  return handleRequest(request);
}

export async function POST(request: Request): Promise<Response> {
  return handleRequest(request);
}
