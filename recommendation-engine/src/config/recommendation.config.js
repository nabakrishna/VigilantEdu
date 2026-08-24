/**
 * Recommendation Engine — Tunable Business Rules
 *
 * Keeping these in one place makes it trivial to A/B test thresholds later
 * without hunting through service logic.
 */

module.exports = {
  // A subtopic is "weak" if accuracy is strictly below this threshold.
  WEAK_ACCURACY_THRESHOLD: 60,

  // Below this, recommend EASY questions. Between this and WEAK_ACCURACY_THRESHOLD*,
  // recommend MEDIUM. (Spec: <40 => EASY, 40-75 => MEDIUM. Note the band overlaps
  // the "weak" definition intentionally — see difficulty.util.js for the exact rule.)
  DIFFICULTY_EASY_MAX: 40,
  DIFFICULTY_MEDIUM_MAX: 75,

  // How many of the weakest subtopics we focus on.
  MIN_WEAK_SUBTOPICS: 2,
  MAX_WEAK_SUBTOPICS: 3,

  // Total number of practice questions returned per request.
  RECOMMENDATION_COUNT: 5,

  // Don't re-recommend a question the student attempted within this window.
  EXHAUSTION_WINDOW_DAYS: 30,

  // Minimum number of test_responses required before a subtopic is even
  // considered for weakness analysis (avoids noisy conclusions from a
  // single lucky/unlucky question).
  MIN_ATTEMPTS_FOR_SIGNAL: 1,

  // Cold start: how many topics to sample from when a student has no history.
  COLD_START_TOPIC_SAMPLE_SIZE: 5,

  // Redis
  CACHE_KEY_PREFIX: 'reco',
  CACHE_TTL_SECONDS: 60 * 60 * 24, // 24h; refreshed on every new test submission
  WEAK_TOPICS_TTL_SECONDS: 60 * 60 * 24,

  // BullMQ
  QUEUE_NAME: 'recommendation-calculation',
  JOB_ATTEMPTS: 3,
  JOB_BACKOFF_MS: 5000,
};
