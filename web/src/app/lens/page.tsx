import { redirect } from "next/navigation";

export default function LensPage() {
  redirect("/benchmark?view=lens");
}
