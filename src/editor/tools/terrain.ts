import type { EditorContext, EditorTool, WorldPoint } from './tool';

export class TerrainTool implements EditorTool {
  readonly id = 'terrain' as const;
  private brushing = false;
  private flattenTo = 0;

  leave(ctx: EditorContext) {
    this.brushing = false;
    ctx.hideRing();
  }

  down(ctx: EditorContext, p: WorldPoint) {
    const { host } = ctx;
    host.pushUndo();
    this.brushing = true;
    this.flattenTo = host.hf.baseAt(p.x, p.z);
    this.brushAt(ctx, p);
  }

  move(ctx: EditorContext, p: WorldPoint): boolean {
    if (this.brushing) this.brushAt(ctx, p);
    return false;
  }

  up(ctx: EditorContext) {
    if (!this.brushing) return;
    this.brushing = false;
    ctx.host.net.dirty = new Set(ctx.host.net.segs.keys());
    ctx.host.commitEdit({ scenery: true });
  }

  hover(ctx: EditorContext, p: WorldPoint) {
    ctx.showRing(p.x, p.y + 2, p.z, ctx.brushRadius);
    ctx.setStatus('');
  }

  private brushAt(ctx: EditorContext, p: { x: number; z: number }) {
    const { hf, net } = ctx.host;
    hf.brush(ctx.brushMode, p.x, p.z, ctx.brushRadius, ctx.brushStrength, this.flattenTo);
    hf.grade(net);
  }
}
