// Pure track-planning geometry and anchor resolution. Kept free of Three.js and the DOM for unit testing.
import type { Network, RailNode, Segment, Side } from '../rail/network';
import {
  CROSSING_CLEARANCE,
  curveMinRadius,
  DIAMOND_MAX_DY,
  findCurveCrossings,
  MAX_GRADE,
  MIN_RADIUS,
  planCurve,
} from '../rail/network';
import { WATER_LEVEL } from '../world/heightfield';

export const ANCHOR_NODE = 14;
export const ANCHOR_SEG = 9;

export type Anchor =
  | { kind: 'node'; node: number }
  | { kind: 'seg'; seg: number; s: number; x: number; y: number; z: number }
  | { kind: 'free'; x: number; y: number; z: number };

export interface TrackPoint {
  x: number;
  y: number;
  z: number;
}

export interface TrackPlan {
  ok: boolean;
  reason: string;
  curve: ReturnType<typeof planCurve> | null;
  P: TrackPoint;
  Q: TrackPoint;
  d0x: number;
  d0z: number;
  d1x: number;
  d1z: number;
}

export function clampSplit(net: Network, seg: number, s: number) {
  const L = net.geom.get(seg)!.length;
  return Math.max(6, Math.min(L - 6, s));
}

export function anchorAt(
  net: Network,
  baseAt: (x: number, z: number) => number,
  p: TrackPoint,
  heightOffset: number,
): Anchor {
  const n = net.nearestNode(p.x, p.z, ANCHOR_NODE);
  if (n) return { kind: 'node', node: n.id };
  const near = net.nearest(p.x, p.z, ANCHOR_SEG);
  if (near) {
    const s = net.sample(near.seg, near.s);
    return { kind: 'seg', seg: near.seg, s: near.s, x: s.x, y: s.y, z: s.z };
  }
  const base = baseAt(p.x, p.z);
  return { kind: 'free', x: p.x, y: Math.max(base + 0.7, WATER_LEVEL + 3) + heightOffset, z: p.z };
}

export function anchorPos(net: Network, a: Anchor): TrackPoint {
  if (a.kind === 'node') {
    const n = net.nodes.get(a.node)!;
    return { x: n.x, y: n.y, z: n.z };
  }
  return { x: a.x, y: a.y, z: a.z };
}

