// 旅程を組み立てる流れ本体。画面には触りません。
//
// もとは app.js の中にありましたが、DOM と混ざっていると
// 「四国・9泊10日」のような組み合わせをテストで固定できませんでした。
// 実際に壊れていたのはこの流れの側なので、画面から切り離してあります。
//
//   1. 希望を読む（AI）
//   2. 知識ベースを検索して候補を作る
//   3. AI が案を出す                      ← 1回目
//   4. 各スポットを実際の移動時間で検証する  ← Routes API + 営業時間
//   5. 問題があれば、理由を渡して直させる    ← 2回目
//   6. 時刻を割り付けて旅程にする
//   7. 希望に応えられたかを確かめて、応えられていなければそう伝える

import {
  embedQuery, hasApiKey, proposePlan, resolvedModel, understandRequest,
} from "./ai.js";
import { areaNote, areaScope, detectAreas, unknownPlaceTerms } from "./areas.js";
import { discoverArea, resolveDestination } from "./discover.js";
import { estimateMinutes, haversineKm } from "./feasibility.js";
import {
  mergeIntoKb, rankRegions, reachableRegions, searchSpots, searchSpotsByKeyword,
} from "./kb.js";
import { extractKeywords } from "./keywords.js";
import { analyzeCoverage, coverageMessage, seasonalNotes } from "./match.js";
import { balanceByTier, mixTargets } from "./mix.js";
import { buildItinerary } from "./planner.js";
import { computeRoute, legDetailLookup, legLookupAll, pickMode }
  from "./routes.js";
import { SPOTS_PER_DAY, planStays, suggestRegionCount } from "./stays.js";
import { dayEnd, endPlace, nightsOf } from "./trip.js";
import { issuesToPrompt, trimToFit } from "./verify.js";
import { critique, relaxForItinerary, relaxForUnreachable } from "./relax.js";
import { itineraryCrowd, spreadCrowds } from "./crowd.js";
import { costBreakdown } from "./cost.js";
import { sunNotes, sunTimes } from "./sun.js";
import { forecastFor, summarizeDay } from "./weather.js";
import { suggestReplan } from "./replan.js";
import { eventNotesFor } from "./events.js";
import { luggagePlanFor } from "./luggage.js";
import { storyFor } from "./story.js";
import { pickBest, scoreItinerary } from "./score.js";

/**
 * @param {object} args
 * @param {object} args.trip  makeTrip の結果（検証済み）
 * @param {object} args.kb    loadKnowledgeBase の結果
 * @param {(step:number, note?:string)=>void} [args.onProgress]
 * @returns {Promise<object>} 表示用の旅程
 */
