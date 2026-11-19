import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";
import { eq } from "drizzle-orm";

let testDb: ReturnType<typeof createTestDb>;
let base: ReturnType<typeof seedBaseData>;

vi.mock("~/db", () => ({
  get db() {
    return testDb;
  },
}));

import { getAnalyticsOverview, getCourseAnalytics } from "./analyticsService";
import { createTeamPurchase } from "./purchaseService";

const NOW = new Date("2026-06-15T12:00:00.000Z");
const DAY = 86_400_000;

function ago(ms: number) {
  return new Date(NOW.getTime() - ms).toISOString();
}

let userCounter = 0;
function createStudent(name = `Student ${++userCounter}`) {
  return testDb
    .insert(schema.users)
    .values({
      name,
      email: `${name.toLowerCase().replace(/\s+/g, ".")}.${++userCounter}@example.com`,
      role: schema.UserRole.Student,
    })
    .returning()
    .get();
}

function createInstructor(name: string) {
  return testDb
    .insert(schema.users)
    .values({
      name,
      email: `${name.toLowerCase().replace(/\s+/g, ".")}@example.com`,
      role: schema.UserRole.Instructor,
    })
    .returning()
    .get();
}

let courseCounter = 0;
function createCourse(
  instructorId: number,
  title: string,
  status: schema.CourseStatus = schema.CourseStatus.Published
) {
  return testDb
    .insert(schema.courses)
    .values({
      title,
      slug: `course-${++courseCounter}`,
      description: "",
      salesCopy: "",
      instructorId,
      categoryId: base.category.id,
      status,
    })
    .returning()
    .get();
}

function enroll(userId: number, courseId: number, enrolledAt = ago(100 * DAY)) {
  testDb
    .insert(schema.enrollments)
    .values({ userId, courseId, enrolledAt })
    .run();
}

function purchase(
  userId: number,
  courseId: number,
  amountPaid: number,
  createdAt = ago(100 * DAY)
) {
  return testDb
    .insert(schema.purchases)
    .values({ userId, courseId, amountPaid, country: "US", createdAt })
    .returning()
    .get();
}