/** Works out heading, shape and validity for a candidate track piece between two anchors. */
export function previewTrackPlan(net: Network, startA: Anchor, endA: Anchor, snap: boolean): TrackPlan {
  const P = anchorPos(net, startA);
  const Q = anchorPos(net, endA);
  const chord = Math.hypot(Q.x - P.x, Q.z - P.z);
  if (chord < 15) {
    return { ok: false, reason: 'Too short', curve: null, P, Q, d0x: 1, d0z: 0, d1x: -1, d1z: 0 };
  }
  const cx = (Q.x - P.x) / chord;
  const cz = (Q.z - P.z) / chord;
  let d0x = cx;
  let d0z = cz;
  if (startA.kind === 'node') {
    const n = net.nodes.get(startA.node)!;
    const side = n.dx * cx + n.dz * cz >= 0 ? 1 : -1;
    d0x = n.dx * side;
    d0z = n.dz * side;
  } else if (startA.kind === 'seg') {
    const s = net.sample(startA.seg, startA.s);
    const l = Math.hypot(s.tx, s.tz) || 1;
    const side = s.tx * cx + s.tz * cz >= 0 ? 1 : -1;
    d0x = (s.tx / l) * side;
    d0z = (s.tz / l) * side;
  } else if (snap) {
    const a = Math.round(Math.atan2(cz, cx) / (Math.PI / 12)) * (Math.PI / 12);
    d0x = Math.cos(a);
    d0z = Math.sin(a);
  }
  let d1x: number;
  let d1z: number;
  if (endA.kind === 'node') {
    const n = net.nodes.get(endA.node)!;
    const side = n.dx * -cx + n.dz * -cz >= 0 ? 1 : -1;
    d1x = n.dx * side;
    d1z = n.dz * side;
  } else if (endA.kind === 'seg') {
    const s = net.sample(endA.seg, endA.s);
    const l = Math.hypot(s.tx, s.tz) || 1;
    const side = (s.tx / l) * -cx + (s.tz / l) * -cz >= 0 ? 1 : -1;
    d1x = (s.tx / l) * side;
    d1z = (s.tz / l) * side;
  } else {
    // Mirror the start tangent across the chord: a free end finishes a circular arc.
    const dot = d0x * cx + d0z * cz;
    const rx = 2 * dot * cx - d0x;
    const rz = 2 * dot * cz - d0z;
    d1x = -rx;
    d1z = -rz;
  }
  const curve = planCurve(P.x, P.z, d0x, d0z, Q.x, Q.z, d1x, d1z);
  const minR = curveMinRadius(curve.xs, curve.zs, curve.steps + 1, 6);
  const grade = Math.abs(Q.y - P.y) / curve.length;
  let ok = true;
  let reason = `${Math.round(curve.length)} m, radius ${minR === Infinity ? 'straight' : Math.round(minR) + ' m'}, grade ${(grade * 100).toFixed(1)}%`;
  if (d0x * cx + d0z * cz < 0.05) {
    ok = false;
    reason = 'Turn is too sharp: start in the direction the track already points';
  } else if (minR < MIN_RADIUS) {
    ok = false;
    reason = `Curve too tight: radius ${Math.round(minR)} m, minimum ${MIN_RADIUS} m`;
  } else if (grade > MAX_GRADE) {
    ok = false;
    reason = `Too steep: ${(grade * 100).toFixed(1)}%, maximum ${(MAX_GRADE * 100).toFixed(0)}%. Change the height with [ and ]`;
  } else {
    const ignore = new Set<number>();
    for (const a of [startA, endA]) {
      if (a.kind === 'node') ignore.add(a.node);
      else if (a.kind === 'seg') {
        const s = net.segs.get(a.seg);
        if (s) {
          ignore.add(s.a);
          ignore.add(s.b);
        }
      }
    }
    const hits = findCurveCrossings(
      net,
      curve.xs,
      curve.zs,
      curve.cum,
      curve.steps,
      (f) => P.y + (Q.y - P.y) * f,
      ignore,
    );
    const tight = hits.find((h) => h.dy > DIAMOND_MAX_DY && h.dy < CROSSING_CLEARANCE);
    const flat = hits.find((h) => h.dy <= DIAMOND_MAX_DY);
    if (tight) {
      reason += ` — Tight clearance (${tight.dy.toFixed(1)} m): raise to ≥${CROSSING_CLEARANCE} m for a bridge or match height for a diamond`;
    } else if (flat) {
      reason += ' — Crosses track at grade: interlocked diamond crossing';
    } else if (hits.length) {
      const minClear = Math.min(...hits.map((h) => h.dy));
      reason += ` — Crosses over/under track (${minClear.toFixed(1)} m clearance)`;
    }
  }
  return { ok, reason, curve, P, Q, d0x, d0z, d1x, d1z };
}

function resolveAnchor(net: Network, a: Anchor, dirX: number, dirZ: number): { node: RailNode; side: Side } {
  let node: RailNode;
  if (a.kind === 'node') node = net.nodes.get(a.node)!;
  else if (a.kind === 'seg') node = net.split(a.seg, clampSplit(net, a.seg, a.s));
  else node = net.addNode(a.x, a.y, a.z, dirX, dirZ);
  const side: Side = node.dx * dirX + node.dz * dirZ >= 0 ? 1 : -1;
  return { node, side };
}

export function buildTrackSegment(
  net: Network,
  startA: Anchor,
  endA: Anchor,
  plan: TrackPlan,
): { ok: true; seg: Segment; nextStart: Anchor | null } | { ok: false; reason: string } {
  const a = resolveAnchor(net, startA, plan.d0x, plan.d0z);
  const endIsFree = endA.kind === 'free';
  let b: { node: RailNode; side: Side };
  if (endIsFree) {
    const node = net.addNode(plan.Q.x, plan.Q.y, plan.Q.z, -plan.d1x, -plan.d1z);
    b = { node, side: -1 };
  } else {
    // Splitting may have replaced an anchor's segment; re-find it when both ends sit on one segment.
    let endAnchor = endA;
    if (endA.kind === 'seg' && startA.kind === 'seg' && endA.seg === startA.seg) {
      const near = net.nearest(endA.x, endA.z, ANCHOR_SEG * 2);
      if (near) endAnchor = { ...endA, seg: near.seg, s: near.s };
    }
    b = resolveAnchor(net, endAnchor, plan.d1x, plan.d1z);
  }
  if (a.node.id === b.node.id) {
    return { ok: false, reason: 'A track cannot start and end at the same point' };
  }
  const seg = net.addSegment(a.node.id, a.side, b.node.id, b.side);
  return { ok: true, seg, nextStart: endIsFree ? { kind: 'node', node: b.node.id } : null };
}
