import type { Side, SignalType } from '../../rail/network';
import { signalType } from '../../rail/network';
import type { EditorContext, EditorTool, WorldPoint } from './tool';
import { nodeForPoint, trackPointFromMouse } from './trackHit';

const SIGNAL_LABELS: Record<SignalType, string> = { main: 'main', distant: 'distant', shunt: 'calling-on' };

function inspectSignal(ctx: EditorContext, p: WorldPoint) {
  const { net } = ctx.host;
  const pt = trackPointFromMouse(net, p);
  if (!pt) return null;
  const existingNode = net.nearestNode(pt.x, pt.z, 10);
  const side: Side = existingNode ? (existingNode.dx * pt.tx + existingNode.dz * pt.tz >= 0 ? 1 : -1) : 1;
  return { pt, existingNode, side, existing: existingNode?.signals[side] };
}

export const signalTool: EditorTool = {
  id: 'signal',
  tapToConfirm: true,
  down(ctx: EditorContext, p: WorldPoint) {
    const { host } = ctx;
    const hit = inspectSignal(ctx, p);
    if (!hit) {
      host.toast('Click close to a track to place a signal');
      return;
    }
    ctx.edit({}, () => {
      const node = hit.existingNode ?? nodeForPoint(host.net, hit.pt);
      const side: Side = node.dx * hit.pt.tx + node.dz * hit.pt.tz >= 0 ? 1 : -1;
      const existing = node.signals[side];
      if (existing) {
        if (signalType(existing) !== ctx.signalType) {
          existing.type = ctx.signalType;
          host.toast(`Signal changed to ${SIGNAL_LABELS[ctx.signalType]}`);
        } else {
          delete node.signals[side];
          host.toast('Signal removed');
        }
      } else {
        node.signals[side] = { hold: false, type: ctx.signalType };
        const label = SIGNAL_LABELS[ctx.signalType];
        host.toast(`${label[0].toUpperCase()}${label.slice(1)} signal placed`);
      }
      host.net.markSignalDirty(node.id);
      host.net.version++;
      host.playLeverSound?.('signal');
    });
  },
  hover(ctx: EditorContext, p: WorldPoint) {
    const hit = inspectSignal(ctx, p);
    if (!hit) {
      ctx.setStatus('Move close to a track to place or change a signal');
      return;
    }
    const { pt, existingNode, existing } = hit;
    const hx = existingNode ? existingNode.x : pt.x;
    const hy = existingNode ? existingNode.y : pt.y;
    const hz = existingNode ? existingNode.z : pt.z;
    ctx.showArrow(hx + pt.tx * 7, hy + 2, hz + pt.tz * 7, pt.tx, pt.tz);
    ctx.showHighlight(hx, hy + 0.5, hz, 4);
    if (existing) {
      const curType = signalType(existing);
      ctx.setStatus(
        curType !== ctx.signalType
          ? `Click to change ${SIGNAL_LABELS[curType]} signal to ${SIGNAL_LABELS[ctx.signalType]}`
          : `Click to remove ${SIGNAL_LABELS[curType]} signal`,
      );
    } else {
      ctx.setStatus(
        `Click to place ${SIGNAL_LABELS[ctx.signalType]} signal facing the arrow (move across track to flip)`,
      );
    }
  },
};
