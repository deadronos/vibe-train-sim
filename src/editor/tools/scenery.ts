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
};
