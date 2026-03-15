export type ShadingModeId = "glint" | "macro";

export type ShadingModePreset = {
  id: ShadingModeId;
  label: string;
  description: string;
};

export type DebugViewId =
  | "beauty"
  | "footprint"
  | "coverage"
  | "normal"
  | "slope"
  | "histogram"
  | "glint";

export type DebugViewPreset = {
  id: DebugViewId;
  label: string;
  description: string;
};

export const SHADING_MODES: ShadingModePreset[] = [
  {
    id: "glint",
    label: "Glint",
    description:
      "Histogram-driven v0 glint path with directional sparkle lookup plus macro IBL fallback."
  },
  {
    id: "macro",
    label: "Macro",
    description: "Existing SAT slope-moments baseline mapped into anisotropic GGX."
  }
];

export const DEBUG_VIEWS: DebugViewPreset[] = [
  {
    id: "beauty",
    label: "Beauty",
    description: "Beauty shading for the active macro or glint path."
  },
  {
    id: "footprint",
    label: "Footprint mm",
    description: "Visualize the projected world-space footprint size of one pixel."
  },
  {
    id: "coverage",
    label: "Cell Coverage",
    description: "Estimate how many 0.3 mm cells each pixel spans at the current view."
  },
  {
    id: "normal",
    label: "Mean Normal",
    description: "Inspect the footprint-filtered mean normal from the precomputed slope moments."
  },
  {
    id: "slope",
    label: "Slope",
    description: "Inspect the procedural height-to-slope texture used to build glint histograms."
  },
  {
    id: "histogram",
    label: "Histogram",
    description: "Show the center-tile slope histogram in slope space with the target-slope marker."
  },
  {
    id: "glint",
    label: "Glint Density",
    description: "Heatmap of the target-slope lookup used by the v0 glint estimator."
  }
];
