import { heading, para } from './controls';
import type { PanelFactory } from './panel';

export const stationPanel: PanelFactory = (container) => {
  container.append(
    heading('Stations'),
    para('Click beside a track to build a platform on that side. Trains stop here on their timetable.'),
  );
  return { key: () => 'station', update() {} };
};
