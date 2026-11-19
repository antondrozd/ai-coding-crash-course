import {
  and,
  count,
  countDistinct,
  eq,
  exists,
  avg,
  inArray,
  max,
  min,
  ne,
  sql,
  sum,
  type SQL,
} from "drizzle-orm";
import { db } from "~/db";
import {
  CourseStatus,
  courses,
  enrollments,
  LessonProgressStatus,
  lessonProgress,
  lessons,
  modules,
  purchases,
  quizAttempts,
  quizzes,
  users,
} from "~/db/schema";

// ─── Analytics Service ───
// Live course metrics for instructors and admins. Every figure comes from
// grouped SQL aggregates over the courses in scope — never a per-student loop.
// Uses object options (per the analytics PRD) so `now` can be injected.

const RECENT_WINDOW_MS = 30 * 86_400_000;

/** Enrollment and revenue volume, for one course or summed across courses. */
export interface CourseVolume {
  /** Distinct enrolled users. */
  students: number;
  /** Distinct users whose first enrollment in the course is within the last 30 days. */
  studentsLast30Days: number;
  /** Gross revenue in cents (sum of amount actually paid). */
  revenue: number;
  /** Gross revenue in cents from purchases within the last 30 days. */
  revenueLast30Days: number;
}

const EMPTY_VOLUME: CourseVolume = {
  students: 0,
  studentsLast30Days: 0,
  revenue: 0,
  revenueLast30Days: 0,
};

function addVolume(a: CourseVolume, b: CourseVolume): CourseVolume {
  return {
    students: a.students + b.students,
    studentsLast30Days: a.studentsLast30Days + b.studentsLast30Days,
    revenue: a.revenue + b.revenue,
    revenueLast30Days: a.revenueLast30Days + b.revenueLast30Days,
  };
}

export interface AnalyticsCourseRow extends CourseVolume {
  courseId: number;
  title: string;
  instructorName: string;
  /** Mean of every (student, quiz) best score in the course, 0–1; `null` when nobody attempted a quiz. */
  averageBestQuizScore: number | null;
  /** Share of enrolled students who completed every lesson; `null` with no lessons or no enrollments. */
  completionRate: number | null;
  /** Mean over enrolled students of completed/total lessons; `null` with no lessons or no enrollments. */
  averageProgress: number | null;
}

export type AnalyticsTotals = CourseVolume;

export interface AnalyticsOverview {
  /** Published and archived courses in scope, sorted by students (desc). */
  rows: AnalyticsCourseRow[];
  /** Sums across `rows` (a student in two courses counts twice). */
  totals: AnalyticsTotals;
}

export interface CourseAnalytics extends AnalyticsCourseRow {
  /** Number of purchase rows (a team purchase counts as one). */
  purchases: number;
  /** One entry per quiz, in course order (module position, then lesson position). */
  quizzes: QuizBreakdown[];
}

export interface QuizBreakdown {
  quizId: number;
  quizTitle: string;
  lessonTitle: string;
  /** Distinct enrolled students with at least one attempt. */
  attempted: number;
  /** Distinct enrolled students in the course. */
  enrolled: number;
  /** Mean of each attempting student's best score, 0–1; `null` when nobody attempted. */
  averageBestScore: number | null;
  /**
   * Share of attempting students whose best score is `>=` the quiz's own
   * passing score (the stored `passed` flag is ignored); `null` when nobody attempted.
   */
  passRate: number | null;
}

export function getAnalyticsOverview({
  instructorId,
  now = new Date(),
}: {
  /** `null` means every course (admin view). */
  instructorId: number | null;
  now?: Date;
}): AnalyticsOverview {
  const inScope = selectCourses(
    and(
      ne(courses.status, CourseStatus.Draft),
      instructorId === null ? undefined : eq(courses.instructorId, instructorId)
    )
  );

  const rows = buildRows(inScope, now).sort(
    (a, b) => b.students - a.students || a.title.localeCompare(b.title)
  );

  const totals = rows.reduce<AnalyticsTotals>(addVolume, EMPTY_VOLUME);

  return { rows, totals };
}

/**
 * Analytics for one course, whatever its status (drafts included, unlike the
 * overview). Returns `null` when the course does not exist. Access checks are
 * the caller's job.
 */
export function getCourseAnalytics(
  courseId: number,
  { now = new Date() }: { now?: Date } = {}
): CourseAnalytics | null {
  const inScope = selectCourses(eq(courses.id, courseId));
  if (inScope.length === 0) return null;

  const [row] = buildRows(inScope, now);
  return {
    ...row,
    purchases: purchaseCount(courseId),
    quizzes: quizBreakdown(courseId, row.students),
  };
}

// ─── Internals ───
// Each metric family is one grouped query over the courses in scope, returned
// as a Map keyed by course id. `buildRows` merges them into rows; add a new
// metric as another helper plus one merge line there.

type CourseInScope = { id: number; title: string; instructorName: string };

