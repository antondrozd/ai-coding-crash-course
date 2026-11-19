import { describe, it, expect, beforeEach, vi } from "vitest";
import { createTestDb, seedBaseData } from "~/test/setup";
import * as schema from "~/db/schema";

let testDb: ReturnType<typeof createTestDb>;
let base: ReturnType<typeof seedBaseData>;

vi.mock("~/db", () => ({
  get db() {
    return testDb;
  },
}));

import { getAnalyticsOverview } from "./analyticsService";
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
