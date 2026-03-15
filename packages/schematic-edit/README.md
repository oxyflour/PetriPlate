# schematic-edit

Interactive microwave ladder editor with a Next.js frontend and a FastAPI plus scikit-rf solver backend.

## Run

Start the solver:

```bash
uv run uvicorn api.server:app --reload --host 127.0.0.1 --port 8010
```

Start the web app:

```bash
npx pnpm --filter @petriplate/schematic-edit dev
```

The Next.js app proxies solver requests to `http://127.0.0.1:8010/solve` by default. Override with `SKRF_SOLVER_URL` if needed.
