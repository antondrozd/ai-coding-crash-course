import {
  and,
  count,
  countDistinct,
  eq,
  inArray,
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
  purchases,
  users,
} from "~/db/schema";

// ─── Analytics Service ───
// Live course metrics for instructors and admins. Every figure comes from
// grouped SQL aggregates over the courses in scope — never a per-student loop.
// Uses object options (per the analytics PRD) so `now` can be injected.

const RECENT_WINDOW_MS = 30 * 86_400_000;

export interface AnalyticsCourseRow {
  courseId: number;
  title: string;
  instructorName: string;
  /** Distinct enrolled users. */
  students: number;
  /** Distinct users enrolled within the last 30 days. */
  studentsLast30Days: number;
  /** Gross revenue in cents (sum of amount actually paid). */
  revenue: number;
  /** Gross revenue in cents from purchases within the last 30 days. */
  revenueLast30Days: number;
}

export interface AnalyticsTotals {
  students: number;
  studentsLast30Days: number;
  revenue: number;
  revenueLast30Days: number;
}

export interface AnalyticsOverview {
  /** Published and archived courses in scope, sorted by students (desc). */
  rows: AnalyticsCourseRow[];
  /** Sums across `rows` (a student in two courses counts twice). */
  totals: AnalyticsTotals;
}

export interface CourseAnalytics extends AnalyticsCourseRow {
  /** Number of purchase rows (a team purchase counts as one). */
  purchases: number;
}

export function getAnalyticsOverview({
  instructorId,
  now = new Date(),
}: {
  /** `null` means every course (admin view). */
  instructorId: number | null;
  now?: Date;
}): AnalyticsOverview {
  const scoped = selectCourses(
    and(
      ne(courses.status, CourseStatus.Draft),
      instructorId === null
        ? undefined
        : eq(courses.instructorId, instructorId)
    )
  );

  const rows = buildRows(scoped, now).sort(
    (a, b) => b.students - a.students || a.title.localeCompare(b.title)
  );

  const totals = rows.reduce<AnalyticsTotals>(
    (acc, r) => ({
      students: acc.students + r.students,
      studentsLast30Days: acc.studentsLast30Days + r.studentsLast30Days,
      revenue: acc.revenue + r.revenue,
      revenueLast30Days: acc.revenueLast30Days + r.revenueLast30Days,
    }),
    { students: 0, studentsLast30Days: 0, revenue: 0, revenueLast30Days: 0 }
  );

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
  const scoped = selectCourses(eq(courses.id, courseId));
  if (scoped.length === 0) return null;

  const [row] = buildRows(scoped, now);
  return { ...row, purchases: purchaseCounts([courseId]).get(courseId) ?? 0 };
}

// ─── Internals ───
// Each metric family is one grouped query over the courses in scope, returned
// as a Map keyed by course id. `buildRows` merges them into rows; add a new
// metric as another helper plus one merge line there.

type ScopedCourse = { id: number; title: string; instructorName: string };

function selectCourses(where: SQL | undefined): ScopedCourse[] {
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

function buildRows(scoped: ScopedCourse[], now: Date): AnalyticsCourseRow[] {
  const courseIds = scoped.map((c) => c.id);
  const cutoff = recentCutoff(now);
  const students = studentStats(courseIds, cutoff);
  const revenue = revenueStats(courseIds, cutoff);

  return scoped.map((c) => ({
    courseId: c.id,
    title: c.title,
    instructorName: c.instructorName,
    students: students.get(c.id)?.students ?? 0,
    studentsLast30Days: students.get(c.id)?.studentsLast30Days ?? 0,
    revenue: revenue.get(c.id)?.revenue ?? 0,
    revenueLast30Days: revenue.get(c.id)?.revenueLast30Days ?? 0,
  }));
}

/** Start of the rolling 30-day window. Timestamps are ISO strings, which sort lexicographically. */
function recentCutoff(now: Date): string {
  return new Date(now.getTime() - RECENT_WINDOW_MS).toISOString();
}

function studentStats(courseIds: number[], cutoff: string) {
  return new Map(
    db
      .select({
        courseId: enrollments.courseId,
        students: countDistinct(enrollments.userId),
        studentsLast30Days: countDistinct(
          sql`case when ${enrollments.enrolledAt} >= ${cutoff} then ${enrollments.userId} end`
        ),
      })
      .from(enrollments)
      .where(inArray(enrollments.courseId, courseIds))
      .groupBy(enrollments.courseId)
      .all()
      .map((r) => [r.courseId, r])
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
      .map((r) => [r.courseId, r])
  );
}

function purchaseCounts(courseIds: number[]) {
  return new Map(
    db
      .select({ courseId: purchases.courseId, purchases: count() })
      .from(purchases)
      .where(inArray(purchases.courseId, courseIds))
      .groupBy(purchases.courseId)
      .all()
      .map((r) => [r.courseId, r.purchases])
  );
}
