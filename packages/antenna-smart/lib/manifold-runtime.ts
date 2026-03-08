import type { ManifoldRuntime } from "./types";

let runtimePromise: Promise<ManifoldRuntime> | null = null;
const dynamicImport = new Function(
  "specifier",
  "return import(specifier);"
) as (specifier: string) => Promise<{ default: (config?: { locateFile?: () => string }) => Promise<unknown> }>;

export function ensureManifoldRuntime() {
  if (!runtimePromise) {
    runtimePromise = loadRuntime();
  }
  return runtimePromise;
}

async function loadRuntime(): Promise<ManifoldRuntime> {
  const manifoldModule = await dynamicImport("/vendor/manifold.js");
  const runtime = (await manifoldModule.default({
    locateFile: () => "/vendor/manifold.wasm"
  })) as unknown as ManifoldRuntime;
  runtime.setup();
  return runtime;
}
