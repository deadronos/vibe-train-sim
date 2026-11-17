import { bridgeTool } from './bridge';
import { deleteTool } from './delete';
import { sceneryTool } from './scenery';
import { SelectTool } from './select';
import { signalTool } from './signal';
import { StationTool } from './station';
import { TerrainTool } from './terrain';
import type { EditorTool, Tool } from './tool';
import { TrackTool } from './track';
import { trainTool } from './train';

export function createTools(): Record<Tool, EditorTool> {
  return {
    select: new SelectTool(),
    track: new TrackTool(),
    signal: signalTool,
    station: new StationTool(),
    bridge: bridgeTool,
    terrain: new TerrainTool(),
    scenery: sceneryTool,
    train: trainTool,
    delete: deleteTool,
  };
}
