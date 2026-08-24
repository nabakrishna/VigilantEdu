/**
 * testSubmission.controller.js
 *
 * NOTE: This file represents the INTEGRATION POINT into the platform's
 * EXISTING `POST /api/tests/submit` endpoint. It is intentionally a thin
 * example — in your real codebase, this logic lives inside your existing
 * test-submission controller (proctoring engine, scoring, etc). The only
 * thing this module needs you to add is the single call to
 * `enqueueRecommendationRecalculation(studentId)` AFTER the test_responses
 * rows have been committed.
 *
 * See README.md section "Integrating into the Existing Application" for
 * the minimal-diff version of this.
 */

const prisma = require('../config/prisma');
const { enqueueRecommendationRecalculation } = require('../queues/recommendation.queue');

/**
 * Example shape of the request body:
 * {
 *   studentId: "uuid",
 *   testId: "uuid",
 *   responses: [
 *     { questionId: "uuid", subtopicId: "uuid", selectedOption: "A", isCorrect: true },
 *     ...
 *   ]
 * }
 */
async function submitTestHandler(req, res, next) {
  try {
    const { studentId, testId, responses } = req.body;

    if (!studentId || !Array.isArray(responses) || responses.length === 0) {
      return res.status(400).json({
        success: false,
        error: 'studentId and a non-empty responses[] array are required.',
      });
    }

    // --- 1. Persist test responses (existing platform logic) -----------
    // This is a simplified stand-in for whatever your scoring/proctoring
    // pipeline already does. The critical part for THIS module is simply
    // that rows land in `test_responses`.
    await prisma.testResponse.createMany({
      data: responses.map((r) => ({
        studentId,
        questionId: r.questionId,
        subtopicId: r.subtopicId,
        isCorrect: r.isCorrect,
      })),
    });

    // --- 2. Fire the async recommendation recalculation -----------------
    // This is the ONE LINE integration point required by the recommendation
    // engine module. It enqueues a BullMQ job and returns immediately — it
    // does NOT block the HTTP response, satisfying the "async, post-submit"
    // performance requirement.
    await enqueueRecommendationRecalculation(studentId, { testId });

    // --- 3. Respond to the client immediately ---------------------------
    return res.status(201).json({
      success: true,
      message: 'Test submitted successfully. Recommendations are being recalculated.',
      testId,
    });
  } catch (err) {
    return next(err);
  }
}

module.exports = { submitTestHandler };
