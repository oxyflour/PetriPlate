export type DebugViewId = "beauty" | "footprint" | "coverage" | "normal";

export type DebugViewPreset = {
  id: DebugViewId;
  label: string;
  description: string;
};

export const DEBUG_VIEWS: DebugViewPreset[] = [
  {
    id: "beauty",
    label: "Beauty",
    description: "Metal shading with HDR IBL plus compute-precomputed roughness and anisotropy."
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
  }
];
