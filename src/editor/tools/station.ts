import type { EditorContext, EditorTool, WorldPoint } from './tool';
import { nodeForPoint, trackPointFromMouse } from './trackHit';

const STATION_NAMES = [
  'Ashcombe',
  'Birchford',
  'Coldwater',
  'Dunmoor',
  'Elmstead',
  'Fernhollow',
  'Greyhaven',
  'Hartsmere',
  'Ivybridge Road',
  'Juniper Halt',
  'Kestrel Lane',
  'Low Marsh',
];

export class StationTool implements EditorTool {
  readonly id = 'station' as const;
  readonly tapToConfirm = true;
  private nameCounter = 0;

  down(ctx: EditorContext, p: WorldPoint) {
    const { host } = ctx;
    const pt = trackPointFromMouse(host.net, p);
    if (!pt) {
      host.toast('Click close to a track to place a station');
      return;
    }
    const node0 = host.net.nearestNode(pt.x, pt.z, 10);
    if (node0 && host.net.stationAt(node0.id)) {
      host.toast('This point already has a station');
      return;
    }
    let name = '';
    ctx.edit({ scenery: true }, () => {
      const node = nodeForPoint(host.net, pt);
      const onRightOfNode = (p.x - node.x) * -node.dz + (p.z - node.z) * node.dx >= 0;
      name = STATION_NAMES[this.nameCounter++ % STATION_NAMES.length];
      host.net.stations.push({
        id: host.net.id(),
        name,
        nodeId: node.id,
        platformSide: onRightOfNode ? 1 : -1,
        length: 140,
      });
      host.net.version++;
      ctx.selected = node.id;
    });
    host.toast(`Station ${name} placed. Rename it from the panel with the select tool`);
  }

  hover(ctx: EditorContext, p: WorldPoint) {
    const pt = trackPointFromMouse(ctx.host.net, p);
    if (!pt) {
      ctx.setStatus('Move close to a track');
      return;
    }
    ctx.showHighlight(pt.x, pt.y + 0.5, pt.z, 4);
    ctx.setStatus('The platform is built on the side the mouse is on');
  }
}
