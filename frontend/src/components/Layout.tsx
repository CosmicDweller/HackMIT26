import { NavLink, Outlet } from "react-router-dom";
import { cn } from "@/lib/utils";

const steps = [
  { to: "/enroll", label: "1. Voice Enrollment" },
  { to: "/record", label: "2. Record Visit" },
  { to: "/transcript", label: "3. Transcript" },
  { to: "/soap-note", label: "4. SOAP Note" },
];

export function Layout() {
  return (
    <div className="min-h-svh bg-background text-foreground">
      <header className="border-b">
        <div className="mx-auto flex max-w-5xl flex-col gap-3 px-4 py-4 sm:flex-row sm:items-center sm:justify-between">
          <span className="text-lg font-semibold">Visit Notes</span>
          <nav className="flex flex-wrap gap-2">
            {steps.map((step) => (
              <NavLink
                key={step.to}
                to={step.to}
                className={({ isActive }) =>
                  cn(
                    "rounded-md px-3 py-1.5 text-sm transition-colors",
                    isActive
                      ? "bg-primary text-primary-foreground"
                      : "text-muted-foreground hover:bg-accent hover:text-accent-foreground",
                  )
                }
              >
                {step.label}
              </NavLink>
            ))}
          </nav>
        </div>
      </header>
      <main className="mx-auto max-w-5xl px-4 py-8">
        <Outlet />
      </main>
    </div>
  );
}
