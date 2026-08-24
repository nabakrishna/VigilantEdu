/**
 * BullMQ Queue — Recommendation Calculation
 *
 * This queue decouples the expensive weak-subtopic aggregation from the
 * `POST /api/tests/submit` request/response cycle. The controller enqueues
 * a job and returns immediately; the worker process (recommendation.worker.js)
 * consumes it separately.
 */

const { Queue } = require('bullmq');
const { bullConnection } = require('../config/redis');
const {
  QUEUE_NAME,
  JOB_ATTEMPTS,
  JOB_BACKOFF_MS,
} = require('../config/recommendation.config');

const recommendationQueue = new Queue(QUEUE_NAME, {
  ...bullConnection,
  defaultJobOptions: {
    attempts: JOB_ATTEMPTS,
    backoff: {
      type: 'exponential',
      delay: JOB_BACKOFF_MS,
    },
    removeOnComplete: {
      age: 60 * 60 * 24, // keep completed jobs for 24h for observability
      count: 1000,
    },
    removeOnFail: {
      age: 60 * 60 * 24 * 7, // keep failed jobs for 7 days for debugging
    },
  },
});

/**
 * Enqueues a recommendation recalculation job for a student.
 *
 * Uses a deterministic jobId (`recalc:<studentId>`) with BullMQ's built-in
 * deduplication semantics: if a student submits multiple tests in rapid
 * succession, we don't want to stack redundant recompute jobs. A new
 * `POST /api/tests/submit` while a job is still queued (not yet active)
 * will simply replace/no-op depending on job state — BullMQ treats adding
 * a job with an existing, still-waiting jobId as a duplicate and ignores it,
 * which is the desired debounce behavior here.
 *
 * @param {string} studentId
 * @param {object} [meta] - optional metadata (e.g. testId) for logging/tracing
 */
async function enqueueRecommendationRecalculation(studentId, meta = {}) {
  if (!studentId) {
    throw new Error('studentId is required to enqueue a recommendation job');
  }

  return recommendationQueue.add(
    'recalculate-weak-subtopics',
    { studentId, ...meta, enqueuedAt: new Date().toISOString() },
    
    // { jobId: `recalc:${studentId}` }
    // 
    { jobId: `recalc-${studentId}` }
  );
}

module.exports = { recommendationQueue, enqueueRecommendationRecalculation };
