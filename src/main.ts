import { StateManager } from './state/StateManager';
import { Renderer } from './rendering/Renderer';
import { MinimapRenderer } from './rendering/MinimapRenderer';
import { SimulationEngine } from './engine/SimulationEngine';
import { UIController } from './ui/UIController';

const stateManager    = new StateManager();
const renderer        = new Renderer('battleCanvas');
const minimapRenderer = new MinimapRenderer('minimapCanvas', 750, 750);
const engine          = new SimulationEngine(stateManager, renderer, minimapRenderer);
new UIController(engine, stateManager, renderer, minimapRenderer);

stateManager.initGrid();
stateManager.spawnInitialUnits();
engine.start();
