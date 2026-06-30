import { AuthForm } from "@/components/auth/auth-form";

export default async function RegisterPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // `needConsent=1` is set by the server-side registration gate
  // (auth.config.ts) when a brand-new user tries to sign up from /login.
  const sp = await searchParams;
  const next = typeof sp.next === "string" ? sp.next : undefined;
  return (
    <AuthForm
      mode="register"
      needConsent={sp.needConsent === "1"}
      next={next}
      oauthError={sp.error !== undefined}
    />
  );
}
