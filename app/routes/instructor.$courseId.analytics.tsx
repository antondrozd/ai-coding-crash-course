import { Link, data } from "react-router";
import type { Route } from "./+types/instructor.$courseId.analytics";
import { requireStaff, requireUserId } from "~/lib/access.server";
import { getCourseAnalytics } from "~/services/analyticsService";
import { Button } from "~/components/ui/button";
import { Card } from "~/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import {
  AnalyticsErrorBoundary,
  AnalyticsSkeleton,
  StatCardGrid,
  volumeCards,
} from "~/components/analytics/analytics-page";
import { Pencil, Users } from "lucide-react";
import { formatPercent } from "~/lib/utils";

// ─── Course Analytics ───
// Students, gross revenue, purchases and a per-quiz breakdown for one course.
// Open to the course's own instructor and admins; drafts render too. All
// aggregation lives in analyticsService.getCourseAnalytics.

export function meta({ loaderData }: Route.MetaArgs) {
  const title = loaderData?.course.title ?? "Course";
  return [{ title: `Analytics: ${title} — Cadence` }];
}

export async function loader({ params, request }: Route.LoaderArgs) {
  const courseId = parseInt(params.courseId, 10);
  if (isNaN(courseId)) {
    throw data("Invalid course ID.", { status: 400 });
  }

  // Order matters: 401 for no user, then 404 for a missing course (the same
  // for instructors and admins), then 403 for someone else's course.
  await requireUserId(request);

  const course = getCourseAnalytics(courseId);
  if (!course) {
    throw data("Course not found.", { status: 404 });
  }

  await requireStaff(request, courseId);

  return { course };
}

export default function CourseAnalytics({ loaderData }: Route.ComponentProps) {
  const { course } = loaderData;

  const cards = [
    ...volumeCards(course),
    { label: "Purchases", value: course.purchases.toLocaleString() },
    { label: "Completion rate", value: formatPercent(course.completionRate) },
    { label: "Average progress", value: formatPercent(course.averageProgress) },
    {
      label: "Avg. best quiz score",
      value: formatPercent(course.averageBestQuizScore),
    },
  ];

  return (
    <div className="mx-auto max-w-6xl p-6 lg:p-8">
      <nav className="mb-6 text-sm text-muted-foreground">
        <Link to="/" className="hover:text-foreground">
          Home
        </Link>
        <span className="mx-2">/</span>
        <Link to="/instructor/analytics" className="hover:text-foreground">
          Analytics
        </Link>
        <span className="mx-2">/</span>
        <span className="text-foreground">{course.title}</span>
      </nav>

      <div className="mb-8 flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-bold">{course.title}</h1>
          <p className="mt-1 text-muted-foreground">Course analytics</p>
        </div>
        <div className="flex gap-2">
          <Link to={`/instructor/${course.courseId}/students`}>
            <Button variant="outline">
              <Users className="mr-2 size-4" />
              Student roster
            </Button>
          </Link>
          <Link to={`/instructor/${course.courseId}`}>
            <Button variant="outline">
              <Pencil className="mr-2 size-4" />
              Edit course
            </Button>
          </Link>
        </div>
      </div>

      <StatCardGrid cards={cards} />

      <h2 className="mb-4 text-xl font-semibold">Quizzes</h2>
      {course.quizzes.length === 0 ? (
        <p className="text-muted-foreground">This course has no quizzes.</p>
      ) : (
        <Card className="py-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-4">Lesson</TableHead>
                <TableHead>Quiz</TableHead>
                <TableHead className="text-right">Attempted</TableHead>
                <TableHead className="text-right">Avg. best score</TableHead>
                <TableHead className="pr-4 text-right">Pass rate</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {course.quizzes.map((quiz) => (
                <TableRow key={quiz.quizId}>
                  <TableCell className="pl-4">{quiz.lessonTitle}</TableCell>
                  <TableCell className="font-medium">
                    {quiz.quizTitle}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {quiz.attempted.toLocaleString()} of{" "}
                    {quiz.enrolled.toLocaleString()}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {formatPercent(quiz.averageBestScore)}
                  </TableCell>
                  <TableCell className="pr-4 text-right tabular-nums">
                    {formatPercent(quiz.passRate)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </Card>
      )}
    </div>
  );
}

export function HydrateFallback() {
  return <AnalyticsSkeleton cardCount={8} breadcrumbWidth="w-56" />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  return (
    <AnalyticsErrorBoundary
      error={error}
      fallbackMessage="An unexpected error occurred while loading course analytics."
    />
  );
}
