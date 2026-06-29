export type { ScoringInput, ScoringResult, RankedResult } from './types.js';
export { computeGLP } from './glp.js';
export { computeSonderprüfung } from './sonderpruefung.js';
export { computeRundstrecke } from './rundstrecke.js';
export { computeOrientierung } from './orientierung.js';

import { computeGLP } from './glp.js';
import { computeSonderprüfung } from './sonderpruefung.js';
import { computeRundstrecke } from './rundstrecke.js';
import { computeOrientierung } from './orientierung.js';
import type { ScoringInput, ScoringResult } from './types.js';

/**
 * Dispatches to the appropriate scoring implementation based on
 * the format specified in input.config.
 */
export function computeResults(input: ScoringInput): ScoringResult {
  switch (input.config.format) {
    case 'glp':
      return computeGLP(input);
    case 'sonderpruefung':
      return computeSonderprüfung(input);
    case 'rundstrecke':
      return computeRundstrecke(input);
    case 'orientierung':
      return computeOrientierung(input);
    default: {
      const _exhaustive: never = input.config;
      throw new Error(`Unknown event format: ${JSON.stringify(_exhaustive)}`);
    }
  }
}
