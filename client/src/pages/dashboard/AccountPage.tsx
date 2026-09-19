import { useNavigate } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useAuth } from "@/hooks/useAuth";

export function AccountPage() {
  const { user, signOut } = useAuth();
  const navigate = useNavigate();

  async function handleSignOut() {
    await signOut();
    navigate("/login", { replace: true });
  }

  return (
    <div className="mx-auto max-w-md space-y-6">
      <h1 className="text-xl font-semibold tracking-tight">Account</h1>
      <Card>
        <CardHeader>
          <CardTitle className="text-sm text-muted-foreground">Signed in as</CardTitle>
          <CardDescription className="text-base text-foreground">{user?.email}</CardDescription>
        </CardHeader>
        <CardContent>
          <Button variant="outline" onClick={handleSignOut}>
            Sign out
          </Button>
        </CardContent>
      </Card>
      <p className="text-xs text-muted-foreground">
        A doctor account identifies you as an application user; it does not verify a medical
        license. This app does not provide diagnosis, treatment recommendations, or automated
        clinical decision-making, and is not HIPAA-compliant. Use synthetic data for testing.
      </p>
    </div>
  );
}
