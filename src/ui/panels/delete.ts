import { heading, para } from './controls';
import type { PanelFactory } from './panel';

export const deletePanel: PanelFactory = (container) => {
  container.append(
    heading('Remove'),
    para('Click a train, signal, station, placed scenery or section of track to remove it.'),
  );
  return { key: () => 'delete', update: () => {} };
};
