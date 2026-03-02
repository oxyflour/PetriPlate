import { loadHDRTextureData, packTextureRows } from "./hdrLoader";

export type CompileLevel = "info" | "warning" | "error";

export type CompileMessage = {
  level: CompileLevel;
  source: "render" | "build";
  text: string;
  line?: number;
  column?: number;
};

export type CompileResult = {
  ok: boolean;
  messages: CompileMessage[];
};

type Vec3 = [number, number, number];

type RuntimeProgram = {
  renderPipeline: GPURenderPipeline;
  buildPipeline: GPUComputePipeline;
  renderBindGroup: GPUBindGroup;
  buildBindGroup: GPUBindGroup;
};

const BASE_GRID_SIZE = 1024;
const WORLD_HALF_EXTENT = 8192;

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function sub3(a: Vec3, b: Vec3): Vec3 {
  return [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
}

function cross3(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0]
  ];
}

function length3(v: Vec3): number {
  return Math.hypot(v[0], v[1], v[2]);
}

function normalize3(v: Vec3): Vec3 {
  const len = length3(v);
  if (len < 1e-7) {
    return [0, 0, 0];
  }
  return [v[0] / len, v[1] / len, v[2] / len];
}

export class TerrainRenderer {
  private canvas: HTMLCanvasElement | null = null;
  private context: GPUCanvasContext | null = null;
  private device: GPUDevice | null = null;
  private canvasFormat: GPUTextureFormat | null = null;

  private heightTexture: GPUTexture | null = null;
  private minMaxTexture: GPUTexture | null = null;
  private minMaxMipViews: GPUTextureView[] = [];
  private slopeSatTextureA: GPUTexture | null = null;
  private slopeSatTextureB: GPUTexture | null = null;
  private slopeSatRowTextureA: GPUTexture | null = null;
  private slopeSatRowTextureB: GPUTexture | null = null;
  private envTexture: GPUTexture | null = null;
  private envSampler: GPUSampler | null = null;

  private renderUniformBuffer: GPUBuffer | null = null;
  private buildUniformBuffer: GPUBuffer | null = null;
  private reduceUniformBuffer: GPUBuffer | null = null;

  private reducePipeline: GPUComputePipeline | null = null;
  private satRowPipeline: GPUComputePipeline | null = null;
  private satColumnPipeline: GPUComputePipeline | null = null;
  private program: RuntimeProgram | null = null;

  private readonly baseGridSize = BASE_GRID_SIZE;
  private readonly worldHalfExtent = WORLD_HALF_EXTENT;
  private mipCount = 1;
  private minMaxFormat: "rg32float" | "rgba16float" = "rg32float";

  private readonly fovDegrees = 52;
  private yaw = 0.54;
  private pitch = 0.68;
  private distance = 2500;
  private readonly target: Vec3 = [0, 110, 0];

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
    this.mipCount = Math.floor(Math.log2(this.baseGridSize)) + 1;
    this.minMaxFormat = this.pickMinMaxFormat(device);

    this.configureContext();
    this.createTextures();
    this.createBuffers();
    this.createEnvironmentResources();
    this.createReducePipeline();
    this.createSatPipelines();

