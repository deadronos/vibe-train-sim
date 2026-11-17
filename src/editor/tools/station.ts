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
      host.net.markStationDirty(node.id);
      host.net.version++;
      ctx.selected = node.id;
    });
    host.toast(`Station ${name} placed. Rename it from the panel with the select tool`);
  }

  hover(ctx: EditorContext, p: WorldPoint) {
    const { net } = ctx.host;
    const pt = trackPointFromMouse(net, p);
    if (!pt) {
      ctx.setStatus('Move close to a track to place a station');
      return;
    }
    const node0 = net.nearestNode(pt.x, pt.z, 10);
    const existing = node0 ? net.stationAt(node0.id) : undefined;
    const hx = node0 ? node0.x : pt.x;
    const hy = node0 ? node0.y : pt.y;
    const hz = node0 ? node0.z : pt.z;
    ctx.showHighlight(hx, hy + 0.5, hz, existing ? 5 : 4);
    if (existing) {
      ctx.setStatus(`${existing.name} is already at this point — move along the track to place another`);
      return;
    }
    // Arrow points to the side of the track where the platform will be built.
    const rx = node0 ? -node0.dz : -pt.tz;
    const rz = node0 ? node0.dx : pt.tx;
    const side = (p.x - hx) * rx + (p.z - hz) * rz >= 0 ? 1 : -1;
    ctx.showArrow(hx + rx * side * 6, hy + 1.5, hz + rz * side * 6, rx * side, rz * side);
    ctx.setStatus('Click to place a station (arrow shows platform side)');
  }
}
