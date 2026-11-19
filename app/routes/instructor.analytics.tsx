import { Link } from "react-router";
import type { Route } from "./+types/instructor.analytics";
import { requireInstructorOrAdmin } from "~/lib/access.server";
import { getAnalyticsOverview } from "~/services/analyticsService";
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
import { BarChart3, Plus } from "lucide-react";
import { formatPercent, formatRevenue } from "~/lib/utils";

// ─── Analytics Overview ───
// Students, gross revenue, completion, progress and quiz scores across the
// courses in scope: an instructor's own
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
            ? "Students, gross revenue, completion, progress and quiz scores across every course"
            : "Students, gross revenue, completion, progress and quiz scores across your courses"}
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
          <StatCardGrid cards={volumeCards(totals)} />

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
                    Gross revenue, last 30 days
                  </TableHead>
                  <TableHead className="text-right">Completion</TableHead>
                  <TableHead className="text-right">Avg. progress</TableHead>
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
                    <TableCell className="text-right tabular-nums">
                      {formatPercent(row.completionRate)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatPercent(row.averageProgress)}
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
  return <AnalyticsSkeleton cardCount={4} withTable />;
}

export function ErrorBoundary({ error }: Route.ErrorBoundaryProps) {
  return (
    <AnalyticsErrorBoundary
      error={error}
      fallbackMessage="An unexpected error occurred while loading analytics."
    />
  );
}
