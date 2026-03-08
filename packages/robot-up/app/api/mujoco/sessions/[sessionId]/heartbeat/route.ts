import { getMujocoSessionManager } from "../../../../../../src/server/mujoco-session-manager";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(
  _request: Request,
  context: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await context.params;
  const expiresAt = getMujocoSessionManager().touchSession(sessionId);

  if (!expiresAt) {
    return Response.json({ error: "MuJoCo session was not found." }, { status: 404 });
  }

  return Response.json({ ok: true, expiresAt });
}
