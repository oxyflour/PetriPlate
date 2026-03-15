export const BUILD_HISTOGRAM_SHADER = `
@group(0) @binding(0) var slopeTex: texture_2d<f32>;
@group(0) @binding(1) var<storage, read_write> histCounts: array<u32>;
@group(0) @binding(2) var<storage, read_write> histOverflow: array<u32>;
@group(0) @binding(3) var<uniform> buildParams: array<vec4<f32>, 2>;

var<workgroup> localBins: array<atomic<u32>, 256>;
var<workgroup> overflowCounter: atomic<u32>;

fn slope_to_bin_index(slope: vec2<f32>) -> u32 {
  let binsPerAxis = i32(max(buildParams[1].y, 1.0));
  let sMax = max(buildParams[1].z, 1e-4);
  let normalized = clamp(
    (slope / sMax) * 0.5 + vec2<f32>(0.5, 0.5),
    vec2<f32>(0.0, 0.0),
    vec2<f32>(0.999999, 0.999999)
  );
  let coord = vec2<i32>(floor(normalized * f32(binsPerAxis)));
  return u32(coord.y * binsPerAxis + coord.x);
}

@compute @workgroup_size(16, 16, 1)
fn cs_build_histogram(
  @builtin(workgroup_id) workgroupId: vec3<u32>,
  @builtin(local_invocation_id) localId: vec3<u32>
) {
  let tilesPerAxis = u32(max(buildParams[0].w, 1.0));
  if (workgroupId.x >= tilesPerAxis || workgroupId.y >= tilesPerAxis) {
    return;
  }

  let localIndex = localId.y * 16u + localId.x;
  atomicStore(&localBins[localIndex], 0u);
  if (localIndex == 0u) {
    atomicStore(&overflowCounter, 0u);
  }
  workgroupBarrier();

  let tileSize = u32(max(buildParams[1].x, 1.0));
  let texel = vec2<i32>(
    i32(workgroupId.x * tileSize + localId.x),
    i32(workgroupId.y * tileSize + localId.y)
  );
  let slope = textureLoad(slopeTex, texel, 0).xy;
  let sMax = max(buildParams[1].z, 1e-4);

  if (abs(slope.x) > sMax || abs(slope.y) > sMax) {
    atomicAdd(&overflowCounter, 1u);
  }

  let binIndex = slope_to_bin_index(clamp(slope, vec2<f32>(-sMax, -sMax), vec2<f32>(sMax, sMax)));
  atomicAdd(&localBins[binIndex], 1u);
  workgroupBarrier();

  let binsPerAxis = u32(max(buildParams[1].y, 1.0));
  let binsPerTile = binsPerAxis * binsPerAxis;
  let tileIndex = workgroupId.y * tilesPerAxis + workgroupId.x;
  histCounts[tileIndex * binsPerTile + localIndex] = atomicLoad(&localBins[localIndex]);

  if (localIndex == 0u) {
    histOverflow[tileIndex] = atomicLoad(&overflowCounter);
  }
}
`;

export const NORMALIZE_HISTOGRAM_SHADER = `
@group(0) @binding(0) var<storage, read> histCounts: array<u32>;
@group(0) @binding(1) var<storage, read_write> histPdf: array<f32>;
@group(0) @binding(2) var<uniform> buildParams: array<vec4<f32>, 2>;

@compute @workgroup_size(256, 1, 1)
fn cs_normalize_histogram(
  @builtin(workgroup_id) workgroupId: vec3<u32>,
  @builtin(local_invocation_id) localId: vec3<u32>
) {
  let tilesPerAxis = u32(max(buildParams[0].w, 1.0));
  let tileIndex = workgroupId.x;
  let tileCount = tilesPerAxis * tilesPerAxis;
  if (tileIndex >= tileCount) {
    return;
  }

  let binsPerAxis = u32(max(buildParams[1].y, 1.0));
  let binsPerTile = binsPerAxis * binsPerAxis;
  let binIndex = localId.x;
  if (binIndex >= binsPerTile) {
    return;
  }

  let sampleCount = max(buildParams[1].x * buildParams[1].x, 1.0);
  let flatIndex = tileIndex * binsPerTile + binIndex;
  histPdf[flatIndex] = f32(histCounts[flatIndex]) / sampleCount;
}
`;