export async function planTrip({ trip, kb, onProgress = () => {},
                                 ...opts }) {
    const hours = (trip.arriveBy - trip.departAt) / 3600000;

  onProgress(0);
  // 希望文の読み取りと検索用ベクトルは、3案を作るときに使い回します。
  // 案ごとに読み取り直すと、同じ文をモデルに3回投げることになります
  // （変わるのはペースと穴場の割合だけで、希望文は同じです）。
  const query = opts.query
    ?? await understandRequest(trip.note, trip.interests, hours);
  // ペースは、利用者が選んでいればそちらを使います。
  // 希望文からの推測で上書きすると、「もっとゆっくり」を押したのに
  // 何も変わらない、ということが起きます（実際に起きていました）。
  if (!trip.paceChosen) trip.pace = query.pace;

  onProgress(1);
  const vector = opts.vector !== undefined ? opts.vector
    : (kb.hasVectors ? await embedQuery(query.searchText) : null);
  // 地名は絞り込み（scope）で使うので、スポットの検索語からは外します。
  // 「四国」を語として残すと、名前に四国を含む「四国中央市」の
  // 地元の祭りばかりが上位に来ます（実際にそうなりました）。
  const areaWords = new Set(detectAreas(trip.note, kb)
    .flatMap((a) => [a.term, a.term.replace(/[都道府県]$/, "")]));
  const searchWords = [...query.keywords, ...query.interests]
    .filter((w) => !areaWords.has(w));

  let matches = vector
    ? searchSpots(kb, vector, { limit: 160, hiddenBias: trip.hiddenBias })
    : searchSpotsByKeyword(kb, searchWords,
                           { limit: 160, hiddenBias: trip.hiddenBias });

  // 一致が無いときにエラーで止めない。「その希望には応えられないが、
  // 行ける範囲でこういう案はある」と示したほうが役に立ちます。
  // 応えられなかったことは、あとで coverage が明示します。
  if (!matches.length) {
    matches = searchSpotsByKeyword(kb, trip.interests,
                                   { limit: 160, hiddenBias: trip.hiddenBias });
  }
  if (!matches.length) {
    matches = kb.spots.map((spot) => ({ spot, score: 0 }));
  }

  // 地名は他の検索語と性質が違います。「四国」を無視して銚子を出すのは、
  // 近いものを返しているのではなく、別の質問に答えているのと同じです。
  // 「地名の指定を外す」を選ばれたときは、地名を見ません。
  let scope = opts.ignoreAreas
    ? { regionIds: null, matched: [], missing: [] }
    : areaScope(detectAreas(trip.note, kb));

  // 収録に無い土地は、AIに調べさせてから候補に入れます。
  //
  // 収録を手で増やす方向だと、書いた土地しか通りません。しかも日本の
  // 都道府県を前提に検証していたので、「パリに行きたい」は収録が無いうえに
  // 調べることもできず、「見つかりません」で止まっていました。
  //
  // いまは二段構えです。
  //   ・日本の収録エリアに当たる → その範囲から選ぶ（従来どおり）
  //   ・当たらない → 検索を使って行き先そのものを割り出し、調べる
  // 後者は国内・国外を問いません。地名が書かれていない希望
  // （「オーロラが見たい」）も、体験できる場所を割り出して調べます。
  const discovered = [];
  const discoverFn = opts.discover ?? discoverArea;
  const resolveFn = opts.resolve ?? resolveDestination;
  const when = `${trip.departAt.getFullYear()}年${trip.departAt.getMonth() + 1}月`;
  const requested = [];   // 利用者が名指しした場所（調べがついたもの）

  async function bring(term, country) {
    // 日数に見合う量を調べます。3日の旅で4エリア×6件は多すぎ、
    // 10日の旅で1エリア×3件では埋まりません。
    const days0 = nightsOf(trip) + 1;
    const found = await discoverFn(term, {
      kb, country, when, note: trip.note, signal: opts.signal,
      areaCount: Math.max(1, Math.min(5, Math.ceil(days0 / 2))),
      spotCount: Math.max(4, Math.min(8, days0 * 2)),
    });
    if (!found.ok) {
      discovered.push({ term, ok: false, reason: found.reason });
      return false;
    }
    mergeIntoKb(kb, found);
    requested.push(term);
    discovered.push({
      term, ok: true, country: found.country ?? country,
      areas: found.regions.length, spots: found.spots.length,
      cached: found.cached, rejected: found.rejected.length,
      unverifiedPlace: found.unverifiedPlace ?? [],
      sources: found.sources ?? [],
    });
    return true;
  }

  // 名指しされた場所は、収録の有無にかかわらず調べにいきます。
  //
  // 以前は「日本のエリアが1つでも当たったら調べない」作りでした。
  // その結果、「北海道の…宗谷岬、知床、青い池を巡りたい」と書いても
  // 北海道が当たった時点で打ち切られ、宗谷岬は「収録がありません」と
  // 言われて終わっていました。当たったのは地方名で、名指しされた場所は
  // 何ひとつ調べていないのに、です。
  //
  // 呼びすぎないよう、名指しがあるときだけ割り出しを走らせます。
  // 「温泉でゆっくり」のように場所の名前が無い希望では呼びません。
  let resolved = null;
  let namedTerms = [];
  if (!opts.ignoreAreas) {
    const named = [...new Set([
      ...scope.missing.map((a) => a.term),
      ...unknownPlaceTerms(trip.note, kb),
    ])];
    namedTerms = named;
    const canAsk = hasApiKey() || opts.resolve || opts.discover;

    if (named.length && canAsk) {
      if (hasApiKey() || opts.resolve) {
        onProgress(1, `${named.slice(0, 2).join("・")}を調べています`);
        resolved = await resolveFn(trip.note, { signal: opts.signal });
      }
      const targets = resolved?.places?.length
        ? resolved.places.slice(0, 3).map((p) => [p.name, p.country])
        : named.slice(0, 2).map((t) => [t, "日本"]);
      for (const [name, country] of targets) {
        onProgress(1, `「${name}」を調べています`);
        await bring(name, country);
      }
    } else if (named.length) {
      for (const term of named.slice(0, 3)) {
        discovered.push({ term, ok: false,
          reason: "AIキーが未設定のため、収録に無い土地は調べられません" });
      }
    }
  }

  if (discovered.some((d) => d.ok)) {
    // 調べたぶんを含めて解釈し直す
    const before = scope.regionIds;
    scope = areaScope(detectAreas(trip.note, kb));
    if (!scope.regionIds) {
      // 収録の地名として解釈できない場合は、調べたエリアに絞る
      const ids = new Set(kb.regions.filter((r) => r.source === "ai")
        .map((r) => r.id));
      if (ids.size) scope = { regionIds: ids, matched: [], missing: [] };
    } else if (before) {
      // 地方名（北海道など）で絞られていた場合、調べたエリアも必ず含めます
      for (const r of kb.regions) {
        if (r.source === "ai") scope.regionIds.add(r.id);
      }
    }
    matches = searchSpotsByKeyword(kb, searchWords,
                                   { limit: 200, hiddenBias: trip.hiddenBias });
    if (!matches.length) matches = kb.spots.map((spot) => ({ spot, score: 0 }));

    // 名指しされた場所は、検索の点数ではなく「頼まれたから」上に来ます。
    const wanted = [...requested, ...(resolved?.places ?? []).map((p) => p.name)];
    const have = new Set(matches.map((m) => m.spot.id));
    for (const spot of kb.spots) {
      if (spot.source !== "ai") continue;
      const hit = wanted.some((w) => spot.name.includes(w)
        || spot.region?.includes(w));
      if (!hit) continue;
      const existing = matches.find((m) => m.spot.id === spot.id);
      if (existing) existing.score += 5;
      else if (!have.has(spot.id)) matches.push({ spot, score: 5 });
    }
  }

  const nights = nightsOf(trip);
  const days = nights + 1;

  if (scope.regionIds) {
    // 語句に一致したものだけを残すと、「四国」という語を説明文に含む
    // 数件だけが候補になり、四国7エリアのうち3エリアしか検討されません
    // でした。指定された範囲は丸ごと候補にしたうえで、語句に一致した
    // ものを上に置きます。
    //
    // そのうえで、**指定エリアだけでは日数が埋まらないなら、隣を足します。**
    // 箱根の収録は11件です。「箱根で」と書いて3泊4日にすると、
    // 4日で11か所（1日2〜3か所）にしかならず、あとは空きます。
    // 実際に行く人も、その場合は小田原や熱海まで足を延ばします。
    // 足りているときは触りません（指定を無視して広げたりはしません）。
    widenScopeForDays(scope, kb, days);
    const inArea = matches.filter((m) => scope.regionIds.has(m.spot.regionId));
    const have = new Set(inArea.map((m) => m.spot.id));
    const rest = kb.spots
      .filter((sp) => scope.regionIds.has(sp.regionId) && !have.has(sp.id))
      .map((spot) => ({ spot, score: 0 }));
    matches = [...inArea, ...rest];
  }
  // 1日に動ける時間から、その日の件数を決めます。
  //
  // ペース（ゆったり／標準／詰込）だけで決めていたときは、
  // 「毎日6時間で切り上げたい」も「朝から晩まで歩ける」も同じ件数に
  // なっていました。滞在と移動で1か所あたり約1.6時間として割ります。
  const basePerDay = SPOTS_PER_DAY[trip.pace] ?? 4;
  const dayHours = Number.isFinite(trip.dayStartHour)
      && Number.isFinite(trip.dayEndHour)
    ? trip.dayEndHour - trip.dayStartHour
    : null;
  const perDay = Number.isFinite(dayHours)
    ? Math.max(2, Math.min(basePerDay + 2, Math.round(dayHours / 1.6)))
    : basePerDay;
  // 日帰りは残り時間で決まり、泊まりは日数で決まります。
  // 「1日あたり3〜4か所」を素直に日数倍しないと、10日間の旅程が
  // 4スポットのままになります（実際にそうなっていました）。
  const maxSpots = nights === 0
    ? Math.max(3, Math.min(11, Math.round(hours / 1.8)))
    : Math.max(4, Math.min(48, days * perDay));
  const maxRegions = suggestRegionCount(days);
  const targets = mixTargets(maxSpots, trip.hiddenBias);

  // 「必ず行く」は絶対条件なので、地名の指定より優先します。
  // ただし到達できるかどうかは、他のエリアと同じように確かめます。
  // ここで検査から外すと、往復できないエリアが黙って旅程に入ります。
  const mustSpotIds = (trip.must?.spotIds ?? []).filter((id) => kb.spotsById.has(id));
  const avoidSpotIds = trip.must?.avoidSpotIds ?? [];
  const mustRegionIds = new Set(
    mustSpotIds.map((id) => kb.spotsById.get(id).regionId));

  const searchRegions = scope.regionIds
    ? kb.regions.filter((r) => scope.regionIds.has(r.id) || mustRegionIds.has(r.id))
    : kb.regions;
  const { kept: reachable, rejected: unreachable } = reachableRegions(
    searchRegions, {
      origin: trip.origin,
      endPlace: endPlace(trip) ?? trip.origin,
      totalMinutes: Math.round((trip.arriveBy - trip.departAt) / 60000),
      nights, travelFn: estimateMinutes,
    });
  if (!reachable.length) {
    const term = scope.matched.map((a) => a.term).join("・");
    const where = term ? `「${term}」の収録エリアは`
      : "指定の時間内で行ける旅先が";
    throw new PlanError(
      `${where}、この日程では${trip.origin.name}から往復できませんでした。`,
      relaxForUnreachable({ trip, rejected: unreachable, areaTerm: term }));
  }
  const reachableIds = new Set(reachable.map((r) => r.region.id));
  const inRange = matches.filter((m) => reachableIds.has(m.spot.regionId));

  // 絶対条件のエリアは、検索の点数で落とさない（到達判定は通ったもののみ）。
  // 「行ける候補が無い」の判定より前に入れます。地名の指定に合う場所が
  // 全部届かなくても、「必ず行く」が届くならその旅程は成立するからです。
  const unreachableMust = [];
  for (const rid of mustRegionIds) {
    if (!reachableIds.has(rid)) {
      unreachableMust.push(kb.regionsById.get(rid));
      continue;
    }
    if (inRange.some((m) => m.spot.regionId === rid)) continue;
    for (const sp of kb.spotsByRegion.get(rid) ?? []) {
      inRange.push({ spot: sp, score: mustSpotIds.includes(sp.id) ? 9 : 0.5 });
    }
  }

  if (!inRange.length) {
    throw new PlanError(
      "ご希望に合う場所は見つかりましたが、この時間内では往復できません"
      + `（${unreachable.length}件の旅先が時間の都合で対象外）。`,
      relaxForUnreachable({ trip, rejected: unreachable }));
  }

  const travelByRegion = new Map(
    reachable.map((r) => [r.region.id, r.oneWay + r.toEnd]));
  const candidates = rankRegions(kb, inRange, 12, {
    oneWayByRegion: travelByRegion,
    totalMinutes: Math.round((trip.arriveBy - trip.departAt) / 60000),
    wantedGenres: [...new Set([...trip.interests, ...query.interests])],
    days,
  }).slice(0, 10).map((c) => {
    const matched = new Map(c.spots.map((s) => [s.spot.id, s]));
    const all = kb.spotsByRegion.get(c.region.id) ?? [];
    const pool = [
      ...c.spots,
      ...all.filter((s) => !matched.has(s.id)).map((s) => ({ spot: s, score: 0 })),
    ];
    // モデルに見せる候補。16件では、選ぶ前から選択肢が尽きていました。
    const shown = balanceByTier(pool, Math.min(28, pool.length),
                                trip.hiddenBias);
    // 「必ず行く」は、上限からはみ出しても必ず入れます。
    //
    // ここを見落としていました。エリアの候補を28件に絞るときに、
    // 指定された場所が29番目だと、そこで消えます。以降の「必ず入れる」
    // 処理は候補集合の中しか見ないので、**指定したのに入らない**旅程が
    // できていました（鎌倉大仏を指定して鎌倉が選ばれるのに、
    // 大仏だけ入らない）。
    const have = new Set(shown.map((x) => x.spot.id));
    for (const s of pool) {
      if (mustSpotIds.includes(s.spot.id) && !have.has(s.spot.id)) {
        shown.unshift(s);
        have.add(s.spot.id);
      }
    }
    return { ...c, spots: shown };
  });

  onProgress(2);
  const planOpts = { maxRegions, days, mustSpotIds, avoidSpotIds };
  let proposal = await proposePlan(candidates, query, trip.note,
                                   maxSpots, targets, "", planOpts);

  onProgress(3, "移動時間と営業時間を照合しています");
  let checked = await verifyProposal(proposal, trip, candidates, kb,
                                     { useRoutes: false });

  let repaired = false;
  const needsRepair = (c) => !c.result.ok || c.result.underfilled;
  if (needsRepair(checked) && hasApiKey()) {
    const n = checked.result.issues.length;
    onProgress(4, n
      ? `${n}件の問題を見つけました。作り直しています`
      : "予定の空きが多いため、作り直しています");
    const second = await proposePlan(candidates, query, trip.note, maxSpots,
                                     targets, issuesToPrompt(checked.result),
                                     planOpts);
    const recheck = await verifyProposal(second, trip, candidates, kb,
                                         { useRoutes: false });
    // どちらを採るかは、点で決めます。
    //
    // 以前は「立ち寄りの多いほう」でした。その基準だと、30分の見学と
    // 90分の移動を繰り返す詰め込み案が、ゆったり回る案に勝ちます。
    // 回れる数ではなく、無理のなさで選びます。
    const best = pickBest([
      { key: "first", proposal, checked },
      { key: "second", proposal: second, checked: recheck },
    ].map((o) => ({ ...o, itin: draftItinerary(o.checked, trip, kb) })),
    { interests: trip.interests ?? [] });
    if (best?.key === "second") {
      proposal = second; checked = recheck; repaired = true;
    }
  }

  // 採用が決まってから、実際の経路を取りにいきます（ここだけが課金対象）。
  onProgress(4, "採用した案の経路を確認しています");
  const routed = await verifyProposal(proposal, trip, candidates, kb,
                                      { useRoutes: true });
  if (routed.result.visits.length) checked = routed;

  onProgress(5);
  // 使い回せるように、読み取り結果を外へ返します
  const region = kb.regionsById.get(proposal.regionId);
  const reasons = new Map(proposal.picks.map((p) => [p.spotId, p.reason]));
  const itin = buildItinerary({
    trip, kb, region, stays: checked.stays, visits: checked.result.visits,
    meals: checked.result.meals, moves: checked.result.moves,
    reasons, legs: checked.legs, legDetail: checked.legDetail,
  });
  // AIが付けた見出しだけを使います。キー未設定のときの自動見出しは
  // エリア名の羅列でしかなく、上の見出しと同じことを繰り返すだけなので。
  itin.headline = proposal.fromModel ? proposal.headline : "";
  itin.rationale = proposal.rationale;
  itin.verifyNote = buildVerifyNote(checked, repaired, proposal);

  // 7. 希望に応えられたか
  const chosenSpots = checked.result.visits.map((v) => v.spot);
  // 地名は areaNote が別に説明するので、ここでは数えません。
  // 二重に「応えられなかった」と言うことになるためです。
  const areaTerms = new Set([
    ...scope.matched.map((a) => a.term),
    ...scope.missing.map((a) => a.term),
  ]);
  const wanted = extractKeywords(trip.note).keywords
    .filter((t) => !areaTerms.has(t) && !areaTerms.has(`${t}県`));
  const coverage = analyzeCoverage(wanted, chosenSpots, kb.spots);
  itin.coverage = coverageMessage(coverage, itin.regionName,
                                  { sampleData: kb.source === "sample" });
  const discoveryNotes = [];
  const sources = [];
  for (const d of discovered) {
    if (d.ok) {
      const where = d.country && d.country !== "日本" ? `${d.country}の` : "";
      discoveryNotes.push(`${where}「${d.term}」は収録が無かったため、`
        + `AIが検索して調べた${d.areas}エリア・${d.spots}スポットを`
        + "候補に加えました。営業時間・料金・場所は未確認です。"
        + "訪問前に公式情報をご確認ください。");
      if (d.unverifiedPlace?.length) {
        discoveryNotes.push(`${d.unverifiedPlace.join("・")}については、`
          + "国の位置と突き合わせる基準を持っていないため、"
          + "座標の確からしさを確認できていません。");
      }
      for (const src of d.sources ?? []) sources.push(src);
    } else {
      discoveryNotes.push(`「${d.term}」は収録が無く、${d.reason}。`);
    }
  }
  itin.discovered = discovered;
  itin.sources = dedupeSources(sources);

  // 絶対条件が守れなかったときは、いちばん先に伝えます。
  const mustNotes = (checked.conflicts ?? []).map((c) =>
    `「必ず行く」に指定された${c.name}を旅程に入れられませんでした。${c.detail}`);
  for (const r of unreachableMust) {
    mustNotes.push(`「必ず行く」に指定された${r.name}は、この日程では`
      + `${trip.origin.name}から往復できないため外しました。`);
  }
  // 地名を書いたのに別の地方が選ばれたなら、理由を言います。
  // 絶対条件が優先された結果であって、地名を無視したのではありません。
  if (scope.regionIds && !scope.regionIds.has(itin.regionId)) {
    const pinnedHere = mustSpotIds
      .filter((id) => kb.spotsById.get(id).regionId === itin.regionId)
      .map((id) => kb.spotsById.get(id).name);
    mustNotes.push(pinnedHere.length
      ? `「${scope.matched.map((a) => a.term).join("・")}」をご指定でしたが、`
        + `「必ず行く」の${pinnedHere.join("・")}を優先して`
        + `${itin.regionName}にしました。`
      : `「${scope.matched.map((a) => a.term).join("・")}」の中には`
        + `この日程で回れるエリアが無かったため、${itin.regionName}にしました。`);
  }

  // 調べにいった地名については discoveryNotes が結果を述べています。
  // areaNote が同じ地名でもう一度「収録がありません」と言うと、
  // 同じことを二度言うことになります。
  // 割り出しが走ったなら、名指しの場所は「調べていない」わけではありません。
  // 調べたうえで日程に入らなかったものと、そもそも収録が無いものは別物です。
  const askedFor = resolved?.places?.map((p) => p.name) ?? [];
  const covered = discovered.filter((d) => d.ok).map((d) => d.term);
  const notCovered = namedTerms.filter((t) =>
    !covered.some((c) => c.includes(t) || t.includes(c))
    && !askedFor.some((a) => a.includes(t) || t.includes(a)));
  if (resolved && notCovered.length) {
    discoveryNotes.push(
      `名指しいただいた場所のうち、${covered.join("・")}を調べて旅程に入れました。`
      + `${notCovered.join("・")}は、日程に対して行き先が多くなるため`
      + "今回は入れていません。日数を延ばすか、行き先を絞ると入れられます。");
  }

  const handled = new Set([
    ...discovered.map((d) => d.term),
    // 割り出しが走った場合、名指しの語はすべて「見た」ことになります。
    // 見たうえで外したものに「収録がありません」と言うのは誤りです。
    ...(resolved ? namedTerms : []),
  ]);
  const areaNotes = areaNote(
    { ...scope, missing: scope.missing.filter((a) => !handled.has(a.term)) },
    {
      chosenRegionName: itin.regionName,
      unknownTerms: unknownPlaceTerms(trip.note, kb)
        .filter((t) => !handled.has(t)),
    });
  // 「出発地の近くに収録エリアが無い」ときだけ伝える。
  // 判断材料は、選ばれた旅先までの距離ではなく *最も近い* 収録エリアまでの
  // 片道時間です。近場があるのに遠くが選ばれたのは、希望に合ったからであって
  // 収録不足ではないので、そこで警告を出すのは誤りになります。
  const nearestOneWay = Math.min(...reachable.map((r) => r.oneWay));
  const chosenOneWay = reachable.find((r) => r.region.id === region.id)?.oneWay ?? 0;
  const farNotes = [];
  // 地名を指定されたときは、その範囲だけを見ています。範囲の外に近い
  // エリアがあっても「近くに収録が無い」とは言えないので、出しません。
  if (!scope.regionIds && nearestOneWay > 180) {
    farNotes.push(`${trip.origin.name}の近くには収録エリアがありません。`
      + `最も近い収録エリアでも片道約${Math.round(nearestOneWay / 60)}時間のため、`
      + `${region.name}（片道約${Math.round(chosenOneWay / 60)}時間）を提案しています。`
      + "近場を増やすには知識ベースの拡充が必要です。");
  }
  itin.crowd = trip.avoidCrowds === false ? null : itineraryCrowd(itin);
  itin.cost = costBreakdown(itin, { people: trip.people ?? 1 });
  itin.sun = sunNotes(itin);
  itin.critique = critique(itin);
  // 旅程の質は、プログラム側で数えて採点します。AIに自己採点させると、
  // 同じ旅程でも聞くたびに点が変わり、案どうしを比べられません。
  itin.score = scoreItinerary(itin, { interests: trip.interests ?? [] });

  // 8. 天気・日没・混雑から、見直しの提案を作ります。
  //    ここでは提案を出すだけで、旅程は変えません。押されたときだけ
  //    条件を書き換えて、同じ手順で組み直します。
  itin.replan = await buildReplan(itin, candidates, opts);
  // 9. その時期ならではのこと、荷物、旅の意味づけ。
  //    どれも数えれば決まるので、AIには書かせません
  //    （同じ旅程で毎回違う説明が出ると、説明として成立しません）。
  itin.seasonNotes = eventNotesFor(itin);
  itin.luggage = luggagePlanFor(itin);
  itin.story = storyFor(itin);

  // 3案を作るときに使い回すための持ち出し
  itin.query = query;
  itin.vector = vector;
  itin.suggestions = relaxForItinerary({ trip, checked });

  itin.warnings = [
    ...mustNotes,
    ...discoveryNotes,
    ...areaNotes,
    ...farNotes,
    ...seasonalNotes(chosenSpots, trip.departAt),
    ...itin.warnings,
  ];

  return itin;
}

