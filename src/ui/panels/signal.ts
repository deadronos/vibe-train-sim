import type { SignalType } from '../../rail/network';
import { buttonRow, heading, para } from './controls';
import type { PanelFactory } from './panel';

const SIGNAL_TYPES: { type: SignalType; label: string }[] = [
  { type: 'main', label: 'Main' },
  { type: 'distant', label: 'Distant' },
  { type: 'shunt', label: 'Calling-on' },
];

export const signalPanel: PanelFactory = (container, g) => {
  const ed = g.editor;
  const row = buttonRow(
    SIGNAL_TYPES.map((s) => ({
      label: s.label,
      pressed: s.type === ed.signalType,
      dataset: { sig: s.type },
      onClick: () => {
        ed.signalType = s.type;
        update();
      },
    })),
  );
  row.root.id = 'signal-types';
  const update = () => {
    for (const b of row.buttons) b.setAttribute('aria-pressed', String(b.dataset.sig === ed.signalType));
  };
  container.append(
    heading('Signals'),
    row.root,
    para('Click beside a track to place or switch type; click again with the same type to remove.'),
    para(
      'Main stops at red and shows junction routes; distant repeats the next main signal; calling-on admits trains into occupied track at 25 km/h.',
    ),
  );
  return { key: () => 'signal', update };
};
