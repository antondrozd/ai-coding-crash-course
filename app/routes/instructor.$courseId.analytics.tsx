import { Link, data, isRouteErrorResponse } from "react-router";
import type { Route } from "./+types/instructor.$courseId.analytics";
import { requireStaff } from "~/lib/access.server";
import { getCourseAnalytics } from "~/services/analyticsService";
import { Button } from "~/components/ui/button";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { Skeleton } from "~/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "~/components/ui/table";
import { AlertTriangle, Pencil, Users } from "lucide-react";
import { formatPercent, formatRevenue } from "~/lib/utils";

// ─── Course Analytics ───
// Students, gross revenue, purchases and a per-quiz breakdown for one course. Open to the course's
// own instructor and admins; drafts render too. All aggregation lives in
// analyticsService.getCourseAnalytics.

export function meta({ loaderData }: Route.MetaArgs) {
  const title = loaderData?.course.title ?? "Course";
  return [{ title: `Analytics: ${title} — Cadence` }];
}

export async function loader({ params, request }: Route.LoaderArgs) {
  const courseId = parseInt(params.courseId, 10);
  if (isNaN(courseId)) {
    throw data("Invalid course ID.", { status: 400 });
  }

  await requireStaff(request, courseId);

  const course = getCourseAnalytics(courseId);
  if (!course) {
    throw data("Course not found.", { status: 404 });
  }

  return { course };
}

export default function CourseAnalytics({ loaderData }: Route.ComponentProps) {
  const { course } = loaderData;

  const cards = [
    { label: "Students", value: course.students.toLocaleString() },
    {
      label: "Students (last 30 days)",
      value: course.studentsLast30Days.toLocaleString(),
    },
    { label: "Gross revenue", value: formatRevenue(course.revenue) },
    {
      label: "Gross revenue (last 30 days)",
      value: formatRevenue(course.revenueLast30Days),
    },
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

      <div className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {cards.map((card) => (
          <Card key={card.label}>
            <CardHeader>
              <CardDescription>{card.label}</CardDescription>
              <CardTitle className="text-2xl tabular-nums">
                {card.value}
              </CardTitle>
            </CardHeader>
          </Card>
        ))}
      </div>

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
  return (
    <div className="mx-auto max-w-6xl p-6 lg:p-8">
      <Skeleton className="mb-6 h-4 w-56" />
      <Skeleton className="mb-8 h-9 w-72" />
      <div className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-24 w-full" />
        ))}
      </div>
    </div>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let title = "Something went wrong";
  let message = "An unexpected error occurred while loading course analytics.";

  if (isRouteErrorResponse(error)) {
    if (error.status === 401) {
      title = "Sign in required";
      message =
        typeof error.data === "string"
          ? error.data
          : "Please select a user from the DevUI panel.";
    } else if (error.status === 403) {
      title = "Not allowed";
      message =
        typeof error.data === "string"
          ? error.data
          : "You don't have access to this page.";
    } else if (error.status === 404) {
      title = "Course not found";
      message =
        typeof error.data === "string"
          ? error.data
          : "This course doesn't exist.";
    } else {
      title = `Error ${error.status}`;
      message = typeof error.data === "string" ? error.data : error.statusText;
    }
  }

  return (
    <div className="flex min-h-[50vh] items-center justify-center p-6">
      <div className="text-center">
        <AlertTriangle className="mx-auto mb-4 size-12 text-muted-foreground" />
        <h1 className="mb-2 text-2xl font-bold">{title}</h1>
        <p className="mb-6 text-muted-foreground">{message}</p>
        <Link to="/instructor">
          <Button>My Courses</Button>
        </Link>
      </div>
    </div>
  );
}
