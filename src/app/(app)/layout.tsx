import { redirect } from "next/navigation";
import { currentUser } from "@/lib/auth/session";
import { AppShell } from "@/components/app-shell";
import { ErrorBoundary } from "@/components/error-boundary";
import { ServerProvider, ToastProvider } from "@/components/providers";

export const dynamic = "force-dynamic";

/**
 * Authenticated shell.
 *
 * `CrashSentinel` is mounted once, in the root layout. Mounting it here as well
 * started a second sentinel per navigation, and each start wrote its own session
 * record over the first one's — so the following mount read a live session as
 * "terminated without unloading" and filed a false crash report on every page
 * load, which is exactly the evidence an "Aw, Snap!" investigation needs to be
 * clean.
 */
export default async function AppLayout({ children }: { children: React.ReactNode }) {
  const user = await currentUser();
  if (!user) redirect("/login");

  return (
    <ToastProvider>
      <ServerProvider>
        <AppShell user={{ name: user.name, email: user.email, role: user.role }}>
          {/* A page that throws must not take the navigation, the session or
              the console chrome down with it. */}
          <ErrorBoundary scope="This page">{children}</ErrorBoundary>
        </AppShell>
      </ServerProvider>
    </ToastProvider>
  );
}
