import { getIsaacSessionManager } from "../../../../src/server/isaac-session-manager";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  const formData = await request.formData();
  const upload = formData.get("file");
  const entryPath = formData.get("entryPath");

  if (!(upload instanceof File)) {
    return Response.json({ error: "Expected multipart field `file`." }, { status: 400 });
  }

  try {
    const manager = getIsaacSessionManager();
    const origin = new URL(request.url).origin;
    const requestHostname = new URL(request.url).hostname;
    const session = await manager.createSession({
      file: upload,
      entryPath: typeof entryPath === "string" ? entryPath : null,
      origin,
      requestHostname
    });

    return Response.json(session, { status: 201 });
  } catch (error) {
    return Response.json(
      {
        error: error instanceof Error ? error.message : "Isaac session could not be created."
      },
      { status: 500 }
    );
  }
}
