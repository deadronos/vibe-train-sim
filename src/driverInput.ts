// Keys held by the driver and the power lever they move.
import type { Game } from './game';
import { activatesFocused, gameKeyAllowed, keyContext } from './keyFilter';
import type { Train } from './rail/sim';

// The first part of the lever's brake side is engine brake alone, and the rest adds the air brake.
const ENGINE_BRAKE_RANGE = 0.25;

export class DriverInput {
  /** Power lever: positive is throttle, negative is brake. */
  lever = 0;
  private keys = new Set<string>();

  press(code: string) {
    this.keys.add(code);
  }

  release(code: string) {
    this.keys.delete(code);
  }

  releaseAll() {
    this.keys.clear();
  }

  /** True while a power key is held, which takes a train off autopilot. */
  get movingLever() {
    return this.keys.has('KeyW') || this.keys.has('ArrowUp') || this.keys.has('KeyS') || this.keys.has('ArrowDown');
  }

  /** Moves the lever for held keys and applies it to the train. */
  drive(t: Train, dt: number) {
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) this.lever = Math.min(1, this.lever + dt * 0.55);
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) this.lever = Math.max(-1, this.lever - dt * 0.75);
    t.throttle = Math.max(0, this.lever);
    t.dynamic = Math.min(1, Math.max(0, -this.lever) / ENGINE_BRAKE_RANGE);
    t.brake = Math.max(0, (-this.lever - ENGINE_BRAKE_RANGE) / (1 - ENGINE_BRAKE_RANGE));
    t.emergency = this.keys.has('Space');
  }

  bind(g: Game) {
    window.addEventListener('keydown', (e) => {
      const ctx = keyContext(e);
      const undoKey = (e.ctrlKey || e.metaKey) && !e.altKey && e.code === 'KeyZ';
      if (!gameKeyAllowed(undoKey ? { ...ctx, modifier: false } : ctx)) return;
      g.audio.unlock();
      // Space is the brake; stop it also pressing a focused button.
      if (activatesFocused(ctx)) e.preventDefault();
      if ((e.ctrlKey || e.metaKey) && e.code === 'KeyZ' && g.editing) {
        e.preventDefault();
        if (e.shiftKey) g.redo();
        else g.undo();
        return;
      }
      if (e.code === 'KeyE' && !e.repeat) {
        e.preventDefault();
        g.setMode(!g.editing);
        return;
      }
      if (e.code === 'KeyH' && !e.repeat) g.audio.horn(true);
      this.press(e.code);
      if (g.editing || e.repeat) return;
      switch (e.code) {
        case 'KeyC':
          g.rig.cycle();
          g.hud.syncDrive();
          break;
        case 'KeyJ':
          g.throwNextSwitch();
          break;
        case 'KeyP':
          g.setAutopilot(!g.driven?.ai);
          break;
        case 'KeyN':
          g.nextTrain();
          break;
        case 'KeyR':
          g.reverseDriven();
          break;
        case 'KeyM':
          g.audio.setMuted(!g.audio.muted);
          g.hud.toast(g.audio.muted ? 'Sound off' : 'Sound on');
          break;
      }
    });
    window.addEventListener('keyup', (e) => {
      // Browsers click a focused button on Space keyup, so stop that too.
      if (gameKeyAllowed(keyContext(e)) && activatesFocused(keyContext(e))) e.preventDefault();
      this.release(e.code);
      if (e.code === 'KeyH') g.audio.horn(false);
    });
    // A key released while another window had focus never sends keyup.
    const releaseAll = () => {
      this.releaseAll();
      g.audio.horn(false);
      g.editor.releaseKeys();
    };
    window.addEventListener('blur', releaseAll);
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) releaseAll();
    });
    window.addEventListener('pointerdown', () => g.audio.unlock());
  }
}
