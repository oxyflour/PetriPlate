import {
  buildHDRMipChain,
  loadHDRTextureData,
  packTextureRows,
  parseHDRTextureData
} from "./hdrLoader";
import type { HDRTextureData } from "./hdrLoader";
import { DEFAULT_HEIGHT_WGSL } from "./defaultHeight";
import type { DebugViewId, ShadingModeId } from "./presets";
import {
  buildHeightToSlopeShader,
  buildSatRowShader
} from "./shaders/dynamicPreprocess";
import {
  BUILD_HISTOGRAM_SHADER,
  NORMALIZE_HISTOGRAM_SHADER
} from "./shaders/histogram";
import { RENDER_SHADER } from "./shaders/renderPlate";
import { SAT_COLUMN_SHADER } from "./shaders/satColumn";

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
  shadingMode: ShadingModeId;
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
const HISTOGRAM_TILE_SIZE = 16;
const HISTOGRAM_BIN_COUNT = 16;
const HISTOGRAM_SLOPE_MAX = 4;
const HISTOGRAM_TILE_COUNT = MICRO_ATLAS_RESOLUTION / HISTOGRAM_TILE_SIZE;
const HISTOGRAM_BIN_TOTAL = HISTOGRAM_BIN_COUNT * HISTOGRAM_BIN_COUNT;
const GLINT_GAIN = 52;
const GLINT_WINDOW_SCALE = 0.45;
const FRAME_UNIFORM_VECTORS = 10;
const BUILD_UNIFORM_VECTORS = 2;
export const MIN_CAMERA_DISTANCE_MM = 30;
export const MAX_CAMERA_DISTANCE_MM = 140;
export const DEFAULT_CAMERA_DISTANCE_MM = 62;
export const DEFAULT_ENVIRONMENT_URL = "/hdr/venice_sunset_1k.hdr";
export const DEFAULT_ENVIRONMENT_NAME = "venice_sunset_1k.hdr";

const DEBUG_VIEW_INDEX: Record<DebugViewId, number> = {
  beauty: 0,
  footprint: 1,
  coverage: 2,
  normal: 3,
  slope: 4,
  histogram: 5,
  glint: 6
};