async function verifyProposal(proposal, trip, candidates, kb, opts = {}) {
  // 案を選ぶ段階では、経路APIを呼びません。
  //
  // 以前は1回目の案と作り直した案の両方で経路を取りに行っていました。
  // 1回の旅程作成で 3リクエストのはずが 6 になり、しかも捨てるほうの案の
  // ぶんは完全に無駄です。順序や取捨は距離からの推定で足りるので、
  // 実際の経路は「採用した案」に対してだけ取りにいきます。
  const useRoutes = opts.useRoutes !== false;
  const nights = nightsOf(trip);
  const days = nights + 1;
  const end = dayEnd(trip, nights).place ?? endPlace(trip) ?? trip.origin;

  // AI が選んだエリアを、地理的に無理のない順に並べ、日数を割り振る。
  const chosen = (proposal.regionIds ?? [proposal.regionId])
    .map((id) => candidates.find((c) => c.region.id === id))
    .filter(Boolean);
  if (!chosen.length) chosen.push(candidates[0]);
  const { stays, baseByDay } = planStays(chosen, {
    days, origin: trip.origin, end, pace: trip.pace,
  });

  // 立ち寄りを滞在の順に並べ替える（同じエリアのぶんは続けて回る）
  const byRegion = new Map(stays.map((s) => [s.region.id, []]));
  for (const p of proposal.picks) {
    const spot = kb.spotsById.get(p.spotId);
    if (!spot) continue;
    byRegion.get(spot.regionId)?.push(spot);
  }
  let spots = stays.flatMap((s) => byRegion.get(s.region.id) ?? []);
  // 「このスポットは何日目以降に回る」を滞在計画から決めておく。
  //
  // 滞在の初日にまとめて詰め込むと、3日いるエリアで「1日目に4か所、
  // 2日目に1か所、3日目は何も無し」という旅程になります（実際そうでした）。
  // 滞在日数で割って、均した日を下限として与えます。上限ではないので、
  // 前が押していれば後ろにずれるだけです。
  const dayFloorById = new Map();
  for (const s of stays) {
    const list = byRegion.get(s.region.id) ?? [];
    const n = list.length || 1;
    list.forEach((sp, k) => {
      dayFloorById.set(sp.id, s.dayFrom + Math.floor((k * s.days) / n));
    });
  }

  const first = stays[0].station;
  const localPoints = [first, ...spots, end];
  const stationPoints = stays.length > 1
    ? [...stays.map((s) => s.station), end] : null;

  let outRoute = null;
  let localRoute = null;
  let stationRoute = null;
  let travelFn = estimateMinutes;
  let legDetail = () => null;
  let outbound = { minutes: estimateMinutes(trip.origin, first),
                   routed: false, line: null };

  if (useRoutes) {
    outRoute = await computeRoute([trip.origin, first],
      { departAt: trip.departAt, mode: "TRANSIT" });
    outbound = outRoute.legs[0];

    // 拠点どうしの移動を先に取ります。
    // 経路検索の回数には上限があるので、長い区間（＝取り違えると
    // その日がまるごと崩れる区間）から先に使い切ります。
    const entries = [];
    if (stationPoints) {
      // 出発時刻を送らないと「いまこの瞬間」で調べられます。夜に作れば
      // 終電後として扱われ、拠点の移動だけが推定に落ちていました。
      // 拠点を移すのは午前中が普通なので、旅の初日の10時で見ます
      // （何日目に移るかは区間ごとに違うので、ここは一本の目安です）。
      const moveAt = new Date(trip.departAt);
      moveAt.setHours(10, 0, 0, 0);
      stationRoute = await computeRoute(stationPoints,
        { mode: "TRANSIT", departAt: moveAt });
      entries.push([stationPoints, stationRoute.legs]);
    }

    // エリア内の経路
    localRoute = await computeRoute(localPoints, {
      mode: pickMode(localPoints),
      departAt: new Date(trip.departAt.getTime() + outbound.minutes * 60000),
    });
    entries.unshift([localPoints, localRoute.legs]);
    travelFn = legLookupAll(entries);
    legDetail = legDetailLookup(entries);
  }

  // その日の並び順を決めます。
  //
  // **まず道順、そのあとで混雑**です。混雑だけで並べていたときは、
  // 上高地の河童橋 → 市街の松本城 → また上高地の大正池、という旅程が
  // 出ていました（松本城がいちばん混むので朝いちに引き上げられる）。
  //
  // 混雑を避ける設定を切っていても、道順は整えます。順番がでたらめな
  // 旅程に意味はありません。
  spots = spreadCrowds(spots, {
    dayFloorById,
    start: first,
    travelFn,
    // 早く閉まる場所と「必ず行く」場所は、先に回さないと間に合いません。
    pinnedIds: trip.must?.spotIds ?? [],
    useCrowd: trip.avoidCrowds !== false,
  });

  const ctx = {
    start: first,
    startAt: new Date(trip.departAt.getTime() + outbound.minutes * 60000),
    end, endBy: trip.arriveBy, pace: trip.pace, travelFn,
    nights, baseByDay, dayFloorById, day0: trip.departAt,
    // 選んでもらった時間帯を、そのまま2日目以降の枠にします。
    // 渡さないと TUNING の 9:00〜18:30 に固定されたままです。
    dayStartHour: trip.dayStartHour,
    dayEndHour: trip.dayEndHour,
    pinnedIds: trip.must?.spotIds ?? [],
  };
  const trimmed = trimToFit(spots, ctx);
  const inbound = localRoute?.legs.at(-1) ?? outbound;
  const routeError = outRoute?.error ?? localRoute?.error ?? stationRoute?.error;
  return {
    result: trimmed.result, dropped: trimmed.dropped,
    conflicts: trimmed.conflicts ?? [], stays,
    legs: { outbound, inbound, local: localRoute, routeError,
            modeNote: localRoute?.modeNote, routed: useRoutes },
    legDetail,
  };
}

