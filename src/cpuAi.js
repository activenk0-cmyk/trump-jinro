// src/cpuAi.js
// トランプ人狼 CPU思考エンジン（純粋な判断ロジックのみ。Firestoreやこの画面には一切触れない）
//
// ⚠ 最重要ルール：この中では st.wolf を絶対に参照しない。
//   人間プレイヤーと同じ「公開情報」だけから人狼を推理する。

const MARKS = ["♠", "♥", "♣", "♦"];
const NUMBERS = [1, 2, 3, 4];

function opponentOf(s) { return s === "A" ? "B" : "A"; }

// ---- ① 人狼候補の推理エンジン ----
// 自分の初期ヒント・自分の占い師履歴・両者が場に出した安全な市民カードから、
// まだ否定されていない（マーク, 数字）の組み合わせ一覧を返す。
export function computeCandidates(st, slot) {
  let candidates = [];
  MARKS.forEach((m) => NUMBERS.forEach((n) => candidates.push({ mark: m, number: n })));

  const clue = st.clues?.[slot];
  if (clue) {
    if (clue.mode === "confirmed") candidates = candidates.filter((c) => c[clue.attr] === clue.value);
    else if (clue.mode === "exclude") candidates = candidates.filter((c) => c[clue.attr] !== clue.value);
  }

  const seerAttr = slot === "A" ? "number" : "mark";
  (st.seerHistory?.[slot] || []).forEach((v) => { candidates = candidates.filter((c) => c[seerAttr] !== v); });

  ["A", "B"].forEach((s) => {
    (st.table?.[s] || []).forEach((c) => {
      if (c.type === "citizen") candidates = candidates.filter((x) => !(x.mark === c.mark && x.number === c.number));
    });
  });

  return candidates;
}

// ---- ② 疑わしさスコア（相手の動きを見た心理読み） ----
// 相手が「強制されておらず」「レースに追われていない」状況で任意に出したカードは、
// 相手の得意属性側について少しだけ「安全寄り」に補正する。あくまで補助的な重み。
function buildSuspicionMap(st, slot) {
  const scores = {};
  MARKS.forEach((m) => (scores["mark:" + m] = 1));
  NUMBERS.forEach((n) => (scores["number:" + n] = 1));

  const oppAttr = slot === "A" ? "number" : "mark"; // 相手が元々ヒントを持つ属性を観察材料にする
  const winCount = st.settings?.winCount || 6;

  (st.playHistory || []).forEach((h) => {
    if (h.type !== "citizen") return;
    if (h.actor === slot) return; // 相手の行動だけを観察対象にする
    if (h.wasConstrained) return; // 強制されたプレイはノイズなので無視
    // このプレイをした時点で、相手自身が追い込まれていた（＝賭けだった）形跡が強い場合は無視
    const actorWasPressured = h.oppEscapeCountAfter >= winCount - 2;
    if (actorWasPressured) return;
    const val = oppAttr === "mark" ? h.mark : h.number;
    const key = oppAttr + ":" + val;
    if (scores[key] !== undefined) scores[key] *= 0.7;
  });

  return scores;
}
function cardSuspicion(card, scores) {
  return (scores["mark:" + card.mark] || 1) * (scores["number:" + card.number] || 1);
}
function leastRiskyCitizen(citizens, scores) {
  return citizens.slice().sort((a, b) => cardSuspicion(a, scores) - cardSuspicion(b, scores))[0];
}

// ---- ③ アグロジョーカー判定 ----
function computeAggroState(st, slot) {
  const hand = st.hands?.[slot] || [];
  const hasJoker = hand.some((c) => c.type === "joker");
  if (!hasJoker) return false;

  const isSecond = st.firstPlayer !== slot;
  const hasSeenJ =
    hand.some((c) => c.type === "role" && c.role === "J") ||
    (st.playHistory || []).some((h) => h.actor === slot && h.roleType === "J");

  // 後攻でJをまだ引けていない時点で、最初からアグロ濃度MAXで突入
  if (isSecond && !hasSeenJ) return true;

  // 一度アグロに入った/入りうる状況でも、コストがジョーカーコストに迫っていれば続行
  const meta = st.playerMeta?.[slot];
  const cost = (st.costPool?.[slot] || 0) + (meta?.virtualCostUnused ? 1 : 0);
  const jokerCost = st.settings?.jokerCost || 4;
  if (cost >= jokerCost - 1) return true;

  return false;
}

