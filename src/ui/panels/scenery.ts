import type { SceneryType } from '../../world/scenery';
import { heading, labeledSelect, para } from './controls';
import type { PanelFactory } from './panel';

const SCENERY_LABEL: Record<SceneryType, string> = {
  tree_pine: 'Pine tree',
  tree_oak: 'Oak tree',
  tree_birch: 'Birch tree',
  rock_a: 'Small rock',
  rock_b: 'Large rock',
  house_a: 'Cottage',
  house_b: 'Long house',
  house_c: 'Town house',
};

export const sceneryPanel: PanelFactory = (container, g) => {
  const ed = g.editor;
  const typeSelect = labeledSelect({
    id: 'scenery-type',
    label: 'Place',
    options: (Object.entries(SCENERY_LABEL) as [SceneryType, string][]).map(([value, label]) => ({ value, label })),
    value: ed.sceneryType,
    onChange: (value) => (ed.sceneryType = value as SceneryType),
  });
  container.append(heading('Scenery'), typeSelect.root, para('Click the ground to place one.'));
  return {
    key: () => 'scenery',
    update: () => {
      typeSelect.setValue(ed.sceneryType);
    },
  };
};
