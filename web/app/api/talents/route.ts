import { NextResponse } from "next/server";
import { loadTalentRows, serialise, summarise } from "@/lib/talents-read";
import { rankTalents, type BoardKey } from "@/lib/talents";

export const dynamic = "force-dynamic";

/// Twenty to a page. The whole registered set is ranked first — a page boundary must not change
/// someone's position — and only then sliced.
const PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 100;

export async function GET(request: Request) {
  const url = new URL(request.url);
  const board = (url.searchParams.get("board") ?? "workers") as BoardKey;
  const q = url.searchParams.get("q") ?? undefined;
  const kindParam = url.searchParams.get("kind");
  const kind = kindParam === null || kindParam === "" ? undefined : Number(kindParam);
  const pageSize = Math.min(Math.max(Number(url.searchParams.get("pageSize") ?? PAGE_SIZE), 1), MAX_PAGE_SIZE);

  try {
    const { rows, lastBlock } = await loadTalentRows();
    const ranked = rankTalents(rows, { board, q, kind });
    const pages = Math.max(1, Math.ceil(ranked.rows.length / pageSize));
    const page = Math.min(Math.max(Number(url.searchParams.get("page") ?? 1), 1), pages);
    const from = (page - 1) * pageSize;
    const slice = ranked.rows.slice(from, from + pageSize);
    return NextResponse.json({
      board,
      total: ranked.total,
      page,
      pages,
      pageSize,
      /// 1-based bounds of this page, so the page can say "21–40 of 57" without guessing.
      firstRow: slice.length === 0 ? 0 : from + 1,
      lastRow: from + slice.length,
      asOfBlock: Number(lastBlock),
      /// Registry-wide, computed before the active filter, so the filter controls can show counts.
      summary: summarise(rows),
      /// Every figure is a registry counter written once per settled job, so there is nothing
      /// off-chain in these numbers that could disagree with the chain.
      source: "PactNames.profileOf",
      rows: slice.map(serialise),
    });
  } catch (error) {
    console.error("talents read failed", error);
    return NextResponse.json({ error: "could not read the registry" }, { status: 502 });
  }
}