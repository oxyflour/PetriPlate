import {
  buildHDRMipChain,
  loadHDRTextureData,
  packTextureRows,
  parseHDRTextureData
} from "./hdrLoader";
import type { HDRTextureData } from "./hdrLoader";
import { DEFAULT_HEIGHT_WGSL } from "./defaultHeight";
import type { DebugViewId } from "./presets";

type Vec2 = [number, number];
type Vec3 = [number, number, number];

export type MetalPlateSnapshot = {
  centerFootprintMm: number;
  centerFootprintCells: number;
  centerRoughness: number;
  centerAspect: number;
  cameraDistanceMm: number;
};

type RuntimeConfig = {
  debugView: DebugViewId;
};

export type CompileLevel = "info" | "warning" | "error";

export type CompileMessage = {
  level: CompileLevel;
  source: "build";
  text: string;
  line?: number;
  column?: number;
};

export type CompileResult = {
  ok: boolean;
  messages: CompileMessage[];
};

const PLATE_HALF_EXTENT_MM = 25;
const MICRO_CELL_MM = 0.3;
const MICRO_HEIGHT_MM = 0.04;
const BASE_ROUGHNESS = 0.06;
const ENV_EXPOSURE = 1.18;
const MICRO_ATLAS_CELLS = 8;
const MICRO_ATLAS_RESOLUTION = 512;
export const MIN_CAMERA_DISTANCE_MM = 30;
export const MAX_CAMERA_DISTANCE_MM = 140;
export const DEFAULT_CAMERA_DISTANCE_MM = 62;
export const DEFAULT_ENVIRONMENT_URL = "/hdr/venice_sunset_1k.hdr";
export const DEFAULT_ENVIRONMENT_NAME = "venice_sunset_1k.hdr";

const DEBUG_VIEW_INDEX: Record<DebugViewId, number> = {
  beauty: 0,
  footprint: 1,
  coverage: 2,
  normal: 3
};

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function length3(v: Vec3): number {
  return Math.hypot(v[0], v[1], v[2]);
}

function normalize3(v: Vec3): Vec3 {
  const len = length3(v);
  if (len < 1e-6) {
    return [0, 0, 0];
  }
  return [v[0] / len, v[1] / len, v[2] / len];
}

function add3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
}

function sub3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function mul3(v: Vec3, scalar: number): Vec3 {
  return [v[0] * scalar, v[1] * scalar, v[2] * scalar];
}

function cross3(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0]
  ];
}

export class MetalPlateRenderer {
  private canvas: HTMLCanvasElement | null = null;
  private context: GPUCanvasContext | null = null;
  private device: GPUDevice | null = null;
  private canvasFormat: GPUTextureFormat | null = null;

  private pipeline: GPURenderPipeline | null = null;
  private bindGroup: GPUBindGroup | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private buildUniformBuffer: GPUBuffer | null = null;
  private envTexture: GPUTexture | null = null;
  private envSampler: GPUSampler | null = null;
  private envMipLevelCount = 1;
  private environmentLoadToken = 0;
  private slopeSatTextureA: GPUTexture | null = null;
  private slopeSatTextureB: GPUTexture | null = null;
  private slopeSatRowTextureA: GPUTexture | null = null;
  private slopeSatRowTextureB: GPUTexture | null = null;
  private satRowPipeline: GPUComputePipeline | null = null;
  private satColumnPipeline: GPUComputePipeline | null = null;
  private heightSource = DEFAULT_HEIGHT_WGSL;

  private readonly fovDegrees = 36;
  private yaw = 0.62;
  private pitch = 0.62;
  private distance = DEFAULT_CAMERA_DISTANCE_MM;
  private readonly target: Vec3 = [0, 0, 0];

  private runtimeConfig: RuntimeConfig = {
    debugView: "beauty"
  };

  private snapshot: MetalPlateSnapshot = {
    centerFootprintMm: 0,
    centerFootprintCells: 0,
    centerRoughness: BASE_ROUGHNESS,
    centerAspect: 1,
    cameraDistanceMm: this.distance
  };

  public constructor(
    private readonly onRuntimeError?: (message: string) => void
  ) {}

  public async initialize(canvas: HTMLCanvasElement): Promise<boolean> {
    if (typeof navigator === "undefined" || !navigator.gpu) {
      return false;
    }

    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) {
      return false;
    }

    const device = await adapter.requestDevice();
    const context = canvas.getContext("webgpu");
    if (!context) {
      return false;
    }

    this.canvas = canvas;
    this.device = device;
    this.context = context;
    this.canvasFormat = navigator.gpu.getPreferredCanvasFormat();

    this.configureContext();
    this.createResources();
    this.createPipelines();
    this.refreshBindGroup();
    await this.compileHeightFunction(this.heightSource);

    void this.loadDefaultEnvironment().catch((error) => {
      const message =
        error instanceof Error ? error.message : "Failed to load HDR environment.";
      this.onRuntimeError?.(message);
    });

    device.addEventListener("uncapturederror", (event: Event) => {
      const message =
        (event as { error?: { message?: string } }).error?.message ??
        "Unknown GPU error.";
      this.onRuntimeError?.(message);
    });

