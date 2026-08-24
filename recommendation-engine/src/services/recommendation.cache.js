/**
 * Recommendation Cache — Redis key conventions + thin wrappers
 *
 * Key shapes:
 *   reco:weak-subtopics:<studentId>   -> JSON array of weak subtopic analysis
 *   reco:questions:<studentId>        -> JSON array of recommended questions (final payload)
 *
 * We cache BOTH the intermediate weak-subtopic analysis and the final
 * question payload:
 *  - `weak-subtopics` is written by the async worker after a test submission
 *    and is the expensive-to-compute artifact (aggregation query).
 *  - `questions` is the ready-to-serve payload for GET /api/recommendations,
 *    built from the weak-subtopic analysis. Caching it separately means the
 *    hot read path (dashboard load) never has to re-run subtopic aggregation
 *    OR re-run question selection — it's a straight Redis GET.
 */

const { redisClient } = require('../config/redis');
const {
  CACHE_KEY_PREFIX,
  CACHE_TTL_SECONDS,
  WEAK_TOPICS_TTL_SECONDS,
} = require('../config/recommendation.config');

function weakSubtopicsKey(studentId) {
  return `${CACHE_KEY_PREFIX}:weak-subtopics:${studentId}`;
}

function questionsKey(studentId) {
  return `${CACHE_KEY_PREFIX}:questions:${studentId}`;
}

async function setWeakSubtopics(studentId, weakSubtopics) {
  await redisClient.set(
    weakSubtopicsKey(studentId),
    JSON.stringify(weakSubtopics),
    'EX',
    WEAK_TOPICS_TTL_SECONDS
  );
}

async function getWeakSubtopics(studentId) {
  const raw = await redisClient.get(weakSubtopicsKey(studentId));
  return raw ? JSON.parse(raw) : null;
}

async function setRecommendedQuestions(studentId, payload) {
  await redisClient.set(
    questionsKey(studentId),
    JSON.stringify(payload),
    'EX',
    CACHE_TTL_SECONDS
  );
}

async function getRecommendedQuestions(studentId) {
  const raw = await redisClient.get(questionsKey(studentId));
  return raw ? JSON.parse(raw) : null;
}

/**
 * Invalidate both cache entries for a student — called at the start of the
 * async worker so a slow recomputation never serves stale-but-not-yet-expired
 * data for longer than necessary, and so failures fail safe to DB fallback.
 */
async function invalidate(studentId) {
  await redisClient.del(weakSubtopicsKey(studentId), questionsKey(studentId));
}

module.exports = {
  weakSubtopicsKey,
  questionsKey,
  setWeakSubtopics,
  getWeakSubtopics,
  setRecommendedQuestions,
  getRecommendedQuestions,
  invalidate,
};
