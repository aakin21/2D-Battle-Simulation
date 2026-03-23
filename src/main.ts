import { StateManager } from './state/StateManager';
import { Renderer } from './rendering/Renderer';
import { MinimapRenderer } from './rendering/MinimapRenderer';
import { SimulationEngine } from './engine/SimulationEngine';
import { UIController } from './ui/UIController';
import { DEFAULT_CONFIG } from './types/types';

const stateManager = new StateManager();
const renderer = new Renderer('battleCanvas');
const minimapRenderer = new MinimapRenderer('minimapCanvas', 750, 750);
const engine = new SimulationEngine(stateManager, renderer, minimapRenderer);
new UIController(engine, stateManager, renderer, minimapRenderer);

// Initialize with defaults so terrain is visible behind the main menu
stateManager.reset(DEFAULT_CONFIG);
engine.applyConfig(DEFAULT_CONFIG);
engine.start();
engine.pause(); // main menu unpauses it
