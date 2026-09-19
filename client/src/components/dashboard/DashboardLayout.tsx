import { AudioLines, FilePlus2, History, LayoutDashboard, LogOut, User } from "lucide-react";
import { NavLink, Outlet, useNavigate } from "react-router-dom";
import { useAuth } from "@/hooks/useAuth";
import { cn } from "@/lib/utils";

const NAV_ITEMS = [
  { to: "/dashboard", label: "Dashboard", icon: LayoutDashboard, end: true },
  { to: "/dashboard/new", label: "New transcription", icon: FilePlus2 },
  { to: "/dashboard/history", label: "Transcript history", icon: History },
  { to: "/dashboard/account", label: "Account", icon: User },
];

export function DashboardLayout() {
  const { signOut } = useAuth();
  const navigate = useNavigate();

  async function handleSignOut() {
    await signOut();
    navigate("/login", { replace: true });
  }

  return (
    <div className="flex min-h-svh flex-col md:flex-row">
      <aside className="flex shrink-0 flex-col border-b border-border bg-card md:w-56 md:border-b-0 md:border-r">
        <div className="flex items-center gap-2 px-4 py-4">
          <AudioLines className="size-5" strokeWidth={2.25} />
          <span className="text-base font-semibold tracking-tight">Scribe</span>
        </div>
        <nav className="flex gap-1 overflow-x-auto px-2 pb-2 md:flex-1 md:flex-col md:overflow-visible md:px-2 md:pb-4">
          {NAV_ITEMS.map(({ to, label, icon: Icon, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) =>
                cn(
                  "flex shrink-0 items-center gap-2 rounded-md px-3 py-2 text-sm font-medium whitespace-nowrap transition-colors",
                  isActive
                    ? "bg-primary text-primary-foreground"
                    : "text-muted-foreground hover:bg-muted hover:text-foreground",
                )
              }
            >
              <Icon className="size-4" />
              {label}
            </NavLink>
          ))}
        </nav>
        <div className="px-2 pb-4">
          <button
            type="button"
            onClick={handleSignOut}
            className="flex w-full items-center gap-2 rounded-md px-3 py-2 text-sm font-medium text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <LogOut className="size-4" />
            Sign out
          </button>
        </div>
      </aside>
      <main className="min-w-0 flex-1 px-4 py-6 sm:px-8 sm:py-8">
        <Outlet />
      </main>
    </div>
  );
}