    return true;
  }

  public setDebugView(debugView: DebugViewId): void {
    this.runtimeConfig.debugView = debugView;
  }

  public orbit(deltaX: number, deltaY: number): void {
    this.yaw -= deltaX * 0.006;
    this.pitch = clamp(this.pitch - deltaY * 0.005, -0.24, 1.34);
  }

  public zoom(deltaY: number): void {
    const scale = 1 + deltaY * 0.001;
    this.distance = clamp(
      this.distance * scale,
      MIN_CAMERA_DISTANCE_MM,
      MAX_CAMERA_DISTANCE_MM
    );
  }

  public setDistance(distance: number): void {
    this.distance = clamp(
      distance,
      MIN_CAMERA_DISTANCE_MM,
      MAX_CAMERA_DISTANCE_MM
    );
  }

  public getDistance(): number {
    return this.distance;
  }

  public async loadDefaultEnvironment(): Promise<void> {
    await this.loadEnvironmentTexture(DEFAULT_ENVIRONMENT_URL);
  }

  public async loadEnvironmentBytes(bytes: Uint8Array): Promise<void> {
    const token = ++this.environmentLoadToken;
    const hdr = parseHDRTextureData(bytes);
    if (token !== this.environmentLoadToken) {
      return;
    }
    this.uploadEnvironmentTexture(hdr);
  }

  public async compileHeightFunction(source: string): Promise<CompileResult> {
    const device = this.device;
    if (!device) {
      return {
        ok: false,
        messages: [
          {
            level: "error",
            source: "build",
            text: "Renderer is not initialized."
          }
        ]
      };
    }

    const module = device.createShaderModule({
      label: "micro-sat-row-dynamic-shader",
      code: this.buildSatRowShader(source)
    });
    const messages = this.dedupeMessages(
      await this.collectCompilationMessages(module, "build")
    );
    if (messages.some((message) => message.level === "error")) {
      return { ok: false, messages };
    }

    try {
      this.satRowPipeline = device.createComputePipeline({
        label: "micro-sat-row-pipeline",
        layout: "auto",
        compute: {
          module,
          entryPoint: "cs_sat_row"
        }
      });
      this.heightSource = source;
      this.rebuildStatistics();
      return { ok: true, messages };
    } catch (error) {
      return {
        ok: false,
        messages: [
          ...messages,
          {
            level: "error",
            source: "build",
            text:
              error instanceof Error
                ? error.message
                : "Failed to create compute pipeline from height shader."
          }
        ]
      };
    }
  }

  public render(timeSeconds: number): void {
    const device = this.device;
    const context = this.context;
    const canvas = this.canvas;
    const uniformBuffer = this.uniformBuffer;
    if (!device || !context || !canvas || !uniformBuffer) {
      return;
    }

    this.resizeCanvas();
    if (canvas.width === 0 || canvas.height === 0) {
      return;
    }

    const cameraPosition = this.getCameraPosition();
    const cameraForward = normalize3(sub3(this.target, cameraPosition));
    let cameraRight = normalize3(cross3(cameraForward, [0, 1, 0]));
    if (length3(cameraRight) < 1e-6) {
      cameraRight = [1, 0, 0];
    }
    const cameraUp = normalize3(cross3(cameraRight, cameraForward));
    const tanHalfFov = Math.tan((this.fovDegrees * Math.PI) / 360);
    const lightDirection = normalize3([0.52, 0.78, 0.34]);

    const params = new Float32Array(8 * 4);
    params.set(
      [
        canvas.width,
        canvas.height,
        timeSeconds,
        DEBUG_VIEW_INDEX[this.runtimeConfig.debugView]
      ],
      0
    );
    params.set(
      [
        PLATE_HALF_EXTENT_MM,
        MICRO_CELL_MM,
        MICRO_HEIGHT_MM,
        MICRO_ATLAS_RESOLUTION
      ],
      4
    );
    params.set([cameraPosition[0], cameraPosition[1], cameraPosition[2], 0], 8);
    params.set([cameraRight[0], cameraRight[1], cameraRight[2], 0], 12);
    params.set([cameraUp[0], cameraUp[1], cameraUp[2], 0], 16);
    params.set([cameraForward[0], cameraForward[1], cameraForward[2], tanHalfFov], 20);
    params.set([BASE_ROUGHNESS, ENV_EXPOSURE, 2.5, MICRO_ATLAS_CELLS], 24);
    params.set(
      [lightDirection[0], lightDirection[1], lightDirection[2], this.envMipLevelCount - 1],
      28
    );
    device.queue.writeBuffer(uniformBuffer, 0, params);

    this.snapshot = this.computeCenterSnapshot(
      canvas.width,
      canvas.height,
      cameraPosition,
      cameraForward,
      cameraRight,
      cameraUp,
      tanHalfFov
    );

    const encoder = device.createCommandEncoder({ label: "metal-plate-frame" });
    const pass = encoder.beginRenderPass({
      label: "metal-plate-pass",
      colorAttachments: [
        {
          view: context.getCurrentTexture().createView(),
          clearValue: { r: 0.02, g: 0.025, b: 0.028, a: 1 },
          loadOp: "clear",
          storeOp: "store"
        }
      ]
    });

    if (this.pipeline && this.bindGroup) {
      pass.setPipeline(this.pipeline);
      pass.setBindGroup(0, this.bindGroup);
      pass.draw(3, 1, 0, 0);
    }

    pass.end();
    device.queue.submit([encoder.finish()]);
  }

  public getSnapshot(): MetalPlateSnapshot {
    return this.snapshot;
  }

  public dispose(): void {
    this.buildUniformBuffer?.destroy();
    this.envTexture?.destroy();
    this.uniformBuffer?.destroy();
    this.slopeSatTextureA?.destroy();
    this.slopeSatTextureB?.destroy();
    this.slopeSatRowTextureA?.destroy();
    this.slopeSatRowTextureB?.destroy();
    this.envTexture = null;
    this.uniformBuffer = null;
    this.buildUniformBuffer = null;
    this.envSampler = null;
    this.slopeSatTextureA = null;
    this.slopeSatTextureB = null;
    this.slopeSatRowTextureA = null;
    this.slopeSatRowTextureB = null;
    this.pipeline = null;
    this.satRowPipeline = null;
    this.satColumnPipeline = null;
    this.bindGroup = null;
    this.context = null;
    this.device = null;
    this.canvas = null;
  }

  private configureContext(): void {
    const device = this.device as GPUDevice;
    const context = this.context as GPUCanvasContext;
    context.configure({
      device,
      format: this.canvasFormat as GPUTextureFormat,
      alphaMode: "opaque"
    });
  }

  private createResources(): void {
    const device = this.device as GPUDevice;
    this.uniformBuffer?.destroy();
    this.buildUniformBuffer?.destroy();
    this.envTexture?.destroy();
    this.slopeSatTextureA?.destroy();
    this.slopeSatTextureB?.destroy();
    this.slopeSatRowTextureA?.destroy();
    this.slopeSatRowTextureB?.destroy();

    this.uniformBuffer = device.createBuffer({
      label: "metal-plate-uniforms",
      size: 8 * 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    this.buildUniformBuffer = device.createBuffer({
      label: "micro-build-uniforms",
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });

    this.envTexture = device.createTexture({
      label: "env-fallback",
      size: [1, 1, 1],
      mipLevelCount: 1,
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
    });
    this.envMipLevelCount = 1;
    device.queue.writeTexture(
      { texture: this.envTexture },
      new Uint8Array([194, 201, 220, 255]),
      { offset: 0 },
      { width: 1, height: 1, depthOrArrayLayers: 1 }
    );

    this.envSampler = device.createSampler({
      label: "env-sampler",
      magFilter: "linear",
      minFilter: "linear",
      mipmapFilter: "linear",
      addressModeU: "repeat",
      addressModeV: "clamp-to-edge"
    });

    this.slopeSatTextureA = device.createTexture({
      label: "micro-sat-a",
      size: [MICRO_ATLAS_RESOLUTION, MICRO_ATLAS_RESOLUTION, 1],
      format: "rgba32float",
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING
    });
    this.slopeSatTextureB = device.createTexture({
      label: "micro-sat-b",
      size: [MICRO_ATLAS_RESOLUTION, MICRO_ATLAS_RESOLUTION, 1],
      format: "r32float",
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING
    });
    this.slopeSatRowTextureA = device.createTexture({
      label: "micro-sat-row-a",
      size: [MICRO_ATLAS_RESOLUTION, MICRO_ATLAS_RESOLUTION, 1],
      format: "rgba32float",
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING
    });
    this.slopeSatRowTextureB = device.createTexture({
      label: "micro-sat-row-b",
      size: [MICRO_ATLAS_RESOLUTION, MICRO_ATLAS_RESOLUTION, 1],
      format: "r32float",
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING
    });
  }

  private createPipelines(): void {
    const device = this.device as GPUDevice;
    const renderModule = device.createShaderModule({
      label: "metal-plate-shader",
      code: this.buildRenderShader()
    });
    const satColumnModule = device.createShaderModule({
      label: "micro-sat-column-shader",
      code: this.buildSatColumnShader()
    });

    this.pipeline = device.createRenderPipeline({
      label: "metal-plate-pipeline",
      layout: "auto",
      vertex: {
        module: renderModule,
        entryPoint: "vs_main"
      },
      fragment: {
        module: renderModule,
        entryPoint: "fs_main",
        targets: [{ format: this.canvasFormat as GPUTextureFormat }]
      },
      primitive: {
        topology: "triangle-list"
      }
    });

    this.satColumnPipeline = device.createComputePipeline({
      label: "micro-sat-column-pipeline",
      layout: "auto",
      compute: {
        module: satColumnModule,
        entryPoint: "cs_sat_column"
      }
    });
  }

  private refreshBindGroup(): void {
    const device = this.device;
    const pipeline = this.pipeline;
    const uniformBuffer = this.uniformBuffer;
    const envTexture = this.envTexture;
    const envSampler = this.envSampler;
    const slopeSatTextureA = this.slopeSatTextureA;
    const slopeSatTextureB = this.slopeSatTextureB;
    if (
      !device ||
      !pipeline ||
      !uniformBuffer ||
      !envTexture ||
      !envSampler ||
      !slopeSatTextureA ||
      !slopeSatTextureB
    ) {
      return;
    }

    this.bindGroup = device.createBindGroup({
      layout: pipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uniformBuffer } },
        { binding: 1, resource: envTexture.createView() },
        { binding: 2, resource: envSampler },
        { binding: 3, resource: slopeSatTextureA.createView() },
        { binding: 4, resource: slopeSatTextureB.createView() }
      ]
    });
  }

  private rebuildStatistics(): void {
    const device = this.device;
    const buildUniformBuffer = this.buildUniformBuffer;
    const satRowPipeline = this.satRowPipeline;
    const satColumnPipeline = this.satColumnPipeline;
    const slopeSatTextureA = this.slopeSatTextureA;
    const slopeSatTextureB = this.slopeSatTextureB;
    const slopeSatRowTextureA = this.slopeSatRowTextureA;
    const slopeSatRowTextureB = this.slopeSatRowTextureB;
    if (
      !device ||
      !buildUniformBuffer ||
      !satRowPipeline ||
      !satColumnPipeline ||
      !slopeSatTextureA ||
      !slopeSatTextureB ||
      !slopeSatRowTextureA ||
      !slopeSatRowTextureB
    ) {
      return;
    }

    device.queue.writeBuffer(
      buildUniformBuffer,
      0,
      new Float32Array([
        MICRO_ATLAS_RESOLUTION,
        MICRO_ATLAS_CELLS,
        MICRO_CELL_MM,
        0
      ])
    );

    const encoder = device.createCommandEncoder({ label: "micro-statistics-build" });
    const pass = encoder.beginComputePass({ label: "micro-statistics-pass" });

    const rowBindGroup = device.createBindGroup({
      layout: satRowPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: slopeSatRowTextureA.createView() },
        { binding: 1, resource: slopeSatRowTextureB.createView() },
        { binding: 2, resource: { buffer: buildUniformBuffer } }
      ]
    });
    pass.setPipeline(satRowPipeline);
    pass.setBindGroup(0, rowBindGroup);
    const groups = Math.ceil(MICRO_ATLAS_RESOLUTION / 64);
    pass.dispatchWorkgroups(groups, 1, 1);

    const columnBindGroup = device.createBindGroup({
      layout: satColumnPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: slopeSatRowTextureA.createView() },
        { binding: 1, resource: slopeSatRowTextureB.createView() },
        { binding: 2, resource: slopeSatTextureA.createView() },
        { binding: 3, resource: slopeSatTextureB.createView() },
        { binding: 4, resource: { buffer: buildUniformBuffer } }
      ]
    });
    pass.setPipeline(satColumnPipeline);
    pass.setBindGroup(0, columnBindGroup);
    pass.dispatchWorkgroups(groups, 1, 1);

    pass.end();
    device.queue.submit([encoder.finish()]);
  }

  private async loadEnvironmentTexture(url: string): Promise<void> {
    const token = ++this.environmentLoadToken;
    const hdr = await loadHDRTextureData(url);
    if (token !== this.environmentLoadToken) {
      return;
    }
    this.uploadEnvironmentTexture(hdr);
  }

  private uploadEnvironmentTexture(hdr: HDRTextureData): void {
    const device = this.device;
    if (!device) {
      return;
    }

    const mipChain = buildHDRMipChain(hdr);
    const texture = device.createTexture({
      label: "env-hdri",
      size: [hdr.width, hdr.height, 1],
      mipLevelCount: mipChain.length,
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
    });
    for (let level = 0; level < mipChain.length; level += 1) {
      const mip = mipChain[level];
      const packed = packTextureRows(mip.data, mip.width, mip.height, 4);
      device.queue.writeTexture(
        { texture, mipLevel: level },
        packed.data as Uint8Array<ArrayBuffer>,
        {
          offset: 0,
          bytesPerRow: packed.bytesPerRow,
          rowsPerImage: mip.height
        },
        {
          width: mip.width,
          height: mip.height,
          depthOrArrayLayers: 1
        }
      );
    }

    this.envTexture?.destroy();
    this.envTexture = texture;
    this.envMipLevelCount = mipChain.length;
    this.refreshBindGroup();
  }

  private resizeCanvas(): void {
    const canvas = this.canvas;
    if (!canvas) {
      return;
    }

    const dpr = Math.max(window.devicePixelRatio || 1, 1);
    const width = Math.max(1, Math.round(canvas.clientWidth * dpr));
    const height = Math.max(1, Math.round(canvas.clientHeight * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
  }

  private getCameraPosition(): Vec3 {
    const cp = Math.cos(this.pitch);
    return [
      this.target[0] + this.distance * Math.sin(this.yaw) * cp,
      this.target[1] + this.distance * Math.sin(this.pitch),
      this.target[2] + this.distance * Math.cos(this.yaw) * cp
    ];
  }

  private computeCenterSnapshot(
    width: number,
    height: number,
    cameraPosition: Vec3,
    cameraForward: Vec3,
    cameraRight: Vec3,
    cameraUp: Vec3,
    tanHalfFov: number
  ): MetalPlateSnapshot {
    const center = this.rayDirectionForPixel(
      width,
      height,
      [width * 0.5, height * 0.5],
      cameraForward,
      cameraRight,
      cameraUp,
      tanHalfFov
    );
    const hit = this.intersectPlate(cameraPosition, center);
    if (!hit) {
      return {
        centerFootprintMm: 0,
        centerFootprintCells: 0,
        centerRoughness: BASE_ROUGHNESS,
        centerAspect: 1,
        cameraDistanceMm: this.distance
      };
    }

    const rightRay = this.rayDirectionForPixel(
      width,
      height,
      [width * 0.5 + 1, height * 0.5],
      cameraForward,
      cameraRight,
      cameraUp,
      tanHalfFov
    );
    const downRay = this.rayDirectionForPixel(
      width,
      height,
      [width * 0.5, height * 0.5 + 1],
      cameraForward,
      cameraRight,
      cameraUp,
      tanHalfFov
    );

    const hitRight = this.intersectPlate(cameraPosition, rightRay);
    const hitDown = this.intersectPlate(cameraPosition, downRay);
    const fallback = (2 * hit.t * tanHalfFov) / Math.max(height, 1);
    const dx = hitRight ? length3(sub3(hitRight.position, hit.position)) : fallback;
    const dy = hitDown ? length3(sub3(hitDown.position, hit.position)) : fallback;
    const footprint = Math.sqrt(Math.max(dx * dy, 1e-8));
    const aspect = Math.max(dx, dy) / Math.max(Math.min(dx, dy), 1e-6);
    const coverage = footprint / MICRO_CELL_MM;
    const roughness = clamp(BASE_ROUGHNESS + Math.pow(coverage, 0.7) * 0.08, 0.02, 0.92);

    return {
      centerFootprintMm: footprint,
      centerFootprintCells: coverage,
      centerRoughness: roughness,
      centerAspect: aspect,
      cameraDistanceMm: this.distance
    };
  }

  private rayDirectionForPixel(
    width: number,
    height: number,
    pixel: Vec2,
    cameraForward: Vec3,
    cameraRight: Vec3,
    cameraUp: Vec3,
    tanHalfFov: number
  ): Vec3 {
    const aspect = width / Math.max(height, 1);
    const ndcX = (pixel[0] / Math.max(width, 1)) * 2 - 1;
    const ndcY = 1 - (pixel[1] / Math.max(height, 1)) * 2;
    const ray = add3(
      cameraForward,
      add3(
        mul3(cameraRight, ndcX * aspect * tanHalfFov),
        mul3(cameraUp, ndcY * tanHalfFov)
      )
    );
    return normalize3(ray);
  }

  private intersectPlate(
    origin: Vec3,
    direction: Vec3
  ): { t: number; position: Vec3 } | null {
    if (Math.abs(direction[1]) < 1e-6) {
      return null;
    }
    const t = -origin[1] / direction[1];
    if (t <= 0) {
      return null;
    }

    const position = add3(origin, mul3(direction, t));
    if (
      Math.abs(position[0]) > PLATE_HALF_EXTENT_MM ||
      Math.abs(position[2]) > PLATE_HALF_EXTENT_MM
    ) {
      return null;
    }
    return { t, position };
  }

  private async collectCompilationMessages(
    module: GPUShaderModule,
    source: "build"
  ): Promise<CompileMessage[]> {
    const info = await module.getCompilationInfo();
    return info.messages.map((message: GPUCompilationMessage) => ({
      level: message.type,
      source,
      line: message.lineNum,
      column: message.linePos,
      text: message.message.trim()
    }));
  }

  private dedupeMessages(messages: CompileMessage[]): CompileMessage[] {
    const seen = new Set<string>();
    const deduped: CompileMessage[] = [];
    for (const message of messages) {
      const key = `${message.level}|${message.source}|${message.line}|${message.column}|${message.text}`;
      if (!seen.has(key)) {
        seen.add(key);
        deduped.push(message);
      }
    }
    return deduped;
  }

  private buildRenderShader(): string {
    return `
const PI = 3.141592653589793;
const HEAT_A = vec3<f32>(0.03, 0.12, 0.18);
const HEAT_B = vec3<f32>(0.16, 0.54, 0.73);
const HEAT_C = vec3<f32>(0.95, 0.72, 0.29);
const HEAT_D = vec3<f32>(1.0, 0.35, 0.1);

@group(0) @binding(0) var<uniform> params: array<vec4<f32>, 8>;
@group(0) @binding(1) var envTex: texture_2d<f32>;
@group(0) @binding(2) var envSampler: sampler;
@group(0) @binding(3) var slopeSatTexA: texture_2d<f32>;
@group(0) @binding(4) var slopeSatTexB: texture_2d<f32>;

struct VSOut {
  @builtin(position) position: vec4<f32>,
};

struct Hit {
  valid: bool,
  t: f32,
  position: vec3<f32>,
};

struct FootprintInfo {
  spanWorld: vec2<f32>,
  sizeMm: f32,
  cellsCovered: f32,
  aspect: f32,
};

struct SlopeStats {
  meanNormal: vec3<f32>,
  meanSlope: vec2<f32>,
  alpha: vec2<f32>,
  anisotropy: f32,
};

@vertex
fn vs_main(@builtin(vertex_index) vertexIndex: u32) -> VSOut {
  var positions = array<vec2<f32>, 3>(
    vec2<f32>(-1.0, -3.0),
    vec2<f32>(-1.0, 1.0),
    vec2<f32>(3.0, 1.0)
  );
  var out: VSOut;
  out.position = vec4<f32>(positions[vertexIndex], 0.0, 1.0);
  return out;
}

fn ray_dir_for_pixel(pixel: vec2<f32>) -> vec3<f32> {
  let resolution = max(params[0].xy, vec2<f32>(1.0, 1.0));
  let aspect = resolution.x / resolution.y;
  let ndc = vec2<f32>(
    (pixel.x / resolution.x) * 2.0 - 1.0,
    1.0 - (pixel.y / resolution.y) * 2.0
  );
  let forward = params[5].xyz;
  let right = params[3].xyz;
  let up = params[4].xyz;
  let tanHalfFov = params[5].w;
  return normalize(
    forward + right * ndc.x * aspect * tanHalfFov + up * ndc.y * tanHalfFov
  );
}

fn intersect_plate(ro: vec3<f32>, rd: vec3<f32>) -> Hit {
  var hit = Hit(false, 0.0, vec3<f32>(0.0, 0.0, 0.0));
  if (abs(rd.y) < 1e-6) {
    return hit;
  }

  let t = -ro.y / rd.y;
  if (t <= 0.0) {
    return hit;
  }

  let p = ro + rd * t;
  let extent = params[1].x;
  if (abs(p.x) > extent || abs(p.z) > extent) {
    return hit;
  }

  hit.valid = true;
  hit.t = t;
  hit.position = p;
  return hit;
}

fn estimate_footprint(fragCoord: vec2<f32>, ro: vec3<f32>, centerHit: Hit) -> FootprintInfo {
  let tanHalfFov = params[5].w;
  let resolution = max(params[0].xy, vec2<f32>(1.0, 1.0));
  let fallback = (2.0 * centerHit.t * tanHalfFov) / resolution.y;

  let hitX = intersect_plate(ro, ray_dir_for_pixel(fragCoord + vec2<f32>(1.0, 0.0)));
  let hitY = intersect_plate(ro, ray_dir_for_pixel(fragCoord + vec2<f32>(0.0, 1.0)));

  var deltaX = vec2<f32>(fallback, 0.0);
  var deltaY = vec2<f32>(0.0, fallback);
  if (hitX.valid) {
    deltaX = hitX.position.xz - centerHit.position.xz;
  }
  if (hitY.valid) {
    deltaY = hitY.position.xz - centerHit.position.xz;
  }

  let spanWorld = vec2<f32>(
    max(abs(deltaX.x) + abs(deltaY.x), fallback),
    max(abs(deltaX.y) + abs(deltaY.y), fallback)
  );
  let sizeMm = sqrt(max(spanWorld.x * spanWorld.y, 1e-8));
  let cells = sizeMm / max(params[1].y, 1e-4);
  let aspect = max(spanWorld.x, spanWorld.y) / max(min(spanWorld.x, spanWorld.y), 1e-6);
  return FootprintInfo(spanWorld, sizeMm, cells, aspect);
}

fn sat_load_a(coord: vec2<i32>, maxCoord: i32) -> vec4<f32> {
  if (coord.x < 0 || coord.y < 0 || coord.x > maxCoord || coord.y > maxCoord) {
    return vec4<f32>(0.0);
  }
  return textureLoad(slopeSatTexA, coord, 0);
}

fn sat_load_b(coord: vec2<i32>, maxCoord: i32) -> f32 {
  if (coord.x < 0 || coord.y < 0 || coord.x > maxCoord || coord.y > maxCoord) {
    return 0.0;
  }
  return textureLoad(slopeSatTexB, coord, 0).x;
}

fn sat_rect_sum_a(minCoord: vec2<i32>, maxCoordRect: vec2<i32>, maxCoord: i32) -> vec4<f32> {
  let a = sat_load_a(maxCoordRect, maxCoord);
  let b = sat_load_a(vec2<i32>(minCoord.x - 1, maxCoordRect.y), maxCoord);
  let c = sat_load_a(vec2<i32>(maxCoordRect.x, minCoord.y - 1), maxCoord);
  let d = sat_load_a(vec2<i32>(minCoord.x - 1, minCoord.y - 1), maxCoord);
  return a - b - c + d;
}

fn sat_rect_sum_b(minCoord: vec2<i32>, maxCoordRect: vec2<i32>, maxCoord: i32) -> f32 {
  let a = sat_load_b(maxCoordRect, maxCoord);
  let b = sat_load_b(vec2<i32>(minCoord.x - 1, maxCoordRect.y), maxCoord);
  let c = sat_load_b(vec2<i32>(maxCoordRect.x, minCoord.y - 1), maxCoord);
  let d = sat_load_b(vec2<i32>(minCoord.x - 1, minCoord.y - 1), maxCoord);
  return a - b - c + d;
}

fn normal_from_slope(sx: f32, sy: f32) -> vec3<f32> {
  return normalize(vec3<f32>(-sx, 1.0, -sy));
}

fn tangent_from_slope(sx: f32) -> vec3<f32> {
  return normalize(vec3<f32>(1.0, sx, 0.0));
}

fn bitangent_from_slope(sy: f32) -> vec3<f32> {
  return normalize(vec3<f32>(0.0, sy, 1.0));
}

fn slope_stats_at(p: vec2<f32>, footprint: FootprintInfo) -> SlopeStats {
  let atlasRes = max(i32(params[1].w), 1);
  let maxCoord = atlasRes - 1;
  let atlasCells = max(params[6].w, 1.0);
  let texelsPerCell = params[1].w / atlasCells;
  let cellUv = fract(p / max(params[1].y, 1e-4));
  let centerCell = floor(atlasCells * 0.5);
  let center = (vec2<f32>(centerCell, centerCell) + cellUv) * texelsPerCell - vec2<f32>(0.5, 0.5);
  let maxRadiusCells = max(atlasCells * 0.35, 1.0);
  let filterInflation = mix(1.35, 1.85, clamp(footprint.cellsCovered / 6.0, 0.0, 1.0));
  let halfExtentCells = clamp(
    (footprint.spanWorld * 0.5) / max(params[1].y, 1e-4) * filterInflation +
      vec2<f32>(0.18, 0.18),
    vec2<f32>(0.25, 0.25),
    vec2<f32>(maxRadiusCells, maxRadiusCells)
  );
  let halfExtentTexels = halfExtentCells * texelsPerCell;

  var minCoord = clamp(
    vec2<i32>(floor(center - halfExtentTexels)),
    vec2<i32>(0, 0),
    vec2<i32>(maxCoord, maxCoord)
  );
  var maxCoordRect = clamp(
    vec2<i32>(ceil(center + halfExtentTexels)),
    vec2<i32>(0, 0),
    vec2<i32>(maxCoord, maxCoord)
  );
  if (footprint.cellsCovered > atlasCells * 0.55) {
    minCoord = vec2<i32>(0, 0);
    maxCoordRect = vec2<i32>(maxCoord, maxCoord);
  }

  let area = max(
    f32((maxCoordRect.x - minCoord.x + 1) * (maxCoordRect.y - minCoord.y + 1)),
    1.0
  );
  let sumsA = sat_rect_sum_a(minCoord, maxCoordRect, maxCoord);
  let sumB = sat_rect_sum_b(minCoord, maxCoordRect, maxCoord);
  let meanSx = sumsA.x / area;
  let meanSy = sumsA.y / area;
  let meanSx2 = sumsA.z / area;
  let meanSy2 = sumsA.w / area;
  let meanSxSy = sumB / area;
  let varX = max(meanSx2 - meanSx * meanSx, 0.0);
  let varY = max(meanSy2 - meanSy * meanSy, 0.0);
  let coverageBlur = clamp(sqrt(max(footprint.cellsCovered, 0.0)) * 0.05, 0.0, 0.22);
  let alphaX = clamp(params[6].x + sqrt(varX) * 0.85 + coverageBlur, params[6].x, 0.94);
  let alphaY = clamp(params[6].x + sqrt(varY) * 0.85 + coverageBlur, params[6].x, 0.94);
  let anisotropy = (alphaX - alphaY) / max(alphaX + alphaY, 1e-5);
  return SlopeStats(
    normal_from_slope(meanSx, meanSy),
    vec2<f32>(meanSx, meanSy),
    vec2<f32>(alphaX, alphaY),
    anisotropy
  );
}

fn hash12(p: vec2<f32>) -> f32 {
  let h = dot(p, vec2<f32>(127.1, 311.7));
  return fract(sin(h) * 43758.5453123);
}

fn filtered_slope_stats(p: vec2<f32>, footprint: FootprintInfo, fragCoord: vec2<f32>) -> SlopeStats {
  let baseStats = slope_stats_at(p, footprint);
  let shimmerRisk = smoothstep(0.22, 1.85, footprint.cellsCovered) *
    (1.0 - smoothstep(1.85, 4.4, footprint.cellsCovered));
  if (shimmerRisk <= 0.02) {
    return baseStats;
  }

  let angle = hash12(floor(fragCoord.xy)) * PI * 2.0;
  let cosA = cos(angle);
  let sinA = sin(angle);
  let baseRadius = min(
    footprint.spanWorld * 0.3,
    vec2<f32>(params[1].y * 0.65, params[1].y * 0.65)
  ) * shimmerRisk;
  var normalSum = baseStats.meanNormal;
  var slopeSum = baseStats.meanSlope;
  var alphaSum = baseStats.alpha;
  var anisoSum = baseStats.anisotropy;
  var weightSum = 1.0;
  let offsets = array<vec2<f32>, 4>(
    vec2<f32>(-0.42, -0.18),
    vec2<f32>(0.31, -0.37),
    vec2<f32>(-0.24, 0.39),
    vec2<f32>(0.45, 0.21)
  );

  for (var i = 0; i < 4; i = i + 1) {
    let offset = offsets[i];
    let rotated = vec2<f32>(
      offset.x * cosA - offset.y * sinA,
      offset.x * sinA + offset.y * cosA
    );
    let sampleStats = slope_stats_at(p + rotated * baseRadius, footprint);
    let w = 0.55;
    normalSum = normalSum + sampleStats.meanNormal * w;
    slopeSum = slopeSum + sampleStats.meanSlope * w;
    alphaSum = alphaSum + sampleStats.alpha * w;
    anisoSum = anisoSum + sampleStats.anisotropy * w;
    weightSum = weightSum + w;
  }

  return SlopeStats(
    normalize(normalSum / weightSum),
    slopeSum / weightSum,
    alphaSum / weightSum,
    anisoSum / weightSum
  );
}

fn decode_rgbe(encoded: vec4<f32>) -> vec3<f32> {
  let rgbe = encoded * 255.0;
  if (rgbe.w <= 0.0) {
    return vec3<f32>(0.0);
  }
  let scale = exp2(rgbe.w - 128.0) / 256.0;
  return rgbe.xyz * scale;
}

fn sample_env(direction: vec3<f32>, lod: f32) -> vec3<f32> {
  let dir = normalize(direction);
  let phi = atan2(dir.z, dir.x);
  let theta = acos(clamp(dir.y, -1.0, 1.0));
  let uv = vec2<f32>(fract(phi / (2.0 * PI) + 0.5), clamp(theta / PI, 0.0, 1.0));
  let maxLod = max(params[7].w, 0.0);
  return decode_rgbe(textureSampleLevel(envTex, envSampler, uv, clamp(lod, 0.0, maxLod))) * params[6].y;
}

fn fresnel_schlick(cosTheta: f32, f0: vec3<f32>) -> vec3<f32> {
  return f0 + (vec3<f32>(1.0) - f0) * pow(1.0 - cosTheta, 5.0);
}

fn distribution_ggx_aniso(
  n: vec3<f32>,
  h: vec3<f32>,
  t: vec3<f32>,
  b: vec3<f32>,
  alpha: vec2<f32>
) -> f32 {
  let ndh = max(dot(n, h), 1e-4);
  let tdh = dot(t, h);
  let bdh = dot(b, h);
  let invAx = 1.0 / max(alpha.x, 1e-4);
  let invAy = 1.0 / max(alpha.y, 1e-4);
  let denom = (tdh * invAx) * (tdh * invAx) + (bdh * invAy) * (bdh * invAy) + ndh * ndh;
  return 1.0 / max(PI * alpha.x * alpha.y * denom * denom, 1e-5);
}

fn smith_g1_aniso(
  n: vec3<f32>,
  v: vec3<f32>,
  t: vec3<f32>,
  b: vec3<f32>,
  alpha: vec2<f32>
) -> f32 {
  let ndv = max(dot(n, v), 1e-4);
  let tdv = dot(t, v) * alpha.x;
  let bdv = dot(b, v) * alpha.y;
  let root = sqrt(ndv * ndv + tdv * tdv + bdv * bdv);
  return (2.0 * ndv) / max(ndv + root, 1e-4);
}

fn geometry_smith_aniso(
  n: vec3<f32>,
  v: vec3<f32>,
  l: vec3<f32>,
  t: vec3<f32>,
  b: vec3<f32>,
  alpha: vec2<f32>
) -> f32 {
  return smith_g1_aniso(n, v, t, b, alpha) * smith_g1_aniso(n, l, t, b, alpha);
}

fn heatmap(t: f32) -> vec3<f32> {
  let x = clamp(t, 0.0, 1.0);
  let c0 = mix(HEAT_A, HEAT_B, smoothstep(0.0, 0.35, x));
  let c1 = mix(c0, HEAT_C, smoothstep(0.28, 0.72, x));
  return mix(c1, HEAT_D, smoothstep(0.68, 1.0, x));
}

fn tonemap_aces(color: vec3<f32>) -> vec3<f32> {
  let a = 2.51;
  let b = 0.03;
  let c = 2.43;
  let d = 0.59;
  let e = 0.14;
  return clamp(
    (color * (a * color + b)) / (color * (c * color + d) + e),
    vec3<f32>(0.0),
    vec3<f32>(1.0)
  );
}

@fragment
fn fs_main(@builtin(position) fragCoord: vec4<f32>) -> @location(0) vec4<f32> {
  let ro = params[2].xyz;
  let rd = ray_dir_for_pixel(fragCoord.xy);
  let plateHit = intersect_plate(ro, rd);
  let debugView = i32(params[0].w + 0.5);

  if (!plateHit.valid) {
    let bg = tonemap_aces(sample_env(rd, 0.0));
    return vec4<f32>(pow(bg, vec3<f32>(1.0 / 2.2)), 1.0);
  }

  let footprint = estimate_footprint(fragCoord.xy, ro, plateHit);
  let slopeStats = filtered_slope_stats(plateHit.position.xz, footprint, fragCoord.xy);
  let n = slopeStats.meanNormal;
  let v = normalize(ro - plateHit.position);
  let l = normalize(params[7].xyz);
  let h = normalize(v + l);

  if (debugView == 1) {
    let band = heatmap(clamp(footprint.sizeMm / 1.4, 0.0, 1.0));
    return vec4<f32>(pow(band, vec3<f32>(1.0 / 2.2)), 1.0);
  }

  if (debugView == 2) {
    let cov = heatmap(clamp(footprint.cellsCovered / 6.0, 0.0, 1.0));
    return vec4<f32>(pow(cov, vec3<f32>(1.0 / 2.2)), 1.0);
  }

  if (debugView == 3) {
    let encoded = n * 0.5 + vec3<f32>(0.5);
    return vec4<f32>(pow(encoded, vec3<f32>(1.0 / 2.2)), 1.0);
  }

  let baseColor = vec3<f32>(0.96, 0.88, 0.72);
  let tangent = tangent_from_slope(slopeStats.meanSlope.x);
  let bitangent = bitangent_from_slope(slopeStats.meanSlope.y);
  let ndv = max(dot(n, v), 0.0);
  let ndl = max(dot(n, l), 0.0);
  let grazingLift = pow(1.0 - ndv, 2.0) * 0.16;
  let shadedAlpha = min(
    slopeStats.alpha + vec2<f32>(grazingLift, grazingLift),
    vec2<f32>(0.96, 0.96)
  );
  let fresnel = fresnel_schlick(max(dot(h, v), 0.0), baseColor);
  let d = distribution_ggx_aniso(n, h, tangent, bitangent, shadedAlpha);
  let g = geometry_smith_aniso(n, v, l, tangent, bitangent, shadedAlpha);
  let directSpec = (d * g * fresnel) / max(4.0 * ndv * ndl, 1e-5);

  let isoRough = sqrt(shadedAlpha.x * shadedAlpha.y);
  let envBlur = clamp(
    max(
      isoRough,
      clamp((footprint.cellsCovered - 0.85) * 0.12, 0.0, 0.32) +
        abs(slopeStats.anisotropy) * 0.12
    ),
    0.0,
    1.0
  );
  let envLod = envBlur * max(params[7].w, 0.0);
  let reflectDir = reflect(-v, n);
  let blurMix = envBlur * envBlur * 0.88;
  let envReflect = normalize(mix(reflectDir, n, blurMix));
  let envSpec = sample_env(envReflect, envLod) * fresnel;
  let grazing = sample_env(n, min(envLod + 1.0, max(params[7].w, 0.0))) * 0.05 * baseColor;
  let direct = directSpec * ndl * params[6].z;
  let edgeMask = smoothstep(params[1].x, params[1].x - 1.6, max(abs(plateHit.position.x), abs(plateHit.position.z)));

  var color = envSpec + grazing + direct;
  color = mix(color, color * 0.58, edgeMask);
  color = tonemap_aces(color);
  color = pow(color, vec3<f32>(1.0 / 2.2));
  return vec4<f32>(color, 1.0);
}
`;
  }

  private buildSatRowShader(heightCode: string): string {
    return `
${heightCode}

@group(0) @binding(0) var satRowAOut: texture_storage_2d<rgba32float, write>;
@group(0) @binding(1) var satRowBOut: texture_storage_2d<r32float, write>;
@group(0) @binding(2) var<uniform> buildParams: array<vec4<f32>, 1>;

fn atlas_world_position(coord: vec2<f32>) -> vec2<f32> {
  let resolution = max(buildParams[0].x, 1.0);
  let totalSize = buildParams[0].y * buildParams[0].z;
  let uv = (coord + vec2<f32>(0.5, 0.5)) / resolution;
  return uv * totalSize;
}

@compute @workgroup_size(64, 1, 1)
fn cs_sat_row(@builtin(global_invocation_id) gid: vec3<u32>) {
  let resolution = u32(buildParams[0].x);
  if (gid.x >= resolution) {
    return;
  }

  let y = i32(gid.x);
  let maxCoord = i32(resolution - 1u);
  let texelWorld = (buildParams[0].y * buildParams[0].z) / max(f32(resolution), 1.0);
  let invSlopeScale = 1.0 / max(2.0 * texelWorld, 1e-6);
  var sumA = vec4<f32>(0.0);
  var sumB = 0.0;

  for (var x = 0; x <= maxCoord; x = x + 1) {
    let p = atlas_world_position(vec2<f32>(f32(x), f32(y)));
    let hL = height(p - vec2<f32>(texelWorld, 0.0));
    let hR = height(p + vec2<f32>(texelWorld, 0.0));
    let hD = height(p - vec2<f32>(0.0, texelWorld));
    let hU = height(p + vec2<f32>(0.0, texelWorld));
    let sx = (hR - hL) * invSlopeScale;
    let sy = (hU - hD) * invSlopeScale;

    sumA = sumA + vec4<f32>(sx, sy, sx * sx, sy * sy);
    sumB = sumB + sx * sy;
    textureStore(satRowAOut, vec2<i32>(x, y), sumA);
    textureStore(satRowBOut, vec2<i32>(x, y), vec4<f32>(sumB, 0.0, 0.0, 1.0));
  }
}
`;
  }

  private buildSatColumnShader(): string {
    return `
@group(0) @binding(0) var satRowAIn: texture_2d<f32>;
@group(0) @binding(1) var satRowBIn: texture_2d<f32>;
@group(0) @binding(2) var satOutA: texture_storage_2d<rgba32float, write>;
@group(0) @binding(3) var satOutB: texture_storage_2d<r32float, write>;
@group(0) @binding(4) var<uniform> buildParams: array<vec4<f32>, 1>;

@compute @workgroup_size(64, 1, 1)
fn cs_sat_column(@builtin(global_invocation_id) gid: vec3<u32>) {
  let resolution = u32(buildParams[0].x);
  if (gid.x >= resolution) {
    return;
  }

  let x = i32(gid.x);
  let maxCoord = i32(resolution - 1u);
  var sumA = vec4<f32>(0.0);
  var sumB = 0.0;

  for (var y = 0; y <= maxCoord; y = y + 1) {
    let rowA = textureLoad(satRowAIn, vec2<i32>(x, y), 0);
    let rowB = textureLoad(satRowBIn, vec2<i32>(x, y), 0).x;
    sumA = sumA + rowA;
    sumB = sumB + rowB;
    textureStore(satOutA, vec2<i32>(x, y), sumA);
    textureStore(satOutB, vec2<i32>(x, y), vec4<f32>(sumB, 0.0, 0.0, 1.0));
  }
}
`;
  }
}
