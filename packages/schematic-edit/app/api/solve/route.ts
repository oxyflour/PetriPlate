import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

const DEFAULT_SOLVER_URL = "http://127.0.0.1:8010/solve";

export async function POST(request: Request) {
  const payload = await request.text();
  const solverUrl = process.env.SKRF_SOLVER_URL ?? DEFAULT_SOLVER_URL;

  try {
    const response = await fetch(solverUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json"
      },
      body: payload,
      cache: "no-store"
    });
    const responseText = await response.text();

    return new NextResponse(responseText, {
      status: response.status,
      headers: {
        "content-type": "application/json"
      }
    });
  } catch (error) {
    const message =
      error instanceof Error
        ? error.message
        : "Unable to reach the scikit-rf solver.";

    return NextResponse.json(
      {
        error: `${message} Start the backend with "uv run uvicorn api.server:app --reload --host 127.0.0.1 --port 8010".`
      },
      { status: 503 }
    );
  }
}
