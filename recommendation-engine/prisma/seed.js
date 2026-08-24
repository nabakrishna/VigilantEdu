/**
 * prisma/seed.js
 *
 * Populates a fresh local database with enough sample data to exercise
 * every code path in the recommendation engine:
 *   - Multiple topics, each with multiple subtopics
 *   - Questions at EASY/MEDIUM/HARD across all subtopics
 *   - Test history for one "weak student" (low accuracy in 2 subtopics,
 *     good accuracy elsewhere) and one "new student" (zero history, for
 *     cold-start testing)
 *
 * Run with: npx prisma db seed
 * (wired up via the "prisma.seed" key in package.json)
 */

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

const WEAK_STUDENT_ID = '11111111-1111-1111-1111-111111111111';
const NEW_STUDENT_ID = '22222222-2222-2222-2222-222222222222';

async function main() {
  console.log('Seeding database...');

  // --- Clean slate (safe for local/dev only) ---------------------------
  await prisma.testResponse.deleteMany();
  await prisma.question.deleteMany();
  await prisma.subtopic.deleteMany();
  await prisma.topic.deleteMany();

  // --- Topics & Subtopics -------------------------------------------
  const math = await prisma.topic.create({ data: { name: 'Mathematics' } });
  const science = await prisma.topic.create({ data: { name: 'Science' } });

  const algebra = await prisma.subtopic.create({ data: { name: 'Algebra', topicId: math.id } });
  const geometry = await prisma.subtopic.create({ data: { name: 'Geometry', topicId: math.id } });
  const trigonometry = await prisma.subtopic.create({ data: { name: 'Trigonometry', topicId: math.id } });

  const physics = await prisma.subtopic.create({ data: { name: 'Physics', topicId: science.id } });
  const chemistry = await prisma.subtopic.create({ data: { name: 'Chemistry', topicId: science.id } });

  // --- Questions (several per subtopic per difficulty, so exhaustion
  //     fallback logic has real headroom to be tested) -----------------
  const subtopics = [algebra, geometry, trigonometry, physics, chemistry];
  const difficulties = ['EASY', 'MEDIUM', 'HARD'];

  const allQuestions = [];
  for (const st of subtopics) {
    for (const diff of difficulties) {
      for (let i = 1; i <= 4; i += 1) {
        const q = await prisma.question.create({
          data: {
            subtopicId: st.id,
            difficulty: diff,
            questionText: `[${st.name} - ${diff} #${i}] Sample question text goes here?`,
            options: { A: 'Option A', B: 'Option B', C: 'Option C', D: 'Option D' },
            correctOption: 'A',
          },
        });
        allQuestions.push(q);
      }
    }
  }

  // --- Test history for the WEAK STUDENT --------------------------------
  // Weak in Algebra (2/10 correct = 20%) and Trigonometry (3/10 = 30%).
  // Strong in Geometry (9/10 = 90%) so it should NOT show up as weak.
  // const algebraQs = allQuestions.filter((q) => q.subtopicId === algebra.id);
  // const trigQs = allQuestions.filter((q) => q.subtopicId === trigonometry.id);
  // const geoQs = allQuestions.filter((q) => q.subtopicId === geometry.id);

  // await seedResponses(WEAK_STUDENT_ID, algebra.id, algebraQs, 10, 2);
  // await seedResponses(WEAK_STUDENT_ID, trigonometry.id, trigQs, 10, 3);
  // await seedResponses(WEAK_STUDENT_ID, geometry.id, geoQs, 10, 9);
//new code ----------------- ->
  const algebraNonEasy = allQuestions.filter(
    (q) => q.subtopicId === algebra.id && q.difficulty !== 'EASY'
  );
  const trigNonEasy = allQuestions.filter(
    (q) => q.subtopicId === trigonometry.id && q.difficulty !== 'EASY'
  );
  const geoQs = allQuestions.filter((q) => q.subtopicId === geometry.id);

  await seedResponses(WEAK_STUDENT_ID, algebra.id, algebraNonEasy, 10, 2);
  await seedResponses(WEAK_STUDENT_ID, trigonometry.id, trigNonEasy, 10, 3);
  await seedResponses(WEAK_STUDENT_ID, geometry.id, geoQs, 10, 9);

  

  // NEW_STUDENT_ID intentionally has zero test_responses -> cold start.

  console.log('Seed complete.');
  console.log('');
  console.log('Try these against your running API:');
  console.log(`  GET /api/recommendations?studentId=${WEAK_STUDENT_ID}   (weak in Algebra + Trig)`);
  console.log(`  GET /api/recommendations?studentId=${NEW_STUDENT_ID}   (cold start, no history)`);
}

/**
 * Creates `totalCount` test_responses for a subtopic, marking the first
 * `correctCount` as correct and the rest incorrect, reusing the seeded
 * questions (cycling if totalCount > questions.length).
 */
async function seedResponses(studentId, subtopicId, questionsPool, totalCount, correctCount) {
  const data = [];
  for (let i = 0; i < totalCount; i += 1) {
    const question = questionsPool[i % questionsPool.length];
    data.push({
      studentId,
      subtopicId,
      questionId: question.id,
      isCorrect: i < correctCount,
    });
  }
  await prisma.testResponse.createMany({ data });
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
