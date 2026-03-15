from __future__ import annotations

from collections import defaultdict
from dataclasses import dataclass

import numpy as np
import skrf as rf
from skrf.circuit import Circuit

from .models import SchematicModel, SchematicNode, SolvePoint, SolveResponse, SolveSummary

UNIT_SCALE = {
    "resistor": {
        "mohm": 1e-3,
        "ohm": 1.0,
        "kohm": 1e3,
    },
    "inductor": {
        "pH": 1e-12,
        "nH": 1e-9,
        "uH": 1e-6,
    },
    "capacitor": {
        "fF": 1e-15,
        "pF": 1e-12,
        "nF": 1e-9,
    },
}

PORT_PRIORITY = {
    "input": 0,
    "output": 1,
}


@dataclass(slots=True)
class NormalizedComponent:
    source: SchematicNode
    base_value: float


class UnionFind:
    def __init__(self) -> None:
        self.parent: dict[tuple[str, str], tuple[str, str]] = {}

    def add(self, item: tuple[str, str]) -> None:
        self.parent.setdefault(item, item)

    def find(self, item: tuple[str, str]) -> tuple[str, str]:
        parent = self.parent[item]
        if parent != item:
            self.parent[item] = self.find(parent)
        return self.parent[item]

    def union(self, left: tuple[str, str], right: tuple[str, str]) -> None:
        left_root = self.find(left)
        right_root = self.find(right)
        if left_root != right_root:
            self.parent[right_root] = left_root


def solve_schematic(schematic: SchematicModel) -> SolveResponse:
    frequency = rf.Frequency(
        start=schematic.sweep.start_ghz,
        stop=schematic.sweep.stop_ghz,
        npoints=schematic.sweep.points,
        unit="ghz",
    )
    z0 = schematic.sweep.port_impedance_ohm
    component_nodes = [node for node in schematic.nodes if node.kind in UNIT_SCALE]
    normalized_components = {
        node.id: normalize_component(node)
        for node in component_nodes
    }

    terminal_sets = build_terminal_sets(schematic)
    networks = build_networks(
        frequency=frequency,
        z0=z0,
        schematic=schematic,
        normalized_components=normalized_components,
    )
    connections = build_connections(
        schematic=schematic,
        networks=networks,
        terminal_sets=terminal_sets,
    )
    circuit = Circuit(connections, name=schematic.name, auto_reduce=True, split_ground=True)
    network = circuit.network

    if network.nports != 2:
        raise ValueError(f"Expected a 2-port result but solver produced {network.nports} ports")

    s_matrix = network.s
    s11 = s_matrix[:, 0, 0]
    s21 = s_matrix[:, 1, 0]

    s11_db = magnitude_db(s11)
    s21_db = magnitude_db(s21)
    s11_phase_deg = np.degrees(np.unwrap(np.angle(s11)))
    s21_phase_deg = np.degrees(np.unwrap(np.angle(s21)))
    midband_index = len(frequency.f) // 2
    best_match_index = int(np.argmin(s11_db)) if len(s11_db) > 0 else 0

    warnings = build_warnings(
        schematic=schematic,
        terminal_sets=terminal_sets,
        component_nodes=component_nodes,
    )

    points = [
        SolvePoint(
            frequency_hz=float(frequency_hz),
            s11_db=float(s11_db[index]),
            s21_db=float(s21_db[index]),
            s11_phase_deg=float(s11_phase_deg[index]),
            s21_phase_deg=float(s21_phase_deg[index]),
        )
        for index, frequency_hz in enumerate(frequency.f)
    ]

    summary = SolveSummary(
        best_match_hz=float(frequency.f[best_match_index]) if points else None,
        midband_s11_db=float(s11_db[midband_index]) if points else 0.0,
        midband_s21_db=float(s21_db[midband_index]) if points else 0.0,
        component_count=len(component_nodes),
        node_count=len(schematic.nodes),
        edge_count=len(schematic.edges),
        topology_label=describe_topology(
            component_count=len(component_nodes),
            edge_count=len(schematic.edges),
            terminal_sets=terminal_sets,
            schematic=schematic,
        ),
    )

    return SolveResponse(points=points, summary=summary, warnings=warnings)