function selectCourses(where: SQL | undefined): CourseInScope[] {
  return db
    .select({
      id: courses.id,
      title: courses.title,
      instructorName: users.name,
    })
    .from(courses)
    .innerJoin(users, eq(users.id, courses.instructorId))
    .where(where)
    .all();
}

function buildRows(inScope: CourseInScope[], now: Date): AnalyticsCourseRow[] {
  const courseIds = inScope.map((c) => c.id);
  const cutoff = recentCutoff(now);
  const students = studentStats(courseIds, cutoff);
  const revenue = revenueStats(courseIds, cutoff);
  const quizScores = quizScoreStats(courseIds);
  const progress = progressStats(courseIds);

  return inScope.map((c) => {
    const volume: CourseVolume = {
      ...EMPTY_VOLUME,
      ...students.get(c.id),
      ...revenue.get(c.id),
    };
    return {
      courseId: c.id,
      title: c.title,
      instructorName: c.instructorName,
      ...volume,
      averageBestQuizScore: quizScores.get(c.id) ?? null,
      ...progressRates(progress.get(c.id), volume.students),
    };
  });
}

/**
 * Start of the rolling 30-day window, as an ISO string. Window checks compare
 * it as text against `enrolledAt` / `createdAt`, which relies on those columns
 * holding ISO-8601 UTC timestamps (they sort lexicographically).
 */
function recentCutoff(now: Date): string {
  return new Date(now.getTime() - RECENT_WINDOW_MS).toISOString();
}

/**
 * Distinct students per course. A student counts as recent only when their
 * first enrollment in the course is inside the window, so a duplicate recent
 * enrollment doesn't make a long-standing student look new.
 */
function studentStats(courseIds: number[], cutoff: string) {
  const firstEnrollments = db
    .select({
      courseId: enrollments.courseId,
      userId: enrollments.userId,
      firstEnrolledAt: min(enrollments.enrolledAt).as("first_enrolled_at"),
    })
    .from(enrollments)
    .where(inArray(enrollments.courseId, courseIds))
    .groupBy(enrollments.courseId, enrollments.userId)
    .as("first_enrollments");

  return new Map(
    db
      .select({
        courseId: firstEnrollments.courseId,
        students: count(),
        studentsLast30Days: sum(
          sql`case when ${firstEnrollments.firstEnrolledAt} >= ${cutoff} then 1 else 0 end`
        ).mapWith(Number),
      })
      .from(firstEnrollments)
      .groupBy(firstEnrollments.courseId)
      .all()
      .map(({ courseId, ...counts }) => [courseId, counts])
  );
}

function revenueStats(courseIds: number[], cutoff: string) {
  return new Map(
    db
      .select({
        courseId: purchases.courseId,
        revenue: sum(purchases.amountPaid).mapWith(Number),
        revenueLast30Days: sum(
          sql`case when ${purchases.createdAt} >= ${cutoff} then ${purchases.amountPaid} else 0 end`
        ).mapWith(Number),
      })
      .from(purchases)
      .where(inArray(purchases.courseId, courseIds))
      .groupBy(purchases.courseId)
      .all()
      .map(({ courseId, ...amounts }) => [courseId, amounts])
  );
}

function purchaseCount(courseId: number): number {
  return (
    db
      .select({ purchases: count() })
      .from(purchases)
      .where(eq(purchases.courseId, courseId))
      .get()?.purchases ?? 0
  );
}

/**
 * Subquery with one row per (student, quiz) holding the student's best score
 * on that quiz, for quizzes in the given courses. Retakes collapse to the best
 * attempt. Only students enrolled in the quiz's course count, so "attempted by
 * X of N enrolled" stays coherent. Shared by the course-level average and the
 * per-quiz breakdown.
 */
function bestQuizScores(courseIds: number[]) {
  const enrolledInCourse = db
    .select({ one: sql`1` })
    .from(enrollments)
    .where(
      and(
        eq(enrollments.userId, quizAttempts.userId),
        eq(enrollments.courseId, modules.courseId)
      )
    );

  return db
    .select({
      courseId: modules.courseId,
      quizId: quizAttempts.quizId,
      userId: quizAttempts.userId,
      bestScore: max(quizAttempts.score).as("best_score"),
    })
    .from(quizAttempts)
    .innerJoin(quizzes, eq(quizzes.id, quizAttempts.quizId))
    .innerJoin(lessons, eq(lessons.id, quizzes.lessonId))
    .innerJoin(modules, eq(modules.id, lessons.moduleId))
    .where(and(inArray(modules.courseId, courseIds), exists(enrolledInCourse)))
    .groupBy(modules.courseId, quizAttempts.quizId, quizAttempts.userId)
    .as("best_quiz_scores");
}

function quizScoreStats(courseIds: number[]) {
  const best = bestQuizScores(courseIds);
  return new Map(
    db
      .select({
        courseId: best.courseId,
        averageBestQuizScore: avg(best.bestScore).mapWith(Number),
      })
      .from(best)
      .groupBy(best.courseId)
      .all()
      .map((r) => [r.courseId, r.averageBestQuizScore])
  );
}