describe("getAnalyticsOverview", () => {
  beforeEach(() => {
    testDb = createTestDb();
    base = seedBaseData(testDb);
  });

  it("counts distinct enrolled students, so a duplicate enrollment counts once", () => {
    const other = createStudent();
    enroll(base.user.id, base.course.id);
    enroll(base.user.id, base.course.id);
    enroll(other.id, base.course.id);

    const { rows } = getAnalyticsOverview({
      instructorId: base.instructor.id,
      now: NOW,
    });

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      courseId: base.course.id,
      title: base.course.title,
      students: 2,
    });
  });

  it("scopes to the instructor's own courses, or every course with instructor names when instructorId is null", () => {
    const other = createInstructor("Other Instructor");
    const otherCourse = createCourse(other.id, "Other Course");

    const mine = getAnalyticsOverview({
      instructorId: base.instructor.id,
      now: NOW,
    });
    expect(mine.rows.map((r) => r.courseId)).toEqual([base.course.id]);

    const all = getAnalyticsOverview({ instructorId: null, now: NOW });
    expect(
      all.rows
        .map((r) => ({
          courseId: r.courseId,
          instructorName: r.instructorName,
        }))
        .sort((a, b) => a.courseId - b.courseId)
    ).toEqual([
      { courseId: base.course.id, instructorName: "Test Instructor" },
      { courseId: otherCourse.id, instructorName: "Other Instructor" },
    ]);
  });

  it("excludes draft courses and includes archived ones", () => {
    const archived = createCourse(
      base.instructor.id,
      "Archived Course",
      schema.CourseStatus.Archived
    );
    createCourse(base.instructor.id, "Draft Course", schema.CourseStatus.Draft);

    const { rows } = getAnalyticsOverview({ instructorId: null, now: NOW });

    expect(rows.map((r) => r.courseId).sort((a, b) => a - b)).toEqual([
      base.course.id,
      archived.id,
    ]);
  });

  it("sums gross revenue at the amount paid, so a team purchase counts once and a PPP purchase at its discount", () => {
    const buyer = createStudent();
    const pppBuyer = createStudent();
    // Team purchase: 5 seats bought in one payment of $200.00.
    createTeamPurchase(buyer.id, base.course.id, 20000, "US", 5);
    // PPP purchase: list price $50.00, paid $20.00.
    testDb
      .insert(schema.purchases)
      .values({
        userId: pppBuyer.id,
        courseId: base.course.id,
        amountPaid: 2000,
        country: "IN",
      })
      .run();

    const { rows } = getAnalyticsOverview({
      instructorId: base.instructor.id,
      now: NOW,
    });

    expect(rows[0].revenue).toBe(22000);
  });

  it("counts enrollments and purchases in the rolling 30-day window relative to the injected now", () => {
    const inside = createStudent();
    const outside = createStudent();
    // Just inside: one minute short of 30 days ago. Just outside: one minute past.
    enroll(inside.id, base.course.id, ago(30 * DAY - 60_000));
    enroll(outside.id, base.course.id, ago(30 * DAY + 60_000));
    purchase(inside.id, base.course.id, 4900, ago(30 * DAY - 60_000));
    purchase(outside.id, base.course.id, 3100, ago(30 * DAY + 60_000));

    const { rows } = getAnalyticsOverview({
      instructorId: base.instructor.id,
      now: NOW,
    });

    expect(rows[0]).toMatchObject({
      students: 2,
      studentsLast30Days: 1,
      revenue: 8000,
      revenueLast30Days: 4900,
    });
  });

  it("counts a student in the last 30 days only when their first enrollment in the course falls in the window", () => {
    const returning = createStudent();
    const fresh = createStudent();
    // Enrolled long ago, then a duplicate enrollment recently: not a new student.
    enroll(returning.id, base.course.id, ago(100 * DAY));
    enroll(returning.id, base.course.id, ago(2 * DAY));
    enroll(fresh.id, base.course.id, ago(2 * DAY));

    const { rows } = getAnalyticsOverview({
      instructorId: base.instructor.id,
      now: NOW,
    });

    expect(rows[0]).toMatchObject({ students: 2, studentsLast30Days: 1 });
  });

  it("sorts rows by students, highest first, and totals the figures across rows", () => {
    const bigCourse = createCourse(base.instructor.id, "Big Course");
    const [a, b, c] = [createStudent(), createStudent(), createStudent()];

    enroll(a.id, base.course.id, ago(5 * DAY));
    purchase(a.id, base.course.id, 1000, ago(5 * DAY));

    enroll(a.id, bigCourse.id, ago(40 * DAY));
    enroll(b.id, bigCourse.id, ago(10 * DAY));
    enroll(c.id, bigCourse.id, ago(2 * DAY));
    purchase(a.id, bigCourse.id, 5000, ago(40 * DAY));
    purchase(b.id, bigCourse.id, 5000, ago(10 * DAY));

    const { rows, totals } = getAnalyticsOverview({
      instructorId: base.instructor.id,
      now: NOW,
    });

    expect(rows.map((r) => [r.title, r.students])).toEqual([
      ["Big Course", 3],
      [base.course.title, 1],
    ]);
    expect(totals).toEqual({
      students: 4,
      studentsLast30Days: 3,
      revenue: 11000,
      revenueLast30Days: 6000,
    });
  });

  it("returns no rows and zero totals when the instructor has no courses in scope", () => {
    const newcomer = createInstructor("New Instructor");
    createCourse(newcomer.id, "Unfinished", schema.CourseStatus.Draft);

    expect(
      getAnalyticsOverview({ instructorId: newcomer.id, now: NOW })
    ).toEqual({
      rows: [],
      totals: {
        students: 0,
        studentsLast30Days: 0,
        revenue: 0,
        revenueLast30Days: 0,
      },
    });
  });
});

