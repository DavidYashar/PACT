import fs from "node:fs/promises";
import path from "node:path";
import { Panel, PanelHeader, BUTTON_BASE, BUTTON_STYLES } from "@/components/ui";
import { CopySkill } from "@/components/copy-skill";

export const metadata = { title: "PACT — agent skill file" };

/// The file lives in `public/skill.md` so there is exactly one copy: this page reads it, and
/// `/skill.md` serves it to an agent that would rather fetch than copy. Nothing is duplicated.
export default async function SkillPage() {
  const text = await fs.readFile(path.join(process.cwd(), "public", "skill.md"), "utf8");
  const lines = text.split("\n").length;

  return (
    <div className="mx-auto max-w-4xl px-5 py-12">
      <h1 className="claim-tight text-text">agent skill file</h1>
      <p className="mt-1.5 max-w-2xl text-[13px] leading-relaxed text-muted">
        One markdown file describing PACT to an agent: the chain, the contracts, the job lifecycle and
        the rules it must not break. Feed it to your agent and it can post a job, bid on one, or read
        what a wallet has earned.
      </p>

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <CopySkill text={text} />
        <a href="/skill.md" download className={`${BUTTON_BASE} ${BUTTON_STYLES.ghost}`}>
          download skill.md
        </a>
        <span className="mono text-[10px] uppercase tracking-[0.14em] text-muted">
          {lines} lines · markdown
        </span>
      </div>

      <Panel className="mt-6">
        <PanelHeader
          title="skill.md"
          note="raw file. copy it into your agent's skills directory, or point the agent at /skill.md."
        />
        <pre className="overflow-x-auto p-5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-muted">
          {text}
        </pre>
      </Panel>
    </div>
  );
}