/**
 * Per-quiz figures for one course, in course order. Quizzes nobody attempted
 * still appear, with 0 attempted and null score / pass rate.
 */
function quizBreakdown(courseId: number, enrolled: number): QuizBreakdown[] {
  const best = bestQuizScores([courseId]);
  const stats = db
    .select({
      quizId: best.quizId,
      attempted: count().as("attempted"),
      averageBestScore: avg(best.bestScore).as("average_best_score"),
      passRate: avg(
        sql`case when ${best.bestScore} >= ${quizzes.passingScore} then 1.0 else 0 end`
      ).as("pass_rate"),
    })
    .from(best)
    .innerJoin(quizzes, eq(quizzes.id, best.quizId))
    .groupBy(best.quizId)
    .as("quiz_stats");

  return db
    .select({
      quizId: quizzes.id,
      quizTitle: quizzes.title,
      lessonTitle: lessons.title,
      attempted: stats.attempted,
      averageBestScore: stats.averageBestScore,
      passRate: stats.passRate,
    })
    .from(quizzes)
    .innerJoin(lessons, eq(lessons.id, quizzes.lessonId))
    .innerJoin(modules, eq(modules.id, lessons.moduleId))
    .leftJoin(stats, eq(stats.quizId, quizzes.id))
    .where(eq(modules.courseId, courseId))
    .orderBy(modules.position, lessons.position, quizzes.id)
    .all()
    .map((q) => ({
      ...q,
      attempted: q.attempted ?? 0,
      enrolled,
      averageBestScore:
        q.averageBestScore === null ? null : Number(q.averageBestScore),
      passRate: q.passRate === null ? null : Number(q.passRate),
    }));
}

// ─── Completion rate and average progress ───
// Completion counts lessons only (quizzes don't count) and ignores the unused
// `enrollments.completedAt`. Lessons added later lower the rates — accepted.

type ProgressStats = {
  /** Lessons in the course. */
  lessons: number;
  /** Sum over enrolled students of distinct completed lessons. */
  completedLessons: number;
  /** Enrolled students who completed every lesson. */
  completedStudents: number;
};

function progressRates(
  stats: ProgressStats | undefined,
  students: number
): Pick<AnalyticsCourseRow, "completionRate" | "averageProgress"> {
  if (!stats || stats.lessons === 0 || students === 0) {
    return { completionRate: null, averageProgress: null };
  }
  return {
    completionRate: stats.completedStudents / students,
    averageProgress: stats.completedLessons / (stats.lessons * students),
  };
}

function progressStats(courseIds: number[]): Map<number, ProgressStats> {
  const lessonTotals = db
    .select({
      courseId: modules.courseId,
      lessons: count(lessons.id).as("lessons"),
    })
    .from(lessons)
    .innerJoin(modules, eq(modules.id, lessons.moduleId))
    .where(inArray(modules.courseId, courseIds))
    .groupBy(modules.courseId)
    .as("lesson_totals");

  // Distinct completed lessons per enrolled (course, student). Joining
  // enrollments drops progress from non-enrolled users; countDistinct absorbs
  // duplicate enrollments and duplicate progress rows.
  const perStudent = db
    .select({
      courseId: modules.courseId,
      completedLessons: countDistinct(lessonProgress.lessonId).as(
        "completed_lessons"
      ),
    })
    .from(lessonProgress)
    .innerJoin(lessons, eq(lessons.id, lessonProgress.lessonId))
    .innerJoin(modules, eq(modules.id, lessons.moduleId))
    .innerJoin(
      enrollments,
      and(
        eq(enrollments.userId, lessonProgress.userId),
        eq(enrollments.courseId, modules.courseId)
      )
    )
    .where(
      and(
        inArray(modules.courseId, courseIds),
        eq(lessonProgress.status, LessonProgressStatus.Completed)
      )
    )
    .groupBy(modules.courseId, lessonProgress.userId)
    .as("per_student");

  const completionByCourse = new Map(
    db
      .select({
        courseId: perStudent.courseId,
        completedLessons: sum(perStudent.completedLessons).mapWith(Number),
        completedStudents: sum(
          sql`case when ${perStudent.completedLessons} >= ${lessonTotals.lessons} then 1 else 0 end`
        ).mapWith(Number),
      })
      .from(perStudent)
      .innerJoin(lessonTotals, eq(lessonTotals.courseId, perStudent.courseId))
      .groupBy(perStudent.courseId)
      .all()
      .map((r) => [r.courseId, r])
  );

  return new Map(
    db
      .select({
        courseId: lessonTotals.courseId,
        lessons: lessonTotals.lessons,
      })
      .from(lessonTotals)
      .all()
      .map((r) => [
        r.courseId,
        {
          lessons: r.lessons,
          completedLessons:
            completionByCourse.get(r.courseId)?.completedLessons ?? 0,
          completedStudents:
            completionByCourse.get(r.courseId)?.completedStudents ?? 0,
        },
      ])
  );
}
