import type { TrainKind } from '../../editor/editor';
import { buttonRow, heading, labeledCheckbox, labeledSelect, para } from './controls';
import type { PanelFactory } from './panel';

const TRAIN_KINDS: { value: TrainKind; label: string }[] = [
  { value: 'passenger', label: 'Express: 3 coaches, 2 locomotives' },
  { value: 'shuttle', label: 'Local: 2 coaches' },
  { value: 'freight', label: 'Freight: 5 loaded wagons' },
  { value: 'emptyFreight', label: 'Empties: 5 empty wagons' },
];

export const trainPanel: PanelFactory = (container, g) => {
  const ed = g.editor;
  const kind = labeledSelect({
    id: 'train-kind',
    label: 'Type',
    options: TRAIN_KINDS,
    value: ed.trainKind,
    onChange: (value) => (ed.trainKind = value as TrainKind),
  });
  const runTrains = labeledCheckbox({
    id: 'run-trains',
    label: ' Keep trains moving while editing',
    checked: ed.runTrains,
    onChange: (checked) => (ed.runTrains = checked),
  });
  const tt = buttonRow([
    {
      id: 'btn-tt-edit',
      label: 'Edit timetables',
      onClick: () => g.hud.timetable.open(g.sim.trains.at(-1) ?? null),
    },
  ]);
  container.append(
    heading('Add a train'),
    kind.root,
    para('Click a track to place it. New trains call at every station.'),
    runTrains.root,
    tt.root,
  );
  return {
    key: () => 'train',
    update: () => {
      kind.setValue(ed.trainKind);
      runTrains.setChecked(ed.runTrains);
    },
  };
};
