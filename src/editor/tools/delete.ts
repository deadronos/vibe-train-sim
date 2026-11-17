import type { EditorContext, EditorTool, WorldPoint } from './tool';

export const deleteTool: EditorTool = {
  id: 'delete',
  tapToConfirm: true,
  down(ctx: EditorContext, p: WorldPoint) {
    const { host } = ctx;
    const { net, sim } = host;
    for (const t of sim.trains) {
      for (let d = 0; d <= t.length; d += 8) {
        const q = sim.behind(t, d);
        if (Math.hypot(q.x - p.x, q.z - p.z) < 7) {
          host.pushUndo();
          host.removeTrain(t);
          host.toast(`${t.name} removed`);
          return;
        }
      }
    }
    const n = net.nearestNode(p.x, p.z, 8);
    if (n && (n.signals[1] || n.signals[-1])) {
      ctx.edit({}, () => {
        n.signals = {};
        net.version++;
      });
      host.toast('Signal removed');
      return;
    }
    if (n) {
      const st = net.stationAt(n.id);
      if (st) {
        ctx.edit({ scenery: true }, () => {
          net.stations = net.stations.filter((s) => s !== st);
          net.version++;
        });
        host.toast(`${st.name} removed`);
        return;
      }
    }
    const pi = host.placedSceneryNear(p.x, p.z, 7);
    if (pi >= 0) {
      ctx.edit({ scenery: true }, () => {
        host.removePlacedScenery(pi);
      });
      return;
    }
    const near = net.nearest(p.x, p.z, 7);
    if (near) {
      ctx.edit({ scenery: true }, () => {
        net.removeSegment(near.seg);
      });
      host.toast('Track removed');
    }
  },
  hover(ctx: EditorContext, p: WorldPoint) {
    const near = ctx.host.net.nearest(p.x, p.z, 7);
    if (!near) return;
    const s = ctx.host.net.sample(near.seg, near.s);
    ctx.showHighlight(s.x, s.y + 0.5, s.z, 4);
  },
};
