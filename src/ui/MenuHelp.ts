import { BATTLE_CONFIG, DEFAULT_CONFIG } from '../types/types';
import {
  BASE_HP,
  CONTROL_CAPTURE_SECONDS,
  CONTROL_POINTS_PER_SEC,
  CONTROL_TIME_LIMIT,
  MATCH_TIME_LIMIT,
} from '../engine/Rules';
import { LLM_INTERVAL_SEC } from '../ai/LlmController';
import { JEV_INTERVAL_SEC } from '../ai/GameRules';
import { clock } from './format';
import { segValue } from './seg';

// Plain-language lines in Match setup and the Sandbox: what a battle is (under Match setup's
// title), what the objective means and who commands each side (under their controls), and what
// the selected Sandbox tab is. Numbers come from the code's constants. It only reads the controls
// and writes these lines; MainMenu calls refresh() after every change.

const TAB_TEXT: Record<string, string> = {
  'tab-default': `Classic mode (Phase 1): your hero and ${DEFAULT_CONFIG.warriorCount} warriors hold out against waves of berserkers. Right-click to move the hero; its warriors follow.`,
  'tab-custom': 'Classic mode with your own army size, wave strength and terrain.',
  'tab-stress':
    'A performance test of the classic mode: thousands of warriors against thousands of berserkers.',
};

export const SETUP_TEXT = `Two armies of ${BATTLE_CONFIG.heroesPerSide} heroes and their soldiers. Choose who commands each side and what wins.`;

const OBJECTIVE_TEXT: Record<string, string> = {
  elimination: `Destroy every enemy unit. If time runs out (${clock(MATCH_TIME_LIMIT)}), the side with more HP left wins.`,
  control: `Hold the points A and B: a side holds a point after ${CONTROL_CAPTURE_SECONDS} s with more units near it, and scores ${CONTROL_POINTS_PER_SEC} point per second for it. After ${clock(CONTROL_TIME_LIMIT)} the side with more points wins.`,
  base: `Destroy the enemy base (a tower with ${BASE_HP} HP). If time runs out (${clock(MATCH_TIME_LIMIT)}), the side with more HP left wins.`,
};

const LLM_TEXT = `a large language model (LLM) gives every hero a strategic order every ${LLM_INTERVAL_SEC} s`;
const tactical = (name: string) =>
  `A large language model (LLM) gives strategic orders every ${LLM_INTERVAL_SEC} s, and ${name}, a fast decision model, adjusts each hero's order every ${JEV_INTERVAL_SEC} s.`;

// Who commands a side, by the button's data-val (the west side's "none" is the user, the east
// side's the rule layer)
function commanderText(val: string, west: boolean): string {
  switch (val) {
    case 'none':
      return west
        ? 'You give the orders: select one of your heroes, then right-click the map to send it there.'
        : 'Built-in rule-based heroes, no AI.';
    case 'llm':
      return `${LLM_TEXT[0].toUpperCase()}${LLM_TEXT.slice(1)}.`;
    case 'jev+llm':
      return tactical('Jev');
    case 'snap+llm':
      return tactical('SubQ Snap');
    default:
      return '';
  }
}

export class MenuHelp {
  constructor() {
    setText('setup-desc', SETUP_TEXT);
    this.refresh();
  }

  refresh(): void {
    const tab = document.querySelector('#menu-tabs button.active')?.id ?? '';
    setText('tab-desc', TAB_TEXT[tab] ?? '');
    setText('desc-objective', OBJECTIVE_TEXT[segValue('cfg-objective')] ?? '');
    setText('desc-west', commanderText(segValue('cfg-west'), true));
    setText('desc-east', commanderText(segValue('cfg-opponent'), false));
  }
}

function setText(id: string, text: string): void {
  const el = document.getElementById(id);
  if (el && el.textContent !== text) el.textContent = text;
}