/**
 * 採点のためだけに、旅程をいったん組み立てます。
 *
 * buildItinerary は外に触らない純粋な処理なので、案を比べるために
 * 何度呼んでも費用はかかりません。点を出すには時刻の入った旅程が
 * 要るので、比べる前に一度組みます。
 */
function draftItinerary(checked, trip, kb) {
  try {
    return buildItinerary({
      trip, kb,
      region: kb.regionsById.get(checked.stays?.[0]?.region?.id),
      stays: checked.stays, visits: checked.result.visits,
      meals: checked.result.meals, moves: checked.result.moves,
      reasons: new Map(), legs: checked.legs,
    });
  } catch {
    // 組めない案は、比べる土俵に乗りません
    return { days: [] };
  }
}

/**
 * 天気・日没・混雑から、見直しの提案を作ります。
 *
 * 天気は取れないことがあります（オフライン、予報の効かない先の日付）。
 * 取れなくても旅程は成立するので、失敗はそのまま「分かりません」として
 * 画面に出すだけにします。
 */
async function buildReplan(itin, candidates, opts = {}) {
  if (opts.useWeather === false) return { suggestions: [], notes: [] };

  const getForecast = opts.forecast ?? forecastFor;
  const weather = {};
  const sunset = {};
  const daySummaries = [];

  for (const [di, day] of (itin.days ?? []).entries()) {
    const first = (day.items ?? []).find((i) => i.kind === "spot" && i.place);
    const at = first?.place;
    if (!at) continue;

    // 日没は計算で出ます（通信も課金もありません）
    const t = sunTimes(day.date, at.lat, at.lng);
    if (t.sunset) sunset[di] = t.sunset;

    try {
      const f = await getForecast(at, day.date, { signal: opts.signal });
      weather[di] = f;
      if (f.ok) daySummaries.push(`${di + 1}日目: ${summarizeDay(f)}`);
    } catch {
      // 天気が取れないことは、旅程の失敗ではありません
    }
  }

  // 差し替え候補は、選定に使った候補集合から取ります。
  // ここに無い場所を持ち出すと、旅程と関係のない土地が混ざります。
  const pool = (candidates ?? []).flatMap((c) => c.spots.map((x) => x.spot));
  const out = suggestReplan(itin, { weather, sunset, candidates: pool });
  out.days = daySummaries;
  return out;
}

