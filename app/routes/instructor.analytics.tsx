import { Link, isRouteErrorResponse } from "react-router";
import type { Route } from "./+types/instructor.analytics";
import { requireInstructorOrAdmin } from "~/lib/access.server";
import { getAnalyticsOverview } from "~/services/analyticsService";
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
import { AlertTriangle, BarChart3, Plus } from "lucide-react";
import { formatPercent, formatRevenue } from "~/lib/utils";

// ─── Analytics Overview ───
// Students and gross revenue across the courses in scope: an instructor's own
// published and archived courses, or every course for admins. All aggregation
// lives in analyticsService.getAnalyticsOverview.

export function meta() {
  return [{ title: "Analytics — Cadence" }];
}

export async function loader({ request }: Route.LoaderArgs) {
  const { userId, isAdmin } = await requireInstructorOrAdmin(request);

  // Admins span every course; instructors see only the courses they own.
  const overview = getAnalyticsOverview({
    instructorId: isAdmin ? null : userId,
  });

  return { ...overview, isAdmin };
}

export default function InstructorAnalytics({
  loaderData,
}: Route.ComponentProps) {
  const { rows, totals, isAdmin } = loaderData;

  const cards = [
    { label: "Students", value: totals.students.toLocaleString() },
    {
      label: "Students (last 30 days)",
      value: totals.studentsLast30Days.toLocaleString(),
    },
    { label: "Gross revenue", value: formatRevenue(totals.revenue) },
    {
      label: "Gross revenue (last 30 days)",
      value: formatRevenue(totals.revenueLast30Days),
    },
  ];

  return (
    <div className="mx-auto max-w-6xl p-6 lg:p-8">
      <nav className="mb-6 text-sm text-muted-foreground">
        <Link to="/" className="hover:text-foreground">
          Home
        </Link>
        <span className="mx-2">/</span>
        <span className="text-foreground">Analytics</span>
      </nav>

      <div className="mb-8">
        <h1 className="text-3xl font-bold">Analytics</h1>
        <p className="mt-1 text-muted-foreground">
          {isAdmin
            ? "Students and gross revenue across every course"
            : "Students and gross revenue across your courses"}
        </p>
      </div>

      {rows.length === 0 ? (
        <div className="flex flex-col items-center justify-center py-16 text-center">
          <BarChart3 className="mb-4 size-12 text-muted-foreground/50" />
          <h2 className="text-lg font-medium">No courses to analyse yet</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Analytics appear once you have a published course.
          </p>
          <Link to="/instructor/new" className="mt-4">
            <Button>
              <Plus className="mr-2 size-4" />
              Create Course
            </Button>
          </Link>
        </div>
      ) : (
        <>
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

          <Card className="py-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead className="pl-4">Course</TableHead>
                  {isAdmin && <TableHead>Instructor</TableHead>}
                  <TableHead className="text-right">Students</TableHead>
                  <TableHead className="text-right">Last 30 days</TableHead>
                  <TableHead className="text-right">Gross revenue</TableHead>
                  <TableHead className="text-right">
                    Revenue, last 30 days
                  </TableHead>
                  <TableHead className="pr-4 text-right">
                    Avg. best quiz score
                  </TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.map((row) => (
                  <TableRow key={row.courseId}>
                    <TableCell className="pl-4 font-medium">
                      <Link
                        to={`/instructor/${row.courseId}/analytics`}
                        className="hover:underline"
                      >
                        {row.title}
                      </Link>
                    </TableCell>
                    {isAdmin && <TableCell>{row.instructorName}</TableCell>}
                    <TableCell className="text-right tabular-nums">
                      {row.students.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {row.studentsLast30Days.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatRevenue(row.revenue)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatRevenue(row.revenueLast30Days)}
                    </TableCell>
                    <TableCell className="pr-4 text-right tabular-nums">
                      {formatPercent(row.averageBestQuizScore)}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </Card>
        </>
      )}
    </div>
  );
}

export function HydrateFallback() {
  return (
    <div className="mx-auto max-w-6xl p-6 lg:p-8">
      <Skeleton className="mb-6 h-4 w-40" />
      <Skeleton className="mb-8 h-9 w-72" />
      <div className="mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-24 w-full" />
        ))}
      </div>
      <Skeleton className="h-64 w-full" />
    </div>
  );
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  let title = "Something went wrong";
  let message = "An unexpected error occurred while loading analytics.";

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
