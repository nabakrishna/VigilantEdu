/**
 * Recommendation Engine — Data Access Layer
 *
 * All raw Prisma / SQL access for the recommendation engine lives here.
 * Nothing in this file makes business decisions (no thresholds, no
 * difficulty logic) — it only fetches and aggregates data. That keeps the
 * service layer (recommendation.service.js) fully unit-testable by mocking
 * this module.
 */

const prisma = require('../config/prisma');
const { Prisma } = require('@prisma/client');
const { EXHAUSTION_WINDOW_DAYS } = require('../config/recommendation.config');

/**
 * Aggregates a student's accuracy per subtopic across ALL of their test
 * history. Uses a raw grouped query for performance — this is the exact
 * kind of aggregation that benefits from running in Postgres rather than
 * pulling every row into Node and reducing in memory.
 *
 * Leverages the existing index on test_responses(student_id, subtopic_id).
 *
 * @param {string} studentId
 * @returns {Promise<Array<{
 *   subtopicId: string,
 *   subtopicName: string,
 *   topicId: string,
 *   topicName: string,
 *   totalAttempts: number,
 *   correctAttempts: number,
 *   accuracyPct: number
 * }>>}
 */
async function getSubtopicAccuracyForStudent(studentId) {
  const rows = await prisma.$queryRaw`
    SELECT
      s.id                                  AS "subtopicId",
      s.name                                AS "subtopicName",
      t.id                                  AS "topicId",
      t.name                                AS "topicName",
      COUNT(tr.id)::int                     AS "totalAttempts",
      SUM(CASE WHEN tr.is_correct THEN 1 ELSE 0 END)::int AS "correctAttempts",
      ROUND(
        (SUM(CASE WHEN tr.is_correct THEN 1 ELSE 0 END)::numeric
          / NULLIF(COUNT(tr.id), 0)::numeric) * 100,
        2
      )::float AS "accuracyPct"
    FROM test_responses tr
    INNER JOIN subtopics s ON s.id = tr.subtopic_id
    INNER JOIN topics t    ON t.id = s.topic_id
    WHERE tr.student_id = ${studentId}
    GROUP BY s.id, s.name, t.id, t.name
    ORDER BY "accuracyPct" ASC NULLS LAST;
  `;

  return rows;
}

/**
 * Returns the set of question IDs the student has attempted within the
 * exhaustion window (default 30 days). Used to exclude recently-seen
 * questions from new recommendations.
 *
 * @param {string} studentId
 * @param {number} [windowDays]
 * @returns {Promise<string[]>}
 */
async function getRecentlyAttemptedQuestionIds(studentId, windowDays = EXHAUSTION_WINDOW_DAYS) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - windowDays);

  const rows = await prisma.testResponse.findMany({
    where: {
      studentId,
      createdAt: { gte: cutoff },
    },
    select: { questionId: true },
    distinct: ['questionId'],
  });

  return rows.map((r) => r.questionId);
}

/**
 * Fetches up to `limit` questions for a given subtopic and difficulty,
 * excluding any question IDs already in `excludeIds`.
 *
 * Leverages the existing index on questions(subtopic_id, difficulty).
 *
 * @param {object} params
 * @param {string} params.subtopicId
 * @param {'EASY'|'MEDIUM'|'HARD'} params.difficulty
 * @param {string[]} params.excludeIds
 * @param {number} params.limit
 */
async function getUnattemptedQuestionsForSubtopic({ subtopicId, difficulty, excludeIds, limit }) {
  return prisma.question.findMany({
    where: {
      subtopicId,
      difficulty,
      id: excludeIds.length ? { notIn: excludeIds } : undefined,
    },
    take: limit,
    select: {
      id: true,
      subtopicId: true,
      difficulty: true,
      questionText: true,
      options: true,
      // NOTE: correctOption intentionally excluded — never ship the answer
      // key to the client via the recommendation feed.
    },
  });
}

/**
 * Fallback fetch: pulls unattempted questions for an entire TOPIC (any of
 * its subtopics), used when a specific subtopic is exhausted. Matches any
 * difficulty in [preferredDifficulty, 'MEDIUM'] to maximize the chance of
 * finding something, preferring the exact difficulty first via ORDER BY.
 *
 * @param {object} params
 * @param {string} params.topicId
 * @param {'EASY'|'MEDIUM'|'HARD'} params.preferredDifficulty
 * @param {string[]} params.excludeIds
 * @param {string[]} params.excludeSubtopicIds - subtopics already covered, to avoid duplicate content
 * @param {number} params.limit
 */