def normalize_component(node: SchematicNode) -> NormalizedComponent:
    if node.value is None or node.unit is None:
        raise ValueError(f"Component node {node.id!r} is missing value or unit")

    scale = UNIT_SCALE[node.kind][node.unit]
    return NormalizedComponent(source=node, base_value=node.value * scale)


def build_networks(
    *,
    frequency: rf.Frequency,
    z0: float,
    schematic: SchematicModel,
    normalized_components: dict[str, NormalizedComponent],
) -> dict[str, rf.Network]:
    networks: dict[str, rf.Network] = {}

    for node in schematic.nodes:
        if node.kind == "port":
            networks[node.id] = Circuit.Port(frequency, name=node.id, z0=z0)
            continue

        if node.kind == "ground":
            networks[node.id] = Circuit.Ground(frequency, name=node.id, z0=z0)
            continue

        networks[node.id] = component_network(
            frequency=frequency,
            component=normalized_components[node.id],
            z0=z0,
        )

    return networks


def build_terminal_sets(schematic: SchematicModel) -> dict[tuple[str, str], list[tuple[SchematicNode, str]]]:
    union_find = UnionFind()
    node_map = {node.id: node for node in schematic.nodes}

    for node in schematic.nodes:
        for terminal in valid_terminals(node):
            union_find.add((node.id, terminal))

    for edge in schematic.edges:
        left = (edge.from_.node_id, edge.from_.terminal)
        right = (edge.to.node_id, edge.to.terminal)
        union_find.union(left, right)

    terminal_sets: dict[tuple[str, str], list[tuple[SchematicNode, str]]] = defaultdict(list)
    for node in schematic.nodes:
        for terminal in valid_terminals(node):
            root = union_find.find((node.id, terminal))
            terminal_sets[root].append((node_map[node.id], terminal))

    return terminal_sets


def build_connections(
    *,
    schematic: SchematicModel,
    networks: dict[str, rf.Network],
    terminal_sets: dict[tuple[str, str], list[tuple[SchematicNode, str]]],
) -> list[list[tuple[rf.Network, int]]]:
    ordered_sets = [
        sort_terminal_set(terminals)
        for terminals in terminal_sets.values()
        if not all(node.kind == "ground" for node, _ in terminals)
    ]
    ordered_sets.sort(key=terminal_set_sort_key)

    connections: list[list[tuple[rf.Network, int]]] = []
    for terminals in ordered_sets:
        connection = [
            terminal_to_connection(node=node, terminal=terminal, networks=networks)
            for node, terminal in terminals
        ]
        if connection:
            connections.append(connection)

    if not connections:
        raise ValueError("Unable to construct any circuit connections from the current graph")

    return connections


def component_network(*, frequency: rf.Frequency, component: NormalizedComponent, z0: float) -> rf.Network:
    omega = 2 * np.pi * frequency.f
    impedance = impedance_for_component(component, omega)
    return Circuit.SeriesImpedance(frequency, impedance, name=component.source.id, z0=z0)


def impedance_for_component(component: NormalizedComponent, omega: np.ndarray) -> np.ndarray:
    value = component.base_value
    kind = component.source.kind

    if kind == "resistor":
        return np.full_like(omega, value, dtype=complex)
    if kind == "inductor":
        return 1j * omega * value

    return np.divide(1.0, 1j * omega * value, out=np.full_like(omega, np.inf, dtype=complex), where=omega != 0)


def terminal_to_connection(
    *,
    node: SchematicNode,
    terminal: str,
    networks: dict[str, rf.Network],
) -> tuple[rf.Network, int]:
    if node.kind in {"port", "ground"}:
        return networks[node.id], 0

    return networks[node.id], 0 if terminal == "left" else 1


def valid_terminals(node: SchematicNode) -> tuple[str, ...]:
    return ("port",) if node.kind in {"port", "ground"} else ("left", "right")


def sort_terminal_set(terminals: list[tuple[SchematicNode, str]]) -> list[tuple[SchematicNode, str]]:
    return sorted(terminals, key=terminal_sort_key)


def terminal_sort_key(item: tuple[SchematicNode, str]) -> tuple[int, str, str]:
    node, terminal = item
    if node.kind == "port":
        return PORT_PRIORITY[node.role], node.id, terminal
    if node.kind == "ground":
        return 3, node.id, terminal
    return 2, node.id, terminal


