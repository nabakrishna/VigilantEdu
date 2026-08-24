/**
 * recommendation.service.js
 *
 * Core business logic for the Personalized Recommendation Engine.
 *
 * Responsibilities:
 *  1. Analyze a student's per-subtopic accuracy and identify weak areas.
 *  2. Scale recommended difficulty based on how weak a subtopic is.
 *  3. Select unattempted, non-exhausted questions (with topic-level fallback).
 *  4. Handle the cold-start case (no test history).
 *  5. Orchestrate Redis caching (write on compute, read on serve).
 *
 * This module contains NO Express-specific code (no req/res) and NO queue
 * code — it's called by both the async worker (write path) and the
 * controller (read path, cache-miss fallback), which keeps it independently
 * unit-testable.
 */

const prisma = require('../config/prisma');
const queries = require('../db/recommendation.queries');
const cache = require('./recommendation.cache');
const { resolveDifficultyForAccuracy } = require('../utils/difficulty.util');
const {
  WEAK_ACCURACY_THRESHOLD,
  MIN_WEAK_SUBTOPICS,
  MAX_WEAK_SUBTOPICS,
  RECOMMENDATION_COUNT,
  MIN_ATTEMPTS_FOR_SIGNAL,
  COLD_START_TOPIC_SAMPLE_SIZE,
} = require('../config/recommendation.config');

/**
 * Step 1: Compute the weak-subtopic analysis for a student from the DB.
 * This is the expensive aggregation query — meant to be run in the async
 * worker (post test-submission) and cached, NOT on the hot read path.
 *
 * @param {string} studentId
 * @returns {Promise<Array<object>>} weak subtopics, sorted weakest-first,
 *   each annotated with the recommended difficulty tier.
 */
async function computeWeakSubtopics(studentId) {
  const allSubtopicStats = await queries.getSubtopicAccuracyForStudent(studentId);

  // Filter out subtopics with too little signal (e.g. a single attempt)
  // and anything at/above the weakness threshold.
  const eligible = allSubtopicStats.filter(
    (row) =>
      row.totalAttempts >= MIN_ATTEMPTS_FOR_SIGNAL &&
      row.accuracyPct !== null &&
      row.accuracyPct < WEAK_ACCURACY_THRESHOLD
  );

  // Already sorted ascending by accuracy from the SQL query, but re-sort
  // defensively in case that contract ever changes upstream.
  eligible.sort((a, b) => a.accuracyPct - b.accuracyPct);

  const weakest = eligible.slice(0, MAX_WEAK_SUBTOPICS);

  // Guarantee at least MIN_WEAK_SUBTOPICS where possible isn't strictly
  // enforceable if the student simply doesn't have that many weak areas —
  // in that case we return however many genuinely qualify (could be 0, 1,
  // or 2). This is intentional: we never manufacture "weakness" that isn't
  // real just to hit a quota.
  return weakest.map((row) => ({
    subtopicId: row.subtopicId,
    subtopicName: row.subtopicName,
    topicId: row.topicId,
    topicName: row.topicName,
    accuracyPct: row.accuracyPct,
    totalAttempts: row.totalAttempts,
    correctAttempts: row.correctAttempts,
    recommendedDifficulty: resolveDifficultyForAccuracy(row.accuracyPct),
  }));
}

/**
 * Step 2: Given weak subtopics, select up to RECOMMENDATION_COUNT
 * unattempted practice questions, respecting the 30-day exhaustion window
 * and falling back to the parent topic when a subtopic is exhausted.
 *
 * Distributes the question count as evenly as possible across the weak
 * subtopics (e.g. 5 questions / 2 subtopics -> 3 + 2).
 *
 * @param {string} studentId
 * @param {Array<object>} weakSubtopics - output of computeWeakSubtopics
 * @returns {Promise<Array<object>>} question payload ready to serve
 */
