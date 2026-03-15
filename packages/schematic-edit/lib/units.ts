import type { ComponentKind, ComponentTopology, ComponentUnit } from "./types";

type UnitOption = {
  value: ComponentUnit;
  label: string;
};

const UNIT_OPTIONS: Record<ComponentKind, UnitOption[]> = {
  resistor: [
    { value: "mohm", label: "mOhm" },
    { value: "ohm", label: "Ohm" },
    { value: "kohm", label: "kOhm" }
  ],
  inductor: [
    { value: "pH", label: "pH" },
    { value: "nH", label: "nH" },
    { value: "uH", label: "uH" }
  ],
  capacitor: [
    { value: "fF", label: "fF" },
    { value: "pF", label: "pF" },
    { value: "nF", label: "nF" }
  ]
};

const DEFAULT_UNITS: Record<ComponentKind, ComponentUnit> = {
  resistor: "ohm",
  inductor: "nH",
  capacitor: "pF"
};

const DEFAULT_VALUES: Record<ComponentKind, Record<ComponentTopology, number>> = {
  resistor: {
    series: 50,
    shunt: 1000
  },
  inductor: {
    series: 6.8,
    shunt: 18
  },
  capacitor: {
    series: 0.8,
    shunt: 1.2
  }
};

export function getUnitOptions(kind: ComponentKind) {
  return UNIT_OPTIONS[kind];
}

export function getDefaultUnit(kind: ComponentKind) {
  return DEFAULT_UNITS[kind];
}

export function getDefaultValue(kind: ComponentKind, topology: ComponentTopology) {
  return DEFAULT_VALUES[kind][topology];
}

export function formatEngineering(value: number, digits = 2) {
  if (!Number.isFinite(value)) {
    return "--";
  }
  return value.toFixed(digits);
}

export function formatDb(value: number) {
  if (!Number.isFinite(value)) {
    return "--";
  }
  return `${value.toFixed(2)} dB`;
}

export function formatFrequency(frequencyHz: number | null) {
  if (!frequencyHz || !Number.isFinite(frequencyHz)) {
    return "--";
  }

  if (frequencyHz >= 1e9) {
    return `${(frequencyHz / 1e9).toFixed(3)} GHz`;
  }

  if (frequencyHz >= 1e6) {
    return `${(frequencyHz / 1e6).toFixed(3)} MHz`;
  }

  return `${frequencyHz.toFixed(0)} Hz`;
}

export function formatComponentValue(value: number, unit: ComponentUnit) {
  return `${formatEngineering(value)} ${unit}`;
}
