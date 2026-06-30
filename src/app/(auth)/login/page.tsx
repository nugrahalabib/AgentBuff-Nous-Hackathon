import { AuthForm } from "@/components/auth/auth-form";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // `next` = the deep-link the user was bounced from (honored as callbackUrl
  // with a same-origin guard in AuthForm). `error` = a NextAuth OAuth failure
  // code — we only need its presence to surface the error banner.
  const sp = await searchParams;
  const next = typeof sp.next === "string" ? sp.next : undefined;
  return (
    <AuthForm mode="login" next={next} oauthError={sp.error !== undefined} />
  );
}
