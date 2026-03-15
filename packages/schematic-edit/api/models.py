from __future__ import annotations

from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, field_validator, model_validator


def to_camel(value: str) -> str:
    head, *tail = value.split("_")
    return head + "".join(part.capitalize() for part in tail)


class ApiModel(BaseModel):
    model_config = ConfigDict(alias_generator=to_camel, populate_by_name=True, extra="forbid")


class SweepSettings(ApiModel):
    start_ghz: float = Field(gt=0)
    stop_ghz: float = Field(gt=0)
    points: int = Field(ge=11, le=2001)
    port_impedance_ohm: float = Field(gt=0)

    @model_validator(mode="after")
    def validate_range(self) -> "SweepSettings":
        if self.stop_ghz <= self.start_ghz:
            raise ValueError("stopGhz must be larger than startGhz")
        return self


class Point(ApiModel):
    x: float
    y: float


class SchematicNode(ApiModel):
    id: str = Field(min_length=1)
    label: str = Field(min_length=1)
    kind: Literal["port", "ground", "resistor", "inductor", "capacitor"]
    position: Point | None = None
    role: Literal["input", "output"] | None = None
    value: float | None = None
    unit: str | None = None

    @field_validator("unit")
    @classmethod
    def normalize_unit(cls, value: str | None) -> str | None:
        return value.strip() if value is not None else None

    @model_validator(mode="after")
    def validate_shape(self) -> "SchematicNode":
        valid_units = {
            "resistor": {"mohm", "ohm", "kohm"},
            "inductor": {"pH", "nH", "uH"},
            "capacitor": {"fF", "pF", "nF"},
        }

        if self.kind == "port":
            if self.role not in {"input", "output"}:
                raise ValueError(f"Port node {self.id!r} must include role=input|output")
            if self.value is not None or self.unit is not None:
                raise ValueError(f"Port node {self.id!r} cannot define value or unit")
            return self

        if self.kind == "ground":
            if self.role is not None or self.value is not None or self.unit is not None:
                raise ValueError(f"Ground node {self.id!r} cannot define role, value, or unit")
            return self

        if self.role is not None:
            raise ValueError(f"Component node {self.id!r} cannot define a port role")
        if self.value is None or self.value <= 0:
            raise ValueError(f"Component node {self.id!r} must define a positive value")
        if self.unit not in valid_units[self.kind]:
            raise ValueError(f"Unsupported unit {self.unit!r} for {self.kind}")
        return self


class TerminalRef(ApiModel):
    node_id: str = Field(min_length=1)
    terminal: Literal["left", "right", "port"]


class SchematicEdge(ApiModel):
    id: str = Field(min_length=1)
    from_: TerminalRef = Field(alias="from")
    to: TerminalRef


class SchematicModel(ApiModel):
    name: str = Field(min_length=1)
    sweep: SweepSettings
    nodes: list[SchematicNode] = Field(default_factory=list, max_length=128)
    edges: list[SchematicEdge] = Field(default_factory=list, max_length=256)

    @model_validator(mode="after")
    def validate_graph(self) -> "SchematicModel":
        if len({node.id for node in self.nodes}) != len(self.nodes):
            raise ValueError("Node ids must be unique")
        if len({edge.id for edge in self.edges}) != len(self.edges):
            raise ValueError("Edge ids must be unique")

        node_map = {node.id: node for node in self.nodes}
        input_ports = [node for node in self.nodes if node.kind == "port" and node.role == "input"]
        output_ports = [node for node in self.nodes if node.kind == "port" and node.role == "output"]

        if len(input_ports) != 1 or len(output_ports) != 1:
            raise ValueError("Schematic must contain exactly one input port and one output port")

        for edge in self.edges:
            for endpoint in (edge.from_, edge.to):
                node = node_map.get(endpoint.node_id)
                if node is None:
                    raise ValueError(f"Edge {edge.id!r} references unknown node {endpoint.node_id!r}")
                valid_terminals = {"port"} if node.kind in {"port", "ground"} else {"left", "right"}
                if endpoint.terminal not in valid_terminals:
                    raise ValueError(
                        f"Terminal {endpoint.terminal!r} is invalid for node {node.id!r} ({node.kind})"
                    )

            if edge.from_.node_id == edge.to.node_id and edge.from_.terminal == edge.to.terminal:
                raise ValueError(f"Edge {edge.id!r} cannot connect a terminal to itself")

        return self


class SolvePoint(ApiModel):
    frequency_hz: float
    s11_db: float
    s21_db: float
    s11_phase_deg: float
    s21_phase_deg: float


class SolveSummary(ApiModel):
    best_match_hz: float | None
    midband_s11_db: float
    midband_s21_db: float
    component_count: int
    node_count: int
    edge_count: int
    topology_label: str


class SolveResponse(ApiModel):
    points: list[SolvePoint]
    summary: SolveSummary
    warnings: list[str] = Field(default_factory=list)
