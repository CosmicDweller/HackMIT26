import { useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { AuthLayout } from "@/components/auth/AuthLayout";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAuth } from "@/hooks/useAuth";

export function ResetPasswordPage() {
  const { requestPasswordReset, error, clearError } = useAuth();
  const [email, setEmail] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [sent, setSent] = useState(false);

  async function handleSubmit(e: FormEvent) {
    e.preventDefault();
    setSubmitting(true);
    try {
      await requestPasswordReset(email);
      setSent(true);
    } catch {
      // error is surfaced via useAuth().error
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AuthLayout
      title="Reset password"
      description="We'll send a password reset link to your email."
      footer={
        <Link to="/login" className="font-medium text-foreground underline underline-offset-2">
          Back to sign in
        </Link>
      }
    >
      {sent ? (
        <p className="text-sm text-muted-foreground">
          If an account exists for <span className="font-medium text-foreground">{email}</span>,
          a reset link is on its way.
        </p>
      ) : (
        <form onSubmit={handleSubmit} className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="email">Email</Label>
            <Input
              id="email"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(e) => {
                setEmail(e.target.value);
                clearError();
              }}
            />
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <Button type="submit" className="w-full" disabled={submitting}>
            {submitting ? "Sending..." : "Send reset link"}
          </Button>
        </form>
      )}
    </AuthLayout>
  );
}