// 相手がアグロジョーカーを仕掛けてきそうかを検知（防御側の判断材料）
function detectOpponentAggro(st, slot) {
  const opp = opponentOf(slot);
  const oppMeta = st.playerMeta?.[opp];
  const oppUsedJ = (st.playHistory || []).some((h) => h.actor === opp && h.roleType === "J");
  const oppCost = (st.costPool?.[opp] || 0) + (oppMeta?.virtualCostUnused ? 1 : 0);
  const jokerCost = st.settings?.jokerCost || 4;
  return !oppUsedJ && oppCost >= jokerCost - 1;
}

function pickGuess(candidates) {
  if (candidates.length === 0) {
    return { mark: MARKS[Math.floor(Math.random() * MARKS.length)], number: NUMBERS[Math.floor(Math.random() * NUMBERS.length)] };
  }
  return candidates[Math.floor(Math.random() * candidates.length)];
}
function buildQTarget(st, slot, scores) {
  const oppAttr = slot === "A" ? "number" : "mark";
  const values = oppAttr === "mark" ? MARKS : NUMBERS;
  let best = values[0], bestScore = -1;
  values.forEach((v) => { const s = scores[oppAttr + ":" + v] ?? 1; if (s > bestScore) { bestScore = s; best = v; } });
  return { attr: oppAttr, value: best };
}
function buildRoleOpt(card, st, slot, scores) {
  if (card.type === "role" && card.role === "Q") return buildQTarget(st, slot, scores);
  return {};
}