def terminal_set_sort_key(terminals: list[tuple[SchematicNode, str]]) -> tuple[int, str]:
    priorities = [terminal_sort_key(item)[0] for item in terminals]
    return min(priorities), terminals[0][0].id


def build_warnings(
    *,
    schematic: SchematicModel,
    terminal_sets: dict[tuple[str, str], list[tuple[SchematicNode, str]]],
    component_nodes: list[SchematicNode],
) -> list[str]:
    warnings: list[str] = []
    edge_terminals = {
        (edge.from_.node_id, edge.from_.terminal)
        for edge in schematic.edges
    } | {
        (edge.to.node_id, edge.to.terminal)
        for edge in schematic.edges
    }

    if not component_nodes:
        warnings.append("No lumped components present. The response depends only on the direct wiring between ports.")
    if not schematic.edges:
        warnings.append("No wires present. Both ports are effectively open until you connect the graph.")
    if schematic.sweep.stop_ghz / schematic.sweep.start_ghz > 40:
        warnings.append("Wide sweep ratio may hide narrow resonances. Zoom in around the best match if needed.")
    if schematic.sweep.points < 101 and len(component_nodes) >= 6:
        warnings.append("Dense graphs can create sharp poles. Increase the sweep point count if traces look coarse.")

    floating = [
        node.label
        for node in component_nodes
        if (node.id, "left") not in edge_terminals and (node.id, "right") not in edge_terminals
    ]
    if floating:
        warnings.append(f"Floating components detected: {', '.join(floating[:4])}.")

    dangling = [
        node.label
        for node in component_nodes
        if ((node.id, "left") in edge_terminals) ^ ((node.id, "right") in edge_terminals)
    ]
    if dangling:
        warnings.append(f"Open terminals detected on: {', '.join(dangling[:4])}.")

    path_state = classify_path_state(schematic=schematic, terminal_sets=terminal_sets)
    if path_state == "disconnected":
        warnings.append("P1 and P2 are not connected through any component path.")
    if path_state == "shorted" and component_nodes:
        warnings.append("P1 and P2 share the same wired net. Some components may be bypassed.")

    return warnings


def classify_path_state(
    *,
    schematic: SchematicModel,
    terminal_sets: dict[tuple[str, str], list[tuple[SchematicNode, str]]],
) -> str:
    root_map: dict[tuple[str, str], tuple[str, str]] = {}
    for root, terminals in terminal_sets.items():
        for node, terminal in terminals:
            root_map[(node.id, terminal)] = root

    input_node = next(node for node in schematic.nodes if node.kind == "port" and node.role == "input")
    output_node = next(node for node in schematic.nodes if node.kind == "port" and node.role == "output")
    input_root = root_map[(input_node.id, "port")]
    output_root = root_map[(output_node.id, "port")]

    if input_root == output_root:
        return "shorted"

    adjacency: dict[tuple[str, str], set[tuple[str, str]]] = defaultdict(set)
    for node in schematic.nodes:
        if node.kind in {"port", "ground"}:
            continue

        left = root_map[(node.id, "left")]
        right = root_map[(node.id, "right")]
        adjacency[left].add(right)
        adjacency[right].add(left)

    seen = {input_root}
    stack = [input_root]
    while stack:
        current = stack.pop()
        if current == output_root:
            return "linked"
        for neighbor in adjacency[current]:
            if neighbor not in seen:
                seen.add(neighbor)
                stack.append(neighbor)

    return "disconnected"


def magnitude_db(values: np.ndarray) -> np.ndarray:
    magnitudes = np.clip(np.abs(values), 1e-12, None)
    return 20.0 * np.log10(magnitudes)


def describe_topology(
    *,
    component_count: int,
    edge_count: int,
    terminal_sets: dict[tuple[str, str], list[tuple[SchematicNode, str]]],
    schematic: SchematicModel,
) -> str:
    path_state = classify_path_state(schematic=schematic, terminal_sets=terminal_sets)
    path_label = {
        "linked": "P1->P2 linked",
        "shorted": "P1/P2 same net",
        "disconnected": "P1/P2 open",
    }[path_state]
    return f"{component_count} components | {edge_count} wires | {path_label}"
