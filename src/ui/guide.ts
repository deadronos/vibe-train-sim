// A short first-run guide: drive to a station, then lay track and drive again. Skippable, and replayable from Help.
import type { Game } from '../game';

const KEY = 'vibe-train-sim/guide';

interface Step {
  text: string;
  /** True once the player has done what the step asks. segs is the track count when the step began. */
  done: (g: Game, segs: number) => boolean;
}

const STEPS: Step[] = [
  {
    text: 'Take the controls: press W, or push the lever on the right of the desk up. The autopilot hands the train to you.',
    done: (g) => !!g.driven && !g.driven.ai,
  },
  {
    text: 'Drive to the next station and stop with the whole train in the platform. S brakes. The desk shows the limit, the next signal and how far the stop is.',
    done: (g) => (g.driven?.duty?.stops ?? 0) > 0,
  },
  {
    text: 'Now build some railway: press E, or choose Edit map at the top left.',
    done: (g) => g.editing,
  },
  {
    text: 'Pull the Track lever. Click the end of a line or beside a track, then click again to lay a section.',
    done: (g, segs) => g.net.segs.size > segs,
  },
  {
    text: 'Press E to drive again. Your new track is part of the railway, and trains can run on it.',
    done: (g) => !g.editing,
  },
];

export class Guide {
  private step = -1;
  private segs = 0;

  constructor(
    private game: Game,
    private el: HTMLElement,
  ) {
    el.querySelector<HTMLButtonElement>('.guide-skip')!.onclick = () => this.finish();
    this.step = readStep();
    this.enter();
  }

  restart() {
    this.step = 0;
    this.enter();
  }

  /** Called a few times a second. */
  update() {
    if (this.step < 0) return;
    if (!STEPS[this.step].done(this.game, this.segs)) return;
    this.step++;
    if (this.step >= STEPS.length) {
      this.finish();
      this.game.hud.toast('That is the railway: drive, build and drive again. Help lists every control');
      return;
    }
    this.enter();
  }

  private enter() {
    writeStep(this.step);
    this.el.hidden = this.step < 0;
    if (this.step < 0) return;
    this.segs = this.game.net?.segs.size ?? 0;
    this.el.querySelector('.guide-count')!.textContent = `Getting started, ${this.step + 1} of ${STEPS.length}`;
    this.el.querySelector('.guide-text')!.textContent = STEPS[this.step].text;
  }

  private finish() {
    this.step = -1;
    this.enter();
  }
}

/** The step to show, or -1 when the guide is finished or skipped. A new player starts at 0. */
function readStep(): number {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return 0;
    const n = Number(raw);
    return Number.isInteger(n) && n >= -1 && n < STEPS.length ? n : -1;
  } catch {
    return -1;
  }
}

function writeStep(n: number) {
  try {
    localStorage.setItem(KEY, String(n));
  } catch {
    /* The guide just starts again next time. */
  }
}
