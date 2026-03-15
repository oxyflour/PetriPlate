type DisposableGeometry = {
  delete?: () => void;
};

type GeometryNodeName<Nodes extends Record<string, unknown>> = Extract<
  keyof Nodes,
  string
>;

function isDisposableGeometry(value: unknown): value is DisposableGeometry {
  return typeof value === "object" && value !== null && "delete" in value;
}

function safeDelete(candidate: DisposableGeometry) {
  try {
    candidate.delete?.();
  } catch {
    // Ignore WASM cleanup failures during teardown.
  }
}

export class GeometryScope {
  private readonly tracked = new Set<DisposableGeometry>();

  track<T>(value: T): T {
    if (isDisposableGeometry(value)) {
      this.tracked.add(value);
    }
    return value;
  }

  create<T>(factory: () => T): T {
    return this.track(factory());
  }

  take<T>(value: T): T {
    if (isDisposableGeometry(value)) {
      this.tracked.delete(value);
    }
    return value;
  }

  adopt<T>(other: GeometryScope, value: T): T {
    return this.track(other.take(value));
  }

  dispose<T>(value: T) {
    if (!isDisposableGeometry(value)) {
      return;
    }

    this.tracked.delete(value);
    safeDelete(value);
  }

  replace<T>(current: T, next: T): T {
    this.track(next);

    if (current !== next) {
      this.dispose(current);
    }

    return next;
  }

  disposeAll() {
    for (const value of Array.from(this.tracked).reverse()) {
      this.dispose(value);
    }
  }
}

type GeometryNodeDefinition<
  Nodes extends Record<string, unknown>,
  K extends GeometryNodeName<Nodes>,
  D extends GeometryNodeName<Nodes>
> = {
  dependencies: readonly D[];
  build: (deps: Pick<Nodes, D>) => Nodes[K];
};

export class GeometryDag<Nodes extends Record<string, unknown>> {
  private readonly definitions = new Map<
    GeometryNodeName<Nodes>,
    GeometryNodeDefinition<Nodes, GeometryNodeName<Nodes>, GeometryNodeName<Nodes>>
  >();
  private readonly values = new Map<GeometryNodeName<Nodes>, unknown>();
  private readonly resolving = new Set<GeometryNodeName<Nodes>>();

  constructor(private readonly scope: GeometryScope) {}

  input<K extends GeometryNodeName<Nodes>>(name: K, value: Nodes[K]) {
    this.assertNameAvailable(name);
    this.values.set(name, this.scope.track(value));
    return this;
  }

  node<K extends GeometryNodeName<Nodes>, D extends GeometryNodeName<Nodes>>(
    name: K,
    dependencies: readonly D[],
    build: (deps: Pick<Nodes, D>) => Nodes[K]
  ) {
    this.assertNameAvailable(name);
    this.definitions.set(
      name,
      {
        dependencies,
        build
      } as GeometryNodeDefinition<
        Nodes,
        GeometryNodeName<Nodes>,
        GeometryNodeName<Nodes>
      >
    );
    return this;
  }

  get<K extends GeometryNodeName<Nodes>>(name: K): Nodes[K] {
    if (this.values.has(name)) {
      return this.values.get(name) as Nodes[K];
    }

    const definition = this.definitions.get(name);
    if (!definition) {
      throw new Error(`Unknown geometry DAG node: ${name}`);
    }
    if (this.resolving.has(name)) {
      throw new Error(`Geometry DAG cycle detected at node: ${name}`);
    }

    this.resolving.add(name);

    try {
      const dependencies = {} as Pick<Nodes, GeometryNodeName<Nodes>>;
      for (const dependency of definition.dependencies) {
        dependencies[dependency] = this.get(dependency);
      }

      const value = this.scope.track(
        definition.build(dependencies)
      ) as Nodes[K];
      this.values.set(name, value);
      return value;
    } finally {
      this.resolving.delete(name);
    }
  }

  private assertNameAvailable(name: GeometryNodeName<Nodes>) {
    if (this.values.has(name) || this.definitions.has(name)) {
      throw new Error(`Geometry DAG node already defined: ${name}`);
    }
  }
}
