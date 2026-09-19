import { AudioLines } from "lucide-react";

export function Header() {
  return (
    <header className="border-b border-border">
      <div className="mx-auto flex max-w-5xl items-center gap-2 px-6 py-5">
        <AudioLines className="size-5 text-foreground" strokeWidth={2.25} />
        <span className="text-base font-semibold tracking-tight">Scribe</span>
      </div>
    </header>
  );
}
