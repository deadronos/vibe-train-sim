import { DIAMOND_MAX_DY } from '../../rail/network';
import type { Anchor } from '../trackPlan';
import { anchorAt, anchorPos, buildTrackSegment, previewTrackPlan } from '../trackPlan';
import type { EditorContext, EditorTool, WorldPoint } from './tool';

export class TrackTool implements EditorTool {
  readonly id = 'track' as const;
  readonly tapToConfirm = true;
  private start: Anchor | null = null;

  leave(ctx: EditorContext) {
    this.cancel(ctx);
  }

  cancel(ctx: EditorContext) {
    this.start = null;
    ctx.hideRibbon();
    ctx.setStatus('');
  }

  onHeightChange(ctx: EditorContext) {
    this.refreshPreview(ctx);
  }

  private refreshPreview(ctx: EditorContext) {
    if (!this.start || !ctx.cursor) {
      ctx.hideRibbon();
      return;
    }
    const { net, hf } = ctx.host;
    const end = anchorAt(net, (x, z) => hf.baseAt(x, z), ctx.cursor, ctx.heightOffset);
    const plan = previewTrackPlan(net, this.start, end, ctx.shift || ctx.snap);
    ctx.setStatus(plan.reason);
    if (!plan.curve) {
      ctx.hideRibbon();
      return;
    }
    ctx.showRibbon(plan.curve, plan.P, plan.Q, plan.ok);
  }

  down(ctx: EditorContext, p: WorldPoint) {
    const { host } = ctx;
    const { net, hf } = host;
    const here = anchorAt(net, (x, z) => hf.baseAt(x, z), p, ctx.heightOffset);
    if (!this.start) {
      this.start = here;
      ctx.setStatus('Click where the track should end');
      return;
    }
    const plan = previewTrackPlan(net, this.start, here, ctx.shift || ctx.snap);
    if (!plan.ok) {
      host.toast(plan.reason);
      return;
    }
    const startA = this.start;
    let builtSegId = -1;
    let failReason = '';
    const committed = ctx.edit({ scenery: true }, () => {
      const res = buildTrackSegment(net, startA, here, plan);
      if (!res.ok) {
        failReason = res.reason;
        return false;
      }
      builtSegId = res.seg.id;
      this.start = res.nextStart;
      if (!this.start) ctx.hideRibbon();
      return true;
    });
    if (!committed) {
      host.toast(failReason);
      this.cancel(ctx);
      return;
    }
    this.refreshPreview(ctx);
    const crossings = net.crossingsOn(builtSegId);
    if (crossings.some((c) => Math.abs(c.y1 - c.y2) > DIAMOND_MAX_DY)) {
      host.toast('Tight crossing clearance: raise to ≥5 m for a bridge, or match height for a diamond', true);
    } else if (crossings.length) {
      host.toast('Interlocked diamond crossing formed');
    }
  }

  hover(ctx: EditorContext, p: WorldPoint) {
    const { net, hf } = ctx.host;
    const a = anchorAt(net, (x, z) => hf.baseAt(x, z), p, ctx.heightOffset);
    if (a.kind !== 'free') {
      const q = anchorPos(net, a);
      ctx.showHighlight(q.x, q.y + 0.5, q.z, 5);
    }
    if (this.start) {
      this.refreshPreview(ctx);
    } else {
      ctx.setStatus(
        a.kind === 'node'
          ? 'Click to continue from here'
          : a.kind === 'seg'
            ? 'Click to branch from this track'
            : 'Click to start a new line',
      );
    }
  }
}