// ---- ④ メイン：CPUの1手を決定する ----
// 戻り値の kind: "draw" | "mulligan" | "citizen" | "role" | "accuse" | "facedownBlock"
export function decideCpuAction(st, slot) {
  const opp = opponentOf(slot);
  const hand = st.hands[slot];
  const meta = st.playerMeta[slot];

  if (st.phase === "needDraw") {
    const forcedMulliganOk =
      st.firstPlayer === slot && !meta.mulliganUsed && !meta.hasDrawnYet &&
      hand.filter((c) => c.type === "citizen").length === 0;
    return forcedMulliganOk ? { kind: "mulligan" } : { kind: "draw" };
  }

  const constraint = st.constraints[slot];
  const candidates = computeCandidates(st, slot);
  const scores = buildSuspicionMap(st, slot);
  const winCount = st.settings.winCount;
  const jokerCost = st.settings.jokerCost;
  const myEscape = st.table[slot].filter((c) => c.type === "citizen").length;
  const oppEscape = st.table[opp].filter((c) => c.type === "citizen").length;
  const myCost = (st.costPool[slot] || 0) + (meta.virtualCostUnused ? 1 : 0);

  // 制約：告発を強制されている（ジョーカーを撃たれた）
  if (constraint?.type === "forceAccuse") {
    const g = pickGuess(candidates);
    return { kind: "accuse", mark: g.mark, number: g.number };
  }

  const allCitizens = hand.filter((c) => c.type === "citizen");
  let citizensInHand = allCitizens;
  const forceAttrHasMatch =
    constraint?.type === "forceAttribute" &&
    allCitizens.some((c) => (constraint.attr === "mark" ? c.mark === constraint.value : c.number === constraint.value));
  if (forceAttrHasMatch) {
    citizensInHand = allCitizens.filter((c) => (constraint.attr === "mark" ? c.mark === constraint.value : c.number === constraint.value));
  }
  const mustPlayCitizen = forceAttrHasMatch || (constraint?.type === "blockRoles" && allCitizens.length > 0);
  const forcedFacedownBlock = constraint?.type === "blockRoles" && allCitizens.length === 0;
  const canAccuseNow = !mustPlayCitizen;

  const safeInHand = citizensInHand.filter((c) => !candidates.some((x) => x.mark === c.mark && x.number === c.number));

  // ① このターンで脱出達成できるなら最優先で実行
  if (safeInHand.length > 0 && myEscape + 1 >= winCount) {
    return { kind: "citizen", cardId: leastRiskyCitizen(safeInHand, scores).id };
  }

  // ② CRITICAL：相手があと1枚で上がりそうなら告発を強行（何もしなければ次で確実に負けるため）
  if (canAccuseNow && oppEscape >= winCount - 1 && candidates.length > 0) {
    const g = pickGuess(candidates);
    return { kind: "accuse", mark: g.mark, number: g.number };
  }

  // ③ 候補が1つに絞れているなら告発（確信度による自主告発はしない。特定できた時だけ）
  if (canAccuseNow && candidates.length === 1) {
    return { kind: "accuse", mark: candidates[0].mark, number: candidates[0].number };
  }

  // 縛りで市民カード必須ならここで確定
  if (mustPlayCitizen) {
    const card = safeInHand.length > 0 ? leastRiskyCitizen(safeInHand, scores) : leastRiskyCitizen(citizensInHand, scores);
    return { kind: "citizen", cardId: card.id };
  }
  if (forcedFacedownBlock) {
    const anyRole = hand.find((c) => c.type === "role" || c.type === "joker");
    if (anyRole) return { kind: "role", cardId: anyRole.id, opt: { forceFacedownByBlock: true } };
  }

  const hasJ = hand.find((c) => c.type === "role" && c.role === "J");
  const hasQ = hand.find((c) => c.type === "role" && c.role === "Q");
  const hasK = hand.find((c) => c.type === "role" && c.role === "K");
  const hasJoker = hand.find((c) => c.type === "joker");
  const aggro = computeAggroState(st, slot);

  // ④ 相手のアグロジョーカーを警戒し、温存していたKを差すタイミング
  if (!aggro && hasK && myCost >= 1 && detectOpponentAggro(st, slot)) {
    return { kind: "role", cardId: hasK.id, opt: {} };
  }

  if (aggro) {
    if (hasJoker && myCost >= jokerCost) return { kind: "role", cardId: hasJoker.id, opt: {} };
    if (citizensInHand.length > 0) {
      const card = safeInHand.length > 0 ? leastRiskyCitizen(safeInHand, scores) : leastRiskyCitizen(citizensInHand, scores);
      return { kind: "citizen", cardId: card.id };
    }
    if (hasK && myCost >= 1) return { kind: "role", cardId: hasK.id, opt: {} };
  } else {
    // ⑤ 情報収集（占い師）を最優先。安全札があっても温存する
    if (hasJ && myCost >= 1) return { kind: "role", cardId: hasJ.id, opt: {} };
    // ⑥ 安全な市民カードがあれば脱出優先
    if (safeInHand.length > 0) return { kind: "citizen", cardId: leastRiskyCitizen(safeInHand, scores).id };
    // ⑦ 怪盗／騎士で牽制
    if (hasQ && myCost >= 1) return { kind: "role", cardId: hasQ.id, opt: buildQTarget(st, slot, scores) };
    if (hasK && myCost >= 1) return { kind: "role", cardId: hasK.id, opt: {} };
    // ⑧ 通常の一手としてジョーカー
    if (hasJoker && myCost >= jokerCost) return { kind: "role", cardId: hasJoker.id, opt: {} };
  }

  // ⑨ どうしようもなければ一番疑わしさが低い市民カードを賭ける
  if (citizensInHand.length > 0) {
    return { kind: "citizen", cardId: leastRiskyCitizen(citizensInHand, scores).id };
  }

  // 市民カードが手札に無い＝役職カードしかない
  const anyRole = hand.find((c) => c.type === "role" || c.type === "joker");
  if (anyRole) {
    const cost = anyRole.type === "joker" ? jokerCost : 1;
    if (myCost >= cost) return { kind: "role", cardId: anyRole.id, opt: buildRoleOpt(anyRole, st, slot, scores) };
    return { kind: "role", cardId: anyRole.id, opt: { emergencySet: true } };
  }

  return { kind: "draw" }; // 理論上ここには到達しないはずの保険
}
