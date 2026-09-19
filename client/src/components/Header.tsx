import { AudioLines } from "lucide-react";
import { Link } from "react-router-dom";

export function Header() {
  return (
    <header className="border-b border-border">
      <div className="mx-auto flex max-w-5xl items-center justify-between gap-2 px-6 py-5">
        <div className="flex items-center gap-2">
          <AudioLines className="size-5 text-foreground" strokeWidth={2.25} />
          <span className="text-base font-semibold tracking-tight">Scribe</span>
        </div>
        <Link
          to="/login"
          className="text-sm font-medium text-muted-foreground underline underline-offset-2 hover:text-foreground"
        >
          Doctor sign in
        </Link>
      </div>
    </header>
  );
}
