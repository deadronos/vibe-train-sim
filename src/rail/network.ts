// Track graph. Nodes have a heading; each segment leaves a node on side +1 (along the heading) or -1 (against it).
// A train arriving at a node on one side always leaves on the other, so 2+ segments on one side is a junction.

export type Side = 1 | -1;
export type Dir = 1 | -1; // 1 = travelling a -> b along a segment

export interface SignalDef {
  hold: boolean; // Manually held at danger by the player
}

export interface RailNode {
  id: number;
  x: number;
  y: number;
  z: number;
  dx: number;
  dz: number;
  sw: { [side: string]: number | undefined }; // Selected exit segment per side
  signals: { [side: string]: SignalDef | undefined }; // Signal governing trains that leave on this side
}

export type BridgeMode = 'auto' | 'force' | 'none';

export interface Segment {
  id: number;
  a: number;
  sa: Side;
  b: number;
  sb: Side;
  bridge: BridgeMode;
}

export interface Station {
  id: number;
  name: string;
  nodeId: number;
  platformSide: Side; // +1 = right of node heading
  length: number;
}

export interface SegGeom {
  length: number;
  n: number;
  step: number;
  pos: Float32Array; // n * 3
  tan: Float32Array; // n * 3
  minRadius: number;
  vmax: number; // m/s
}

export interface Piece {
  seg: number;
  dir: Dir;
}

export interface Exit {
  node: number;
  side: Side; // exit side at the node
  options: number[];
}

export const LINE_VMAX = 33.3; // 120 km/h
export const MIN_RADIUS = 55;
export const MAX_GRADE = 0.07;
const LATERAL_ACCEL = 1.25;

export function bezierHandle(chord: number, cosTheta: number): number {
  // Handle length that makes the cubic close to a circular arc for the angle between end tangents.
  const theta = Math.acos(Math.max(-1, Math.min(1, cosTheta)));
  if (theta < 0.02) return chord / 3;
  const radius = chord / (2 * Math.sin(theta / 2));
  return Math.min((4 / 3) * Math.tan(theta / 4) * radius, chord * 0.9);
}

/** Planar curve shared by real segments and editor previews. d0/d1 are the tangents leaving each end. */
export function planCurve(
  x0: number,
  z0: number,
  d0x: number,
  d0z: number,
  x1: number,
  z1: number,
  d1x: number,
  d1z: number,
) {
  const chord = Math.hypot(x1 - x0, z1 - z0);
  // Angle between the direction of travel at each end.
  const h = bezierHandle(chord, d0x * -d1x + d0z * -d1z);
  const p1x = x0 + d0x * h;
  const p1z = z0 + d0z * h;
  const p2x = x1 + d1x * h;
  const p2z = z1 + d1z * h;
  const steps = Math.max(12, Math.ceil(chord / 1.5));
  const xs = new Float64Array(steps + 1);
  const zs = new Float64Array(steps + 1);
  const cum = new Float64Array(steps + 1);
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const u = 1 - t;
    const b0 = u * u * u;
    const b1 = 3 * u * u * t;
    const b2 = 3 * u * t * t;
    const b3 = t * t * t;
    xs[i] = b0 * x0 + b1 * p1x + b2 * p2x + b3 * x1;
    zs[i] = b0 * z0 + b1 * p1z + b2 * p2z + b3 * z1;
    if (i > 0) cum[i] = cum[i - 1] + Math.hypot(xs[i] - xs[i - 1], zs[i] - zs[i - 1]);
  }
  return { xs, zs, cum, length: cum[steps], steps };
}

export function curveMinRadius(xs: ArrayLike<number>, zs: ArrayLike<number>, n: number, stride = 4): number {
  let min = Infinity;
  for (let i = stride; i < n - stride; i += stride) {
    const ax = xs[i] - xs[i - stride];
    const az = zs[i] - zs[i - stride];
    const bx = xs[i + stride] - xs[i];
    const bz = zs[i + stride] - zs[i];
    const cross = Math.abs(ax * bz - az * bx);
    const la = Math.hypot(ax, az);
    const lb = Math.hypot(bx, bz);
    const lc = Math.hypot(xs[i + stride] - xs[i - stride], zs[i + stride] - zs[i - stride]);
    if (cross > 1e-6) min = Math.min(min, (la * lb * lc) / (2 * cross));
  }
  return min;
}