function buildVerifyNote(checked, repaired, proposal) {
  const parts = [];
  if (proposal.fromModel) {
    const m = resolvedModel();
    parts.push(m ? `${m} が案を作成` : "AIが案を作成");
  } else {
    parts.push("検索結果から案を作成");
  }
  const dropped = checked.dropped?.length ?? 0;
  if (dropped) {
    parts.push(repaired ? `時間が合わない${dropped}件を差し替え`
                        : `時間が合わない${dropped}件を除外`);
  } else if (checked.result.ok) {
    parts.push("全スポットが時間内に収まることを確認");
  } else {
    parts.push("時間の制約が厳しく、立ち寄りを絞り込み");
  }
  parts.push(checked.legs.local?.routed
    ? "移動時間はGoogleマップの経路検索"
    : "移動時間は距離からの推定");
  const u = checked.result.underfilled;
  if (u) {
    parts.push(`${u.totalDays}日のうち${u.plannedDays}日ぶんしか予定を埋められず`
      + "（収録スポットが足りません）");
  } else if (checked.result.slackMin > 0) {
    const m = checked.result.slackMin;
    parts.push(m >= 120
      ? `終点まで約${Math.floor(m / 60)}時間${m % 60 ? `${m % 60}分` : ""}の余裕`
      : `終点まで約${m}分の余裕`);
  }
  if (checked.stays?.length > 1) {
    parts.push(`${checked.stays.map((s) => `${s.region.name}${s.days}日`).join("→")}`
      + "で拠点を移動");
  }
  return parts.join("、") + "。";
}


