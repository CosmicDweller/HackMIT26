import { AudioLines } from "lucide-react";
import type { ReactNode } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";

interface AuthLayoutProps {
  title: string;
  description: string;
  children: ReactNode;
  footer?: ReactNode;
}

export function AuthLayout({ title, description, children, footer }: AuthLayoutProps) {
  return (
    <div className="flex min-h-svh flex-col items-center justify-center gap-6 px-6 py-12">
      <div className="flex items-center gap-2">
        <AudioLines className="size-5" strokeWidth={2.25} />
        <span className="text-base font-semibold tracking-tight">Scribe</span>
      </div>
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>{title}</CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">{children}</CardContent>
      </Card>
      {footer && <div className="text-sm text-muted-foreground">{footer}</div>}
    </div>
  );
}
