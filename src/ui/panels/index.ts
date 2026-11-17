import type { Tool } from '../../editor/editor';
import { bridgePanel } from './bridge';
import { deletePanel } from './delete';
import type { PanelFactory } from './panel';
import { sceneryPanel } from './scenery';
import { selectPanel } from './select';
import { signalPanel } from './signal';
import { stationPanel } from './station';
import { terrainPanel } from './terrain';
import { trackPanel } from './track';
import { trainPanel } from './train';

export type { EditorPanel, PanelFactory } from './panel';

export const PANELS: Record<Tool, PanelFactory> = {
  select: selectPanel,
  track: trackPanel,
  signal: signalPanel,
  station: stationPanel,
  bridge: bridgePanel,
  terrain: terrainPanel,
  scenery: sceneryPanel,
  train: trainPanel,
  delete: deletePanel,
};
