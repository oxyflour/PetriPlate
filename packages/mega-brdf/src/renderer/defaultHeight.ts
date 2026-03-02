export type HeightPreset = {
  id: string;
  label: string;
  source: string;
};

export const DEFAULT_HEIGHT_WGSL = `fn hash21(p: vec2<f32>) -> f32 {
  let h = dot(p, vec2<f32>(127.1, 311.7));
  return fract(sin(h) * 43758.5453123);
}

fn noise2(p: vec2<f32>) -> f32 {
  let i = floor(p);
  let f = fract(p);
  let a = hash21(i);
  let b = hash21(i + vec2<f32>(1.0, 0.0));
  let c = hash21(i + vec2<f32>(0.0, 1.0));
  let d = hash21(i + vec2<f32>(1.0, 1.0));
  let u = f * f * (3.0 - 2.0 * f);
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}

fn fbm(p: vec2<f32>) -> f32 {
  var sum = 0.0;
  var amp = 0.5;
  var freq = 1.0;
  for (var i = 0; i < 6; i = i + 1) {
    sum = sum + amp * noise2(p * freq);
    freq = freq * 2.02;
    amp = amp * 0.5;
  }
  return sum;
}

fn height(p: vec2<f32>) -> f32 {
  let macroNoise = fbm(p * 0.00028);
  let ridge = abs(fbm(p * 0.0012) * 2.0 - 1.0);
  let detail = noise2(p * 0.0055) * 10.0;
  return macroNoise * 250.0 + (1.0 - ridge) * 165.0 + detail - 120.0;
}`;

export const PERIODIC_PYRAMID_WGSL = `fn pyramid_cell(p: vec2<f32>) -> f32 {
  let q = abs(fract(p) - vec2<f32>(0.5, 0.5)) * 2.0;
  let spike = 1.0 - max(q.x, q.y);
  return max(spike, 0.0);
}

fn height(p: vec2<f32>) -> f32 {
  let uv = p * 0.00165;
  let major = pyramid_cell(uv);
  let minor = pyramid_cell(uv * 2.0 + vec2<f32>(0.3, 0.25)) * 0.32;
  let ridge = pyramid_cell(uv * 0.5 + vec2<f32>(0.15, -0.2)) * 0.46;
  return (major + minor + ridge) * 350.0 - 120.0;
}`;

export const SINE_STRIPES_WGSL = `fn height(p: vec2<f32>) -> f32 {
  let px = p.x * 0.0062;
  let py = p.y * 0.0028;
  let stripes = sin(px) * 0.5 + 0.5;
  let warped = sin(px * 2.8 + sin(py * 1.7) * 2.2) * 0.35;
  let cross = sin(py * 4.6 + px * 0.35) * 0.18;
  return (stripes * 0.72 + warped + cross) * 190.0 - 86.0;
}`;

export const HEIGHT_PRESETS: HeightPreset[] = [
  {
    id: "fractal-ridge",
    label: "分形山脊",
    source: DEFAULT_HEIGHT_WGSL
  },
  {
    id: "periodic-pyramid",
    label: "周期性金字塔",
    source: PERIODIC_PYRAMID_WGSL
  },
  {
    id: "sine-stripes",
    label: "正弦波条纹",
    source: SINE_STRIPES_WGSL
  }
];
