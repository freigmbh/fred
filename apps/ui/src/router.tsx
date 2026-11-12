import { createRootRoute, createRoute, createRouter, Outlet, useLocation } from "@tanstack/react-router";
import { Login } from "./components/login";
import { Sidebar } from "./components/sidebar";
import { UnauthorizedBoundary } from "./components/unauthorized-boundary";
import { useAdminSecret } from "./lib/secret";
import { Overview } from "./routes/overview";
import { Queue } from "./routes/queue";
import { Reviews } from "./routes/reviews";
import { Spend } from "./routes/spend";
import { Export } from "./routes/export";
import { Projects } from "./routes/projects";

// Sidebar and content once the secret is stored; the login form alone before that.
function Layout() {
  const { secret, clearSecret } = useAdminSecret();
  const pathname = useLocation({ select: (location) => location.pathname });
  if (!secret) return <Login />;
  return (
    <div className="flex min-h-svh flex-col md:flex-row">
      <Sidebar onLogout={clearSecret} />
      <main className="min-w-0 flex-1">
        <UnauthorizedBoundary key={`${secret}:${pathname}`}>
          <Outlet />
        </UnauthorizedBoundary>
      </main>
    </div>
  );
}

const rootRoute = createRootRoute({ component: Layout });
const overviewRoute = createRoute({ getParentRoute: () => rootRoute, path: "/", component: Overview });
const queueRoute = createRoute({ getParentRoute: () => rootRoute, path: "/queue", component: Queue });
const reviewsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/reviews", component: Reviews });
const spendRoute = createRoute({ getParentRoute: () => rootRoute, path: "/spend", component: Spend });
const projectsRoute = createRoute({ getParentRoute: () => rootRoute, path: "/projects", component: Projects });
const exportRoute = createRoute({ getParentRoute: () => rootRoute, path: "/export", component: Export });

export const router = createRouter({ routeTree: rootRoute.addChildren([overviewRoute, queueRoute, reviewsRoute, spendRoute, projectsRoute, exportRoute]) });

declare module "@tanstack/react-router" {
  interface Register {
    router: typeof router;
  }
}
