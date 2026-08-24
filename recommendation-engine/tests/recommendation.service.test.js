jest.mock('../src/db/recommendation.queries');
jest.mock('../src/services/recommendation.cache');
jest.mock('../src/config/prisma', () => ({
  testResponse: {
    findFirst: jest.fn(),
  },
}));

const queries = require('../src/db/recommendation.queries');
const cache = require('../src/services/recommendation.cache');
const prisma = require('../src/config/prisma');
const {
  computeWeakSubtopics,
  selectQuestionsForWeakSubtopics,
  distributeCount,
  getRecommendations,
} = require('../src/services/recommendation.service');

describe('distributeCount', () => {
  test('splits evenly with remainder front-loaded', () => {
    expect(distributeCount(5, 3)).toEqual([2, 2, 1]);
    expect(distributeCount(5, 2)).toEqual([3, 2]);
    expect(distributeCount(6, 3)).toEqual([2, 2, 2]);
    expect(distributeCount(5, 0)).toEqual([]);
  });
});

describe('computeWeakSubtopics', () => {
  beforeEach(() => jest.clearAllMocks());

  test('filters to accuracy < 60, sorts weakest first, caps at 3, tags difficulty', async () => {
    queries.getSubtopicAccuracyForStudent.mockResolvedValue([
      { subtopicId: 's1', subtopicName: 'Algebra Basics', topicId: 't1', topicName: 'Math', totalAttempts: 5, correctAttempts: 1, accuracyPct: 20 },
      { subtopicId: 's2', subtopicName: 'Fractions', topicId: 't1', topicName: 'Math', totalAttempts: 5, correctAttempts: 3, accuracyPct: 60 }, // NOT weak (not < 60)
      { subtopicId: 's3', subtopicName: 'Geometry', topicId: 't1', topicName: 'Math', totalAttempts: 5, correctAttempts: 2, accuracyPct: 40 },
      { subtopicId: 's4', subtopicName: 'Trig', topicId: 't1', topicName: 'Math', totalAttempts: 5, correctAttempts: 2, accuracyPct: 45 },
      { subtopicId: 's5', subtopicName: 'Stats', topicId: 't1', topicName: 'Math', totalAttempts: 5, correctAttempts: 0, accuracyPct: 0 },
    ]);

    const result = await computeWeakSubtopics('student-1');

    // Only 4 qualify (< 60): s1(20), s3(40), s4(45), s5(0) -> capped to 3 weakest
    expect(result).toHaveLength(3);
    expect(result.map((r) => r.subtopicId)).toEqual(['s5', 's1', 's3']); // 0, 20, 40 ascending
    expect(result[0].recommendedDifficulty).toBe('EASY'); // 0 -> EASY
    expect(result[2].recommendedDifficulty).toBe('MEDIUM'); // 40 -> MEDIUM
  });

  test('returns empty array when no subtopics qualify as weak', async () => {
    queries.getSubtopicAccuracyForStudent.mockResolvedValue([
      { subtopicId: 's1', subtopicName: 'A', topicId: 't1', topicName: 'Math', totalAttempts: 5, correctAttempts: 5, accuracyPct: 100 },
    ]);
    const result = await computeWeakSubtopics('student-1');
    expect(result).toEqual([]);
  });
});

describe('selectQuestionsForWeakSubtopics', () => {
  beforeEach(() => jest.clearAllMocks());

  test('falls back to parent topic when subtopic is exhausted', async () => {
    queries.getRecentlyAttemptedQuestionIds.mockResolvedValue([]);

    // Subtopic-level fetch returns nothing (exhausted)
    queries.getUnattemptedQuestionsForSubtopic.mockResolvedValue([]);

    // Topic-level fallback returns questions
    queries.getUnattemptedQuestionsForTopic.mockResolvedValue([
      { id: 'q1', subtopicId: 'other-sub', difficulty: 'EASY', questionText: 'Q1', options: {} },
      { id: 'q2', subtopicId: 'other-sub', difficulty: 'EASY', questionText: 'Q2', options: {} },
    ]);

    const weakSubtopics = [
      { subtopicId: 's1', subtopicName: 'Algebra', topicId: 't1', topicName: 'Math', accuracyPct: 20, recommendedDifficulty: 'EASY' },
    ];

    const result = await selectQuestionsForWeakSubtopics('student-1', weakSubtopics);

    expect(queries.getUnattemptedQuestionsForTopic).toHaveBeenCalled();
    expect(result.length).toBeGreaterThan(0);
    expect(result[0].sourceSubtopicId).toBe('s1');
  });

  test('excludes recently attempted question ids', async () => {
    queries.getRecentlyAttemptedQuestionIds.mockResolvedValue(['q-old']);
    queries.getUnattemptedQuestionsForSubtopic.mockImplementation(({ excludeIds }) => {
      expect(excludeIds).toContain('q-old');
      return Promise.resolve([{ id: 'q-new', subtopicId: 's1', difficulty: 'EASY', questionText: 'Q', options: {} }]);
    });

    const weakSubtopics = [
      { subtopicId: 's1', subtopicName: 'Algebra', topicId: 't1', topicName: 'Math', accuracyPct: 20, recommendedDifficulty: 'EASY' },
    ];

    await selectQuestionsForWeakSubtopics('student-1', weakSubtopics);
    expect(queries.getUnattemptedQuestionsForSubtopic).toHaveBeenCalled();
  });
});

describe('getRecommendations (read path)', () => {
  beforeEach(() => jest.clearAllMocks());

  test('returns cached payload when cache hit', async () => {
    cache.getRecommendedQuestions.mockResolvedValue({
      studentId: 'student-1',
      mode: 'PERSONALIZED',
      weakSubtopics: [],
      questions: [{ id: 'q1' }],
      generatedAt: '2026-01-01T00:00:00.000Z',
    });

    const result = await getRecommendations('student-1');

    expect(result.source).toBe('CACHE');
    expect(queries.getSubtopicAccuracyForStudent).not.toHaveBeenCalled();
  });

  test('falls back to DB computation on cache miss, cold start with no history', async () => {
    cache.getRecommendedQuestions.mockResolvedValue(null);
    queries.getSubtopicAccuracyForStudent.mockResolvedValue([]);
    prisma.testResponse.findFirst.mockResolvedValue(null); // no history
    queries.getRecentlyAttemptedQuestionIds.mockResolvedValue([]);
    queries.getColdStartBaselineQuestions.mockResolvedValue([
      { id: 'q1', subtopicId: 's1', difficulty: 'EASY', questionText: 'Q1', options: {}, topicId: 't1', topicName: 'Math' },
    ]);

    const result = await getRecommendations('student-new');

    expect(result.source).toBe('DB_FALLBACK');
    expect(result.mode).toBe('COLD_START');
    expect(cache.setRecommendedQuestions).toHaveBeenCalled();
  });
});
