import { getIsaacSessionManager } from "../../../../../src/server/isaac-session-manager";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(
  _request: Request,
  context: { params: Promise<{ sessionId: string }> }
) {
  const { sessionId } = await context.params;
  await getIsaacSessionManager().destroySession(sessionId);
  return new Response(null, { status: 204 });
}