describe("getCourseAnalytics", () => {
  beforeEach(() => {
    testDb = createTestDb();
    base = seedBaseData(testDb);
  });

  it("returns the course's identity and counts a duplicate enrollment once", () => {
    const other = createStudent();
    enroll(base.user.id, base.course.id);
    enroll(base.user.id, base.course.id);
    enroll(other.id, base.course.id);

    expect(getCourseAnalytics(base.course.id, { now: NOW })).toMatchObject({
      courseId: base.course.id,
      title: base.course.title,
      instructorName: "Test Instructor",
      students: 2,
    });
  });

  it("counts purchases and sums revenue at the amount paid, so a team purchase is one purchase", () => {
    const teamBuyer = createStudent();
    const soloBuyer = createStudent();
    const elsewhere = createCourse(base.instructor.id, "Elsewhere");
    // Team purchase: 5 seats bought in one payment of $200.00.
    createTeamPurchase(teamBuyer.id, base.course.id, 20000, "US", 5);
    purchase(soloBuyer.id, base.course.id, 4900);
    purchase(soloBuyer.id, elsewhere.id, 9900);

    expect(getCourseAnalytics(base.course.id, { now: NOW })).toMatchObject({
      revenue: 24900,
      purchases: 2,
    });
  });

  it("counts zero purchases and zero revenue for a course nobody bought", () => {
    expect(getCourseAnalytics(base.course.id, { now: NOW })).toMatchObject({
      students: 0,
      revenue: 0,
      purchases: 0,
    });
  });

  it("counts enrollments and purchases in the rolling 30-day window relative to the injected now", () => {
    const inside = createStudent();
    const outside = createStudent();
    enroll(inside.id, base.course.id, ago(30 * DAY - 60_000));
    enroll(outside.id, base.course.id, ago(30 * DAY + 60_000));
    purchase(inside.id, base.course.id, 4900, ago(30 * DAY - 60_000));
    purchase(outside.id, base.course.id, 3100, ago(30 * DAY + 60_000));

    expect(getCourseAnalytics(base.course.id, { now: NOW })).toMatchObject({
      students: 2,
      studentsLast30Days: 1,
      revenue: 8000,
      revenueLast30Days: 4900,
      purchases: 2,
    });
  });

  it("still reports a draft course's figures", () => {
    const draft = createCourse(
      base.instructor.id,
      "Draft Course",
      schema.CourseStatus.Draft
    );
    enroll(base.user.id, draft.id);
    purchase(base.user.id, draft.id, 1500);

    expect(getCourseAnalytics(draft.id, { now: NOW })).toMatchObject({
      courseId: draft.id,
      students: 1,
      revenue: 1500,
      purchases: 1,
    });
  });

  it("returns null for a course that does not exist", () => {
    expect(getCourseAnalytics(9999, { now: NOW })).toBeNull();
  });
});

// ─── Average best quiz score ───

let quizCounter = 0;
function createQuiz(courseId: number, passingScore = 0.7) {
  const n = ++quizCounter;
  const mod = testDb
    .insert(schema.modules)
    .values({ courseId, title: `Module ${n}`, position: n })
    .returning()
    .get();
  const lesson = testDb
    .insert(schema.lessons)
    .values({ moduleId: mod.id, title: `Lesson ${n}`, position: 1 })
    .returning()
    .get();
  return testDb
    .insert(schema.quizzes)
    .values({ lessonId: lesson.id, title: `Quiz ${n}`, passingScore })
    .returning()
    .get();
}

function attempt(
  userId: number,
  quizId: number,
  score: number,
  passed = score > 0.7
) {
  testDb
    .insert(schema.quizAttempts)
    .values({ userId, quizId, score, passed, attemptedAt: ago(DAY) })
    .run();
}

