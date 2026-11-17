import type { RailNode, Side, SignalType, Station } from '../../rail/network';
import { signalType } from '../../rail/network';
import type { Train } from '../../rail/sim';
import type { PlacedItem } from '../../world/scenery';
import { SCENERY_LABEL } from '../../world/scenery';
import type { EditorContext, EditorHost, EditorTool, ScreenPoint, WorldPoint } from './tool';

const SIGNAL_LABELS: Record<SignalType, string> = { main: 'main', distant: 'distant', shunt: 'calling-on' };

export type DeleteTarget =
  | { kind: 'train'; train: Train; x: number; y: number; z: number; label: string }
  | {
      kind: 'signal';
      node: RailNode;
      side: Side;
      x: number;
      y: number;
      z: number;
      tx: number;
      tz: number;
      label: string;
    }
  | { kind: 'station'; station: Station; x: number; y: number; z: number; label: string }
  | { kind: 'placed'; index: number; item: PlacedItem; x: number; y: number; z: number; label: string }
  | { kind: 'track'; seg: number; x: number; y: number; z: number; label: string }
  | { kind: 'generated'; item: PlacedItem; x: number; y: number; z: number; label: string };

interface BoxDrag {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  world: WorldPoint;
  active: boolean;
}

interface BoxMatches {
  trains: Train[];
  signals: { node: RailNode; side: Side }[];
  stations: Station[];
  placedIndices: number[];
  segs: number[];
  generated: PlacedItem[];
}

function signalPostPosition(node: RailNode, side: Side) {
  const tx = node.dx * side;
  const tz = node.dz * side;
  const shunt = signalType(node.signals[side]) === 'shunt';
  const lat = shunt ? 2.45 : 2.9;
  const back = shunt ? 2.5 : 3.0;
  return {
    x: node.x + -tz * lat - tx * back,
    y: node.y,
    z: node.z + tx * lat - tz * back,
    tx,
    tz,
  };
}

/** Single shared hit-test used by both hover and click so the preview always matches what is removed. */
export function pickDeleteTarget(host: EditorHost, p: WorldPoint): DeleteTarget | null {
  const { net, sim, hf } = host;

  let bestTrain: { train: Train; x: number; y: number; z: number; d: number } | null = null;
  for (const t of sim.trains) {
    for (let d = 0; d <= t.length; d += 6) {
      const q = sim.behind(t, Math.min(d, t.length));
      const dist = Math.hypot(q.x - p.x, q.z - p.z);
      if (dist < 7 && (!bestTrain || dist < bestTrain.d)) bestTrain = { train: t, x: q.x, y: q.y, z: q.z, d: dist };
    }
  }
  if (bestTrain) return { kind: 'train', ...bestTrain, label: bestTrain.train.name };

  let bestSig: {
    node: RailNode;
    side: Side;
    x: number;
    y: number;
    z: number;
    tx: number;
    tz: number;
    d: number;
  } | null = null;
  for (const n of net.nodes.values()) {
    for (const side of [1, -1] as Side[]) {
      const def = n.signals[side];
      if (!def) continue;
      const post = signalPostPosition(n, side);
      const dp = Math.hypot(post.x - p.x, post.z - p.z);
      const dn = Math.hypot(n.x - p.x, n.z - p.z);
      if (dp < 8 || dn < 8) {
        if (!bestSig || dp < bestSig.d) {
          bestSig = { node: n, side, ...post, d: dp };
        }
      }
    }
  }
  if (bestSig) {
    const typeLabel = SIGNAL_LABELS[signalType(bestSig.node.signals[bestSig.side])];
    const hasBoth = !!(bestSig.node.signals[1] && bestSig.node.signals[-1]);
    const dirHint = hasBoth ? ` (${bestSig.side === 1 ? 'forward' : 'backward'})` : '';
    return {
      kind: 'signal',
      node: bestSig.node,
      side: bestSig.side,
      x: bestSig.x,
      y: bestSig.y,
      z: bestSig.z,
      tx: bestSig.tx,
      tz: bestSig.tz,
      label: `${typeLabel} signal${dirHint}`,
    };
  }

  let bestSt: { station: Station; node: RailNode; d: number } | null = null;
  for (const st of net.stations) {
    const n = net.nodes.get(st.nodeId);
    if (!n) continue;
    const d = Math.hypot(n.x - p.x, n.z - p.z);
    if (d < 10 && (!bestSt || d < bestSt.d)) bestSt = { station: st, node: n, d };
  }
  if (bestSt) {
    return {
      kind: 'station',
      station: bestSt.station,
      x: bestSt.node.x,
      y: bestSt.node.y,
      z: bestSt.node.z,
      label: `station ${bestSt.station.name}`,
    };
  }

  const pi = host.placedSceneryNear(p.x, p.z, 7);
  if (pi >= 0) {
    const item = host.placedScenery[pi];
    return {
      kind: 'placed',
      index: pi,
      item,
      x: item.x,
      y: hf.height(item.x, item.z),
      z: item.z,
      label: SCENERY_LABEL[item.type].toLowerCase(),
    };
  }

  const near = net.nearest(p.x, p.z, 7);
  if (near) {
    const s = net.sample(near.seg, near.s);
    return { kind: 'track', seg: near.seg, x: s.x, y: s.y, z: s.z, label: 'track section' };
  }

  const gen = host.generatedSceneryNear(p.x, p.z, 6);
  if (gen) {
    return {
      kind: 'generated',
      item: gen,
      x: gen.x,
      y: hf.height(gen.x, gen.z),
      z: gen.z,
      label: SCENERY_LABEL[gen.type].toLowerCase(),
    };
  }

  return null;
}

