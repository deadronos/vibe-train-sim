import type { Bounds2D } from '../../rail/network';
import type { EditorContext, EditorTool, WorldPoint } from './tool';

export class TerrainTool implements EditorTool {
  readonly id = 'terrain' as const;
  private brushing = false;
  private flattenTo = 0;
  private strokeBounds: Bounds2D | null = null;

  leave(ctx: EditorContext) {
    this.brushing = false;
    this.strokeBounds = null;
    ctx.hideRing();
  }

  down(ctx: EditorContext, p: WorldPoint) {
    const { host } = ctx;
    host.pushUndo();
    this.brushing = true;
    this.strokeBounds = null;
    this.flattenTo = host.hf.baseAt(p.x, p.z);
    this.brushAt(ctx, p);
  }

  move(ctx: EditorContext, p: WorldPoint | null): boolean {
    if (this.brushing && p) this.brushAt(ctx, p);
    return false;
  }

  up(ctx: EditorContext) {
    if (!this.brushing) return;
    this.brushing = false;
    const b = this.strokeBounds;
    this.strokeBounds = null;
    if (b) {
      const pad = 8;
      for (const id of ctx.host.net.segmentsInBounds(b.minX - pad, b.minZ - pad, b.maxX + pad, b.maxZ + pad)) {
        ctx.host.net.dirty.add(id);
      }
      ctx.host.commitEdit({
        scenery: true,
        bounds: { minX: b.minX - pad, minZ: b.minZ - pad, maxX: b.maxX + pad, maxZ: b.maxZ + pad },
      });
    } else {
      ctx.host.commitEdit({ scenery: true });
    }
  }

  hover(ctx: EditorContext, p: WorldPoint) {
    ctx.showRing(p.x, p.y + 2, p.z, ctx.brushRadius);
    ctx.setStatus('');
  }

  private brushAt(ctx: EditorContext, p: { x: number; z: number }) {
    const { hf, net } = ctx.host;
    const r = ctx.brushRadius;
    hf.brush(ctx.brushMode, p.x, p.z, r, ctx.brushStrength, this.flattenTo);
    hf.grade(net);
    if (!this.strokeBounds) {
      this.strokeBounds = { minX: p.x - r, minZ: p.z - r, maxX: p.x + r, maxZ: p.z + r };
    } else {
      this.strokeBounds.minX = Math.min(this.strokeBounds.minX, p.x - r);
      this.strokeBounds.minZ = Math.min(this.strokeBounds.minZ, p.z - r);
      this.strokeBounds.maxX = Math.max(this.strokeBounds.maxX, p.x + r);
      this.strokeBounds.maxZ = Math.max(this.strokeBounds.maxZ, p.z + r);
    }
  }
}
