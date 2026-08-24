/**
 * recommendation.routes.js
 *
 * Mounts:
 *   GET  /api/recommendations        -> read recommendations (cache-first)
 *   POST /api/tests/submit           -> example submission endpoint that
 *                                        enqueues the async recalculation
 *                                        (in your real app, this line is
 *                                        added to your EXISTING route file
 *                                        instead of using this one).
 */

const express = require('express');
const { getRecommendationsHandler } = require('../controllers/recommendation.controller');
const { submitTestHandler } = require('../controllers/testSubmission.controller');
const {
  validateStudentIdQuery,
  validateTestSubmission,
} = require('../middleware/validate.middleware');

const router = express.Router();

router.get('/recommendations', validateStudentIdQuery, getRecommendationsHandler);

// Example-only route illustrating the integration point. Remove this route
// if your platform's test-submission endpoint already exists elsewhere —
// just port the single enqueue call over (see README).
router.post('/tests/submit', validateTestSubmission, submitTestHandler);

module.exports = router;
