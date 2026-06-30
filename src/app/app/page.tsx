import { redirect } from "next/navigation";

export const dynamic = "force-dynamic";

// /app lands on the chat tab by default. Layout already enforced auth +
// container-ready, so this redirect runs for every authenticated visitor.
export default function AppIndexPage() {
  redirect("/app/chat");
}
