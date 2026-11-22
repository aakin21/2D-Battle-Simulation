import './ui/theme.css';
import './ui/layout.css';
import './ui/menu.css';
import './ui/menu-fx.css';
import './ui/intro.css';
import './ui/tour.css';
import './ui/hints.css';
import { StateManager } from './state/StateManager';
import { Renderer } from './rendering/Renderer';
import { MinimapRenderer } from './rendering/MinimapRenderer';
import { SimulationEngine } from './engine/SimulationEngine';
import { UIController } from './ui/UIController';
import { DEFAULT_CONFIG } from './types/types';

const stateManager = new StateManager();
const renderer = new Renderer('battleCanvas');
const minimapRenderer = new MinimapRenderer('minimapCanvas');
const engine = new SimulationEngine(stateManager, renderer, minimapRenderer);
const ui = new UIController(engine, stateManager, renderer, minimapRenderer);

// Development builds expose the running objects for inspection in the browser console
if (import.meta.env.DEV) Object.assign(window, { sim: { engine, stateManager, renderer, ui } });

// A default battlefield, paused, until a run is started from the front end (what a replay watched
// before any run goes back to); its frames run once the front end no longer covers the page
stateManager.reset(DEFAULT_CONFIG);
engine.applyConfig(DEFAULT_CONFIG);
engine.pause();
ui.pageReady();