describe("average best quiz score", () => {
  beforeEach(() => {
    testDb = createTestDb();
    base = seedBaseData(testDb);
  });

  it("counts only a student's best attempt on a quiz, so retakes don't lower the average", () => {
    const quiz = createQuiz(base.course.id);
    enroll(base.user.id, base.course.id);
    attempt(base.user.id, quiz.id, 0.4);
    attempt(base.user.id, quiz.id, 0.9);
    attempt(base.user.id, quiz.id, 0.6);

    const [row] = getAnalyticsOverview({ instructorId: null, now: NOW }).rows;
    expect(row.averageBestQuizScore).toBeCloseTo(0.9);
    expect(
      getCourseAnalytics(base.course.id, { now: NOW })?.averageBestQuizScore
    ).toBeCloseTo(0.9);
  });

  it("averages every (student, quiz) best score in the course, ignoring other courses' quizzes", () => {
    const other = createStudent();
    const elsewhere = createCourse(base.instructor.id, "Elsewhere");
    const quizA = createQuiz(base.course.id);
    const quizB = createQuiz(base.course.id);
    const foreignQuiz = createQuiz(elsewhere.id);
    enroll(base.user.id, base.course.id);
    enroll(other.id, base.course.id);
    enroll(other.id, elsewhere.id);
    attempt(base.user.id, quizA.id, 0.5);
    attempt(base.user.id, quizA.id, 0.8);
    attempt(other.id, quizA.id, 0.6);
    attempt(base.user.id, quizB.id, 1);
    attempt(other.id, foreignQuiz.id, 0.2);

    // Best scores: user/A 0.8, other/A 0.6, user/B 1.0 -> mean 0.8.
    const rows = getAnalyticsOverview({ instructorId: null, now: NOW }).rows;
    const byId = new Map(rows.map((r) => [r.courseId, r]));
    expect(byId.get(base.course.id)?.averageBestQuizScore).toBeCloseTo(0.8);
    expect(byId.get(elsewhere.id)?.averageBestQuizScore).toBeCloseTo(0.2);
    expect(
      getCourseAnalytics(base.course.id, { now: NOW })?.averageBestQuizScore
    ).toBeCloseTo(0.8);
  });

  it("is null when nobody has attempted any quiz in the course", () => {
    createQuiz(base.course.id);
    enroll(base.user.id, base.course.id);

    const [row] = getAnalyticsOverview({ instructorId: null, now: NOW }).rows;
    expect(row.averageBestQuizScore).toBeNull();
    expect(
      getCourseAnalytics(base.course.id, { now: NOW })?.averageBestQuizScore
    ).toBeNull();
  });
});

// ─── Quiz breakdown ───