export class Network {
  nodes = new Map<number, RailNode>();
  segs = new Map<number, Segment>();
  stations: Station[] = [];
  geom = new Map<number, SegGeom>();
  /** Segment ids whose geometry changed since the renderer last synced. */
  dirty = new Set<number>();
  /** Bumped on every edit so props and terrain know to refresh. */
  version = 0;
  private nextId = 1;
  private adj = new Map<number, { p: number[]; m: number[] }>();

  id() {
    return this.nextId++;
  }

  attached(node: number, side: Side): number[] {
    const a = this.adj.get(node);
    if (!a) return [];
    return side === 1 ? a.p : a.m;
  }

  degree(node: number) {
    const a = this.adj.get(node);
    return a ? a.p.length + a.m.length : 0;
  }

  isJunction(node: number) {
    return this.attached(node, 1).length > 1 || this.attached(node, -1).length > 1;
  }

  addNode(x: number, y: number, z: number, dx: number, dz: number, id?: number): RailNode {
    const l = Math.hypot(dx, dz) || 1;
    const nid = id ?? this.id();
    const n: RailNode = { id: nid, x, y, z, dx: dx / l, dz: dz / l, sw: {}, signals: {} };
    this.nodes.set(nid, n);
    this.adj.set(nid, { p: [], m: [] });
    this.version++;
    return n;
  }

  addSegment(a: number, sa: Side, b: number, sb: Side, bridge: BridgeMode = 'auto', id?: number): Segment {
    const sid = id ?? this.id();
    const s: Segment = { id: sid, a, sa, b, sb, bridge };
    this.segs.set(sid, s);
    this.attached(a, sa).push(sid);
    this.attached(b, sb).push(sid);
    const refresh = [a, b];
    for (const nid of refresh) {
      const n = this.nodes.get(nid)!;
      const side = nid === a ? sa : sb;
      if (n.sw[side] === undefined) n.sw[side] = sid;
    }
    this.touchNodes(refresh);
    this.rebuild(sid);
    return s;
  }

  removeSegment(id: number) {
    const s = this.segs.get(id);
    if (!s) return;
    this.segs.delete(id);
    this.geom.delete(id);
    this.dirty.add(id);
    for (const [nid, side] of [
      [s.a, s.sa],
      [s.b, s.sb],
    ] as [number, Side][]) {
      const list = this.attached(nid, side);
      const i = list.indexOf(id);
      if (i >= 0) list.splice(i, 1);
      const n = this.nodes.get(nid)!;
      if (n.sw[side] === id) n.sw[side] = list[0];
    }
    this.touchNodes([s.a, s.b]);
    for (const nid of [s.a, s.b]) if (this.degree(nid) === 0) this.removeNode(nid);
    this.version++;
  }

  removeNode(id: number) {
    if (!this.nodes.has(id)) return;
    for (const list of [this.attached(id, 1), this.attached(id, -1)]) {
      for (const sid of [...list]) this.removeSegment(sid);
    }
    this.nodes.delete(id);
    this.adj.delete(id);
    this.stations = this.stations.filter((s) => s.nodeId !== id);
    this.version++;
  }

  /** Inserts a node at distance s along a segment and returns it; the two halves keep their shape closely. */
  split(segId: number, s: number): RailNode {
    const seg = this.segs.get(segId)!;
    const p = this.sample(segId, s);
    const node = this.addNode(p.x, p.y, p.z, p.tx, p.tz);
    const { b, sb, bridge } = seg;
    const nb = this.nodes.get(b)!;
    const swWasThis = nb.sw[sb] === segId;
    // Rewire: the old id keeps a -> new, a fresh segment takes new -> b.
    const list = this.attached(b, sb);
    list.splice(list.indexOf(segId), 1);
    seg.b = node.id;
    seg.sb = -1;
    this.attached(node.id, -1).push(segId);
    node.sw[-1] = segId;
    const tail = this.addSegment(node.id, 1, b, sb, bridge);
    if (swWasThis) nb.sw[sb] = tail.id;
    this.touchNodes([seg.a, node.id, b]);
    return node;
  }