async function selectQuestionsForWeakSubtopics(studentId, weakSubtopics) {
  if (!weakSubtopics.length) return [];

  const excludeIds = await queries.getRecentlyAttemptedQuestionIds(studentId);
  const results = [];
  const coveredSubtopicIds = weakSubtopics.map((w) => w.subtopicId);

  // Distribute RECOMMENDATION_COUNT across weak subtopics as evenly as
  // possible: e.g. 5 across 3 subtopics -> [2, 2, 1]
  const allocations = distributeCount(RECOMMENDATION_COUNT, weakSubtopics.length);

  for (let i = 0; i < weakSubtopics.length; i += 1) {
    const subtopic = weakSubtopics[i];
    const wanted = allocations[i];
    if (wanted <= 0) continue;

    const alreadyPickedIds = results.map((q) => q.id);
    const excludeForThisPick = [...excludeIds, ...alreadyPickedIds];

    // Primary attempt: exact subtopic + scaled difficulty
    let picked = await queries.getUnattemptedQuestionsForSubtopic({
      subtopicId: subtopic.subtopicId,
      difficulty: subtopic.recommendedDifficulty,
      excludeIds: excludeForThisPick,
      limit: wanted,
    });

    let shortfall = wanted - picked.length;

    // Secondary attempt: same subtopic, but relax difficulty to MEDIUM if we
    // originally asked for EASY and came up short (still within-subtopic,
    // more targeted than jumping straight to the topic-level fallback).
    if (shortfall > 0 && subtopic.recommendedDifficulty === 'EASY') {
      const relaxed = await queries.getUnattemptedQuestionsForSubtopic({
        subtopicId: subtopic.subtopicId,
        difficulty: 'MEDIUM',
        excludeIds: [...excludeForThisPick, ...picked.map((q) => q.id)],
        limit: shortfall,
      });
      picked = [...picked, ...relaxed];
      shortfall = wanted - picked.length;
    }

    // Tertiary attempt: EXHAUSTION SAFETY — subtopic is exhausted, fall
    // back to the parent topic (any of its other subtopics).
    if (shortfall > 0) {
      const topicFallback = await queries.getUnattemptedQuestionsForTopic({
        topicId: subtopic.topicId,
        preferredDifficulty: subtopic.recommendedDifficulty,
        excludeIds: [...excludeForThisPick, ...picked.map((q) => q.id)],
        excludeSubtopicIds: [], // allow other subtopics within the same topic
        limit: shortfall,
      });
      picked = [...picked, ...topicFallback];
    }

    // results.push(
    //   ...picked.map((q) => ({
    //     ...q,
    //     sourceSubtopicId: subtopic.subtopicId,
    //     sourceSubtopicName: subtopic.subtopicName,
    //     sourceTopicId: subtopic.topicId,
    //     sourceTopicName: subtopic.topicName,
    //     reason: `Weak area: ${subtopic.subtopicName} (${subtopic.accuracyPct}% accuracy)`,
    //   }))
    // );
    // new -------------------------------  ->
    results.push(
      ...picked
        .filter((q) => q.difficulty !== 'HARD')
        .map((q) => ({
          ...q,
          sourceSubtopicId: subtopic.subtopicId,
          sourceSubtopicName: subtopic.subtopicName,
          sourceTopicId: subtopic.topicId,
          sourceTopicName: subtopic.topicName,
          reason: `Weak area: ${subtopic.subtopicName} (${subtopic.accuracyPct}% accuracy)`,
        }))
    );
    
  }

  return results.slice(0, RECOMMENDATION_COUNT);
}

/**
 * Cold-start path: student has zero eligible test history. Returns a
 * baseline EASY/MEDIUM mix across sampled top-level topics.
 *
 * @param {string} studentId
 */
async function buildColdStartRecommendations(studentId) {
  const excludeIds = await queries.getRecentlyAttemptedQuestionIds(studentId);

  // Over-fetch slightly per topic since some will be filtered by excludeIds.
  const raw = await queries.getColdStartBaselineQuestions({
    topicSampleSize: COLD_START_TOPIC_SAMPLE_SIZE,
    questionsPerTopic: 2,
  });

  const filtered = raw.filter((q) => !excludeIds.includes(q.id));

  return filtered.slice(0, RECOMMENDATION_COUNT).map((q) => ({
    id: q.id,
    subtopicId: q.subtopicId,
    difficulty: q.difficulty,
    questionText: q.questionText,
    options: q.options,
    sourceTopicId: q.topicId,
    sourceTopicName: q.topicName,
    reason: 'Baseline practice (no test history yet)',
  }));
}

