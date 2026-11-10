import { rankTalents } from "@/lib/talents";
import { PAGE_SIZE, loadTalentRows, serialise, summarise } from "@/lib/talents-read";
import { TalentsBoard } from "./board";

/// The first page is rendered here, on the server, so the page has numbers in it before any
/// JavaScript runs — a judge on a phone should not watch a spinner to find out who to hire.
export const dynamic = "force-dynamic";

export default async function TalentsPage() {
  try {
    const { rows, lastBlock } = await loadTalentRows();
    const ranked = rankTalents(rows, { board: "workers" });
    const slice = ranked.rows.slice(0, PAGE_SIZE);
    return (
      <TalentsBoard
        initial={{
          total: ranked.total,
          page: 1,
          pages: Math.max(1, Math.ceil(ranked.rows.length / PAGE_SIZE)),
          pageSize: PAGE_SIZE,
          firstRow: slice.length === 0 ? 0 : 1,
          lastRow: slice.length,
          asOfBlock: Number(lastBlock),
          summary: summarise(rows),
          rows: slice.map(serialise),
        }}
      />
    );
  } catch {
    /// The read is retried from the client, which is also where an RPC failure gets explained.
    return <TalentsBoard initial={null} />;
  }
}