    void this.loadEnvironmentTexture("/hdr/venice_sunset_1k.hdr").catch((error) => {
      const message =
        error instanceof Error
          ? error.message
          : "Failed to load HDRI environment texture.";
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

  public async compileHeightFunction(source: string): Promise<CompileResult> {
    const device = this.device;
    const canvasFormat = this.canvasFormat;
    const renderUniformBuffer = this.renderUniformBuffer;
    const buildUniformBuffer = this.buildUniformBuffer;
    if (!device || !canvasFormat || !renderUniformBuffer || !buildUniformBuffer) {
      return {
        ok: false,
        messages: [
          {
            level: "error",
            source: "render",
            text: "Renderer is not initialized."
          }
        ]
      };
    }

    const renderModule = device.createShaderModule({
      label: "terrain-render-module",
      code: this.buildRenderShader(source)
    });
    const buildModule = device.createShaderModule({
      label: "terrain-build-module",
      code: this.buildHeightShader(source)
    });

    const collected = (
      await Promise.all([
        this.collectCompilationMessages(renderModule, "render"),
        this.collectCompilationMessages(buildModule, "build")
      ])
    ).flat();
    const messages = this.dedupeMessages(collected);
    const hasErrors = messages.some((message) => message.level === "error");
    if (hasErrors) {
      return { ok: false, messages };
    }

    try {
      const renderPipeline = device.createRenderPipeline({
        label: "terrain-render-pipeline",
        layout: "auto",
        vertex: {
          module: renderModule,
          entryPoint: "vs_main"
        },
        fragment: {
          module: renderModule,
          entryPoint: "fs_main",
          targets: [{ format: canvasFormat }]
        },
        primitive: {
          topology: "triangle-list"
        }
      });

      const buildPipeline = device.createComputePipeline({
        label: "terrain-build-pipeline",
        layout: "auto",
        compute: {
          module: buildModule,
          entryPoint: "cs_build"
        }
      });

      const envTexture = this.envTexture;
      const envSampler = this.envSampler;
      const slopeSatTextureA = this.slopeSatTextureA;
      const slopeSatTextureB = this.slopeSatTextureB;
      if (!envTexture || !envSampler || !slopeSatTextureA || !slopeSatTextureB) {
        return {
          ok: false,
          messages: [
            ...messages,
            {
              level: "error",
              source: "render",
              text: "Render texture resources are not initialized."
            }
          ]
        };
      }

      const renderBindGroup = device.createBindGroup({
        layout: renderPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: renderUniformBuffer } },
          { binding: 1, resource: this.heightTexture?.createView() as GPUTextureView },
          { binding: 2, resource: this.minMaxTexture?.createView() as GPUTextureView },
          { binding: 3, resource: envTexture.createView() },
          { binding: 4, resource: envSampler },
          { binding: 5, resource: slopeSatTextureA.createView() },
          { binding: 6, resource: slopeSatTextureB.createView() }
        ]
      });

      const buildBindGroup = device.createBindGroup({
        layout: buildPipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: { buffer: buildUniformBuffer } },
          { binding: 1, resource: this.heightTexture?.createView() as GPUTextureView },
          { binding: 2, resource: this.minMaxMipViews[0] as GPUTextureView }
        ]
      });

      this.program = {
        renderPipeline,
        buildPipeline,
        renderBindGroup,
        buildBindGroup
      };
      this.rebuildHeightHierarchy();
      return { ok: true, messages };
    } catch (error) {
      return {
        ok: false,
        messages: [
          ...messages,
          {
            level: "error",
            source: "render",
            text:
              error instanceof Error
                ? error.message
                : "Failed to create pipeline from shader."
          }
        ]
      };
    }
  }

  public orbit(deltaX: number, deltaY: number): void {
    this.yaw -= deltaX * 0.004;
    this.pitch = clamp(this.pitch - deltaY * 0.004, -1.2, 1.2);
  }

  public zoom(deltaY: number): void {
    const scale = 1 + deltaY * 0.001;
    this.distance = clamp(this.distance * scale, 160, this.worldHalfExtent * 1.7);
  }

  public render(timeSeconds: number): void {
    const device = this.device;
    const context = this.context;
    const canvas = this.canvas;
    if (!device || !context || !canvas) {
      return;
    }

    this.resizeCanvas();
    if (canvas.width <= 0 || canvas.height <= 0) {
      return;
    }

    const cameraPosition = this.getCameraPosition();
    const cameraForward = normalize3(sub3(this.target, cameraPosition));
    let cameraRight = normalize3(cross3(cameraForward, [0, 1, 0]));
    if (length3(cameraRight) < 1e-6) {
      cameraRight = [1, 0, 0];
    }
    const cameraUp = normalize3(cross3(cameraRight, cameraForward));
    const lightDirection = normalize3([0.35, 0.85, 0.36]);
    const tanHalfFov = Math.tan((this.fovDegrees * Math.PI) / 360);
    const farClip = this.worldHalfExtent * 3;

    const renderParams = new Float32Array(7 * 4);
    renderParams.set([canvas.width, canvas.height, timeSeconds, farClip], 0);
    renderParams.set(
      [this.worldHalfExtent, this.baseGridSize, this.mipCount, tanHalfFov],
      4
    );
    renderParams.set([cameraPosition[0], cameraPosition[1], cameraPosition[2], 0], 8);
    renderParams.set([cameraRight[0], cameraRight[1], cameraRight[2], 0], 12);
    renderParams.set([cameraUp[0], cameraUp[1], cameraUp[2], 0], 16);
    renderParams.set([cameraForward[0], cameraForward[1], cameraForward[2], 0], 20);
    renderParams.set([lightDirection[0], lightDirection[1], lightDirection[2], 0], 24);
    device.queue.writeBuffer(this.renderUniformBuffer as GPUBuffer, 0, renderParams);

    const encoder = device.createCommandEncoder({ label: "terrain-frame-encoder" });
    const pass = encoder.beginRenderPass({
      label: "terrain-render-pass",
      colorAttachments: [
        {
          view: context.getCurrentTexture().createView(),
          clearValue: { r: 0.02, g: 0.06, b: 0.1, a: 1 },
          loadOp: "clear",
          storeOp: "store"
        }
      ]
    });

    if (this.program) {
      pass.setPipeline(this.program.renderPipeline);
      pass.setBindGroup(0, this.program.renderBindGroup);
      pass.draw(3, 1, 0, 0);
    }
    pass.end();

    device.queue.submit([encoder.finish()]);
  }

  public dispose(): void {
    this.heightTexture?.destroy();
    this.minMaxTexture?.destroy();
    this.slopeSatTextureA?.destroy();
    this.slopeSatTextureB?.destroy();
    this.slopeSatRowTextureA?.destroy();
    this.slopeSatRowTextureB?.destroy();
    this.envTexture?.destroy();
    this.heightTexture = null;
    this.minMaxTexture = null;
    this.slopeSatTextureA = null;
    this.slopeSatTextureB = null;
    this.slopeSatRowTextureA = null;
    this.slopeSatRowTextureB = null;
    this.envTexture = null;
    this.envSampler = null;
    this.minMaxMipViews = [];
    this.program = null;
    this.reducePipeline = null;
    this.satRowPipeline = null;
    this.satColumnPipeline = null;
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

  private createBuffers(): void {
    const device = this.device as GPUDevice;
    this.renderUniformBuffer = device.createBuffer({
      label: "render-uniform-buffer",
      size: 7 * 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    this.buildUniformBuffer = device.createBuffer({
      label: "build-uniform-buffer",
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
    this.reduceUniformBuffer = device.createBuffer({
      label: "reduce-uniform-buffer",
      size: 16,
      usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
    });
  }

  private createEnvironmentResources(): void {
    const device = this.device as GPUDevice;
    this.envTexture?.destroy();

    this.envTexture = device.createTexture({
      label: "env-fallback",
      size: [1, 1, 1],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
    });
    this.envSampler = device.createSampler({
      label: "env-sampler",
      magFilter: "nearest",
      minFilter: "nearest",
      mipmapFilter: "nearest",
      addressModeU: "repeat",
      addressModeV: "clamp-to-edge"
    });

    device.queue.writeTexture(
      { texture: this.envTexture },
      new Uint8Array([180, 198, 255, 132]),
      { offset: 0 },
      { width: 1, height: 1, depthOrArrayLayers: 1 }
    );
  }

  private async loadEnvironmentTexture(url: string): Promise<void> {
    const device = this.device;
    if (!device) {
      return;
    }

    const hdr = await loadHDRTextureData(url);
    const texture = device.createTexture({
      label: "env-hdri",
      size: [hdr.width, hdr.height, 1],
      format: "rgba8unorm",
      usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
    });
    const packed = packTextureRows(hdr.data, hdr.width, hdr.height, 4);
    device.queue.writeTexture(
      { texture },
      packed.data as Uint8Array<ArrayBuffer>,
      {
        offset: 0,
        bytesPerRow: packed.bytesPerRow,
        rowsPerImage: hdr.height
      },
      {
        width: hdr.width,
        height: hdr.height,
        depthOrArrayLayers: 1
      }
    );

    this.envTexture?.destroy();
    this.envTexture = texture;
    this.refreshRenderBindGroup();
  }

  private createTextures(): void {
    const device = this.device as GPUDevice;
    this.heightTexture?.destroy();
    this.minMaxTexture?.destroy();
    this.slopeSatTextureA?.destroy();
    this.slopeSatTextureB?.destroy();
    this.slopeSatRowTextureA?.destroy();
    this.slopeSatRowTextureB?.destroy();
    this.minMaxMipViews = [];

    this.heightTexture = device.createTexture({
      label: "height-map",
      size: [this.baseGridSize, this.baseGridSize, 1],
      format: "r32float",
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING
    });

    this.minMaxTexture = device.createTexture({
      label: "minmax-hierarchy",
      size: [this.baseGridSize, this.baseGridSize, 1],
      mipLevelCount: this.mipCount,
      format: this.minMaxFormat,
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING
    });

    this.slopeSatTextureA = device.createTexture({
      label: "slope-sat-a",
      size: [this.baseGridSize, this.baseGridSize, 1],
      format: "rgba32float",
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING
    });
    this.slopeSatTextureB = device.createTexture({
      label: "slope-sat-b",
      size: [this.baseGridSize, this.baseGridSize, 1],
      format: "r32float",
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING
    });
    this.slopeSatRowTextureA = device.createTexture({
      label: "slope-sat-row-a",
      size: [this.baseGridSize, this.baseGridSize, 1],
      format: "rgba32float",
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING
    });
    this.slopeSatRowTextureB = device.createTexture({
      label: "slope-sat-row-b",
      size: [this.baseGridSize, this.baseGridSize, 1],
      format: "r32float",
      usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING
    });

    for (let level = 0; level < this.mipCount; level += 1) {
      this.minMaxMipViews.push(
        this.minMaxTexture.createView({
          baseMipLevel: level,
          mipLevelCount: 1
        })
      );
    }
  }

  private createReducePipeline(): void {
    const device = this.device as GPUDevice;
    const reduceModule = device.createShaderModule({
      label: "minmax-reduce-module",
      code: this.buildReduceShader()
    });
    this.reducePipeline = device.createComputePipeline({
      label: "minmax-reduce-pipeline",
      layout: "auto",
      compute: {
        module: reduceModule,
        entryPoint: "cs_reduce"
      }
    });
  }

  private createSatPipelines(): void {
    const device = this.device as GPUDevice;
    const rowModule = device.createShaderModule({
      label: "slope-sat-row-module",
      code: this.buildSatRowShader()
    });
    const columnModule = device.createShaderModule({
      label: "slope-sat-column-module",
      code: this.buildSatColumnShader()
    });
    this.satRowPipeline = device.createComputePipeline({
      label: "slope-sat-row-pipeline",
      layout: "auto",
      compute: {
        module: rowModule,
        entryPoint: "cs_sat_row"
      }
    });
    this.satColumnPipeline = device.createComputePipeline({
      label: "slope-sat-column-pipeline",
      layout: "auto",
      compute: {
        module: columnModule,
        entryPoint: "cs_sat_column"
      }
    });
  }

  private refreshRenderBindGroup(): void {
    const device = this.device;
    const program = this.program;
    const renderUniformBuffer = this.renderUniformBuffer;
    const heightTexture = this.heightTexture;
    const minMaxTexture = this.minMaxTexture;
    const slopeSatTextureA = this.slopeSatTextureA;
    const slopeSatTextureB = this.slopeSatTextureB;
    const envTexture = this.envTexture;
    const envSampler = this.envSampler;

    if (
      !device ||
      !program ||
      !renderUniformBuffer ||
      !heightTexture ||
      !minMaxTexture ||
      !slopeSatTextureA ||
      !slopeSatTextureB ||
      !envTexture ||
      !envSampler
    ) {
      return;
    }

    program.renderBindGroup = device.createBindGroup({
      layout: program.renderPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: { buffer: renderUniformBuffer } },
        { binding: 1, resource: heightTexture.createView() },
        { binding: 2, resource: minMaxTexture.createView() },
        { binding: 3, resource: envTexture.createView() },
        { binding: 4, resource: envSampler },
        { binding: 5, resource: slopeSatTextureA.createView() },
        { binding: 6, resource: slopeSatTextureB.createView() }
      ]
    });
  }

  private pickMinMaxFormat(device: GPUDevice): "rg32float" | "rgba16float" {
    const candidates: Array<"rg32float" | "rgba16float"> = [
      "rg32float",
      "rgba16float"
    ];
    for (const format of candidates) {
      try {
        const probe = device.createTexture({
          size: [4, 4, 1],
          format,
          usage: GPUTextureUsage.STORAGE_BINDING | GPUTextureUsage.TEXTURE_BINDING
        });
        probe.destroy();
        return format;
      } catch {
        continue;
      }
    }
    return "rgba16float";
  }

  private getCameraPosition(): Vec3 {
    const cp = Math.cos(this.pitch);
    return [
      this.target[0] + this.distance * Math.sin(this.yaw) * cp,
      this.target[1] + this.distance * Math.sin(this.pitch),
      this.target[2] + this.distance * Math.cos(this.yaw) * cp
    ];
  }

  private resizeCanvas(): void {
    const canvas = this.canvas;
    if (!canvas) {
      return;
    }
    const dpr = typeof window === "undefined" ? 1 : window.devicePixelRatio || 1;
    const width = Math.max(1, Math.floor(canvas.clientWidth * dpr));
    const height = Math.max(1, Math.floor(canvas.clientHeight * dpr));
    if (canvas.width !== width || canvas.height !== height) {
      canvas.width = width;
      canvas.height = height;
    }
  }

  private rebuildHeightHierarchy(): void {
    const device = this.device;
    const program = this.program;
    const reducePipeline = this.reducePipeline;
    const satRowPipeline = this.satRowPipeline;
    const satColumnPipeline = this.satColumnPipeline;
    const reduceUniformBuffer = this.reduceUniformBuffer;
    const buildUniformBuffer = this.buildUniformBuffer;
    const heightTexture = this.heightTexture;
    const slopeSatTextureA = this.slopeSatTextureA;
    const slopeSatTextureB = this.slopeSatTextureB;
    const slopeSatRowTextureA = this.slopeSatRowTextureA;
    const slopeSatRowTextureB = this.slopeSatRowTextureB;
    if (
      !device ||
      !program ||
      !reducePipeline ||
      !satRowPipeline ||
      !satColumnPipeline ||
      !reduceUniformBuffer ||
      !buildUniformBuffer ||
      !heightTexture ||
      !slopeSatTextureA ||
      !slopeSatTextureB ||
      !slopeSatRowTextureA ||
      !slopeSatRowTextureB
    ) {
      return;
    }

    const buildParams = new Float32Array([
      this.worldHalfExtent,
      this.baseGridSize,
      performance.now() * 0.001,
      0
    ]);
    device.queue.writeBuffer(buildUniformBuffer, 0, buildParams);

    const encoder = device.createCommandEncoder({ label: "height-hierarchy-encoder" });
    const pass = encoder.beginComputePass({ label: "height-hierarchy-pass" });

    pass.setPipeline(program.buildPipeline);
    pass.setBindGroup(0, program.buildBindGroup);
    const baseGroups = Math.ceil(this.baseGridSize / 8);
    pass.dispatchWorkgroups(baseGroups, baseGroups, 1);

    const satRowBindGroup = device.createBindGroup({
      layout: satRowPipeline.getBindGroupLayout(0),
      entries: [
        { binding: 0, resource: heightTexture.createView() },
        { binding: 1, resource: slopeSatRowTextureA.createView() },
        { binding: 2, resource: slopeSatRowTextureB.createView() },
        { binding: 3, resource: { buffer: buildUniformBuffer } }
      ]
    });
    pass.setPipeline(satRowPipeline);
    pass.setBindGroup(0, satRowBindGroup);
    const satGroups = Math.ceil(this.baseGridSize / 64);
    pass.dispatchWorkgroups(satGroups, 1, 1);

    const satColumnBindGroup = device.createBindGroup({
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
    pass.setBindGroup(0, satColumnBindGroup);
    pass.dispatchWorkgroups(satGroups, 1, 1);

    for (let level = 1; level < this.mipCount; level += 1) {
      const dstSize = Math.max(1, this.baseGridSize >> level);
      device.queue.writeBuffer(
        reduceUniformBuffer,
        0,
        new Float32Array([dstSize, dstSize, 0, 0])
      );

      const bindGroup = device.createBindGroup({
        layout: reducePipeline.getBindGroupLayout(0),
        entries: [
          { binding: 0, resource: this.minMaxMipViews[level - 1] as GPUTextureView },
          { binding: 1, resource: this.minMaxMipViews[level] as GPUTextureView },
          { binding: 2, resource: { buffer: reduceUniformBuffer } }
        ]
      });

      pass.setPipeline(reducePipeline);
      pass.setBindGroup(0, bindGroup);
      const groups = Math.ceil(dstSize / 8);
      pass.dispatchWorkgroups(groups, groups, 1);
    }

    pass.end();
    device.queue.submit([encoder.finish()]);
  }

  private async collectCompilationMessages(
    module: GPUShaderModule,
    source: "render" | "build"
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

  private buildRenderShader(heightCode: string): string {
    return `
${heightCode}

const HIT_EPS = 0.55;
const MIN_STEP = 0.45;
const MAX_STEP = 40.0;
const MAX_SKIP_STEP = 320.0;
const SAFETY_MARGIN = 1.1;
const MAX_TRACE_STEPS = 768;
const REFINE_STEPS = 8;
const PI = 3.141592653589793;
const IBL_EXPOSURE = 1.08;

@group(0) @binding(0) var<uniform> params: array<vec4<f32>, 7>;
@group(0) @binding(1) var heightTex: texture_2d<f32>;
@group(0) @binding(2) var minMaxTex: texture_2d<f32>;
@group(0) @binding(3) var envTex: texture_2d<f32>;
@group(0) @binding(4) var envSampler: sampler;
@group(0) @binding(5) var slopeSatTexA: texture_2d<f32>;
@group(0) @binding(6) var slopeSatTexB: texture_2d<f32>;

struct VSOut {
  @builtin(position) position: vec4<f32>,
};

struct SlopeStats {
  normal: vec3<f32>,
  variance: f32,
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

fn world_to_uv(p: vec2<f32>) -> vec2<f32> {
  let extent = params[1].x;
  let uv = (p / extent) * 0.5 + vec2<f32>(0.5, 0.5);
  return clamp(uv, vec2<f32>(0.0, 0.0), vec2<f32>(1.0, 1.0));
}

fn sample_height(p: vec2<f32>) -> f32 {
  let baseResolution = max(params[1].y, 1.0);
  let texelPos = world_to_uv(p) * (baseResolution - 1.0);
  let i = vec2<i32>(floor(texelPos));
  let f = fract(texelPos);
  let maxCoord = max(i32(baseResolution) - 1, 0);

  let c00 = textureLoad(heightTex, clamp(i, vec2<i32>(0, 0), vec2<i32>(maxCoord, maxCoord)), 0).x;
  let c10 = textureLoad(heightTex, clamp(i + vec2<i32>(1, 0), vec2<i32>(0, 0), vec2<i32>(maxCoord, maxCoord)), 0).x;
  let c01 = textureLoad(heightTex, clamp(i + vec2<i32>(0, 1), vec2<i32>(0, 0), vec2<i32>(maxCoord, maxCoord)), 0).x;
  let c11 = textureLoad(heightTex, clamp(i + vec2<i32>(1, 1), vec2<i32>(0, 0), vec2<i32>(maxCoord, maxCoord)), 0).x;
  return mix(mix(c00, c10, f.x), mix(c01, c11, f.x), f.y);
}

fn sample_minmax(level: i32, p: vec2<f32>) -> vec2<f32> {
  let baseRes = max(u32(params[1].y), 1u);
  let shift = u32(max(level, 0));
  let size = max(baseRes >> shift, 1u);
  let maxCoord = i32(size - 1u);
  let uv = world_to_uv(p);
  let coord = vec2<i32>(floor(uv * vec2<f32>(f32(maxCoord), f32(maxCoord))));
  let mm = textureLoad(minMaxTex, clamp(coord, vec2<i32>(0, 0), vec2<i32>(maxCoord, maxCoord)), level);
  return mm.xy;
}

fn step_to_cell_boundary(level: i32, p: vec2<f32>, dir: vec2<f32>) -> f32 {
  let extent = params[1].x;
  let worldSize = extent * 2.0;
  let baseRes = max(u32(params[1].y), 1u);
  let shift = u32(max(level, 0));
  let gridSize = max(baseRes >> shift, 1u);
  let cellSize = worldSize / f32(gridSize);

  let grid = floor((p + vec2<f32>(extent, extent)) / cellSize);
  let cellMin = -vec2<f32>(extent, extent) + grid * cellSize;

  var tx = 1e9;
  if (abs(dir.x) > 1e-6) {
    var nextX = cellMin.x;
    if (dir.x >= 0.0) {
      nextX = cellMin.x + cellSize;
    }
    tx = (nextX - p.x) / dir.x;
    if (tx <= 1e-4) {
      tx = tx + cellSize / max(abs(dir.x), 1e-6);
    }
    if (tx < 0.0) {
      tx = 1e9;
    }
  }

  var tz = 1e9;
  if (abs(dir.y) > 1e-6) {
    var nextZ = cellMin.y;
    if (dir.y >= 0.0) {
      nextZ = cellMin.y + cellSize;
    }
    tz = (nextZ - p.y) / dir.y;
    if (tz <= 1e-4) {
      tz = tz + cellSize / max(abs(dir.y), 1e-6);
    }
    if (tz < 0.0) {
      tz = 1e9;
    }
  }

  return min(tx, tz);
}

fn hierarchical_skip(rayPos: vec3<f32>, rayDir: vec3<f32>) -> f32 {
  let maxMip = max(i32(params[1].z), 1);
  var level = max(maxMip - 5, 0);
  loop {
    let mm = sample_minmax(level, rayPos.xz);
    if (rayPos.y > mm.y + SAFETY_MARGIN) {
      let jump = step_to_cell_boundary(level, rayPos.xz, rayDir.xz);
      if (jump < 1e8) {
        return jump;
      }
    }

    if (level == 0) {
      break;
    }
    level = level - 1;
  }
  return 0.0;
}

fn normal_at(p: vec2<f32>, rayT: f32) -> vec3<f32> {
  let texelWorld = (params[1].x * 2.0) / max(params[1].y, 1.0);
  let footprintRatio = max(
    estimate_pixel_footprint_world(rayT) / max(texelWorld, 1e-6),
    1.0
  );
  let diffScale = clamp(2.0 + (footprintRatio - 1.0) * 0.6, 2.0, 14.0);
  let e = texelWorld * diffScale;
  let hx = sample_height(p + vec2<f32>(e, 0.0)) - sample_height(p - vec2<f32>(e, 0.0));
  let hz = sample_height(p + vec2<f32>(0.0, e)) - sample_height(p - vec2<f32>(0.0, e));
  return normalize(vec3<f32>(-hx, 2.0 * e, -hz));
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

fn estimate_pixel_footprint_world(rayT: f32) -> f32 {
  let resolutionY = max(params[0].y, 1.0);
  return (2.0 * max(rayT, 0.0) * max(params[1].w, 1e-4)) / resolutionY;
}

fn normal_from_slope(sx: f32, sy: f32) -> vec3<f32> {
  return normalize(vec3<f32>(-sx, 1.0, -sy));
}

fn slope_stats_at(p: vec2<f32>, rayT: f32) -> SlopeStats {
  let baseRes = max(i32(params[1].y), 1);
  let maxCoord = baseRes - 1;
  let texelWorld = (params[1].x * 2.0) / max(params[1].y, 1.0);
  let center = world_to_uv(p) * vec2<f32>(f32(maxCoord), f32(maxCoord));
  let footprintWorld = max(estimate_pixel_footprint_world(rayT) * 1.15, texelWorld);
  let radius = clamp(footprintWorld / max(texelWorld, 1e-6), 0.5, f32(maxCoord));
  let minCoord = clamp(
    vec2<i32>(floor(center - vec2<f32>(radius, radius))),
    vec2<i32>(0, 0),
    vec2<i32>(maxCoord, maxCoord)
  );
  let maxCoordRect = clamp(
    vec2<i32>(ceil(center + vec2<f32>(radius, radius))),
    vec2<i32>(0, 0),
    vec2<i32>(maxCoord, maxCoord)
  );
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
  let cov = meanSxSy - meanSx * meanSy;
  let variance = max(varX + varY + abs(cov) * 0.5, 0.0);
  return SlopeStats(normal_from_slope(meanSx, meanSy), variance);
}

fn decode_rgbe(encoded: vec4<f32>) -> vec3<f32> {
  let rgbe = encoded * 255.0;
  if (rgbe.w <= 0.0) {
    return vec3<f32>(0.0, 0.0, 0.0);
  }
  let scale = exp2(rgbe.w - 128.0) / 256.0;
  return rgbe.xyz * scale;
}

fn sample_env(direction: vec3<f32>) -> vec3<f32> {
  let dir = normalize(direction);
  let phi = atan2(dir.z, dir.x);
  let theta = acos(clamp(dir.y, -1.0, 1.0));
  let uv = vec2<f32>(
    fract(phi / (2.0 * PI) + 0.5),
    clamp(theta / PI, 0.0, 1.0)
  );
  return decode_rgbe(textureSampleLevel(envTex, envSampler, uv, 0.0));
}

fn tonemap_aces(color: vec3<f32>) -> vec3<f32> {
  let a = 2.51;
  let b = 0.03;
  let c = 2.43;
  let d = 0.59;
  let e = 0.14;
  return clamp((color * (a * color + b)) / (color * (c * color + d) + e), vec3<f32>(0.0), vec3<f32>(1.0));
}

@fragment
fn fs_main(@builtin(position) fragCoord: vec4<f32>) -> @location(0) vec4<f32> {
  let resolution = params[0].xy;
  let farClip = params[0].w;
  let extent = params[1].x;
  let tanHalfFov = params[1].w;
  let aspect = resolution.x / max(resolution.y, 1.0);

  var ndc = (fragCoord.xy / resolution) * 2.0 - vec2<f32>(1.0, 1.0);
  ndc.y = -ndc.y;

  let ro = params[2].xyz;
  let right = params[3].xyz;
  let up = params[4].xyz;
  let forward = params[5].xyz;
  let lightDir = normalize(params[6].xyz);
  let rd = normalize(
    forward + right * ndc.x * aspect * tanHalfFov + up * ndc.y * tanHalfFov
  );

  var t = 0.0;
  var hit = false;
  var lastT = 0.0;
  var hasLast = false;
  var hitPos = vec3<f32>(0.0, 0.0, 0.0);

  for (var step = 0; step < MAX_TRACE_STEPS; step = step + 1) {
    let p = ro + rd * t;
    if (abs(p.x) > extent || abs(p.z) > extent || t > farClip) {
      break;
    }

    let h = sample_height(p.xz);
    let delta = p.y - h;
    if (delta <= HIT_EPS) {
      var a = lastT;
      var b = t;
      if (hasLast) {
        for (var i = 0; i < REFINE_STEPS; i = i + 1) {
          let m = (a + b) * 0.5;
          let pm = ro + rd * m;
          let d = pm.y - sample_height(pm.xz);
          if (d > 0.0) {
            a = m;
          } else {
            b = m;
          }
        }
      }
      t = (a + b) * 0.5;
      hitPos = ro + rd * t;
      hit = true;
      break;
    }

    var marchStep = clamp(delta * 0.35, MIN_STEP, MAX_STEP);
    let skip = hierarchical_skip(p, rd);
    if (skip > 0.0) {
      let down = max(-rd.y, 1e-4);
      let verticalLimit = max(delta / down, MIN_STEP);
      let skipLimit = min(verticalLimit * 0.75, MAX_SKIP_STEP);
      marchStep = max(marchStep, min(skip + 0.03, skipLimit));
    }

    lastT = t;
    hasLast = true;
    t = t + marchStep;
  }

  var color = sample_env(rd) * IBL_EXPOSURE;

  if (hit) {
    let geoNormal = normal_at(hitPos.xz, t);
    let slopeStats = slope_stats_at(hitPos.xz, t);
    let texelWorld = (params[1].x * 2.0) / max(params[1].y, 1.0);
    let footprintRatio = estimate_pixel_footprint_world(t) / max(texelWorld, 1e-6);
    let satBlend = clamp((footprintRatio - 1.0) * 0.55, 0.0, 1.0);
    let n = normalize(mix(geoNormal, slopeStats.normal, satBlend));
    let aaRough = clamp(sqrt(max(slopeStats.variance, 0.0)) * 0.35, 0.0, 0.92);
    let v = normalize(ro - hitPos);
    let nDotL = max(dot(n, lightDir), 0.0);
    let nDotV = max(dot(n, v), 0.0);
    let h = normalize(v + lightDir);
    let nDotH = max(dot(n, h), 0.0);
    let hNorm = clamp((hitPos.y + 130.0) / 420.0, 0.0, 1.0);
    let baseTint = mix(
      vec3<f32>(0.07, 0.15, 0.17),
      vec3<f32>(0.73, 0.68, 0.55),
      hNorm
    );

    let reflectDir = reflect(-v, n);
    let envSpec = sample_env(reflectDir) * IBL_EXPOSURE;
    let envDiff = sample_env(n) * IBL_EXPOSURE;
    let f0 = vec3<f32>(0.11, 0.12, 0.13);
    let fresnel = pow(1.0 - nDotV, 5.0);
    let F = f0 + (vec3<f32>(1.0) - f0) * fresnel;
    let specPower = mix(300.0, 42.0, aaRough);
    let directSpec = pow(nDotH, specPower) * nDotL * mix(5.5, 1.25, aaRough);

    let diffuse = baseTint * envDiff * 0.14;
    let specular = envSpec * (F * mix(1.65, 0.75, aaRough)) + vec3<f32>(directSpec);
    let directFill = baseTint * nDotL * 0.06;
    let lit = diffuse + specular + directFill;
    color = lit;
  }

  color = tonemap_aces(color);
  color = pow(color, vec3<f32>(1.0 / 2.2));
  return vec4<f32>(color, 1.0);
}
`;
  }

  private buildHeightShader(heightCode: string): string {
    return `
${heightCode}

@group(0) @binding(0) var<uniform> buildParams: array<vec4<f32>, 1>;
@group(0) @binding(1) var heightOut: texture_storage_2d<r32float, write>;
@group(0) @binding(2) var minMaxOut: texture_storage_2d<${this.minMaxFormat}, write>;

@compute @workgroup_size(8, 8, 1)
fn cs_build(@builtin(global_invocation_id) gid: vec3<u32>) {
  let baseResolution = u32(buildParams[0].y);
  if (gid.x >= baseResolution || gid.y >= baseResolution) {
    return;
  }

  let n = f32(baseResolution);
  let uv = (vec2<f32>(f32(gid.x), f32(gid.y)) + vec2<f32>(0.5, 0.5)) / n;
  let worldHalfExtent = buildParams[0].x;
  let p = (uv * 2.0 - vec2<f32>(1.0, 1.0)) * worldHalfExtent;
  let h = height(p);

  textureStore(heightOut, vec2<i32>(gid.xy), vec4<f32>(h, 0.0, 0.0, 1.0));
  textureStore(minMaxOut, vec2<i32>(gid.xy), vec4<f32>(h, h, 0.0, 1.0));
}
`;
  }

  private buildReduceShader(): string {
    return `
@group(0) @binding(0) var prevLevel: texture_2d<f32>;
@group(0) @binding(1) var nextLevel: texture_storage_2d<${this.minMaxFormat}, write>;
@group(0) @binding(2) var<uniform> reduceParams: array<vec4<f32>, 1>;

@compute @workgroup_size(8, 8, 1)
fn cs_reduce(@builtin(global_invocation_id) gid: vec3<u32>) {
  let dstSize = vec2<u32>(u32(reduceParams[0].x), u32(reduceParams[0].y));
  if (gid.x >= dstSize.x || gid.y >= dstSize.y) {
    return;
  }

  let srcBase = vec2<i32>(gid.xy * 2u);
  let a = textureLoad(prevLevel, srcBase + vec2<i32>(0, 0), 0).xy;
  let b = textureLoad(prevLevel, srcBase + vec2<i32>(1, 0), 0).xy;
  let c = textureLoad(prevLevel, srcBase + vec2<i32>(0, 1), 0).xy;
  let d = textureLoad(prevLevel, srcBase + vec2<i32>(1, 1), 0).xy;

  let minHeight = min(min(a.x, b.x), min(c.x, d.x));
  let maxHeight = max(max(a.y, b.y), max(c.y, d.y));
  textureStore(nextLevel, vec2<i32>(gid.xy), vec4<f32>(minHeight, maxHeight, 0.0, 1.0));
}
`;
  }

  private buildSatRowShader(): string {
    return `
@group(0) @binding(0) var heightTex: texture_2d<f32>;
@group(0) @binding(1) var satRowAOut: texture_storage_2d<rgba32float, write>;
@group(0) @binding(2) var satRowBOut: texture_storage_2d<r32float, write>;
@group(0) @binding(3) var<uniform> buildParams: array<vec4<f32>, 1>;

@compute @workgroup_size(64, 1, 1)
fn cs_sat_row(@builtin(global_invocation_id) gid: vec3<u32>) {
  let baseResolution = u32(buildParams[0].y);
  if (gid.x >= baseResolution) {
    return;
  }

  let y = i32(gid.x);
  let maxCoord = i32(baseResolution - 1u);
  let texelWorld = (buildParams[0].x * 2.0) / max(f32(baseResolution), 1.0);
  let invSlopeScale = 1.0 / max(2.0 * texelWorld, 1e-6);
  var sumA = vec4<f32>(0.0);
  var sumB = 0.0;

  for (var x = 0; x <= maxCoord; x = x + 1) {
    let hL = textureLoad(heightTex, vec2<i32>(max(x - 1, 0), y), 0).x;
    let hR = textureLoad(heightTex, vec2<i32>(min(x + 1, maxCoord), y), 0).x;
    let hD = textureLoad(heightTex, vec2<i32>(x, max(y - 1, 0)), 0).x;
    let hU = textureLoad(heightTex, vec2<i32>(x, min(y + 1, maxCoord)), 0).x;
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
  let baseResolution = u32(buildParams[0].y);
  if (gid.x >= baseResolution) {
    return;
  }

  let x = i32(gid.x);
  let maxCoord = i32(baseResolution - 1u);
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