function removeSingleTarget(ctx: EditorContext, target: DeleteTarget) {
  const { host } = ctx;
  const { net } = host;
  switch (target.kind) {
    case 'train':
      host.pushUndo();
      host.removeTrain(target.train);
      host.toast(`${target.train.name} removed`);
      return;
    case 'signal':
      ctx.edit({}, () => {
        delete target.node.signals[target.side];
        net.version++;
      });
      host.toast('Signal removed');
      return;
    case 'station':
      ctx.edit({ scenery: true }, () => {
        net.stations = net.stations.filter((s) => s !== target.station);
        net.version++;
      });
      host.toast(`${target.station.name} removed`);
      return;
    case 'placed':
      ctx.edit({ scenery: true }, () => {
        host.removePlacedScenery(target.index);
      });
      return;
    case 'track':
      ctx.edit({ scenery: true }, () => {
        net.removeSegment(target.seg);
      });
      host.toast('Track removed');
      return;
    case 'generated':
      ctx.edit({ scenery: true }, () => {
        host.addSceneryExclusion({ x: target.item.x, z: target.item.z, r: 1.5 });
      });
      return;
  }
}

function collectBoxMatches(ctx: EditorContext, x0: number, y0: number, x1: number, y1: number): BoxMatches {
  const minX = Math.min(x0, x1);
  const maxX = Math.max(x0, x1);
  const minY = Math.min(y0, y1);
  const maxY = Math.max(y0, y1);
  const inside = (wx: number, wy: number, wz: number) => {
    const s = ctx.project(wx, wy, wz);
    return s.visible && s.x >= minX && s.x <= maxX && s.y >= minY && s.y <= maxY;
  };
  const { net, sim, hf } = ctx.host;
  const trains: Train[] = [];
  for (const t of sim.trains) {
    for (let d = 0; d <= t.length; d += 6) {
      const q = sim.behind(t, Math.min(d, t.length));
      if (inside(q.x, q.y + 1.5, q.z)) {
        trains.push(t);
        break;
      }
    }
  }
  const signals: { node: RailNode; side: Side }[] = [];
  for (const n of net.nodes.values()) {
    for (const side of [1, -1] as Side[]) {
      if (!n.signals[side]) continue;
      const post = signalPostPosition(n, side);
      if (inside(post.x, post.y + 1.5, post.z)) signals.push({ node: n, side });
    }
  }
  const stations: Station[] = [];
  for (const st of net.stations) {
    const n = net.nodes.get(st.nodeId);
    if (n && inside(n.x, n.y + 1, n.z)) stations.push(st);
  }
  const placedIndices: number[] = [];
  ctx.host.placedScenery.forEach((it, i) => {
    if (inside(it.x, hf.height(it.x, it.z) + 1, it.z)) placedIndices.push(i);
  });
  const segs: number[] = [];
  for (const [id, g] of net.geom) {
    for (let i = 0; i < g.n; i += 2) {
      if (inside(g.pos[i * 3], g.pos[i * 3 + 1], g.pos[i * 3 + 2])) {
        segs.push(id);
        break;
      }
    }
  }
  const generated: PlacedItem[] = [];
  for (const it of ctx.host.generatedScenery) {
    if (inside(it.x, hf.height(it.x, it.z) + 1, it.z)) generated.push(it);
  }
  return { trains, signals, stations, placedIndices, segs, generated };
}