// async function getUnattemptedQuestionsForTopic({
//   topicId,
//   preferredDifficulty,
//   excludeIds,
//   excludeSubtopicIds = [],
//   limit,
// }) {
//   // Build optional AND clauses as composable Prisma.sql fragments —
//   // Prisma.empty is the correct way to conditionally omit a clause inside
//   // a tagged-template raw query (nesting $queryRaw calls as fragments is
//   // NOT supported and would throw at runtime).
//   const excludeIdsClause = excludeIds.length
//     ? Prisma.sql`AND q.id NOT IN (${Prisma.join(excludeIds)})`
//     : Prisma.empty;

//   const excludeSubtopicsClause = excludeSubtopicIds.length
//     ? Prisma.sql`AND q.subtopic_id NOT IN (${Prisma.join(excludeSubtopicIds)})`
//     : Prisma.empty;

//   const rows = await prisma.$queryRaw`
//     SELECT
//       q.id, q.subtopic_id AS "subtopicId", q.difficulty,
//       q.question_text AS "questionText", q.options
//     FROM questions q
//     INNER JOIN subtopics s ON s.id = q.subtopic_id
//     WHERE s.topic_id = ${topicId}
//       ${excludeIdsClause}
//       ${excludeSubtopicsClause}
//     ORDER BY (q.difficulty = ${preferredDifficulty}::"Difficulty") DESC, RANDOM()
//     LIMIT ${limit};
//   `;
//   return rows;
// }

async function getUnattemptedQuestionsForTopic({
  topicId,
  preferredDifficulty,
  excludeIds,
  excludeSubtopicIds = [],
  limit,
}) {
  const excludeIdsClause = excludeIds.length
    ? Prisma.sql`AND q.id NOT IN (${Prisma.join(excludeIds)})`
    : Prisma.empty;

  const excludeSubtopicsClause = excludeSubtopicIds.length
    ? Prisma.sql`AND q.subtopic_id NOT IN (${Prisma.join(excludeSubtopicIds)})`
    : Prisma.empty;

  // HARD CAP: never allow HARD questions through the fallback path.
  const rows = await prisma.$queryRaw`
    SELECT
      q.id, q.subtopic_id AS "subtopicId", q.difficulty,
      q.question_text AS "questionText", q.options
    FROM questions q
    INNER JOIN subtopics s ON s.id = q.subtopic_id
    WHERE s.topic_id = ${topicId}
      AND q.difficulty IN ('EASY'::"Difficulty", 'MEDIUM'::"Difficulty")
      ${excludeIdsClause}
      ${excludeSubtopicsClause}
    ORDER BY (q.difficulty = ${preferredDifficulty}::"Difficulty") DESC, RANDOM()
    LIMIT ${limit};
  `;
  return rows;
}



/**
 * Cold-start fallback: returns a baseline mix of EASY/MEDIUM questions
 * spread across top-level topics for a student with zero test history.
 * Uses a lateral join to pick N random questions per topic in a single
 * round trip rather than N+1 queries.
 *
 * @param {object} params
 * @param {number} params.topicSampleSize - how many topics to sample
 * @param {number} params.questionsPerTopic - how many questions to pull per sampled topic
 */
async function getColdStartBaselineQuestions({ topicSampleSize, questionsPerTopic }) {
  const rows = await prisma.$queryRaw`
    SELECT picked.id, picked.subtopic_id AS "subtopicId", picked.difficulty,
           picked.question_text AS "questionText", picked.options,
           topics_sample.id AS "topicId", topics_sample.name AS "topicName"
    FROM (
      SELECT id, name FROM topics ORDER BY RANDOM() LIMIT ${topicSampleSize}
    ) AS topics_sample
    CROSS JOIN LATERAL (
      SELECT q.id, q.subtopic_id, q.difficulty, q.question_text, q.options
      FROM questions q
      INNER JOIN subtopics s ON s.id = q.subtopic_id
      WHERE s.topic_id = topics_sample.id
        AND q.difficulty IN ('EASY'::"Difficulty", 'MEDIUM'::"Difficulty")
      ORDER BY RANDOM()
      LIMIT ${questionsPerTopic}
    ) AS picked;
  `;
  return rows;
}

module.exports = {
  getSubtopicAccuracyForStudent,
  getRecentlyAttemptedQuestionIds,
  getUnattemptedQuestionsForSubtopic,
  getUnattemptedQuestionsForTopic,
  getColdStartBaselineQuestions,
};
