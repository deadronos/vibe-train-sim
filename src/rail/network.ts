// Track graph. Nodes have a heading; each segment leaves a node on side +1 (along the heading) or -1 (against it).
// A train arriving at a node on one side always leaves on the other, so 2+ segments on one side is a junction.

export type Side = 1 | -1;
export type Dir = 1 | -1; // 1 = travelling a -> b along a segment
export type SignalType = 'main' | 'distant' | 'shunt';

export interface SignalDef {
  hold: boolean; // Manually held at danger by the player
  /** Signal role; omitted in older saves and defaults to 'main'. */
  type?: SignalType;
}

export function signalType(def: SignalDef | undefined): SignalType {
  return def?.type ?? 'main';
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
  /** Optional explicit limit in m/s; effective vmax is the lower of this, curve vmax, and LINE_VMAX. */
  speedLimit?: number;
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
export const CROSSING_CLEARANCE = 5.0; // m vertical clearance needed to pass over/under without interlocking
export const DIAMOND_MAX_DY = 1.2; // m max rail height difference for at-grade diamond crossing geometry
const LATERAL_ACCEL = 1.25;
const ADVANCE_SIGN_DIST = 250; // m ahead of a steep speed drop where an advance warning board stands

export interface Crossing {
  id: string;
  seg1: number;
  s1: number;
  seg2: number;
  s2: number;
  x: number;
  y: number;
  y1: number;
  y2: number;
  z: number;
  t1x: number;
  t1z: number;
  t2x: number;
  t2z: number;
  angle: number;
}

export interface CurveCrossingHit {
  seg: number;
  sSeg: number;
  sCurve: number;
  x: number;
  z: number;
  yCurve: number;
  ySeg: number;
  dy: number;
}

export interface SpeedSign {
  seg: number;
  s: number;
  dir: Dir;
  kmh: number;
  advance: boolean;
  x: number;
  y: number;
  z: number;
  tx: number;
  tz: number;
}

/** Rounds a m/s speed limit to a clean 5 km/h lineside board numeral without rounding up past the curve physics. */
export function speedBoardKmh(vmax: number): number {
  return Math.max(15, Math.min(120, Math.floor((vmax * 3.6 + 1.5) / 5) * 5));
}

function xzIntersect(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  cx: number,
  cz: number,
  dx: number,
  dz: number,
): { t: number; u: number; x: number; z: number } | null {
  const rX = bx - ax;
  const rZ = bz - az;
  const sX = dx - cx;
  const sZ = dz - cz;
  const denom = rX * sZ - rZ * sX;
  if (Math.abs(denom) < 1e-6) return null;
  const qpx = cx - ax;
  const qpz = cz - az;
  const t = (qpx * sZ - qpz * sX) / denom;
  const u = (qpx * rZ - qpz * rX) / denom;
  if (t < 0 || t > 1 || u < 0 || u > 1) return null;
  return { t, u, x: ax + t * rX, z: az + t * rZ };
}

function geomBounds(g: SegGeom) {
  let minX = Infinity;
  let maxX = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (let i = 0; i < g.n; i++) {
    const x = g.pos[i * 3];
    const z = g.pos[i * 3 + 2];
    if (x < minX) minX = x;
    if (x > maxX) maxX = x;
    if (z < minZ) minZ = z;
    if (z > maxZ) maxZ = z;
  }
  return { minX, maxX, minZ, maxZ };
}

/** Finds XZ intersections between a planned curve and existing segments, skipping segments at ignored nodes. */
export function findCurveCrossings(
  net: Network,
  xs: ArrayLike<number>,
  zs: ArrayLike<number>,
  cum: ArrayLike<number>,
  steps: number,
  yAtFrac: (f: number) => number,
  ignoreNodes: Set<number>,
): CurveCrossingHit[] {
  const hits: CurveCrossingHit[] = [];
  const totalLen = cum[steps] || 1;
  let cMinX = Infinity;
  let cMaxX = -Infinity;
  let cMinZ = Infinity;
  let cMaxZ = -Infinity;
  for (let i = 0; i <= steps; i++) {
    if (xs[i] < cMinX) cMinX = xs[i];
    if (xs[i] > cMaxX) cMaxX = xs[i];
    if (zs[i] < cMinZ) cMinZ = zs[i];
    if (zs[i] > cMaxZ) cMaxZ = zs[i];
  }
  for (const [sid, seg] of net.segs) {
    if (ignoreNodes.has(seg.a) || ignoreNodes.has(seg.b)) continue;
    const g = net.geom.get(sid);
    if (!g) continue;
    const b = geomBounds(g);
    if (cMaxX < b.minX || cMinX > b.maxX || cMaxZ < b.minZ || cMinZ > b.maxZ) continue;
    for (let i = 0; i < steps; i++) {
      const ax = xs[i];
      const az = zs[i];
      const bx = xs[i + 1];
      const bz = zs[i + 1];
      for (let j = 0; j < g.n - 1; j++) {
        const cx = g.pos[j * 3];
        const cz = g.pos[j * 3 + 2];
        const dx = g.pos[(j + 1) * 3];
        const dz = g.pos[(j + 1) * 3 + 2];
        const hit = xzIntersect(ax, az, bx, bz, cx, cz, dx, dz);
        if (!hit) continue;
        const sCurve = cum[i] + hit.t * (cum[i + 1] - cum[i]);
        const sSeg = (j + hit.u) * g.step;
        if (hits.some((h) => h.seg === sid && Math.abs(h.sCurve - sCurve) < 4)) continue;
        const yCurve = yAtFrac(sCurve / totalLen);
        const ySeg = g.pos[j * 3 + 1] + hit.u * (g.pos[(j + 1) * 3 + 1] - g.pos[j * 3 + 1]);
        hits.push({
          seg: sid,
          sSeg,
          sCurve,
          x: hit.x,
          z: hit.z,
          yCurve,
          ySeg,
          dy: Math.abs(yCurve - ySeg),
        });
      }
    }
  }
  return hits;
}

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
  private crossingsCache: Crossing[] = [];
  private crossingsVersion = -1;
  private stationByNode = new Map<number, Station>();
  private stationByIdMap = new Map<number, Station>();
  private stationRef: Station[] | null = null;
  private stationCount = -1;
  private stationVersion = -1;

  private syncStations() {
    if (
      this.stationRef === this.stations &&
      this.stationCount === this.stations.length &&
      this.stationVersion === this.version
    ) {
      return;
    }
    this.stationByNode.clear();
    this.stationByIdMap.clear();
    for (const s of this.stations) {
      this.stationByNode.set(s.nodeId, s);
      this.stationByIdMap.set(s.id, s);
    }
    this.stationRef = this.stations;
    this.stationCount = this.stations.length;
    this.stationVersion = this.version;
  }

  stationAt(nodeId: number): Station | undefined {
    this.syncStations();
    return this.stationByNode.get(nodeId);
  }

  stationById(id: number): Station | undefined {
    this.syncStations();
    return this.stationByIdMap.get(id);
  }

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

  /** All level crossings where unconnected segments intersect within vertical clearance. */
  get crossings(): Crossing[] {
    if (this.crossingsVersion !== this.version) {
      this.crossingsCache = this.computeCrossings();
      this.crossingsVersion = this.version;
    }
    return this.crossingsCache;
  }

  crossingsOn(segId: number): Crossing[] {
    return this.crossings.filter((c) => c.seg1 === segId || c.seg2 === segId);
  }

  private computeCrossings(): Crossing[] {
    const out: Crossing[] = [];
    const entries = [...this.segs.entries()];
    const bounds = new Map<number, ReturnType<typeof geomBounds>>();
    for (const [id] of entries) {
      const g = this.geom.get(id);
      if (g) bounds.set(id, geomBounds(g));
    }
    for (let i = 0; i < entries.length; i++) {
      const [id1, s1] = entries[i];
      const g1 = this.geom.get(id1);
      const b1 = bounds.get(id1);
      if (!g1 || !b1) continue;
      for (let j = i + 1; j < entries.length; j++) {
        const [id2, s2] = entries[j];
        if (s1.a === s2.a || s1.a === s2.b || s1.b === s2.a || s1.b === s2.b) continue;
        const g2 = this.geom.get(id2);
        const b2 = bounds.get(id2);
        if (!g2 || !b2) continue;
        if (b1.maxX < b2.minX || b1.minX > b2.maxX || b1.maxZ < b2.minZ || b1.minZ > b2.maxZ) continue;
        let idx = 0;
        for (let a = 0; a < g1.n - 1; a++) {
          const ax = g1.pos[a * 3];
          const az = g1.pos[a * 3 + 2];
          const bx = g1.pos[(a + 1) * 3];
          const bz = g1.pos[(a + 1) * 3 + 2];
          for (let b = 0; b < g2.n - 1; b++) {
            const cx = g2.pos[b * 3];
            const cz = g2.pos[b * 3 + 2];
            const dx = g2.pos[(b + 1) * 3];
            const dz = g2.pos[(b + 1) * 3 + 2];
            const hit = xzIntersect(ax, az, bx, bz, cx, cz, dx, dz);
            if (!hit) continue;
            const y1 = g1.pos[a * 3 + 1] + hit.t * (g1.pos[(a + 1) * 3 + 1] - g1.pos[a * 3 + 1]);
            const y2 = g2.pos[b * 3 + 1] + hit.u * (g2.pos[(b + 1) * 3 + 1] - g2.pos[b * 3 + 1]);
            if (Math.abs(y1 - y2) >= CROSSING_CLEARANCE) continue;
            const s1Dist = (a + hit.t) * g1.step;
            const s2Dist = (b + hit.u) * g2.step;
            if (out.some((o) => o.seg1 === id1 && o.seg2 === id2 && Math.abs(o.s1 - s1Dist) < 4)) continue;
            const p1 = this.sample(id1, s1Dist);
            const p2 = this.sample(id2, s2Dist);
            const l1 = Math.hypot(p1.tx, p1.tz) || 1;
            const l2 = Math.hypot(p2.tx, p2.tz) || 1;
            const t1x = p1.tx / l1;
            const t1z = p1.tz / l1;
            const t2x = p2.tx / l2;
            const t2z = p2.tz / l2;
            const dot = Math.max(-1, Math.min(1, Math.abs(t1x * t2x + t1z * t2z)));
            const angle = Math.acos(dot);
            out.push({
              id: `${id1}:${id2}#${idx++}`,
              seg1: id1,
              s1: s1Dist,
              seg2: id2,
              s2: s2Dist,
              x: hit.x,
              y: (y1 + y2) * 0.5,
              y1,
              y2,
              z: hit.z,
              t1x,
              t1z,
              t2x,
              t2z,
              angle,
            });
          }
        }
      }
    }
    return out;
  }

  private dirtyCrossedSegments(segIds: Iterable<number>) {
    const ids = new Set(segIds);
    for (const c of this.crossings) {
      if (ids.has(c.seg1)) this.dirty.add(c.seg2);
      if (ids.has(c.seg2)) this.dirty.add(c.seg1);
    }
  }

  addSegment(
    a: number,
    sa: Side,
    b: number,
    sb: Side,
    bridge: BridgeMode = 'auto',
    id?: number,
    speedLimit?: number,
  ): Segment {
    const sid = id ?? this.id();
    const s: Segment = { id: sid, a, sa, b, sb, bridge };
    if (speedLimit !== undefined) s.speedLimit = speedLimit;
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
    this.version++;
    this.dirtyCrossedSegments([sid]);
    return s;
  }

  removeSegment(id: number) {
    const s = this.segs.get(id);
    if (!s) return;
    this.dirtyCrossedSegments([id]);
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
    const { b, sb, bridge, speedLimit } = seg;
    const nb = this.nodes.get(b)!;
    const swWasThis = nb.sw[sb] === segId;
    // Rewire: the old id keeps a -> new, a fresh segment takes new -> b.
    const list = this.attached(b, sb);
    list.splice(list.indexOf(segId), 1);
    seg.b = node.id;
    seg.sb = -1;
    this.attached(node.id, -1).push(segId);
    node.sw[-1] = segId;
    const tail = this.addSegment(node.id, 1, b, sb, bridge, undefined, speedLimit);
    if (swWasThis) nb.sw[sb] = tail.id;
    this.touchNodes([seg.a, node.id, b]);
    return node;
  }

  /**
   * Why track at a point breaks the laying rules, or null if it doesn't. Checks every segment that meets the point.
   * Built geometry samples curves more finely than the editor's preview, so radius gets a little slack.
   */
  problemAt(id: number): string | null {
    for (const side of [1, -1] as Side[]) {
      for (const sid of this.attached(id, side)) {
        const seg = this.segs.get(sid)!;
        const g = this.geom.get(sid)!;
        if (g.minRadius < MIN_RADIUS * 0.95) {
          return `Curve too tight: radius ${Math.round(g.minRadius)} m, minimum ${MIN_RADIUS} m`;
        }
        const grade = Math.abs(this.nodes.get(seg.a)!.y - this.nodes.get(seg.b)!.y) / g.length;
        if (grade > MAX_GRADE * 1.02) {
          return `Too steep: ${(grade * 100).toFixed(1)}%, maximum ${(MAX_GRADE * 100).toFixed(0)}%`;
        }
      }
    }
    return null;
  }

  /** Turns a point's heading by an angle in radians, positive anticlockwise seen from above. */
  turnNode(id: number, angle: number) {
    const n = this.nodes.get(id)!;
    const c = Math.cos(angle);
    const s = Math.sin(angle);
    const dx = n.dx * c + n.dz * s;
    const dz = -n.dx * s + n.dz * c;
    n.dx = dx;
    n.dz = dz;
    this.touchNodes([id]);
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
    this.dirtyCrossedSegments(segIds);
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
    const cap = s.speedLimit !== undefined ? Math.min(LINE_VMAX, s.speedLimit) : LINE_VMAX;
    const vmax = Math.min(cap, Math.sqrt(LATERAL_ACCEL * minRadius));
    this.geom.set(segId, { length: L, n, step, pos, tan, minRadius, vmax });
    this.dirty.add(segId);
  }

  sample(segId: number, s: number) {
    return this.sampleOn(segId, s, 1);
  }

  /**
   * A point on a segment, with the segment, distance and direction of travel included in the same object.
   * Trains are placed through this every frame, so it builds one object rather than two.
   */
  sampleOn(segId: number, s: number, dir: Dir) {
    const g = this.geom.get(segId)!;
    const f = Math.max(0, Math.min(g.n - 1.0001, s / g.step));
    const i = Math.floor(f);
    const u = f - i;
    const { pos, tan } = g;
    const a = i * 3;
    const b = a + 3;
    return {
      seg: segId,
      s,
      dir,
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
    for (const s of j.segs) net.addSegment(s.a, s.sa, s.b, s.sb, s.bridge, s.id, s.speedLimit);
    for (const n of j.nodes) net.nodes.get(n.id)!.sw = n.sw;
    net.stations = j.stations;
    net.nextId = j.nextId;
    return net;
  }
}

/**
 * Places lineside speed boards at every speed limit change and start of line, plus advance warning boards
 * ahead of major reductions so a driver can read limits from the lineside alone.
 */
export function computeSpeedSigns(net: Network): SpeedSign[] {
  const out: SpeedSign[] = [];
  const addSign = (seg: number, s: number, dir: Dir, kmh: number, advance: boolean) => {
    const geo = net.geom.get(seg);
    if (!geo || geo.length < 4) return;
    const clampedS = Math.max(2, Math.min(geo.length - 2, s));
    const near = out.find((e) => e.seg === seg && e.dir === dir && Math.abs(e.s - clampedS) < 14);
    if (near) {
      // Keep the lower or non-advance board when two boards would sit on top of each other.
      if ((!advance && near.advance) || (advance === near.advance && kmh < near.kmh)) {
        near.kmh = kmh;
        near.advance = advance;
      }
      return;
    }
    const p = net.sampleOn(seg, clampedS, dir);
    const l = Math.hypot(p.tx, p.tz) || 1;
    out.push({
      seg,
      s: clampedS,
      dir,
      kmh,
      advance,
      x: p.x,
      y: p.y,
      z: p.z,
      tx: (p.tx * dir) / l,
      tz: (p.tz * dir) / l,
    });
  };

  for (const [segId, seg] of net.segs) {
    const geo = net.geom.get(segId);
    if (!geo) continue;
    const kmh = speedBoardKmh(geo.vmax);
    for (const dir of [1, -1] as Dir[]) {
      const entryNode = dir > 0 ? seg.a : seg.b;
      const entrySide = dir > 0 ? seg.sa : seg.sb;
      const incoming = net.attached(entryNode, -entrySide as Side);
      const changed =
        incoming.length === 0 ||
        incoming.some((inId) => {
          const gIn = net.geom.get(inId);
          return gIn ? speedBoardKmh(gIn.vmax) !== kmh : false;
        });
      if (!changed) continue;
      const sStart = dir > 0 ? Math.min(4, geo.length * 0.25) : Math.max(geo.length - 4, geo.length * 0.75);
      addSign(segId, sStart, dir, kmh, false);

      // Walk backward up to ADVANCE_SIGN_DIST along faster incoming tracks to place an advance warning board.
      const placeAdvance = (nodeId: number, intoSide: Side, rem: number, depth: number) => {
        if (depth > 8) return;
        for (const inId of net.attached(nodeId, intoSide)) {
          const inGeo = net.geom.get(inId);
          if (!inGeo) continue;
          const inKmh = speedBoardKmh(inGeo.vmax);
          if (inKmh < kmh + 15) continue;
          const inDir = -net.entryDir(inId, nodeId, intoSide) as Dir;
          if (inGeo.length >= rem) {
            const sAdv = inDir > 0 ? inGeo.length - rem : rem;
            addSign(inId, sAdv, inDir, kmh, true);
          } else {
            const nextExit = net.exit(inId, -inDir as Dir);
            const upstream = net.attached(nextExit.node, nextExit.side);
            if (upstream.length === 0) {
              // Short approach from a buffer: put the advance sign near the start of the approach.
              const sAdv = inDir > 0 ? Math.min(8, inGeo.length * 0.3) : Math.max(inGeo.length - 8, inGeo.length * 0.7);
              addSign(inId, sAdv, inDir, kmh, true);
            } else {
              placeAdvance(nextExit.node, nextExit.side, rem - inGeo.length, depth + 1);
            }
          }
        }
      };
      placeAdvance(entryNode, -entrySide as Side, ADVANCE_SIGN_DIST, 0);
    }
  }
  return out;
}
