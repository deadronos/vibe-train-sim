import type { Dir, Network, RailNode } from '../../rail/network';
import { clampSplit } from '../trackPlan';

export interface TrackHit {
  seg: number;
  s: number;
  x: number;
  y: number;
  z: number;
  tx: number;
  tz: number;
  travel: Dir;
}

/** Finds a point on the track near the pointer, along with the travel side the pointer favours. */
export function trackPointFromMouse(net: Network, p: { x: number; z: number }, radius = 26): TrackHit | null {
  const near = net.nearest(p.x, p.z, radius);
  if (!near) return null;
  const s = net.sample(near.seg, near.s);
  const l = Math.hypot(s.tx, s.tz) || 1;
  const tx = s.tx / l;
  const tz = s.tz / l;
  // Trains keep the signal on their right, so the pointer side picks the direction of travel.
  const cross = (p.x - s.x) * -tz + (p.z - s.z) * tx;
  const travel: Dir = cross >= 0 ? 1 : -1;
  return { seg: near.seg, s: near.s, x: s.x, y: s.y, z: s.z, tx: tx * travel, tz: tz * travel, travel };
}

export function nodeForPoint(net: Network, pt: { seg: number; s: number; x: number; z: number }): RailNode {
  const existing = net.nearestNode(pt.x, pt.z, 10);
  if (existing) return existing;
  return net.split(pt.seg, clampSplit(net, pt.seg, pt.s));
}