describe("quiz breakdown", () => {
  beforeEach(() => {
    testDb = createTestDb();
    base = seedBaseData(testDb);
  });

  function breakdown() {
    return getCourseAnalytics(base.course.id, { now: NOW })?.quizzes;
  }

  /** Moves a quiz's module to `position` and renames its lesson. */
  function moveQuizToModulePosition(
    quiz: { lessonId: number },
    position: number,
    lessonTitle: string
  ) {
    const lesson = testDb
      .update(schema.lessons)
      .set({ title: lessonTitle })
      .where(eq(schema.lessons.id, quiz.lessonId))
      .returning()
      .get();
    testDb
      .update(schema.modules)
      .set({ position })
      .where(eq(schema.modules.id, lesson.moduleId))
      .run();
  }

  it("lists the course's quizzes in course order with 0 attempted and null figures when nobody attempted", () => {
    const second = createQuiz(base.course.id);
    const first = createQuiz(base.course.id);
    moveQuizToModulePosition(second, 2, "Advanced");
    moveQuizToModulePosition(first, 1, "Intro");
    createQuiz(createCourse(base.instructor.id, "Elsewhere").id);
    enroll(base.user.id, base.course.id);
    enroll(createStudent().id, base.course.id);

    expect(breakdown()).toEqual([
      {
        quizId: first.id,
        quizTitle: first.title,
        lessonTitle: "Intro",
        attempted: 0,
        enrolled: 2,
        averageBestScore: null,
        passRate: null,
      },
      {
        quizId: second.id,
        quizTitle: second.title,
        lessonTitle: "Advanced",
        attempted: 0,
        enrolled: 2,
        averageBestScore: null,
        passRate: null,
      },
    ]);
  });

  it("judges a pass against the quiz's own passing score, with a score exactly at the threshold passing", () => {
    const quiz = createQuiz(base.course.id, 0.5);
    const atThreshold = createStudent();
    const below = createStudent();
    const above = createStudent();
    const notAttempted = createStudent();
    for (const s of [atThreshold, below, above, notAttempted]) {
      enroll(s.id, base.course.id);
    }
    attempt(atThreshold.id, quiz.id, 0.5);
    attempt(below.id, quiz.id, 0.4);
    attempt(above.id, quiz.id, 0.6);

    const [row] = breakdown()!;
    expect(row).toMatchObject({ attempted: 3, enrolled: 4 });
    expect(row.averageBestScore).toBeCloseTo(0.5);
    expect(row.passRate).toBeCloseTo(2 / 3);
  });

  it("ignores a stored passed flag that disagrees with the quiz's threshold", () => {
    const quiz = createQuiz(base.course.id, 0.8);
    const flaggedPassed = createStudent();
    const flaggedFailed = createStudent();
    enroll(flaggedPassed.id, base.course.id);
    enroll(flaggedFailed.id, base.course.id);
    // Stored flags are inverted relative to the 0.8 threshold.
    attempt(flaggedPassed.id, quiz.id, 0.75, true);
    attempt(flaggedFailed.id, quiz.id, 0.85, false);

    expect(breakdown()![0].passRate).toBeCloseTo(0.5);
  });

  it("counts only each student's best attempt, so retakes neither add attempters nor lower the figures", () => {
    const quiz = createQuiz(base.course.id, 0.7);
    const retaker = createStudent();
    const oneShot = createStudent();
    enroll(retaker.id, base.course.id);
    enroll(oneShot.id, base.course.id);
    attempt(retaker.id, quiz.id, 0.3);
    attempt(retaker.id, quiz.id, 0.9);
    attempt(retaker.id, quiz.id, 0.5);
    attempt(oneShot.id, quiz.id, 0.6);

    const [row] = breakdown()!;
    expect(row).toMatchObject({ attempted: 2, enrolled: 2 });
    expect(row.averageBestScore).toBeCloseTo(0.75);
    expect(row.passRate).toBeCloseTo(0.5);
  });

  it("ignores attempts by students not enrolled in the course, in the breakdown and the course average", () => {
    const quiz = createQuiz(base.course.id, 0.7);
    const enrolled = createStudent();
    const outsider = createStudent();
    enroll(enrolled.id, base.course.id);
    attempt(enrolled.id, quiz.id, 0.6);
    attempt(outsider.id, quiz.id, 1);

    const course = getCourseAnalytics(base.course.id, { now: NOW })!;
    expect(course.quizzes[0]).toMatchObject({ attempted: 1, enrolled: 1 });
    expect(course.quizzes[0].averageBestScore).toBeCloseTo(0.6);
    expect(course.quizzes[0].passRate).toBe(0);
    expect(course.averageBestQuizScore).toBeCloseTo(0.6);
    const [row] = getAnalyticsOverview({ instructorId: null, now: NOW }).rows;
    expect(row.averageBestQuizScore).toBeCloseTo(0.6);
  });
});

// ─── Completion rate and average progress (#5) ───

let moduleCounter = 0;
function createLessons(courseId: number, n: number) {
  const mod = testDb
    .insert(schema.modules)
    .values({ courseId, title: `Module ${++moduleCounter}`, position: 1 })
    .returning()
    .get();
  return Array.from({ length: n }, (_, i) =>
    testDb
      .insert(schema.lessons)
      .values({ moduleId: mod.id, title: `Lesson ${i + 1}`, position: i + 1 })
      .returning()
      .get()
  );
}

function setProgress(
  userId: number,
  lessonId: number,
  status: schema.LessonProgressStatus = schema.LessonProgressStatus.Completed
) {
  testDb
    .insert(schema.lessonProgress)
    .values({
      userId,
      lessonId,
      status,
      completedAt:
        status === schema.LessonProgressStatus.Completed ? ago(DAY) : null,
    })
    .run();
}

