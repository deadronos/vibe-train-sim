import { EMPTY_FREIGHT, FREIGHT, PASSENGER, SHUTTLE } from '../../rail/demoMap';
import { Train } from '../../rail/sim';
import type { Car } from '../../rail/vehicles';
import type { EditorContext, EditorTool, TrainKind, WorldPoint } from './tool';
import { trackPointFromMouse } from './trackHit';

const CONSIST_BUILDERS: Record<TrainKind, () => Car[]> = {
  passenger: PASSENGER,
  shuttle: SHUTTLE,
  freight: FREIGHT,
  emptyFreight: EMPTY_FREIGHT,
};

const TRAIN_LABELS: Record<TrainKind, string> = {
  passenger: 'Express',
  shuttle: 'Local',
  freight: 'Freight',
  emptyFreight: 'Empties',
};

export const trainTool: EditorTool = {
  id: 'train',
  tapToConfirm: true,
  down(ctx: EditorContext, p: WorldPoint) {
    const { host } = ctx;
    const pt = trackPointFromMouse(host.net, p);
    if (!pt) {
      host.toast('Click a track to add a train');
      return;
    }
    const num = 400 + Math.floor(Math.random() * 500);
    const id = host.sim.trains.reduce((m, t) => Math.max(m, t.id), 0) + 1;
    const train = new Train(id, `${TRAIN_LABELS[ctx.trainKind]} ${num}`, CONSIST_BUILDERS[ctx.trainKind]());
    let blocker: Train | null = null;
    host.pushUndo();
    blocker = host.addTrain(train, pt.seg, pt.s, pt.travel);
    if (blocker) {
      host.abandonEdit();
      host.toast(`There's no room: ${blocker.name} is in the way. Click a clear stretch of track`, true);
      return;
    }
    host.sim.plan(train, false);
    host.syncTrains();
    host.toast(`${train.name} is on the line`);
  },
  hover(ctx: EditorContext, p: WorldPoint) {
    const pt = trackPointFromMouse(ctx.host.net, p);
    if (!pt) {
      ctx.setStatus('Move close to a track');
      return;
    }
    ctx.showArrow(pt.x + pt.tx * 7, pt.y + 2, pt.z + pt.tz * 7, pt.tx, pt.tz);
    ctx.showHighlight(pt.x, pt.y + 0.5, pt.z, 4);
    ctx.setStatus('The train will head the way the arrow points. Move to the other side of the track to turn it');
  },
};
