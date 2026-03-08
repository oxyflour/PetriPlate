import { readFile } from "node:fs/promises";
import path from "node:path";
import { getIsaacSessionManager } from "../../../../../../../src/server/isaac-session-manager";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  context: { params: Promise<{ sessionId: string; assetPath: string[] }> }
) {
  const { sessionId, assetPath } = await context.params;
  const relativeAssetPath = assetPath.join("/");
  const filePath = await getIsaacSessionManager().resolveAssetFile(sessionId, relativeAssetPath);

  if (!filePath) {
    return new Response("Not Found", { status: 404 });
  }

  const fileBuffer = await readFile(filePath);

  return new Response(fileBuffer, {
    status: 200,
    headers: {
      "Content-Type": getContentType(filePath),
      "Cache-Control": "no-store"
    }
  });
}

function getContentType(filePath: string) {
  const extension = path.extname(filePath).toLowerCase();

  if (extension === ".usda" || extension === ".usd" || extension === ".usdc") {
    return "application/octet-stream";
  }
  if (extension === ".png") {
    return "image/png";
  }
  if (extension === ".jpg" || extension === ".jpeg") {
    return "image/jpeg";
  }
  if (extension === ".webp") {
    return "image/webp";
  }
  if (extension === ".mtl" || extension === ".mdl") {
    return "text/plain; charset=utf-8";
  }

  return "application/octet-stream";
}