describe("completion rate and average progress", () => {
  beforeEach(() => {
    testDb = createTestDb();
    base = seedBaseData(testDb);
  });

  it("overview: only students who completed every lesson count as complete, and students with no progress lower the average", () => {
    const lessons = createLessons(base.course.id, 4);
    const finisher = createStudent();
    const almost = createStudent();
    const idle = createStudent();
    for (const s of [finisher, almost, idle]) enroll(s.id, base.course.id);
    enroll(finisher.id, base.course.id); // duplicate enrollment counts once
    for (const l of lessons) setProgress(finisher.id, l.id);
    // Missing the last lesson: in progress, not completed.
    for (const l of lessons.slice(0, 3)) setProgress(almost.id, l.id);
    setProgress(
      almost.id,
      lessons[3].id,
      schema.LessonProgressStatus.InProgress
    );
    // Duplicate progress row for the same lesson counts once.
    setProgress(almost.id, lessons[0].id);

    const { rows } = getAnalyticsOverview({
      instructorId: base.instructor.id,
      now: NOW,
    });

    // 1 of 3 complete; progress (4/4 + 3/4 + 0/4) / 3 = 7/12.
    expect(rows[0].completionRate).toBeCloseTo(1 / 3);
    expect(rows[0].averageProgress).toBeCloseTo(7 / 12);
  });

  it("overview: ignores quiz attempts, other courses' lessons, and progress from students who aren't enrolled", () => {
    const [lesson1, lesson2] = createLessons(base.course.id, 2);
    const elsewhere = createCourse(base.instructor.id, "Elsewhere");
    const [otherLesson] = createLessons(elsewhere.id, 1);
    const enrolled = createStudent();
    const stranger = createStudent();
    enroll(enrolled.id, base.course.id);
    setProgress(enrolled.id, lesson1.id);
    setProgress(enrolled.id, otherLesson.id);
    setProgress(stranger.id, lesson1.id);
    setProgress(stranger.id, lesson2.id);
    const quiz = testDb
      .insert(schema.quizzes)
      .values({ lessonId: lesson2.id, title: "Quiz", passingScore: 0.5 })
      .returning()
      .get();
    testDb
      .insert(schema.quizAttempts)
      .values({ userId: enrolled.id, quizId: quiz.id, score: 1, passed: true })
      .run();

    const row = getAnalyticsOverview({
      instructorId: base.instructor.id,
      now: NOW,
    }).rows.find((r) => r.courseId === base.course.id);

    expect(row).toMatchObject({ completionRate: 0, averageProgress: 0.5 });
  });

  it("overview: a course with no lessons and a course with no enrollments have null rates", () => {
    enroll(base.user.id, base.course.id); // enrolled, but no lessons
    const empty = createCourse(base.instructor.id, "No Students");
    createLessons(empty.id, 3);

    const { rows } = getAnalyticsOverview({
      instructorId: base.instructor.id,
      now: NOW,
    });

    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toMatchObject({
        completionRate: null,
        averageProgress: null,
      });
    }
  });

  it("per course: matches the overview's completion rate and average progress", () => {
    const lessons = createLessons(base.course.id, 2);
    const done = createStudent();
    const half = createStudent();
    const idle1 = createStudent();
    const idle2 = createStudent();
    for (const s of [done, half, idle1, idle2]) enroll(s.id, base.course.id);
    for (const l of lessons) setProgress(done.id, l.id);
    setProgress(half.id, lessons[0].id);

    // 1 of 4 complete; progress (2 + 1 + 0 + 0) / (2 * 4) = 3/8.
    expect(getCourseAnalytics(base.course.id, { now: NOW })).toMatchObject({
      completionRate: 0.25,
      averageProgress: 0.375,
    });
  });

  it("per course: no lessons or no enrollments give null rates", () => {
    enroll(base.user.id, base.course.id);
    const empty = createCourse(base.instructor.id, "No Students");
    createLessons(empty.id, 3);

    for (const id of [base.course.id, empty.id]) {
      expect(getCourseAnalytics(id, { now: NOW })).toMatchObject({
        completionRate: null,
        averageProgress: null,
      });
    }
  });
});
