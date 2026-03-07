export type HeightPreset = {
  id: string;
  label: string;
  description: string;
  source: string;
};

export const DEFAULT_HEIGHT_WGSL = `// p is in millimeters on the plate surface.
// Return height in millimeters.

fn pyramid_cell(uv: vec2<f32>) -> f32 {
  let q = abs(uv - vec2<f32>(0.5, 0.5)) * 2.0;
  return max(1.0 - max(q.x, q.y), 0.0);
}

fn height(p: vec2<f32>) -> f32 {
  let cell = fract(p / 0.3);
  let primary = pyramid_cell(cell);
  let secondary = pyramid_cell(fract(cell * 2.0 + vec2<f32>(0.19, 0.11))) * 0.24;
  return (primary + secondary) * 0.038;
}`;

export const SINE_STRIPES_WGSL = `fn height(p: vec2<f32>) -> f32 {
  let x = p.x / 0.3;
  let y = p.y / 0.3;
  let stripes = sin(x * 6.2831853) * 0.5 + 0.5;
  let warp = sin(x * 18.849556 + sin(y * 6.2831853) * 1.3) * 0.08;
  return clamp(stripes * 0.032 + warp * 0.012, 0.0, 0.045);
}`;

export const DIMPLE_LATTICE_WGSL = `fn smooth_peak(v: f32) -> f32 {
  let x = clamp(v, 0.0, 1.0);
  return x * x * (3.0 - 2.0 * x);
}

fn height(p: vec2<f32>) -> f32 {
  let cell = fract(p / 0.3) - vec2<f32>(0.5, 0.5);
  let radius = length(cell) * 2.0;
  let dimple = 1.0 - smooth_peak(clamp(radius, 0.0, 1.0));
  return dimple * 0.03;
}`;

export const HEIGHT_PRESETS: HeightPreset[] = [
  {
    id: "periodic-pyramid",
    label: "Periodic Pyramid",
    description: "Facet-heavy periodic cell that stresses highlight aliasing.",
    source: DEFAULT_HEIGHT_WGSL
  },
  {
    id: "sine-stripes",
    label: "Sine Stripes",
    description: "Directional grooves for anisotropic highlights.",
    source: SINE_STRIPES_WGSL
  },
  {
    id: "dimple-lattice",
    label: "Dimple Lattice",
    description: "Softer rounded pits with wider filtered lobes.",
    source: DIMPLE_LATTICE_WGSL
  }
];
