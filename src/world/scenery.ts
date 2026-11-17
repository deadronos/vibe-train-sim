// World scenery item types and placed-scenery data, shared between saves, the editor and rendering.
export type SceneryType =
  | 'tree_pine'
  | 'tree_oak'
  | 'tree_birch'
  | 'rock_a'
  | 'rock_b'
  | 'house_a'
  | 'house_b'
  | 'house_c';

export const SCENERY_TYPES: Record<SceneryType, true> = {
  tree_pine: true,
  tree_oak: true,
  tree_birch: true,
  rock_a: true,
  rock_b: true,
  house_a: true,
  house_b: true,
  house_c: true,
};

export interface PlacedItem {
  type: SceneryType;
  x: number;
  z: number;
  rot: number;
  scale: number;
}