  moveNode(id: number, x: number, y: number, z: number) {
    const n = this.nodes.get(id)!;
    n.x = x;
    n.y = y;
    n.z = z;
    this.touchNodes([id]);
  }

  /** Rebuilds segments near the given nodes: node grades depend on neighbours two hops away. */
  touchNodes(ids: number[]) {
    const segIds = new Set<number>();
    const far = new Set<number>(ids);
    for (const id of ids) {
      for (const sid of [...this.attached(id, 1), ...this.attached(id, -1)]) {
        const s = this.segs.get(sid);
        if (!s) continue;
        far.add(s.a);
        far.add(s.b);
      }
    }
    for (const id of far) {
      for (const sid of [...this.attached(id, 1), ...this.attached(id, -1)]) segIds.add(sid);
    }
    for (const sid of segIds) this.rebuild(sid);
    this.version++;
  }

  private nodeGrade(id: number): number {
    const n = this.nodes.get(id)!;
    let sum = 0;
    let count = 0;
    for (const side of [1, -1] as Side[]) {
      for (const sid of this.attached(id, side)) {
        const s = this.segs.get(sid)!;
        const other = this.nodes.get(s.a === id ? s.b : s.a);
        if (!other) continue;
        const len = Math.hypot(other.x - n.x, other.z - n.z) || 1;
        sum += (side * (other.y - n.y)) / len;
        count++;
      }
    }
    const g = count ? sum / count : 0;
    return Math.max(-0.08, Math.min(0.08, g));
  }

  rebuild(segId: number) {
    const s = this.segs.get(segId);
    if (!s) return;
    const A = this.nodes.get(s.a)!;
    const B = this.nodes.get(s.b)!;
    const c = planCurve(A.x, A.z, A.dx * s.sa, A.dz * s.sa, B.x, B.z, B.dx * s.sb, B.dz * s.sb);
    const L = Math.max(c.length, 0.01);
    const n = Math.max(3, Math.ceil(L / 2) + 1);
    const step = L / (n - 1);
    const pos = new Float32Array(n * 3);
    const tan = new Float32Array(n * 3);
    const m0 = s.sa * this.nodeGrade(s.a) * L;
    const m1 = -s.sb * this.nodeGrade(s.b) * L;
    const rx = new Float64Array(n);
    const rz = new Float64Array(n);
    let k = 0;
    for (let i = 0; i < n; i++) {
      const d = i * step;
      while (k < c.steps - 1 && c.cum[k + 1] < d) k++;
      const span = c.cum[k + 1] - c.cum[k] || 1;
      const f = Math.min(1, (d - c.cum[k]) / span);
      rx[i] = c.xs[k] + (c.xs[k + 1] - c.xs[k]) * f;
      rz[i] = c.zs[k] + (c.zs[k + 1] - c.zs[k]) * f;
      const t = i / (n - 1);
      const t2 = t * t;
      const t3 = t2 * t;
      const y = (2 * t3 - 3 * t2 + 1) * A.y + (t3 - 2 * t2 + t) * m0 + (-2 * t3 + 3 * t2) * B.y + (t3 - t2) * m1;
      pos[i * 3] = rx[i];
      pos[i * 3 + 1] = y;
      pos[i * 3 + 2] = rz[i];
    }
    for (let i = 0; i < n; i++) {
      const a = Math.max(0, i - 1);
      const b = Math.min(n - 1, i + 1);
      let tx = pos[b * 3] - pos[a * 3];
      let ty = pos[b * 3 + 1] - pos[a * 3 + 1];
      let tz = pos[b * 3 + 2] - pos[a * 3 + 2];
      const l = Math.hypot(tx, ty, tz) || 1;
      tx /= l;
      ty /= l;
      tz /= l;
      tan[i * 3] = tx;
      tan[i * 3 + 1] = ty;
      tan[i * 3 + 2] = tz;
    }
    const minRadius = curveMinRadius(rx, rz, n, 3);
    const vmax = Math.min(LINE_VMAX, Math.sqrt(LATERAL_ACCEL * minRadius));
    this.geom.set(segId, { length: L, n, step, pos, tan, minRadius, vmax });
    this.dirty.add(segId);
  }