function summarizeMatches(m: BoxMatches): string {
  const parts: string[] = [];
  const add = (n: number, one: string, many: string) => {
    if (n > 0) parts.push(`${n} ${n === 1 ? one : many}`);
  };
  add(m.trains.length, 'train', 'trains');
  add(m.segs.length, 'track section', 'track sections');
  add(m.signals.length, 'signal', 'signals');
  add(m.stations.length, 'station', 'stations');
  add(m.placedIndices.length + m.generated.length, 'scenery item', 'scenery items');
  return parts.join(', ');
}

export class DeleteTool implements EditorTool {
  readonly id = 'delete' as const;
  readonly tapToConfirm = true;
  private drag: BoxDrag | null = null;

  leave(ctx: EditorContext) {
    this.cancel(ctx);
  }

  cancel(ctx: EditorContext) {
    this.drag = null;
    ctx.hideBox();
    ctx.setStatus('');
  }

  down(ctx: EditorContext, p: WorldPoint, screen?: ScreenPoint) {
    if (!screen) {
      const target = pickDeleteTarget(ctx.host, p);
      if (target) removeSingleTarget(ctx, target);
      return;
    }
    this.drag = { x0: screen.x, y0: screen.y, x1: screen.x, y1: screen.y, world: p, active: false };
  }

  move(ctx: EditorContext, _p: WorldPoint | null, screen?: ScreenPoint): boolean {
    if (!this.drag || !screen) return false;
    this.drag.x1 = screen.x;
    this.drag.y1 = screen.y;
    if (!this.drag.active && Math.hypot(screen.x - this.drag.x0, screen.y - this.drag.y0) >= 6) {
      this.drag.active = true;
    }
    if (!this.drag.active) return false;
    ctx.showBox(this.drag.x0, this.drag.y0, this.drag.x1, this.drag.y1);
    const summary = summarizeMatches(collectBoxMatches(ctx, this.drag.x0, this.drag.y0, this.drag.x1, this.drag.y1));
    ctx.setStatus(summary ? `Release to remove ${summary}` : 'Drag over items to remove (Esc to cancel)');
    return true;
  }

  up(ctx: EditorContext, p: WorldPoint | null) {
    const drag = this.drag;
    if (!drag) return;
    this.drag = null;
    ctx.hideBox();
    if (!drag.active) {
      const target = pickDeleteTarget(ctx.host, p ?? drag.world);
      if (target) removeSingleTarget(ctx, target);
      return;
    }
    const matches = collectBoxMatches(ctx, drag.x0, drag.y0, drag.x1, drag.y1);
    const summary = summarizeMatches(matches);
    if (!summary) return;
    const { host } = ctx;
    const { net } = host;
    const ok = ctx.edit({ scenery: true }, () => {
      for (const t of matches.trains) host.removeTrain(t);
      if (matches.signals.length) {
        for (const { node, side } of matches.signals) delete node.signals[side];
        net.version++;
      }
      if (matches.stations.length) {
        const drop = new Set(matches.stations);
        net.stations = net.stations.filter((s) => !drop.has(s));
        net.version++;
      }
      for (const idx of [...matches.placedIndices].sort((a, b) => b - a)) {
        host.removePlacedScenery(idx);
      }
      for (const segId of matches.segs) {
        if (net.segs.has(segId)) net.removeSegment(segId);
      }
      for (const it of matches.generated) {
        host.addSceneryExclusion({ x: it.x, z: it.z, r: 1.5 });
      }
    });
    if (ok) host.toast(`Removed ${summary}`);
  }

  hover(ctx: EditorContext, p: WorldPoint) {
    const target = pickDeleteTarget(ctx.host, p);
    if (!target) {
      ctx.setStatus('Click an item to remove it, or drag a box to remove multiple items');
      return;
    }
    const scale =
      target.kind === 'station'
        ? 6
        : target.kind === 'train'
          ? 5
          : target.kind === 'placed' || target.kind === 'generated'
            ? 3.5
            : 4;
    ctx.showHighlight(target.x, target.y + 0.5, target.z, scale);
    if (target.kind === 'signal') ctx.showArrow(target.x, target.y + 2, target.z, target.tx, target.tz);
    ctx.setStatus(`Click to remove ${target.label}`);
  }
}
