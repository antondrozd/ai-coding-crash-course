import { Link, isRouteErrorResponse } from "react-router";
import { AlertTriangle } from "lucide-react";
import type { CourseVolume } from "~/services/analyticsService";
import { Button } from "~/components/ui/button";
import {
  Card,
  CardDescription,
  CardHeader,
  CardTitle,
} from "~/components/ui/card";
import { Skeleton } from "~/components/ui/skeleton";
import { formatRevenue } from "~/lib/utils";

// ─── Analytics page building blocks ───
// Shared by the analytics overview and the per-course analytics page.

export type StatCard = { label: string; value: string };

/** The student and gross-revenue cards both analytics pages lead with. */
export function volumeCards(volume: CourseVolume): StatCard[] {
  return [
    { label: "Students", value: volume.students.toLocaleString() },
    {
      label: "Students (last 30 days)",
      value: volume.studentsLast30Days.toLocaleString(),
    },
    { label: "Gross revenue", value: formatRevenue(volume.revenue) },
    {
      label: "Gross revenue (last 30 days)",
      value: formatRevenue(volume.revenueLast30Days),
    },
  ];
}

const GRID = "mb-8 grid gap-4 sm:grid-cols-2 lg:grid-cols-4";

export function StatCardGrid({ cards }: { cards: StatCard[] }) {
  return (
    <div className={GRID}>
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
  );
}

export function AnalyticsSkeleton({
  cardCount,
  breadcrumbWidth = "w-40",
  withTable = false,
}: {
  cardCount: number;
  breadcrumbWidth?: string;
  withTable?: boolean;
}) {
  return (
    <div className="mx-auto max-w-6xl p-6 lg:p-8">
      <Skeleton className={`mb-6 h-4 ${breadcrumbWidth}`} />
      <Skeleton className="mb-8 h-9 w-72" />
      <div className={GRID}>
        {Array.from({ length: cardCount }).map((_, i) => (
          <Skeleton key={i} className="h-24 w-full" />
        ))}
      </div>
      {withTable && <Skeleton className="h-64 w-full" />}
    </div>
  );
}

const STATUS_DEFAULTS: Record<number, { title: string; message: string }> = {
  401: {
    title: "Sign in required",
    message: "Please select a user from the DevUI panel.",
  },
  403: { title: "Not allowed", message: "You don't have access to this page." },
  404: { title: "Course not found", message: "This course doesn't exist." },
};

export function AnalyticsErrorBoundary({
  error,
  fallbackMessage,
}: {
  error: unknown;
  /** Shown for errors that aren't route error responses. */
  fallbackMessage: string;
}) {
  let title = "Something went wrong";
  let message = fallbackMessage;

  if (isRouteErrorResponse(error)) {
    const defaults = STATUS_DEFAULTS[error.status] ?? {
      title: `Error ${error.status}`,
      message: error.statusText,
    };
    title = defaults.title;
    message = typeof error.data === "string" ? error.data : defaults.message;
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