/**
 * Full orchestration used by the ASYNC WORKER after a test submission:
 * compute weak subtopics -> select questions -> write BOTH to cache.
 *
 * @param {string} studentId
 */
async function recomputeAndCache(studentId) {
  // Invalidate first so a slow/failed recompute never serves indefinitely
  // stale data past its intended freshness point.
  await cache.invalidate(studentId);

  const weakSubtopics = await computeWeakSubtopics(studentId);

  let questions;
  let mode;

  if (weakSubtopics.length > 0) {
    questions = await selectQuestionsForWeakSubtopics(studentId, weakSubtopics);
    mode = 'PERSONALIZED';
  } else {
    // Student has history but nothing currently qualifies as "weak"
    // (e.g. they're doing well everywhere, or too few attempts per topic).
    questions = await buildColdStartRecommendations(studentId);
    mode = 'BASELINE_NO_WEAKNESS';
  }

  const payload = {
    studentId,
    mode,
    weakSubtopics,
    questions,
    generatedAt: new Date().toISOString(),
  };

  await cache.setWeakSubtopics(studentId, weakSubtopics);
  await cache.setRecommendedQuestions(studentId, payload);

  return payload;
}

/**
 * Full orchestration used by the READ ENDPOINT (GET /api/recommendations):
 * try cache first; on miss, decide cold-start vs computed and fall back to
 * synchronous DB computation (also re-populating the cache).
 *
 * @param {string} studentId
 */
async function getRecommendations(studentId) {
  const cached = await cache.getRecommendedQuestions(studentId);
  if (cached) {
    return { ...cached, source: 'CACHE' };
  }

  // Cache miss -> determine if the student has any test history at all.
  const weakSubtopics = await computeWeakSubtopics(studentId);
  const hasAnyHistory = await studentHasTestHistory(studentId);

  let questions;
  let mode;

  if (!hasAnyHistory) {
    questions = await buildColdStartRecommendations(studentId);
    mode = 'COLD_START';
  } else if (weakSubtopics.length > 0) {
    questions = await selectQuestionsForWeakSubtopics(studentId, weakSubtopics);
    mode = 'PERSONALIZED';
  } else {
    questions = await buildColdStartRecommendations(studentId);
    mode = 'BASELINE_NO_WEAKNESS';
  }

  const payload = {
    studentId,
    mode,
    weakSubtopics,
    questions,
    generatedAt: new Date().toISOString(),
  };

  // Repopulate cache so subsequent requests are fast, matching the async
  // worker's cache shape exactly.
  await cache.setWeakSubtopics(studentId, weakSubtopics);
  await cache.setRecommendedQuestions(studentId, payload);

  return { ...payload, source: 'DB_FALLBACK' };
}

/**
 * Cheap existence check for whether a student has any test_responses at
 * all, used to distinguish "cold start" from "has history but no weak
 * areas right now."
 */
async function studentHasTestHistory(studentId) {
  // findFirst is cheaper than count() here since we only care about
  // existence, not the exact number of rows.
  const row = await prisma.testResponse.findFirst({
    where: { studentId },
    select: { id: true },
  });
  return row !== null;
}

/**
 * Distributes `total` items across `buckets` as evenly as possible,
 * front-loading the remainder onto the earliest (weakest) buckets.
 * e.g. distributeCount(5, 3) -> [2, 2, 1]
 *
 * @param {number} total
 * @param {number} buckets
 * @returns {number[]}
 */
function distributeCount(total, buckets) {
  if (buckets <= 0) return [];
  const base = Math.floor(total / buckets);
  const remainder = total % buckets;
  return Array.from({ length: buckets }, (_, i) => base + (i < remainder ? 1 : 0));
}

module.exports = {
  computeWeakSubtopics,
  selectQuestionsForWeakSubtopics,
  buildColdStartRecommendations,
  recomputeAndCache,
  getRecommendations,
  studentHasTestHistory,
  distributeCount, // exported for unit testing
};
