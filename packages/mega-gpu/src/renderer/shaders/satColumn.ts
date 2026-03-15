export const SAT_COLUMN_SHADER = `
@group(0) @binding(0) var satRowAIn: texture_2d<f32>;
@group(0) @binding(1) var satRowBIn: texture_2d<f32>;
@group(0) @binding(2) var satOutA: texture_storage_2d<rgba32float, write>;
@group(0) @binding(3) var satOutB: texture_storage_2d<r32float, write>;
@group(0) @binding(4) var<uniform> buildParams: array<vec4<f32>, 2>;

@compute @workgroup_size(64, 1, 1)
fn cs_sat_column(@builtin(global_invocation_id) gid: vec3<u32>) {
  let resolution = u32(max(buildParams[0].x, 1.0));
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
