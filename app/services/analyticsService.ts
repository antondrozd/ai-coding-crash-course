import { and, countDistinct, eq, inArray, ne, sql, sum } from "drizzle-orm";
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

export function getAnalyticsOverview({
  instructorId,
  now = new Date(),
}: {
  /** `null` means every course (admin view). */
  instructorId: number | null;
  now?: Date;
}): AnalyticsOverview {
  // Timestamps are ISO strings, which sort lexicographically.
  const cutoff = new Date(now.getTime() - RECENT_WINDOW_MS).toISOString();

  const scoped = db
    .select({
      id: courses.id,
      title: courses.title,
      instructorName: users.name,
    })
    .from(courses)
    .innerJoin(users, eq(users.id, courses.instructorId))
    .where(
      and(
        ne(courses.status, CourseStatus.Draft),
        instructorId === null
          ? undefined
          : eq(courses.instructorId, instructorId)
      )
    )
    .all();

  const courseIds = scoped.map((c) => c.id);

  const studentStats = new Map(
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

  const revenueStats = new Map(
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

  const rows: AnalyticsCourseRow[] = scoped
    .map((c) => ({
      courseId: c.id,
      title: c.title,
      instructorName: c.instructorName,
      students: studentStats.get(c.id)?.students ?? 0,
      studentsLast30Days: studentStats.get(c.id)?.studentsLast30Days ?? 0,
      revenue: revenueStats.get(c.id)?.revenue ?? 0,
      revenueLast30Days: revenueStats.get(c.id)?.revenueLast30Days ?? 0,
    }))
    .sort((a, b) => b.students - a.students || a.title.localeCompare(b.title));

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
