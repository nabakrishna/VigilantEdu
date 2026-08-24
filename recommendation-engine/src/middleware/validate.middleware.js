/**
 * Lightweight validation middleware (no external deps beyond what's already
 * in the stack). Swap for `express-validator`/`zod`/`joi` if your platform
 * already standardizes on one — this is dependency-minimal by design so
 * the module drops into any existing Express app cleanly.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function validateStudentIdQuery(req, res, next) {
  const studentId = req.user?.id || req.query.studentId;

  if (!studentId) {
    return res.status(400).json({
      success: false,
      error: 'studentId is required.',
    });
  }

  if (!UUID_RE.test(studentId)) {
    return res.status(400).json({
      success: false,
      error: 'studentId must be a valid UUID.',
    });
  }

  next();
}

function validateTestSubmission(req, res, next) {
  const { studentId, responses } = req.body || {};

  if (!studentId || !UUID_RE.test(studentId)) {
    return res.status(400).json({ success: false, error: 'A valid studentId (UUID) is required.' });
  }

  if (!Array.isArray(responses) || responses.length === 0) {
    return res.status(400).json({ success: false, error: 'responses[] must be a non-empty array.' });
  }

  for (const r of responses) {
    if (!r.questionId || !r.subtopicId || typeof r.isCorrect !== 'boolean') {
      return res.status(400).json({
        success: false,
        error: 'Each response requires questionId, subtopicId, and boolean isCorrect.',
      });
    }
  }

  next();
}

module.exports = { validateStudentIdQuery, validateTestSubmission };
