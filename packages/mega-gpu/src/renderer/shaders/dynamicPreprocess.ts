export function buildHeightToSlopeShader(heightCode: string): string {
  return `
${heightCode}

@group(0) @binding(0) var slopeTexOut: texture_storage_2d<rgba16float, write>;
@group(0) @binding(1) var<uniform> buildParams: array<vec4<f32>, 2>;

fn atlas_world_position_from_texel(texel: vec2<i32>) -> vec2<f32> {
  let resolution = max(i32(buildParams[0].x + 0.5), 1);
  let totalSize = max(buildParams[0].y * buildParams[0].z, buildParams[0].z);
  let clamped = clamp(texel, vec2<i32>(0, 0), vec2<i32>(resolution - 1, resolution - 1));
  let uv = (vec2<f32>(clamped) + vec2<f32>(0.5, 0.5)) / max(buildParams[0].x, 1.0);
  return uv * totalSize;
}

fn sample_slope(texel: vec2<i32>) -> vec2<f32> {
  let p = atlas_world_position_from_texel(texel);
  let pL = atlas_world_position_from_texel(texel + vec2<i32>(-1, 0));
  let pR = atlas_world_position_from_texel(texel + vec2<i32>(1, 0));
  let pD = atlas_world_position_from_texel(texel + vec2<i32>(0, -1));
  let pU = atlas_world_position_from_texel(texel + vec2<i32>(0, 1));

  let hL = height(pL);
  let hR = height(pR);
  let hD = height(pD);
  let hU = height(pU);

  let dx = max(pR.x - pL.x, 1e-6);
  let dy = max(pU.y - pD.y, 1e-6);
  return vec2<f32>((hR - hL) / dx, (hU - hD) / dy);
}

@compute @workgroup_size(8, 8, 1)
fn cs_height_to_slope(@builtin(global_invocation_id) gid: vec3<u32>) {
  let resolution = u32(max(buildParams[0].x, 1.0));
  if (gid.x >= resolution || gid.y >= resolution) {
    return;
  }

  let texel = vec2<i32>(i32(gid.x), i32(gid.y));
  let slope = sample_slope(texel);
  textureStore(slopeTexOut, texel, vec4<f32>(slope, 0.0, 1.0));
}
`;
}

export function buildSatRowShader(heightCode: string): string {
  return `
${heightCode}

@group(0) @binding(0) var satRowAOut: texture_storage_2d<rgba32float, write>;
@group(0) @binding(1) var satRowBOut: texture_storage_2d<r32float, write>;
@group(0) @binding(2) var<uniform> buildParams: array<vec4<f32>, 2>;

fn atlas_world_position_from_texel(texel: vec2<i32>) -> vec2<f32> {
  let resolution = max(i32(buildParams[0].x + 0.5), 1);
  let totalSize = max(buildParams[0].y * buildParams[0].z, buildParams[0].z);
  let clamped = clamp(texel, vec2<i32>(0, 0), vec2<i32>(resolution - 1, resolution - 1));
  let uv = (vec2<f32>(clamped) + vec2<f32>(0.5, 0.5)) / max(buildParams[0].x, 1.0);
  return uv * totalSize;
}

fn sample_slope(texel: vec2<i32>) -> vec2<f32> {
  let p = atlas_world_position_from_texel(texel);
  let pL = atlas_world_position_from_texel(texel + vec2<i32>(-1, 0));
  let pR = atlas_world_position_from_texel(texel + vec2<i32>(1, 0));
  let pD = atlas_world_position_from_texel(texel + vec2<i32>(0, -1));
  let pU = atlas_world_position_from_texel(texel + vec2<i32>(0, 1));

  let hL = height(pL);
  let hR = height(pR);
  let hD = height(pD);
  let hU = height(pU);

  let dx = max(pR.x - pL.x, 1e-6);
  let dy = max(pU.y - pD.y, 1e-6);
  return vec2<f32>((hR - hL) / dx, (hU - hD) / dy);
}

@compute @workgroup_size(64, 1, 1)
fn cs_sat_row(@builtin(global_invocation_id) gid: vec3<u32>) {
  let resolution = u32(max(buildParams[0].x, 1.0));
  if (gid.x >= resolution) {
    return;
  }

  let y = i32(gid.x);
  let maxCoord = i32(resolution - 1u);
  var sumA = vec4<f32>(0.0);
  var sumB = 0.0;

  for (var x = 0; x <= maxCoord; x = x + 1) {
    let slope = sample_slope(vec2<i32>(x, y));
    let sx = slope.x;
    let sy = slope.y;

    sumA = sumA + vec4<f32>(sx, sy, sx * sx, sy * sy);
    sumB = sumB + sx * sy;
    textureStore(satRowAOut, vec2<i32>(x, y), sumA);
    textureStore(satRowBOut, vec2<i32>(x, y), vec4<f32>(sumB, 0.0, 0.0, 1.0));
  }
}
`;
}
