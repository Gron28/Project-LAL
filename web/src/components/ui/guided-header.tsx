"use client";
import { GuideButton, PageGuide, usePageGuide, type GuideStep } from "./page-guide";

// Page title row shared by the Lab pages, with the page's onboarding guide
// underneath. First visit shows the guide; "Guide" brings it back.
export function GuidedHeader({ id, eyebrow, title, actions, guide }: {
  id: string;
  eyebrow: string;
  title: string;
  actions?: React.ReactNode;
  guide: { intro: string; steps: GuideStep[] };
}) {
  const g = usePageGuide(id);
  return (
    <>
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div><div className="page-eyebrow">{eyebrow}</div><h1 className="page-title text-[28px]">{title}</h1></div>
        <div className="flex flex-wrap items-center gap-2">
          {!g.open && <GuideButton onClick={g.show} />}
          {actions}
        </div>
      </div>
      {g.open && <PageGuide title={`How ${title} works`} intro={guide.intro} steps={guide.steps} onClose={g.close} />}
    </>
  );
}
