import { ANCHOR_NODE } from '../trackPlan';
import type { EditorContext, EditorTool, WorldPoint } from './tool';

export class SelectTool implements EditorTool {
  readonly id = 'select' as const;
  readonly leftPan = true;
  private dragging = false;
  private dragMoved = false;

  leave(ctx: EditorContext) {
    if (this.dragging) {
      this.dragging = false;
      ctx.setControlsEnabled(true);
    }
    this.dragMoved = false;
  }

  down(ctx: EditorContext, p: WorldPoint) {
    const n = ctx.host.net.nearestNode(p.x, p.z, ANCHOR_NODE);
    ctx.selected = n ? n.id : null;
    if (n) {
      ctx.setControlsEnabled(false);
      this.dragging = true;
      // Undo is recorded on the first real move, so selecting a point leaves history alone.
      this.dragMoved = false;
    }
    ctx.refreshPanel();
  }

  move(ctx: EditorContext, p: WorldPoint): boolean {
    if (!this.dragging || ctx.selected === null) return false;
    const net = ctx.host.net;
    const n = net.nodes.get(ctx.selected);
    if (!n) return false;
    if (!this.dragMoved) {
      ctx.host.pushUndo();
      this.dragMoved = true;
    }
    net.moveNode(n.id, p.x, n.y, p.z);
    ctx.host.commitEdit();
    ctx.setStatus(net.problemAt(n.id) ?? 'Release to place the point here');
    ctx.refreshPanel();
    return true;
  }

  up(ctx: EditorContext) {
    if (!this.dragging) return;
    this.dragging = false;
    ctx.setControlsEnabled(true);
    if (this.dragMoved && ctx.selected !== null) ctx.refuseIfBroken(ctx.selected, 'Move');
    else ctx.host.commitEdit({ scenery: true });
    this.dragMoved = false;
  }

  hover(ctx: EditorContext, p: WorldPoint) {
    const n = ctx.host.net.nearestNode(p.x, p.z, ANCHOR_NODE);
    if (n) ctx.showHighlight(n.x, n.y + 0.5, n.z, 5);
  }
}
