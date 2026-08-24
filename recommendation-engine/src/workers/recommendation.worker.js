/**
 * recommendation.worker.js
 *
 * BullMQ Worker — consumes jobs from the `recommendation-calculation` queue
 * and runs the (potentially expensive) weak-subtopic aggregation + question
 * selection, then writes results to Redis.
 *
 * IMPORTANT: Run this as a SEPARATE PROCESS from the main Express API
 * server in production (e.g. `node src/workers/recommendation.worker.js`
 * as its own PM2/Docker/K8s deployment). It can also be run in-process
 * during local development for convenience — see README.
 */

const { Worker } = require('bullmq');
const { bullConnection } = require('../config/redis');
const { QUEUE_NAME } = require('../config/recommendation.config');
const { recomputeAndCache } = require('../services/recommendation.service');

function startRecommendationWorker() {
  const worker = new Worker(
    QUEUE_NAME,
    async (job) => {
      const { studentId } = job.data;
      const startedAt = Date.now();

      const result = await recomputeAndCache(studentId);

      const durationMs = Date.now() - startedAt;
      // eslint-disable-next-line no-console
      console.log(
        `[reco-worker] student=${studentId} mode=${result.mode} ` +
          `weakSubtopics=${result.weakSubtopics.length} questions=${result.questions.length} ` +
          `durationMs=${durationMs}`
      );

      return { mode: result.mode, questionCount: result.questions.length };
    },
    {
      ...bullConnection,
      concurrency: Number(process.env.RECO_WORKER_CONCURRENCY || 5),
    }
  );

  worker.on('completed', (job, returnValue) => {
    // eslint-disable-next-line no-console
    console.log(`[reco-worker] job ${job.id} completed`, returnValue);
  });

  worker.on('failed', (job, err) => {
    // eslint-disable-next-line no-console
    console.error(`[reco-worker] job ${job?.id} failed after ${job?.attemptsMade} attempts:`, err);
    // Production note: wire this into your alerting (Sentry/Datadog/etc.)
    // so silent recommendation staleness doesn't go unnoticed.
  });

  worker.on('error', (err) => {
    // eslint-disable-next-line no-console
    console.error('[reco-worker] worker-level error:', err);
  });

  // eslint-disable-next-line no-console
  console.log(`[reco-worker] listening on queue "${QUEUE_NAME}"`);

  return worker;
}

// Allow running as a standalone process: `node src/workers/recommendation.worker.js`
if (require.main === module) {
  startRecommendationWorker();

  process.on('SIGTERM', async () => {
    // eslint-disable-next-line no-console
    console.log('[reco-worker] SIGTERM received, shutting down gracefully...');
    process.exit(0);
  });
}

module.exports = { startRecommendationWorker };