const SHADING_MODE_INDEX: Record<ShadingModeId, number> = {
  macro: 0,
  glint: 1
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

  private renderPipeline: GPURenderPipeline | null = null;
  private renderBindGroup: GPUBindGroup | null = null;
  private uniformBuffer: GPUBuffer | null = null;
  private buildUniformBuffer: GPUBuffer | null = null;
  private envTexture: GPUTexture | null = null;
  private envSampler: GPUSampler | null = null;
  private envMipLevelCount = 1;
  private environmentLoadToken = 0;
  private slopeTexture: GPUTexture | null = null;
  private slopeSatTextureA: GPUTexture | null = null;
  private slopeSatTextureB: GPUTexture | null = null;
  private slopeSatRowTextureA: GPUTexture | null = null;
  private slopeSatRowTextureB: GPUTexture | null = null;
  private histCountBuffer: GPUBuffer | null = null;
  private histPdfBuffer: GPUBuffer | null = null;
  private histOverflowBuffer: GPUBuffer | null = null;
  private heightToSlopePipeline: GPUComputePipeline | null = null;
  private satRowPipeline: GPUComputePipeline | null = null;
  private satColumnPipeline: GPUComputePipeline | null = null;
  private histogramBuildPipeline: GPUComputePipeline | null = null;
  private histogramNormalizePipeline: GPUComputePipeline | null = null;
  private heightSource = DEFAULT_HEIGHT_WGSL;

  private readonly fovDegrees = 36;
  private yaw = 0.62;
  private pitch = 0.62;
  private distance = DEFAULT_CAMERA_DISTANCE_MM;
  private readonly target: Vec3 = [0, 0, 0];

  private runtimeConfig: RuntimeConfig = {
    debugView: "beauty",
    shadingMode: "glint"
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

  public setShadingMode(shadingMode: ShadingModeId): void {
    this.runtimeConfig.shadingMode = shadingMode;
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

    const heightToSlopeModule = device.createShaderModule({
      label: "micro-height-to-slope-shader",
      code: buildHeightToSlopeShader(source)
    });
    const satRowModule = device.createShaderModule({
      label: "micro-sat-row-dynamic-shader",
      code: buildSatRowShader(source)
    });

    const messages = this.dedupeMessages([
      ...(await this.collectCompilationMessages(heightToSlopeModule, "build")),
      ...(await this.collectCompilationMessages(satRowModule, "build"))
    ]);
    if (messages.some((message) => message.level === "error")) {
      return { ok: false, messages };
    }

    try {
      this.heightToSlopePipeline = device.createComputePipeline({
        label: "micro-height-to-slope-pipeline",
        layout: "auto",
        compute: {
          module: heightToSlopeModule,
          entryPoint: "cs_height_to_slope"
        }
      });
      this.satRowPipeline = device.createComputePipeline({
        label: "micro-sat-row-pipeline",
        layout: "auto",
        compute: {
          module: satRowModule,
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

    const params = new Float32Array(FRAME_UNIFORM_VECTORS * 4);
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
    params.set(
      [
        SHADING_MODE_INDEX[this.runtimeConfig.shadingMode],
        HISTOGRAM_TILE_SIZE,
        HISTOGRAM_BIN_COUNT,
        HISTOGRAM_TILE_COUNT
      ],
      32
    );
    params.set([HISTOGRAM_SLOPE_MAX, GLINT_GAIN, GLINT_WINDOW_SCALE, 0], 36);
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

    if (this.renderPipeline && this.renderBindGroup) {
      pass.setPipeline(this.renderPipeline);
      pass.setBindGroup(0, this.renderBindGroup);
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
    this.slopeTexture?.destroy();
    this.slopeSatTextureA?.destroy();
    this.slopeSatTextureB?.destroy();
    this.slopeSatRowTextureA?.destroy();
    this.slopeSatRowTextureB?.destroy();
    this.histCountBuffer?.destroy();
    this.histPdfBuffer?.destroy();
    this.histOverflowBuffer?.destroy();
    this.envTexture = null;
    this.uniformBuffer = null;
    this.buildUniformBuffer = null;
    this.envSampler = null;
    this.slopeTexture = null;
    this.slopeSatTextureA = null;
    this.slopeSatTextureB = null;
    this.slopeSatRowTextureA = null;
    this.slopeSatRowTextureB = null;
    this.histCountBuffer = null;
    this.histPdfBuffer = null;
    this.histOverflowBuffer = null;
    this.renderPipeline = null;
    this.renderBindGroup = null;
    this.heightToSlopePipeline = null;
    this.satRowPipeline = null;
    this.satColumnPipeline = null;
    this.histogramBuildPipeline = null;
    this.histogramNormalizePipeline = null;
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
    const histogramTileTotal = HISTOGRAM_TILE_COUNT * HISTOGRAM_TILE_COUNT;
    const histogramValueCount = histogramTileTotal * HISTOGRAM_BIN_TOTAL;

    this.uniformBuffer?.destroy();
    this.buildUniformBuffer?.destroy();
    this.envTexture?.destroy();
    this.slopeTexture?.destroy();
    this.slopeSatTextureA?.destroy();
    this.slopeSatTextureB?.destroy();
    this.slopeSatRowTextureA?.destroy();
    this.slopeSatRowTextureB?.destroy();
    this.histCountBuffer?.destroy();
    this.histPdfBuffer?.destroy();
    this.histOverflowBuffer?.destroy();

    this.uniformBuffer = device.createBuffer({
      label: "metal-plate-uniforms",
      size: FRAME_UNIFORM_VECTORS * 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    this.buildUniformBuffer = device.createBuffer({
      label: "micro-build-uniforms",
      size: BUILD_UNIFORM_VECTORS * 16,
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

    this.slopeTexture = device.createTexture({
      label: "micro-slope-texture",
      size: [MICRO_ATLAS_RESOLUTION, MICRO_ATLAS_RESOLUTION, 1],
      format: "rgba16float",
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING
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

    this.histCountBuffer = device.createBuffer({
      label: "micro-hist-counts",
      size: histogramValueCount * Uint32Array.BYTES_PER_ELEMENT,
      usage: GPUBufferUsage.STORAGE
    });
    this.histPdfBuffer = device.createBuffer({
      label: "micro-hist-pdf",
      size: histogramValueCount * Float32Array.BYTES_PER_ELEMENT,
      usage: GPUBufferUsage.STORAGE
    });
    this.histOverflowBuffer = device.createBuffer({
      label: "micro-hist-overflow",
      size: histogramTileTotal * Uint32Array.BYTES_PER_ELEMENT,
      usage: GPUBufferUsage.STORAGE
    });
  }

  private createPipelines(): void {
    const device = this.device as GPUDevice;
    const renderModule = device.createShaderModule({
      label: "metal-plate-shader",
      code: RENDER_SHADER
    });
    const satColumnModule = device.createShaderModule({
      label: "micro-sat-column-shader",
      code: SAT_COLUMN_SHADER
    });
    const histogramBuildModule = device.createShaderModule({
      label: "micro-histogram-build-shader",
      code: BUILD_HISTOGRAM_SHADER
    });
    const histogramNormalizeModule = device.createShaderModule({
      label: "micro-histogram-normalize-shader",
      code: NORMALIZE_HISTOGRAM_SHADER
    });

    this.renderPipeline = device.createRenderPipeline({
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
    this.histogramBuildPipeline = device.createComputePipeline({
      label: "micro-histogram-build-pipeline",
      layout: "auto",
      compute: {
        module: histogramBuildModule,
        entryPoint: "cs_build_histogram"
      }
    });
    this.histogramNormalizePipeline = device.createComputePipeline({
      label: "micro-histogram-normalize-pipeline",
      layout: "auto",
      compute: {
        module: histogramNormalizeModule,
        entryPoint: "cs_normalize_histogram"
      }
    });
  }

  private refreshBindGroup(): void {
    const device = this.device;
    const renderPipeline = this.renderPipeline;
    const uniformBuffer = this.uniformBuffer;
    const envTexture = this.envTexture;
    const envSampler = this.envSampler;
    const slopeSatTextureA = this.slopeSatTextureA;
    const slopeSatTextureB = this.slopeSatTextureB;
    const slopeTexture = this.slopeTexture;
    const histPdfBuffer = this.histPdfBuffer;
    if (
      !device ||
      !renderPipeline ||
      !uniformBuffer ||
      !envTexture ||
      !envSampler ||
      !slopeSatTextureA ||
      !slopeSatTextureB ||
      !slopeTexture ||
      !histPdfBuffer
    ) {
      return;
    }

    this.renderBindGroup = device.createBindGroup({
      layout: renderPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: uniformBuffer } },
        { binding: 1, resource: envTexture.createView() },
        { binding: 2, resource: envSampler },
        { binding: 3, resource: slopeSatTextureA.createView() },
        { binding: 4, resource: slopeSatTextureB.createView() },
        { binding: 5, resource: slopeTexture.createView() },
        { binding: 6, resource: { buffer: histPdfBuffer } }
      ]
    });
  }

  private rebuildStatistics(): void {
    const device = this.device;
    const buildUniformBuffer = this.buildUniformBuffer;
    const slopeTexture = this.slopeTexture;
    const slopeSatTextureA = this.slopeSatTextureA;
    const slopeSatTextureB = this.slopeSatTextureB;
    const slopeSatRowTextureA = this.slopeSatRowTextureA;
    const slopeSatRowTextureB = this.slopeSatRowTextureB;
    const histCountBuffer = this.histCountBuffer;
    const histPdfBuffer = this.histPdfBuffer;
    const histOverflowBuffer = this.histOverflowBuffer;
    const heightToSlopePipeline = this.heightToSlopePipeline;
    const satRowPipeline = this.satRowPipeline;
    const satColumnPipeline = this.satColumnPipeline;
    const histogramBuildPipeline = this.histogramBuildPipeline;
    const histogramNormalizePipeline = this.histogramNormalizePipeline;
    if (
      !device ||
      !buildUniformBuffer ||
      !slopeTexture ||
      !slopeSatTextureA ||
      !slopeSatTextureB ||
      !slopeSatRowTextureA ||
      !slopeSatRowTextureB ||
      !histCountBuffer ||
      !histPdfBuffer ||
      !histOverflowBuffer ||
      !heightToSlopePipeline ||
      !satRowPipeline ||
      !satColumnPipeline ||
      !histogramBuildPipeline ||
      !histogramNormalizePipeline
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
        HISTOGRAM_TILE_COUNT,
        HISTOGRAM_TILE_SIZE,
        HISTOGRAM_BIN_COUNT,
        HISTOGRAM_SLOPE_MAX,
        HISTOGRAM_TILE_SIZE * MICRO_CELL_MM
      ])
    );

    const encoder = device.createCommandEncoder({ label: "micro-statistics-build" });

    const preprocessPass = encoder.beginComputePass({ label: "micro-preprocess-pass" });
    preprocessPass.setPipeline(heightToSlopePipeline);
    preprocessPass.setBindGroup(
      0,
      device.createBindGroup({
        layout: heightToSlopePipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: slopeTexture.createView() },
          { binding: 1, resource: { buffer: buildUniformBuffer } }
        ]
      })
    );
    preprocessPass.dispatchWorkgroups(
      Math.ceil(MICRO_ATLAS_RESOLUTION / 8),
      Math.ceil(MICRO_ATLAS_RESOLUTION / 8),
      1
    );

    preprocessPass.setPipeline(satRowPipeline);
    preprocessPass.setBindGroup(
      0,
      device.createBindGroup({
        layout: satRowPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: slopeSatRowTextureA.createView() },
          { binding: 1, resource: slopeSatRowTextureB.createView() },
          { binding: 2, resource: { buffer: buildUniformBuffer } }
        ]
      })
    );
    preprocessPass.dispatchWorkgroups(Math.ceil(MICRO_ATLAS_RESOLUTION / 64), 1, 1);
    preprocessPass.end();

    const histogramBuildPass = encoder.beginComputePass({
      label: "micro-histogram-build-pass"
    });
    histogramBuildPass.setPipeline(satColumnPipeline);
    histogramBuildPass.setBindGroup(
      0,
      device.createBindGroup({
        layout: satColumnPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: slopeSatRowTextureA.createView() },
          { binding: 1, resource: slopeSatRowTextureB.createView() },
          { binding: 2, resource: slopeSatTextureA.createView() },
          { binding: 3, resource: slopeSatTextureB.createView() },
          { binding: 4, resource: { buffer: buildUniformBuffer } }
        ]
      })
    );
    histogramBuildPass.dispatchWorkgroups(Math.ceil(MICRO_ATLAS_RESOLUTION / 64), 1, 1);

    histogramBuildPass.setPipeline(histogramBuildPipeline);
    histogramBuildPass.setBindGroup(
      0,
      device.createBindGroup({
        layout: histogramBuildPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: slopeTexture.createView() },
          { binding: 1, resource: { buffer: histCountBuffer } },
          { binding: 2, resource: { buffer: histOverflowBuffer } },
          { binding: 3, resource: { buffer: buildUniformBuffer } }
        ]
      })
    );
    histogramBuildPass.dispatchWorkgroups(HISTOGRAM_TILE_COUNT, HISTOGRAM_TILE_COUNT, 1);
    histogramBuildPass.end();

    const histogramNormalizePass = encoder.beginComputePass({
      label: "micro-histogram-normalize-pass"
    });
    histogramNormalizePass.setPipeline(histogramNormalizePipeline);
    histogramNormalizePass.setBindGroup(
      0,
      device.createBindGroup({
        layout: histogramNormalizePipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: histCountBuffer } },
          { binding: 1, resource: { buffer: histPdfBuffer } },
          { binding: 2, resource: { buffer: buildUniformBuffer } }
        ]
      })
    );
    histogramNormalizePass.dispatchWorkgroups(
      HISTOGRAM_TILE_COUNT * HISTOGRAM_TILE_COUNT,
      1,
      1
    );
    histogramNormalizePass.end();

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
}