/**
 * 旅程を組めなかったときのエラー。
 * 「できません」だけでなく「どうすればできます」を持ち歩きます。
 */
export class PlanError extends Error {
  constructor(message, suggestions = []) {
    super(message);
    this.name = "PlanError";
    this.suggestions = suggestions;
  }
}

/** 出典の重複を落とします（同じ記事が何度も返ることがあります）。 */
/** その日数を埋めるのに要る、おおよその立ち寄り件数。 */
export function spotsNeededFor(days) {
  return Math.max(3, days * 4);
}

/**
 * 指定エリアだけでは日数を埋められないとき、近いエリアを足します。
 *
 * 箱根の収録は11件です。「箱根で」と書いて3泊4日にすると、4日で11か所
 * （1日2〜3か所）にしかなりません。実際に行く人も、その場合は小田原や
 * 熱海まで足を延ばします。指定を無視するのではなく、**足りないぶんだけ**
 * 隣を足します。足りているときは何もしません。
 *
 * 近さは、指定エリアの中心からの直線距離で見ます。遠いエリアを足すと
 * 「箱根と言ったのに京都が入る」ことになるので、上限を置きます。
 *
 * @param {{regionIds:Set<string>}} scope その場で書き換えます
 * @param {number} days
 * @returns {string[]} 足したエリア名
 */
