import { buttonRow, heading, labeledCheckbox, labeledRange, para } from './controls';
import type { PanelFactory } from './panel';

export const trackPanel: PanelFactory = (container, g) => {
  const ed = g.editor;
  const height = labeledRange({
    id: 'height',
    outputId: 'height-val',
    label: 'Height above ground',
    unit: ' m',
    min: -30,
    max: 60,
    step: 1,
    value: ed.heightOffset,
    onInput: (v) => (ed.heightOffset = v),
  });
  const snap = labeledCheckbox({
    id: 'snap',
    label: 'Snap new lines to 15° steps (Shift)',
    checked: ed.snap,
    onChange: (checked) => (ed.snap = checked),
  });
  const stop = buttonRow([{ id: 'stop-laying', label: 'Stop laying (Esc)', onClick: () => ed.cancel() }]);
  container.append(
    heading('Lay track'),
    para(
      'Click to start, then click again to lay a section. Start on a track to branch into a junction, or finish on one to join it.',
    ),
    height.root,
    para('High sections become bridges automatically. Low sections cut through the ground.'),
    snap.root,
    stop.root,
  );
  return {
    key: () => 'track',
    update() {
      height.setValue(ed.heightOffset);
      snap.setChecked(ed.snap);
    },
  };
};
