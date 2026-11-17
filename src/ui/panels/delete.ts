import { heading, para } from './controls';
import type { PanelFactory } from './panel';

export const deletePanel: PanelFactory = (container) => {
  container.append(
    heading('Remove'),
    para('Click a train, signal, station, tree, rock, building or section of track to remove it.'),
    para('Drag a box to remove several items at once.'),
  );
  return { key: () => 'delete', update: () => {} };
};
