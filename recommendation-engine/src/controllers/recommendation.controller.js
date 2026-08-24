/**
 * recommendation.controller.js
 *
 * HTTP layer for the recommendation READ path.
 * GET /api/recommendations?studentId=<uuid>
 *
 * This endpoint is the hot path hit by the student dashboard, so it always
 * tries Redis first (via the service layer) and only touches Postgres on a
 * genuine cache miss.
 */

const { getRecommendations } = require('../services/recommendation.service');

async function getRecommendationsHandler(req, res, next) {
  try {
    // In production, prefer deriving studentId from the authenticated
    // session/JWT (req.user.id) rather than trusting a query param.
    // Query param is shown here per the spec's endpoint signature and as a
    // fallback for service-to-service calls; keeping both is common in
    // real systems (internal calls vs. browser calls).
    const studentId = req.user?.id || req.query.studentId;

    if (!studentId) {
      return res.status(400).json({
        success: false,
        error: 'studentId is required (as an authenticated session or ?studentId= query param).',
      });
    }

    const result = await getRecommendations(studentId);

    return res.status(200).json({
      success: true,
      data: result,
    });
  } catch (err) {
    return next(err);
  }
}

module.exports = { getRecommendationsHandler };