  sample(segId: number, s: number) {
    const g = this.geom.get(segId)!;
    const f = Math.max(0, Math.min(g.n - 1.0001, s / g.step));
    const i = Math.floor(f);
    const u = f - i;
    const { pos, tan } = g;
    const a = i * 3;
    const b = a + 3;
    return {
      x: pos[a] + (pos[b] - pos[a]) * u,
      y: pos[a + 1] + (pos[b + 1] - pos[a + 1]) * u,
      z: pos[a + 2] + (pos[b + 2] - pos[a + 2]) * u,
      tx: tan[a] + (tan[b] - tan[a]) * u,
      ty: tan[a + 1] + (tan[b + 1] - tan[a + 1]) * u,
      tz: tan[a + 2] + (tan[b + 2] - tan[a + 2]) * u,
    };
  }

  /** Where a train leaves when reaching the end of a segment in the given direction. */
  exit(seg: number, dir: Dir): Exit {
    const s = this.segs.get(seg)!;
    const node = dir > 0 ? s.b : s.a;
    const arrival = dir > 0 ? s.sb : s.sa;
    const side = -arrival as Side;
    return { node, side, options: this.attached(node, side) };
  }

  entryDir(seg: number, node: number, side: Side): Dir {
    const s = this.segs.get(seg)!;
    return s.a === node && s.sa === side ? 1 : -1;
  }

  /** The segment the switch currently selects at this node, if any. */
  selected(node: number, side: Side): number | undefined {
    const options = this.attached(node, side);
    if (options.length === 0) return undefined;
    const sw = this.nodes.get(node)!.sw[side];
    return sw !== undefined && options.includes(sw) ? sw : options[0];
  }

  throwSwitch(node: number, side: Side) {
    const options = this.attached(node, side);
    if (options.length < 2) return;
    const cur = this.selected(node, side)!;
    this.nodes.get(node)!.sw[side] = options[(options.indexOf(cur) + 1) % options.length];
    this.version++;
  }

  nearest(x: number, z: number, maxDist: number) {
    let best: { seg: number; s: number; dist: number } | null = null;
    let bd = maxDist * maxDist;
    for (const [id, g] of this.geom) {
      for (let i = 0; i < g.n; i++) {
        const dx = g.pos[i * 3] - x;
        const dz = g.pos[i * 3 + 2] - z;
        const d = dx * dx + dz * dz;
        if (d < bd) {
          bd = d;
          best = { seg: id, s: i * g.step, dist: Math.sqrt(d) };
        }
      }
    }
    return best;
  }

  nearestNode(x: number, z: number, maxDist: number): RailNode | null {
    let best: RailNode | null = null;
    let bd = maxDist * maxDist;
    for (const n of this.nodes.values()) {
      const d = (n.x - x) ** 2 + (n.z - z) ** 2;
      if (d < bd) {
        bd = d;
        best = n;
      }
    }
    return best;
  }

  toJSON() {
    return {
      nextId: this.nextId,
      nodes: [...this.nodes.values()].map((n) => ({ ...n })),
      segs: [...this.segs.values()].map((s) => ({ ...s })),
      stations: this.stations.map((s) => ({ ...s })),
    };
  }

  static fromJSON(j: ReturnType<Network['toJSON']>): Network {
    const net = new Network();
    for (const n of j.nodes) {
      const node = net.addNode(n.x, n.y, n.z, n.dx, n.dz, n.id);
      node.signals = n.signals;
    }
    for (const s of j.segs) net.addSegment(s.a, s.sa, s.b, s.sb, s.bridge, s.id);
    for (const n of j.nodes) net.nodes.get(n.id)!.sw = n.sw;
    net.stations = j.stations;
    net.nextId = j.nextId;
    return net;
  }
}
