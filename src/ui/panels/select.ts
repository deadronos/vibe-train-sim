import type { Game } from '../../game';
import type { Side, SignalType } from '../../rail/network';
import { signalType } from '../../rail/network';
import { buttonRow, heading, labeledCheckbox, labeledRange, labeledSelect, labeledText, para } from './controls';
import type { PanelFactory } from './panel';

const SPEED_LIMITS = [0, 30, 50, 70, 90, 120];
const SIGNAL_TYPE_OPTIONS: { value: SignalType; label: string }[] = [
  { value: 'main', label: 'Main (3-aspect)' },
  { value: 'distant', label: 'Distant repeater' },
  { value: 'shunt', label: 'Calling-on / shunt' },
];

function holdLabelFor(sideLabel: string, type: SignalType) {
  return type === 'distant'
    ? `Hold the ${sideLabel.toLowerCase()} distant at caution`
    : `Hold the ${sideLabel.toLowerCase()} signal at red`;
}

function selectKey(g: Game): string {
  const n = g.editor.selected !== null ? g.net.nodes.get(g.editor.selected) : undefined;
  if (!n) return 'select:none';
  const station = g.net.stationAt(n.id) ? 1 : 0;
  const sideKey = ([1, -1] as Side[])
    .map((s) => `${g.net.attached(n.id, s).join(',')}:${n.signals[s] ? 1 : 0}`)
    .join('|');
  return `select:${n.id}:${station}:${sideKey}`;
}

export const selectPanel: PanelFactory = (container, g, sync) => {
  const ed = g.editor;
  const n = ed.selected !== null ? g.net.nodes.get(ed.selected) : null;
  if (!n) {
    container.append(
      heading('Select'),
      para('Click a point on the track to change it. Drag a point to move it. Drag the ground to move the view.'),
    );
    return { key: () => selectKey(g), update: () => {} };
  }

  const updaters: (() => void)[] = [];
  let undoPushed = false;
  const height = labeledRange({
    id: 'sel-h',
    outputId: 'sel-y',
    label: 'Rail height',
    unit: ' m',
    min: -5,
    max: 160,
    step: 0.5,
    value: n.y,
    format: (v) => v.toFixed(1),
    onInput: (v) => {
      if (!undoPushed) {
        g.pushUndo();
        undoPushed = true;
      }
      g.net.moveNode(n.id, n.x, v, n.z);
      g.commitEdit();
      ed.status = g.net.problemAt(n.id) ?? '';
    },
    onChange: () => {
      undoPushed = false;
      ed.refuseIfBroken(n.id, 'Height change');
    },
  });
  updaters.push(() => {
    height.setValue(n.y);
  });

  const turns = buttonRow([
    { label: 'Turn 5° left', dataset: { turn: '5' }, onClick: () => ed.turnSelected(5) },
    { label: 'Turn 5° right', dataset: { turn: '-5' }, onClick: () => ed.turnSelected(-5) },
  ]);

  container.append(heading('Track point'), height.root, turns.root);

  const station = g.net.stationAt(n.id);
  if (station) {
    // Typing a name is one undo step, not one per key.
    let renamePushed = false;
    const nameInput = labeledText({
      id: 'sel-name',
      label: 'Station name',
      maxLength: 24,
      value: station.name,
      onFocus: () => (renamePushed = false),
      onInput: (v) => {
        if (!renamePushed) {
          g.pushUndo();
          renamePushed = true;
        }
        station.name = v || station.name;
        g.net.version++;
      },
    });
    let lenPushed = false;
    const lenInput = labeledRange({
      id: 'sel-len-in',
      outputId: 'sel-len',
      label: 'Platform length',
      unit: ' m',
      min: 60,
      max: 300,
      step: 10,
      value: station.length,
      onInput: (v) => {
        if (!lenPushed) {
          g.pushUndo();
          lenPushed = true;
        }
        station.length = v;
        g.net.version++;
      },
      onChange: () => (lenPushed = false),
    });
    updaters.push(() => {
      if (document.activeElement !== nameInput.input) nameInput.setValue(station.name);
      lenInput.setValue(station.length);
    });
    container.append(nameInput.root, lenInput.root);
  }

  for (const side of [1, -1] as Side[]) {
    const attached = g.net.attached(n.id, side);
    const label = side === 1 ? 'Forward' : 'Backward';
    if (attached.length > 1) {
      container.append(
        buttonRow([
          {
            label: `Throw ${label.toLowerCase()} points`,
            dataset: { throw: String(side) },
            onClick: () => {
              g.pushUndo();
              g.net.throwSwitch(n.id, side);
              g.sim.interlock();
              g.hud.toast('Points thrown');
            },
          },
        ]).root,
      );
    }
    if (attached.length === 1) {
      const seg = g.net.segs.get(attached[0]);
      if (seg) {
        const curKmh = () => (seg.speedLimit !== undefined ? Math.round(seg.speedLimit * 3.6) : 0);
        const limitSelect = labeledSelect({
          label: `${label} speed limit`,
          options: SPEED_LIMITS.map((v) => ({ value: String(v), label: v ? `${v} km/h` : 'Auto (curve)' })),
          value: String(curKmh()),
          dataset: { segLimit: String(seg.id) },
          onChange: (value) => {
            g.pushUndo();
            const kmh = Number(value);
            seg.speedLimit = kmh > 0 ? kmh / 3.6 : undefined;
            g.net.rebuild(seg.id);
            g.net.version++;
            g.commitEdit();
            g.hud.toast(kmh > 0 ? `Speed limit set to ${kmh} km/h` : 'Speed limit set to automatic');
          },
        });
        updaters.push(() => limitSelect.setValue(String(curKmh())));
        container.append(limitSelect.root);
      }
    }
    const sig = n.signals[side];
    if (sig) {
      const sigSelect = labeledSelect({
        label: `${label} signal type`,
        options: SIGNAL_TYPE_OPTIONS,
        value: signalType(sig),
        dataset: { sigType: String(side) },
        onChange: (value) => {
          g.pushUndo();
          sig.type = value as SignalType;
          g.net.version++;
          g.commitEdit();
          sync();
        },
      });
      const holdCheck = labeledCheckbox({
        label: ` ${holdLabelFor(label, signalType(sig))}`,
        checked: sig.hold,
        dataset: { hold: String(side) },
        onChange: (checked) => {
          g.pushUndo();
          sig.hold = checked;
          g.net.version++;
        },
      });
      updaters.push(() => {
        const st = signalType(sig);
        sigSelect.setValue(st);
        holdCheck.setChecked(sig.hold);
        holdCheck.setLabel(` ${holdLabelFor(label, st)}`);
      });
      container.append(sigSelect.root, holdCheck.root);
    }
  }

  container.append(buttonRow([{ id: 'sel-del', label: 'Remove point', onClick: () => ed.deleteSelected() }]).root);

  return {
    key: () => selectKey(g),
    update: () => {
      for (const fn of updaters) fn();
    },
  };
};
