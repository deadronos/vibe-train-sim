import type * as THREE from 'three';

import type { Dir, Network, SignalType } from '../../rail/network';
import type { planCurve } from '../../rail/network';
import type { Sim, Train } from '../../rail/sim';
import type { Heightfield } from '../../world/heightfield';
import type { PlacedItem, SceneryExclusion, SceneryType } from '../../world/scenery';
import type { TrackPoint } from '../trackPlan';

export type Tool = 'select' | 'track' | 'signal' | 'station' | 'bridge' | 'terrain' | 'scenery' | 'train' | 'delete';
export type BrushMode = 'raise' | 'lower' | 'smooth' | 'flatten';
export type TrainKind = 'passenger' | 'shuttle' | 'freight' | 'emptyFreight';
export type WorldPoint = TrackPoint;
export interface ScreenPoint {
  x: number;
  y: number;
}

/** Narrow view of Game that the editor and its tools are allowed to use. */
export interface EditorHost {
  readonly renderer: THREE.WebGLRenderer;
  readonly camera: THREE.PerspectiveCamera;
  readonly scene: THREE.Scene;
  readonly editing: boolean;
  readonly net: Network;
  readonly hf: Heightfield;
  readonly sim: Sim;
  readonly driven: Train | null;
  readonly placedScenery: readonly PlacedItem[];
  readonly generatedScenery: readonly PlacedItem[];
  pushUndo(): void;
  commitEdit(opts?: { scenery?: boolean }): void;
  abandonEdit(): void;
  addPlacedScenery(item: PlacedItem): void;
  placedSceneryNear(x: number, z: number, radius: number): number;
  removePlacedScenery(index: number): void;
  generatedSceneryNear(x: number, z: number, radius: number): PlacedItem | null;
  addSceneryExclusion(ex: SceneryExclusion): void;
  addTrain(train: Train, seg: number, s: number, dir: Dir): Train | null;
  removeTrain(t: Train): void;
  toast(text: string, warn?: boolean): void;
  syncEditor(): void;
  syncTrains(): void;
}

/** Shared state and helpers passed into each editor tool handler. */
export interface EditorContext {
  readonly host: EditorHost;
  readonly cursor: WorldPoint | null;
  readonly shift: boolean;
  selected: number | null;
  heightOffset: number;
  snap: boolean;
  signalType: SignalType;
  brushMode: BrushMode;
  brushRadius: number;
  brushStrength: number;
  sceneryType: SceneryType;
  trainKind: TrainKind;

  /** Runs an edit inside pushUndo + commitEdit, abandoning it without a redo entry if fn returns false. */
  edit(opts: { scenery?: boolean }, fn: () => boolean | void): boolean;
  refuseIfBroken(node: number, action: string): boolean;
  setStatus(text: string): void;
  refreshPanel(): void;
  setControlsEnabled(enabled: boolean): void;
  showHighlight(x: number, y: number, z: number, scale: number): void;
  showArrow(x: number, y: number, z: number, tx: number, tz: number): void;
  showRing(x: number, y: number, z: number, radius: number): void;
  hideRing(): void;
  showRibbon(curve: ReturnType<typeof planCurve>, P: WorldPoint, Q: WorldPoint, ok: boolean): void;
  hideRibbon(): void;
  showBox(x0: number, y0: number, x1: number, y1: number): void;
  hideBox(): void;
  project(x: number, y: number, z: number): { x: number; y: number; visible: boolean };
}

export interface EditorTool {
  readonly id: Tool;
  readonly tapToConfirm?: boolean;
  readonly leftPan?: boolean;
  enter?(ctx: EditorContext): void;
  leave?(ctx: EditorContext): void;
  cancel?(ctx: EditorContext): void;
  down?(ctx: EditorContext, p: WorldPoint, screen?: ScreenPoint): void;
  move?(ctx: EditorContext, p: WorldPoint | null, screen?: ScreenPoint): boolean | void;
  up?(ctx: EditorContext, p: WorldPoint | null, screen?: ScreenPoint): void;
  hover?(ctx: EditorContext, p: WorldPoint): void;
  onHeightChange?(ctx: EditorContext): void;
}
