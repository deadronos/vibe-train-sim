import { SCENERY_LABEL } from '../../world/scenery';
import type { EditorContext, EditorTool, WorldPoint } from './tool';

export const sceneryTool: EditorTool = {
  id: 'scenery',
  tapToConfirm: true,
  down(ctx: EditorContext, p: WorldPoint) {
    ctx.edit({ scenery: true }, () => {
      ctx.host.addPlacedScenery({
        type: ctx.sceneryType,
        x: p.x,
        z: p.z,
        rot: Math.random() * Math.PI * 2,
        scale: ctx.sceneryType.startsWith('house') ? 1 : 0.8 + Math.random() * 0.5,
      });
    });
  },
  hover(ctx: EditorContext, p: WorldPoint) {
    ctx.showHighlight(p.x, p.y + 0.5, p.z, 3);
    ctx.setStatus(`Click to place ${SCENERY_LABEL[ctx.sceneryType].toLowerCase()}`);
  },
};
