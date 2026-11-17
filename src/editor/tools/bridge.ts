import type { EditorContext, EditorTool, WorldPoint } from './tool';

const BRIDGE_NEXT = { auto: 'force', force: 'none', none: 'auto' } as const;
const BRIDGE_TOAST = {
  auto: 'Automatic: bridges where the track is high above ground',
  force: 'Always a bridge on this section',
  none: 'Always an embankment on this section',
};
const BRIDGE_STATUS = { auto: 'automatic', force: 'always a bridge', none: 'always an embankment' };

export const bridgeTool: EditorTool = {
  id: 'bridge',
  tapToConfirm: true,
  down(ctx: EditorContext, p: WorldPoint) {
    const { host } = ctx;
    const near = host.net.nearest(p.x, p.z, 16);
    if (!near) {
      host.toast('Click a track to change how it crosses the ground');
      return;
    }
    const seg = host.net.segs.get(near.seg)!;
    ctx.edit({ scenery: true }, () => {
      seg.bridge = BRIDGE_NEXT[seg.bridge];
      host.net.dirty.add(seg.id);
      host.net.version++;
    });
    host.toast(BRIDGE_TOAST[seg.bridge]);
  },
  hover(ctx: EditorContext, p: WorldPoint) {
    const near = ctx.host.net.nearest(p.x, p.z, 16);
    if (!near) return;
    const s = ctx.host.net.sample(near.seg, near.s);
    ctx.showHighlight(s.x, s.y + 0.5, s.z, 4);
    ctx.setStatus(`This section: ${BRIDGE_STATUS[ctx.host.net.segs.get(near.seg)!.bridge]}. Click to change`);
  },
};
