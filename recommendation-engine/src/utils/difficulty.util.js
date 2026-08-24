const {
  DIFFICULTY_EASY_MAX,
  DIFFICULTY_MEDIUM_MAX,
} = require('../config/recommendation.config');

/**
 * Maps a subtopic accuracy percentage (0-100) to the difficulty tier that
 * should be recommended.
 *
 * Spec rule:
 *   accuracy < 40           -> EASY
 *   40 <= accuracy <= 75    -> MEDIUM
 *   accuracy > 75           -> (not "weak" by definition, but if ever called,
 *                               we return MEDIUM as a safe non-punitive default
 *                               rather than HARD, since this function is only
 *                               invoked for subtopics already flagged weak)
 *
 * @param {number} accuracyPct - 0-100
 * @returns {'EASY'|'MEDIUM'}
 */
function resolveDifficultyForAccuracy(accuracyPct) {
  if (typeof accuracyPct !== 'number' || Number.isNaN(accuracyPct)) {
    // No signal at all -> default to MEDIUM (neutral baseline).
    return 'MEDIUM';
  }

  if (accuracyPct < DIFFICULTY_EASY_MAX) {
    return 'EASY';
  }

  if (accuracyPct <= DIFFICULTY_MEDIUM_MAX) {
    return 'MEDIUM';
  }

  // Defensive fallback — should not normally be reached since only
  // "weak" subtopics (accuracy < 60) flow into this function.
  return 'MEDIUM';
}

module.exports = { resolveDifficultyForAccuracy };
