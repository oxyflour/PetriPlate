# basic-next

`@petri/agent-view` minimal runnable chat demo (Next.js App Router).

## Run

```bash
npx pnpm --filter @petri/agent-view-example dev
```

Open `http://localhost:3000`.

## Runtime behavior

- If `OPENAI_API_KEY` is set, `/api/copilotkit` uses `OpenAIAdapter`.
- If `OPENAI_API_KEY` is missing, it falls back to a local echo adapter so the chat still works.

Optional env vars in `packages/agent-view/examples/basic-next/.env.local`:

```bash
OPENAI_API_KEY=your_key_here
OPENAI_MODEL=gpt-4o-mini
```
