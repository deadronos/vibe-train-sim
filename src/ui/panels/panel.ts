import type { Game } from '../../game';

export interface EditorPanel {
  /** Key whose change means the panel structure must be rebuilt rather than updated in place. */
  key(): string;
  /** Updates control values and pressed states in place, preserving keyboard focus. */
  update(): void;
}

export type PanelFactory = (container: HTMLElement, g: Game, sync: () => void) => EditorPanel;
