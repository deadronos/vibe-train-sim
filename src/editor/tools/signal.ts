import type { Side, SignalType } from '../../rail/network';
import { signalType } from '../../rail/network';
import type { EditorContext, EditorTool, WorldPoint } from './tool';
import { nodeForPoint, trackPointFromMouse } from './trackHit';

const SIGNAL_LABELS: Record<SignalType, string> = { main: 'main', distant: 'distant', shunt: 'calling-on' };

export const signalTool: EditorTool = {
  id: 'signal',
  tapToConfirm: true,
  down(ctx: EditorContext, p: WorldPoint) {
    const { host } = ctx;
    const pt = trackPointFromMouse(host.net, p);
    if (!pt) {
      host.toast('Click close to a track to place a signal');
      return;
    }
    ctx.edit({}, () => {
      const node = nodeForPoint(host.net, pt);
      const side: Side = node.dx * pt.tx + node.dz * pt.tz >= 0 ? 1 : -1;
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
      host.net.version++;
    });
  },
  hover(ctx: EditorContext, p: WorldPoint) {
    const pt = trackPointFromMouse(ctx.host.net, p);
    if (!pt) {
      ctx.setStatus('Move close to a track');
      return;
    }
    ctx.showArrow(pt.x + pt.tx * 7, pt.y + 2, pt.z + pt.tz * 7, pt.tx, pt.tz);
    ctx.showHighlight(pt.x, pt.y + 0.5, pt.z, 4);
    ctx.setStatus(
      'The signal controls trains running in the arrow direction. Move to the other side of the track to flip it',
    );
  },
};
