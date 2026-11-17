import { heading, para } from './controls';
import type { PanelFactory } from './panel';

export const bridgePanel: PanelFactory = (container) => {
  container.append(
    heading('Bridges'),
    para('Click a section of track to switch between automatic, always a bridge, and always an embankment.'),
    para('Spans over water get a steel truss.'),
  );
  return { key: () => 'bridge', update() {} };
};
