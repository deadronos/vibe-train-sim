import type { BrushMode } from '../../editor/editor';
import { buttonRow, heading, labeledRange, para } from './controls';
import type { PanelFactory } from './panel';

const BRUSH_MODES: { mode: BrushMode; label: string }[] = [
  { mode: 'raise', label: 'Raise' },
  { mode: 'lower', label: 'Lower' },
  { mode: 'smooth', label: 'Smooth' },
  { mode: 'flatten', label: 'Flatten' },
];

export const terrainPanel: PanelFactory = (container, g) => {
  const ed = g.editor;
  const modes = buttonRow(
    BRUSH_MODES.map((m) => ({
      label: m.label,
      pressed: m.mode === ed.brushMode,
      dataset: { mode: m.mode },
      onClick: () => {
        ed.brushMode = m.mode;
        update();
      },
    })),
  );
  modes.root.id = 'brush-modes';
  const size = labeledRange({
    id: 'brush-size',
    label: 'Brush size',
    min: 15,
    max: 220,
    value: ed.brushRadius,
    onInput: (v) => (ed.brushRadius = v),
  });
  const strength = labeledRange({
    id: 'brush-str',
    label: 'Strength',
    min: 0.1,
    max: 2,
    step: 0.05,
    value: ed.brushStrength,
    onInput: (v) => (ed.brushStrength = v),
  });
  const update = () => {
    for (const b of modes.buttons) b.setAttribute('aria-pressed', String(b.dataset.mode === ed.brushMode));
    size.setValue(ed.brushRadius);
    strength.setValue(ed.brushStrength);
  };
  container.append(
    heading('Shape terrain'),
    modes.root,
    size.root,
    strength.root,
    para('Lower the ground below the waterline to make lakes and rivers.'),
  );
  return { key: () => 'terrain', update };
};