export function widenScopeForDays(scope, kb, days, maxKm = 60) {
  if (!scope.regionIds?.size) return [];
  const need = spotsNeededFor(days);
  const have = [...scope.regionIds]
    .reduce((n, id) => n + (kb.spotsByRegion.get(id)?.length ?? 0), 0);
  if (have >= need) return [];

  const anchors = [...scope.regionIds]
    .map((id) => kb.regionsById.get(id)).filter(Boolean);
  if (!anchors.length) return [];

  const near = [];
  for (const r of kb.regions) {
    if (scope.regionIds.has(r.id)) continue;
    const km = Math.min(...anchors.map((a) => haversineKm(a, r)));
    if (km <= maxKm) near.push({ region: r, km });
  }
  near.sort((a, b) => a.km - b.km);

  const added = [];
  let total = have;
  for (const { region } of near) {
    if (total >= need) break;
    scope.regionIds.add(region.id);
    total += kb.spotsByRegion.get(region.id)?.length ?? 0;
    added.push(region.name);
  }
  return added;
}

function dedupeSources(list) {
  const seen = new Set();
  const out = [];
  for (const s of list) {
    if (!s?.url || seen.has(s.url)) continue;
    seen.add(s.url);
    out.push(s);
  }
  return out.slice(0, 8);
}
