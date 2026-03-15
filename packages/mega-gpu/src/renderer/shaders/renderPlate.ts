export const RENDER_SHADER = `
const PI = 3.141592653589793;
const HEAT_A = vec3<f32>(0.03, 0.12, 0.18);
const HEAT_B = vec3<f32>(0.16, 0.54, 0.73);
const HEAT_C = vec3<f32>(0.95, 0.72, 0.29);
const HEAT_D = vec3<f32>(1.0, 0.35, 0.1);

const DEBUG_BEAUTY = 0;
const DEBUG_FOOTPRINT = 1;
const DEBUG_COVERAGE = 2;
const DEBUG_NORMAL = 3;
const DEBUG_SLOPE = 4;
const DEBUG_HISTOGRAM = 5;
const DEBUG_GLINT = 6;

const SHADING_MACRO = 0;
const SHADING_GLINT = 1;

@group(0) @binding(0) var<uniform> params: array<vec4<f32>, 10>;
@group(0) @binding(1) var envTex: texture_2d<f32>;
@group(0) @binding(2) var envSampler: sampler;
@group(0) @binding(3) var slopeSatTexA: texture_2d<f32>;
@group(0) @binding(4) var slopeSatTexB: texture_2d<f32>;
@group(0) @binding(5) var slopeTex: texture_2d<f32>;
@group(0) @binding(6) var<storage, read> histPdf: array<f32>;

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

fn atlas_size_mm() -> f32 {
  return max(params[6].w * params[1].y, params[1].y);
}

fn slope_texel_from_world(p: vec2<f32>) -> vec2<i32> {
  let resolution = max(i32(params[1].w + 0.5), 1);
  let uv = fract(p / atlas_size_mm());
  return clamp(
    vec2<i32>(floor(uv * f32(resolution))),
    vec2<i32>(0, 0),
    vec2<i32>(resolution - 1, resolution - 1)
  );
}

fn slope_sample(p: vec2<f32>) -> vec2<f32> {
  return textureLoad(slopeTex, slope_texel_from_world(p), 0).xy;
}

fn tile_index_from_world(p: vec2<f32>) -> i32 {
  let texel = slope_texel_from_world(p);
  let tileSize = max(i32(params[8].y + 0.5), 1);
  let tilesPerAxis = max(i32(params[8].w + 0.5), 1);
  let tile = clamp(
    texel / tileSize,
    vec2<i32>(0, 0),
    vec2<i32>(tilesPerAxis - 1, tilesPerAxis - 1)
  );
  return tile.y * tilesPerAxis + tile.x;
}

fn hist_bins_per_axis() -> i32 {
  return max(i32(params[8].z + 0.5), 1);
}

fn histogram_bin_width() -> f32 {
  return (2.0 * max(params[9].x, 1e-4)) / max(params[8].z, 1.0);
}

fn histogram_bin_area() -> f32 {
  let width = histogram_bin_width();
  return max(width * width, 1e-5);
}

fn target_slope_from_half_vector(h: vec3<f32>) -> vec2<f32> {
  let denom = max(h.y, 1e-4);
  return vec2<f32>(-h.x / denom, -h.z / denom);
}

fn slope_to_hist_bin(slope: vec2<f32>) -> vec2<i32> {
  let sMax = max(params[9].x, 1e-4);
  let bins = hist_bins_per_axis();
  let normalized = clamp(
    (slope / sMax) * 0.5 + vec2<f32>(0.5, 0.5),
    vec2<f32>(0.0, 0.0),
    vec2<f32>(0.999999, 0.999999)
  );
  return vec2<i32>(floor(normalized * f32(bins)));
}

fn hist_offset(tileIndex: i32, binCoord: vec2<i32>) -> u32 {
  let bins = hist_bins_per_axis();
  let tile = max(tileIndex, 0);
  let clamped = clamp(binCoord, vec2<i32>(0, 0), vec2<i32>(bins - 1, bins - 1));
  return u32(tile * bins * bins + clamped.y * bins + clamped.x);
}

fn hist_mass(tileIndex: i32, binCoord: vec2<i32>) -> f32 {
  return histPdf[hist_offset(tileIndex, binCoord)];
}

fn hist_density(tileIndex: i32, slope: vec2<f32>) -> f32 {
  let sMax = max(params[9].x, 1e-4);
  if (abs(slope.x) > sMax || abs(slope.y) > sMax) {
    return 0.0;
  }
  return hist_mass(tileIndex, slope_to_hist_bin(slope)) / histogram_bin_area();
}

fn glint_density(tileIndex: i32, targetSlope: vec2<f32>, footprint: FootprintInfo) -> f32 {
  let sMax = max(params[9].x, 1e-4);
  if (abs(targetSlope.x) > sMax || abs(targetSlope.y) > sMax) {
    return 0.0;
  }

  let bins = hist_bins_per_axis();
  let centerBin = slope_to_hist_bin(targetSlope);
  let radius = i32(clamp(floor(footprint.cellsCovered * params[9].z), 0.0, 2.0));
  var mass = 0.0;
  var taps = 0.0;

  for (var y = -2; y <= 2; y = y + 1) {
    for (var x = -2; x <= 2; x = x + 1) {
      if (abs(x) > radius || abs(y) > radius) {
        continue;
      }
      let coord = clamp(
        centerBin + vec2<i32>(x, y),
        vec2<i32>(0, 0),
        vec2<i32>(bins - 1, bins - 1)
      );
      mass = mass + hist_mass(tileIndex, coord);
      taps = taps + 1.0;
    }
  }

  return mass / max(histogram_bin_area() * max(taps, 1.0), 1e-5);
}

fn render_histogram_debug(ro: vec3<f32>, fragCoord: vec2<f32>) -> vec4<f32> {
  let resolution = max(params[0].xy, vec2<f32>(1.0, 1.0));
  let uv = fragCoord / resolution;
  let slope = (uv * 2.0 - vec2<f32>(1.0, 1.0)) * params[9].x;
  let centerPixel = resolution * 0.5;
  let centerHit = intersect_plate(ro, ray_dir_for_pixel(centerPixel));

  var tileIndex = 0;
  var markerSlope = vec2<f32>(1e5, 1e5);
  if (centerHit.valid) {
    let footprint = estimate_footprint(centerPixel, ro, centerHit);
    let viewDir = normalize(ro - centerHit.position);
    let lightDir = normalize(params[7].xyz);
    let halfVector = normalize(viewDir + lightDir);
    markerSlope = target_slope_from_half_vector(halfVector);
    tileIndex = tile_index_from_world(centerHit.position.xz);
  }

  let density = hist_density(tileIndex, slope);
  let display = clamp(log2(1.0 + density * 48.0) / 5.0, 0.0, 1.0);
  var color = heatmap(display);

  let binWidth = histogram_bin_width();
  let gridUv = abs(fract((slope / binWidth) * 0.5 + vec2<f32>(0.5, 0.5)) - vec2<f32>(0.5, 0.5));
  let grid = 1.0 - smoothstep(0.45, 0.5, max(gridUv.x, gridUv.y));
  color = mix(color, color * 0.68 + vec3<f32>(0.1, 0.12, 0.14), grid * 0.22);

  if (centerHit.valid) {
    let cross = min(abs(slope.x - markerSlope.x), abs(slope.y - markerSlope.y));
    let marker = 1.0 - smoothstep(binWidth * 0.2, binWidth * 0.55, cross);
    color = mix(color, vec3<f32>(1.0, 0.97, 0.9), marker);
  }

  return vec4<f32>(pow(color, vec3<f32>(1.0 / 2.2)), 1.0);
}

@fragment
fn fs_main(@builtin(position) fragCoord: vec4<f32>) -> @location(0) vec4<f32> {
  let ro = params[2].xyz;
  let debugView = i32(params[0].w + 0.5);
  if (debugView == DEBUG_HISTOGRAM) {
    return render_histogram_debug(ro, fragCoord.xy);
  }

  let rd = ray_dir_for_pixel(fragCoord.xy);
  let plateHit = intersect_plate(ro, rd);
  if (!plateHit.valid) {
    let bg = tonemap_aces(sample_env(rd, 0.0));
    return vec4<f32>(pow(bg, vec3<f32>(1.0 / 2.2)), 1.0);
  }

  let footprint = estimate_footprint(fragCoord.xy, ro, plateHit);
  let slopeStats = filtered_slope_stats(plateHit.position.xz, footprint, fragCoord.xy);
  let sampledSlope = slope_sample(plateHit.position.xz);
  let n = slopeStats.meanNormal;
  let v = normalize(ro - plateHit.position);
  let l = normalize(params[7].xyz);
  let h = normalize(v + l);

  if (debugView == DEBUG_FOOTPRINT) {
    let band = heatmap(clamp(footprint.sizeMm / 1.4, 0.0, 1.0));
    return vec4<f32>(pow(band, vec3<f32>(1.0 / 2.2)), 1.0);
  }

  if (debugView == DEBUG_COVERAGE) {
    let cov = heatmap(clamp(footprint.cellsCovered / 6.0, 0.0, 1.0));
    return vec4<f32>(pow(cov, vec3<f32>(1.0 / 2.2)), 1.0);
  }

  if (debugView == DEBUG_NORMAL) {
    let encoded = n * 0.5 + vec3<f32>(0.5);
    return vec4<f32>(pow(encoded, vec3<f32>(1.0 / 2.2)), 1.0);
  }

  if (debugView == DEBUG_SLOPE) {
    let slopeEncoded = clamp(
      vec3<f32>(
        sampledSlope.x / (2.0 * max(params[9].x, 1e-4)) + 0.5,
        sampledSlope.y / (2.0 * max(params[9].x, 1e-4)) + 0.5,
        clamp(length(sampledSlope) / max(params[9].x, 1e-4), 0.0, 1.0)
      ),
      vec3<f32>(0.0),
      vec3<f32>(1.0)
    );
    return vec4<f32>(pow(slopeEncoded, vec3<f32>(1.0 / 2.2)), 1.0);
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
  let directMacro = (d * g * fresnel) / max(4.0 * ndv * ndl, 1e-5) * ndl * params[6].z;

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

  let tileIndex = tile_index_from_world(plateHit.position.xz);
  let targetSlope = target_slope_from_half_vector(h);
  let density = glint_density(tileIndex, targetSlope, footprint);

  if (debugView == DEBUG_GLINT) {
    let glintDebug = heatmap(clamp(log2(1.0 + density * 32.0) / 5.0, 0.0, 1.0));
    return vec4<f32>(pow(glintDebug, vec3<f32>(1.0 / 2.2)), 1.0);
  }

  let glintScale = density * params[9].y / max(0.45 + footprint.cellsCovered * 0.65, 0.45);
  let directGlint = fresnel * ndl * glintScale;
  let shadingMode = i32(params[8].x + 0.5);
  let direct = select(directMacro, directMacro * 0.18 + directGlint, shadingMode == SHADING_GLINT);

  let edgeMask = smoothstep(
    params[1].x,
    params[1].x - 1.6,
    max(abs(plateHit.position.x), abs(plateHit.position.z))
  );

  var color = envSpec + grazing + direct;
  color = mix(color, color * 0.58, edgeMask);
  color = tonemap_aces(color);
  color = pow(color, vec3<f32>(1.0 / 2.2));
  return vec4<f32>(color, 1.0);
}
`;
