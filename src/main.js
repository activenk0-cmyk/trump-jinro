import "./style.css";
import { db } from "./firebase.js";
import { doc, getDoc, runTransaction, onSnapshot } from "firebase/firestore";

// ============================================================
// スプライト（6列5行）
// ============================================================
const MARKS = ["♠", "♥", "♣", "♦"];
const NUMBERS = [1, 2, 3, 4];
const RED_MARKS = ["♥", "♦"];
const WIN_COUNT_OPTIONS = [3, 4, 5, 6, 7];
const JOKER_COST_OPTIONS = [1, 2, 3, 4];
const SESSION_KEY = "trump_jinro_session";

const SPRITE_SUIT_ORDER = ["♣", "♦", "♥", "♠"];
const SPRITE_RANK_ORDER = ["1", "2", "3", "4", "J", "Q", "K"];
const SPRITE_COLS = 6;
const SPRITE_ROWS = 5;

// 横：均等（0,20,40,60,80,100%）
// 縦：均等割だと中央行が下にズレる報告のため各行を個別補正。値を小さくすると上へ。
const SPRITE_ROW_Y = [-0.6, 26.5, 53.2, 76.4, 100]; // %

function getSpriteIndex(card) {
  if (card.type === "joker") return 28 + (Number(card.id) % 2 === 0 ? 0 : 1);
  const suitIdx = SPRITE_SUIT_ORDER.indexOf(card.mark);
  const rankKey = card.type === "citizen" ? String(card.number) : card.role;
  const rankIdx = SPRITE_RANK_ORDER.indexOf(rankKey);
  if (suitIdx === -1 || rankIdx === -1) return null;
  return suitIdx * 7 + rankIdx;
}

// 通常表示（background-size: 600% 500% に対するパーセント位置）
function spritePosition(index) {
  const col = index % SPRITE_COLS;
  const row = Math.floor(index / SPRITE_COLS);
  const x = (col / (SPRITE_COLS - 1)) * 100;
  const y = SPRITE_ROW_Y[row] ?? 0;
  return `${x}% ${y}%`;
}

// 場用（左上70%クロップ = background-size: 857% 714% に対するパーセント位置）
// 拡大率 k = 1/0.7。X方向のセル数は実質 6/k、位置百分率は col/(6/k - 1) 相当だが、
// 「左上を左上に合わせる」ため、拡大後の座標系での各セル左端割合を算出する。
function spritePositionField(index) {
  const col = index % SPRITE_COLS;
  const row = Math.floor(index / SPRITE_COLS);
  const k = 1 / 0.52; // ≒1.4286
  // 拡大後の背景幅 = 元幅 * k。1セルの左端割合(元) = col/(cols) 。
  // background-position% = セル左端割合 / (1 - 表示幅割合) 。表示幅割合 = 1/(cols*k)
  const cellLeftFracX = col / SPRITE_COLS;             // 元シートでのセル左端(0〜1)
  const viewFracX = 1 / (SPRITE_COLS * k);             // 表示窓の幅割合
  const posX = (cellLeftFracX / (1 - viewFracX)) * 100;
  // Y方向は行補正値を使い、同様に左上寄せ
  const cellTopFracY = (SPRITE_ROW_Y[row] ?? 0) / 100 * ((SPRITE_ROWS - 1) / SPRITE_ROWS); // 補正込みの上端割合近似
  const viewFracY = 1 / (SPRITE_ROWS * k);
  const posY = (cellTopFracY / (1 - viewFracY)) * 100;
  return `${posX}% ${posY}%`;
}

class GameActionError extends Error { constructor(m, p) { super(m); this.payload = p || {}; } }
function opponent(s) { return s === "A" ? "B" : "A"; }
function addLog(st, t) { if (!st.log) st.log = []; st.log.push(t); if (st.log.length > 50) st.log = st.log.slice(-50); }
function setLastAction(st, actorSlot, description, cardKey, isRole) {
  if (typeof st.turnSeq !== "number") st.turnSeq = 0;
  st.turnSeq += 1;
  st.lastAction = { actorSlot, description, seq: st.turnSeq, cardKey: cardKey || null, isRole: !!isRole };
}
function buildDeck() {
  const d = []; let id = 0;
  MARKS.forEach((mk) => { NUMBERS.forEach((n) => d.push({ id: String(id++), type: "citizen", mark: mk, number: n })); });
  MARKS.forEach((mk) => { ["J", "Q", "K"].forEach((r) => d.push({ id: String(id++), type: "role", role: r, mark: mk })); });
  d.push({ id: String(id++), type: "joker" }); d.push({ id: String(id++), type: "joker" });
  return d;
}
function shuffleArr(a) { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; }
function countCitizens(h) { return h.filter((c) => c.type === "citizen").length; }
function cardLabel(c) { if (c.type === "citizen") return c.mark + c.number; if (c.type === "role") return c.role + "(" + c.mark + ")"; if (c.type === "joker") return "ジョーカー"; return "?"; }
function createDefaultRoomState() { return { status: "waiting", players: { A: false, B: false }, settings: { infoType: "除外", winCount: 6, jokerCost: 4 }, log: [] }; }
function validateTurnAction(st, s, ph) {
  if (st.status !== "playing") throw new GameActionError("ゲームは進行中ではありません。");
  if (st.currentTurn !== s) throw new GameActionError("あなたのターンではありません。");
  if (st.phase !== ph) throw new GameActionError("今はその操作を行えるタイミングではありません。");
}
function finishTurn(st, s) { st.constraints[s] = null; st.currentTurn = opponent(s); st.phase = "needDraw"; }
function endGame(st, w, r) { st.status = "ended"; st.winner = w; st.reason = r; addLog(st, "🎉 ゲーム終了：プレイヤー" + w + "の勝利（" + r + "）"); }

function reduceJoin(st, s) {
  if (st.status === "waiting") { if (!st.players[s]) { st.players[s] = true; addLog(st, "プレイヤー" + s + "が入室しました。"); } }
  else if (!st.players[s]) throw new GameActionError("このルームは既にゲームが開始されているため、新規参加できません。");
  return st;
}
function reduceUpdateSettings(st, s, it, wc, jc) {
  if (st.status !== "waiting") throw new GameActionError("ゲーム開始後は設定を変更できません。");
  st.settings = { infoType: it, winCount: Number(wc), jokerCost: Number(jc) };
  addLog(st, `設定が更新されました（初期情報:${it} / 勝利枚数:${wc} / ジョーカーコスト:${jc}）`);
  return st;
}
function reduceStartGame(st) {
  if (st.status !== "waiting") throw new GameActionError("既にゲームが開始されています。");
  if (!st.players.A || !st.players.B) throw new GameActionError("両方のプレイヤーの入室を待っています。");
  const deck = shuffleArr(buildDeck());
  const handA = deck.splice(0, 3), handB = deck.splice(0, 3);
  const wolfMark = MARKS[Math.floor(Math.random() * MARKS.length)];
  const wolfNumber = NUMBERS[Math.floor(Math.random() * NUMBERS.length)];
  let infoA, infoB;
  if (st.settings.infoType === "確定") { infoA = `人狼のマークは「${wolfMark}」です。`; infoB = `人狼の数字は「${wolfNumber}」です。`; }
  else {
    const om = MARKS.filter((m) => m !== wolfMark), on = NUMBERS.filter((n) => n !== wolfNumber);
    const exM = om[Math.floor(Math.random() * om.length)], exN = on[Math.floor(Math.random() * on.length)];
    infoA = `人狼のマークは「${exM}」ではありません。`; infoB = `人狼の数字は「${exN}」ではありません。`;
  }
  const fp = Math.random() < 0.5 ? "A" : "B", sp = fp === "A" ? "B" : "A";
  st.status = "playing"; st.wolf = { mark: wolfMark, number: wolfNumber };
  st.hands = { A: handA, B: handB }; st.drawPile = deck; st.table = { A: [], B: [] }; st.discard = [];
  st.info = { A: infoA, B: infoB }; st.seerHistory = { A: [], B: [] }; st.seerRevealLog = { A: [], B: [] }; st.roleDiscard = { A: [], B: [] };
  st.constraints = { A: null, B: null }; st.firstPlayer = fp; st.costPool = { A: 0, B: 0 }; st.turnSeq = 0; st.lastAction = null;
  st.playerMeta = { A: { virtualCostUnused: sp === "A", mulliganUsed: false, hasDrawnYet: false }, B: { virtualCostUnused: sp === "B", mulliganUsed: false, hasDrawnYet: false } };
  st.currentTurn = fp; st.phase = "needDraw"; st.winner = null; st.reason = null;
  addLog(st, "ゲームを開始しました。先攻：プレイヤー" + fp);
  return st;
}
function reduceResetRoom(st) { const ns = { status: "waiting", players: st.players, settings: st.settings, log: st.log || [] }; addLog(ns, "同じルームで新しいゲームの準備を始めました。"); return ns; }
function reduceDraw(st, s) {
  validateTurnAction(st, s, "needDraw");
  if (st.drawPile.length > 0) st.hands[s].push(st.drawPile.pop()); else addLog(st, "山札が尽きているため、" + s + "は引けませんでした。");
  st.playerMeta[s].hasDrawnYet = true; st.phase = "needAction"; return st;
}
function checkConstraintForCitizenPlay(st, s, card) {
  const c = st.constraints[s]; if (!c) return;
  if (c.type === "forceAccuse") throw new GameActionError("前のターンの効果により、今回は告発しか行えません。");
  if (c.type === "forceAttribute") {
    const q = st.hands[s].filter((x) => x.type === "citizen" && (c.attr === "mark" ? x.mark === c.value : x.number === c.value));
    if (q.length > 0) { const m = c.attr === "mark" ? card.mark === c.value : card.number === c.value; if (!m) throw new GameActionError(`前のターンの効果により、「${c.value}」の付いた市民カードを出す必要があります。`); }
  }
}
function reducePlayCitizen(st, s, cardId) {
  validateTurnAction(st, s, "needAction");
  const hand = st.hands[s]; const idx = hand.findIndex((c) => c.id === cardId);
  if (idx === -1) throw new GameActionError("指定されたカードが手札にありません。");
  const card = hand[idx]; if (card.type !== "citizen") throw new GameActionError("市民カードではありません。");
  checkConstraintForCitizenPlay(st, s, card);
  hand.splice(idx, 1);
  const isWolf = card.mark === st.wolf.mark && card.number === st.wolf.number;
  st.table[s].push(card);
  if (isWolf) { addLog(st, `${s}が${card.mark}${card.number}を出し、人狼でした。`); endGame(st, opponent(s), "人狼死"); }
  else {
    addLog(st, `${s}が${card.mark}${card.number}を出しました（セーフ）。`);
    st.costPool[s] = (st.costPool[s] || 0) + 1;
    const esc = st.table[s].filter((c) => c.type === "citizen").length;
    if (esc >= st.settings.winCount) endGame(st, s, "市民脱出");
  }
  if (st.status === "playing") { setLastAction(st, s, card.mark + card.number, "c_" + card.mark + card.number, false); finishTurn(st, s); }
  return st;
}
function computeSeerResult(st, s) {
  const w = st.wolf;
  if (s === "A") { const h = st.seerHistory.A; const cs = NUMBERS.filter((n) => n !== w.number && !h.includes(n)); if (cs.length === 0) throw new GameActionError("これ以上、開示できる安全な数字がありません。"); const v = cs[Math.floor(Math.random() * cs.length)]; return { value: v, text: `安全な数字は「${v}」です。` }; }
  else { const h = st.seerHistory.B; const cs = MARKS.filter((m) => m !== w.mark && !h.includes(m)); if (cs.length === 0) throw new GameActionError("これ以上、開示できる安全なマークがありません。"); const v = cs[Math.floor(Math.random() * cs.length)]; return { value: v, text: `安全なマークは「${v}」です。` }; }
}
function reducePlayRole(st, s, cardId, opt = {}) {
  validateTurnAction(st, s, "needAction");
  const hand = st.hands[s]; const idx = hand.findIndex((c) => c.id === cardId);
  if (idx === -1) throw new GameActionError("指定されたカードが手札にありません。");
  const card = hand[idx]; if (card.type !== "role" && card.type !== "joker") throw new GameActionError("役職カードではありません。");
  const c = st.constraints[s];
  if (c) {
    if (c.type === "forceAccuse") throw new GameActionError("前のターンの効果により、今回は告発しか行えません。");
    if (c.type === "forceAttribute") { const q = hand.filter((x) => x.type === "citizen" && (c.attr === "mark" ? x.mark === c.value : x.number === c.value)); if (q.length > 0) throw new GameActionError(`前のターンの効果により、市民カード（「${c.value}」の付いたもの）を出す必要があります。`); }
    if (c.type === "blockRoles") {
      const hasC = countCitizens(hand) > 0;
      if (hasC) throw new GameActionError("前のターンの効果により、役職カードは出せません。市民カードを出してください。");
      if (!opt.forceFacedownByBlock) throw new GameActionError("騎士の効果：手札に市民カードが無いため、この役職カードは効果を発動できません。裏向きで場に出します。", { kForcedFacedownAvailable: true });
      hand.splice(idx, 1); st.table[s].push({ type: "facedown" }); st.costPool[s] = (st.costPool[s] || 0) + 1;
      setLastAction(st, s, "役職カード（裏向き・騎士効果）", null, true); addLog(st, `${s}は騎士の効果により、役職カードしか手札になく、裏向きで場に出しました。`);
      finishTurn(st, s); return st;
    }
  }
  const req = card.type === "joker" ? st.settings.jokerCost : 1;
  const avail = st.costPool[s] || 0; const meta = st.playerMeta[s];
  const byPool = avail >= req; const withV = !byPool && meta.virtualCostUnused && avail + 1 >= req;
  if (!byPool && !withV) {
    const cih = countCitizens(hand), total = avail + (meta.virtualCostUnused ? 1 : 0), elig = cih === 0 && total === 0;
    if (opt.emergencySet && elig) {
      hand.splice(idx, 1); st.table[s].push({ type: "facedown" }); st.costPool[s] = (st.costPool[s] || 0) + 1;
      setLastAction(st, s, "役職カード（裏向き）", null, true); addLog(st, `${s}が緊急セットで役職カードを裏向きに出しました。`);
      finishTurn(st, s); return st;
    }
    throw new GameActionError("コストが足りません。", { emergencyAvailable: elig });
  }
  let seer = null;
  if (card.type === "role" && card.role === "J") seer = computeSeerResult(st, s);
  if (card.type === "role" && card.role === "Q") { if (!opt.attr || (opt.attr !== "mark" && opt.attr !== "number") || !opt.value) throw new GameActionError("怪盗の効果には、指定するマークまたは数字が必要です。"); }
  if (byPool) st.costPool[s] = avail - req; else { meta.virtualCostUnused = false; st.costPool[s] = Math.max(0, avail - (req - 1)); }
  hand.splice(idx, 1); st.discard.push(card); st.roleDiscard[s].push(card);
  let desc = "";
  if (card.type === "role" && card.role === "J") { st.seerHistory[s].push(seer.value); st.seerRevealLog[s].push(seer.text); addLog(st, `${s}が占い師を使用しました。`); desc = "占い師(J)"; }
  else if (card.type === "role" && card.role === "Q") { st.constraints[opponent(s)] = { type: "forceAttribute", attr: opt.attr, value: opt.value }; addLog(st, `${s}が怪盗を使用し、相手に「${opt.value}」を強制しました。`); desc = "怪盗(Q)"; }
  else if (card.type === "role" && card.role === "K") { st.constraints[opponent(s)] = { type: "blockRoles" }; addLog(st, `${s}が騎士を使用しました。相手は次のターン役職カードを出せません。`); desc = "騎士(K)"; }
  else if (card.type === "joker") { st.constraints[opponent(s)] = { type: "forceAccuse" }; addLog(st, `${s}がジョーカーを使用しました。相手は次のターン告発を強制されます。`); desc = "ジョーカー"; }
  setLastAction(st, s, desc, null, true);
  finishTurn(st, s);
  return st;
}
function reduceAccuse(st, s, mark, number) {
  validateTurnAction(st, s, "needAction");
  const c = st.constraints[s];
  if (c && c.type !== "forceAccuse") {
    if (c.type === "forceAttribute") { const q = st.hands[s].filter((x) => x.type === "citizen" && (c.attr === "mark" ? x.mark === c.value : x.number === c.value)); if (q.length > 0) throw new GameActionError("前のターンの効果により、市民カードを出す必要があるため告発できません。"); }
    if (c.type === "blockRoles") { const hasC = st.hands[s].some((x) => x.type === "citizen"); if (hasC) throw new GameActionError("前のターンの効果により、市民カードを出す必要があるため告発できません。"); }
  }
  const ok = mark === st.wolf.mark && Number(number) === st.wolf.number;
  if (ok) endGame(st, s, "告発成功"); else endGame(st, opponent(s), "告発失敗");
  st.constraints[s] = null; return st;
}
function reduceMulligan(st, s) {
  if (st.status !== "playing") throw new GameActionError("ゲームが進行中ではありません。");
  if (st.firstPlayer !== s) throw new GameActionError("マリガン（手札の引き直し）は先攻プレイヤーのみ使用できます。");
  if (st.currentTurn !== s) throw new GameActionError("今はあなたのターンではありません。");
  const meta = st.playerMeta[s];
  if (meta.mulliganUsed) throw new GameActionError("この対局では既に引き直し済みです。");
  if (meta.hasDrawnYet) throw new GameActionError("マリガンは、ゲーム開始後に最初の山札を引く前のみ使用できます。");
  const hand = st.hands[s];
  if (countCitizens(hand) > 0) throw new GameActionError("手札に市民カードがあるため、引き直しはできません。");
  const old = hand.map(cardLabel).join("、");
  st.drawPile = st.drawPile.concat(hand); st.hands[s] = []; shuffleArr(st.drawPile);
  for (let i = 0; i < 3; i++) st.hands[s].push(st.drawPile.pop());
  meta.mulliganUsed = true; addLog(st, `プレイヤー${s}が手札（${old}）を公開して引き直しました。`);
  return st;
}

// ============================================================
// Firestore
// ============================================================
function normalizeRoomId(id) { return String(id || "").trim().toUpperCase().slice(0, 6); }
function generateRoomId() { const c = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; let s = ""; for (let i = 0; i < 6; i++) s += c[Math.floor(Math.random() * c.length)]; return s; }
function roomRef(id) { return doc(db, "rooms", normalizeRoomId(id)); }
async function runAction(id, fn) {
  const ref = roomRef(id);
  return runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    let st = snap.exists() ? JSON.parse(JSON.stringify(snap.data())) : createDefaultRoomState();
    const ns = fn(st) || st; ns.updatedAt = Date.now(); tx.set(ref, ns); return ns;
  });
}
const Game = {
  createRoom: async () => { const id = generateRoomId(); const st = await runAction(id, (s) => reduceJoin(s, "A")); return { id, state: st }; },
  joinExisting: async (i) => { const id = normalizeRoomId(i); const snap = await getDoc(roomRef(id)); if (!snap.exists()) throw new GameActionError("そのルームIDが見つかりません。IDを確認してください。"); const st = await runAction(id, (s) => reduceJoin(s, "B")); return { id, state: st }; },
  updateSettings: (r, s, i, w, j) => runAction(r, (st) => reduceUpdateSettings(st, s, i, w, j)),
  start: (r) => runAction(r, (s) => reduceStartGame(s)),
  reset: (r) => runAction(r, (s) => reduceResetRoom(s)),
  draw: (r, s) => runAction(r, (st) => reduceDraw(st, s)),
  playCitizen: (r, s, c) => runAction(r, (st) => reducePlayCitizen(st, s, c)),
  playRole: (r, s, c, o) => runAction(r, (st) => reducePlayRole(st, s, c, o)),
  accuse: (r, s, m, n) => runAction(r, (st) => reduceAccuse(st, s, m, n)),
  mulligan: (r, s) => runAction(r, (st) => reduceMulligan(st, s)),
  subscribe: (r, cb) => onSnapshot(roomRef(r), (snap) => cb(snap.exists() ? snap.data() : null)),
};

function saveSession() { localStorage.setItem(SESSION_KEY, JSON.stringify({ roomId, slot: mySlot })); }
function loadSession() { try { const r = localStorage.getItem(SESSION_KEY); return r ? JSON.parse(r) : null; } catch { return null; } }
function clearSession() { localStorage.removeItem(SESSION_KEY); }

// ============================================================
// UI
// ============================================================
const app = document.getElementById("app");
let roomId = null, mySlot = null, unsubscribe = null, lastSeenSeq = 0, endAnnounced = false;

// 手札は常に通常表示（透過/グレースケール/発光アニメを付けない）
function cardVisualHtml(card, opts = {}) {
  const { interactive = false, disabled = true, dataCardId = null, extraClass = "", field = false } = opts;
  const da = disabled ? "disabled" : "";
  const dc = dataCardId ? `data-card-id="${dataCardId}"` : "";
  const ic = interactive ? "interactive" : "";
  if (card.type === "facedown") return `<button ${da} ${dc} class="card card-back ${extraClass}"></button>`;
  const idx = getSpriteIndex(card);
  const pos = idx !== null ? (field ? spritePositionField(idx) : spritePosition(idx)) : "0% 0%";
  const frame = card.type === "citizen" ? (RED_MARKS.includes(card.mark) ? "suit-red" : "suit-black") : card.type === "role" ? "role-frame" : "joker-frame";
  return `<button ${da} ${dc} class="card ${frame} ${ic} ${extraClass}" style="background-image:url('/cards.png'); background-position:${pos};"></button>`;
}
function handCardHtml(card, canAct) {
  const k = card.type === "citizen" ? "suit-" + (RED_MARKS.includes(card.mark) ? "red" : "black") : card.type === "role" ? "role-frame" : "joker-frame";
  const idx = getSpriteIndex(card);
  const pos = idx !== null ? spritePosition(idx) : "0% 0%";
  const ic = canAct ? "interactive" : "";
  const da = canAct ? "" : "disabled";
  // 手札は常に通常見た目。押せるかどうかだけ interactive/disabled で制御。
  return `<button ${da} data-card-id="${card.id}" class="card hand-card ${k} ${ic}" style="background-image:url('/cards.png'); background-position:${pos};"></button>`;
}
function renderFieldRow(cards, minSlots) {
  const items = cards.map((c) => {
    const key = c.type === "citizen" ? "c_" + c.mark + c.number : "";
    return cardVisualHtml(c, { extraClass: "field-card", field: true }).replace("<button ", `<button data-cardkey="${key}" `);
  });
  const total = Math.max(minSlots, items.length);
  while (items.length < total) items.push(`<div class="field-slot empty"></div>`);
  return items.join("");
}
function statusCellHtml(mk, n, played) { const cls = RED_MARKS.includes(mk) ? "mark-red" : "mark-black"; return `<div class="status-cell ${cls} ${played ? "played" : ""}">${mk}${n}</div>`; }

function showModal(h) { const o = document.getElementById("modalOverlay"); document.getElementById("modalContent").innerHTML = h; o.classList.add("show"); }
function closeModal() { const o = document.getElementById("modalOverlay"); if (o) o.classList.remove("show"); }
function showSimpleModal(t) { showModal(`<div class="big-text">${t}</div><button onclick="window.__closeModal()">閉じる</button>`); }
function showError(e) { showSimpleModal("⚠️ " + (e instanceof Error ? e.message : String(e))); }
function openSheet() { document.getElementById("sheetOverlay").classList.add("show"); }
function closeSheet() { const o = document.getElementById("sheetOverlay"); if (o) o.classList.remove("show"); }
const modalOverlayHtml = `<div class="modal-overlay" id="modalOverlay"><div class="modal-box"><div id="modalContent"></div></div></div>`;

function showToast(t, s) {
  const layer = document.getElementById("toastLayer"); if (!layer) return;
  const el = document.createElement("div"); el.className = "toast-banner";
  el.innerHTML = `<div class="toast-title">${t}</div><div class="toast-sub">${s}</div>`;
  layer.appendChild(el); requestAnimationFrame(() => el.classList.add("show"));
  setTimeout(() => { el.classList.remove("show"); setTimeout(() => el.remove(), 350); }, 2200);
}
function showEndOverlay(st) {
  if (document.getElementById("endOverlay")) return;
  const won = st.winner === mySlot;
  const el = document.createElement("div"); el.id = "endOverlay"; el.className = "end-overlay";
  el.innerHTML = `<div class="end-overlay-inner"><div class="end-overlay-title ${won ? "victory" : "defeat"}">${won ? "VICTORY" : "DEFEAT"}</div><div class="end-overlay-sub">勝因：${st.reason} ／ 人狼の正体：${st.wolf.mark}${st.wolf.number}</div><button class="success-btn" id="endOverlayCloseBtn">結果を見る</button></div>`;
  document.body.appendChild(el); requestAnimationFrame(() => el.classList.add("show"));
  document.getElementById("endOverlayCloseBtn").onclick = () => { el.classList.remove("show"); setTimeout(() => el.remove(), 350); };
}

function playSummonEffect(btn) {
  if (!btn) return;
  btn.classList.add("summon-anim");
  btn.addEventListener("animationend", () => {
    btn.classList.remove("summon-anim");
    const board = document.querySelector(".board-screen");
    if (board) { board.classList.add("shake"); setTimeout(() => board.classList.remove("shake"), 160); }
    spawnSparks(btn);
  }, { once: true });
}
function spawnSparks(btn) {
  const rect = btn.getBoundingClientRect();
  const cx = rect.left + rect.width / 2, cy = rect.top + rect.height / 2;
  const layer = document.createElement("div"); layer.className = "spark-layer"; document.body.appendChild(layer);
  for (let i = 0; i < 60; i++) {
    const sp = document.createElement("div"); sp.className = "spark";
    sp.style.left = cx + "px"; sp.style.top = cy + "px";
    const ang = Math.random() * Math.PI * 2, dist = 60 + Math.random() * 120;
    const dx = Math.cos(ang) * dist, dy = Math.sin(ang) * dist, sc = 0.5 + Math.random() * 1.2;
    layer.appendChild(sp);
    sp.animate([{ transform: `translate(0,0) scale(${sc})`, opacity: 1 }, { transform: `translate(${dx}px, ${dy}px) scale(0)`, opacity: 0 }], { duration: 700 + Math.random() * 300, easing: "cubic-bezier(0.15,0.7,0.3,1)", fill: "forwards" });
  }
  setTimeout(() => layer.remove(), 1100);
}

function renderLandingScreen() {
  app.innerHTML = `
    <div class="landing-screen">
      <div class="landing-emblem-wrap"><h1 class="landing-title">トランプ人狼</h1><div class="landing-title-underline"></div></div>
      <div class="landing-sub">DUAL BLIND DUEL</div>
      <div class="landing-buttons">
        <button class="lobby-btn btn-create" id="createRoomBtn">部屋を作る</button>
        <button class="lobby-btn btn-join" id="showJoinFormBtn">部屋に入る</button>
      </div>
      <div class="join-form" id="joinForm" style="display:none;">
        <label>ルームID</label><input type="text" id="joinIdInput" placeholder="例：AB3XQ9" maxlength="6" />
        <button class="lobby-btn btn-join" id="submitJoinBtn">入室する</button>
      </div>
    </div>${modalOverlayHtml}`;
  document.getElementById("createRoomBtn").onclick = handleCreateRoom;
  document.getElementById("showJoinFormBtn").onclick = () => { document.getElementById("joinForm").style.display = "block"; document.getElementById("joinIdInput").focus(); };
  document.getElementById("submitJoinBtn").onclick = handleJoinRoomSubmit;
}
function renderLoading() { app.innerHTML = `<div class="landing-screen"><div class="loading-text">読み込み中...</div></div>${modalOverlayHtml}`; }
async function handleCreateRoom() { try { const { id } = await Game.createRoom(); roomId = id; mySlot = "A"; saveSession(); lastSeenSeq = 0; endAnnounced = false; startWatching(); } catch (e) { showError(e); } }
async function handleJoinRoomSubmit() {
  const v = document.getElementById("joinIdInput").value;
  if (!v || !v.trim()) { showSimpleModal("ルームIDを入力してください。"); return; }
  try { const { id, state } = await Game.joinExisting(v); roomId = id; mySlot = "B"; saveSession(); lastSeenSeq = (state.lastAction && state.lastAction.seq) || 0; endAnnounced = state.status === "ended"; startWatching(); } catch (e) { showError(e); }
}
function startWatching() {
  if (unsubscribe) unsubscribe();
  unsubscribe = Game.subscribe(roomId, (st) => {
    if (!st) { clearSession(); renderLandingScreen(); showSimpleModal("ルームが見つかりませんでした。"); return; }
    renderGame(st);
    if (st.status === "ended" && !endAnnounced) { endAnnounced = true; showEndOverlay(st); }
  });
}
function leaveRoom() { if (unsubscribe) unsubscribe(); unsubscribe = null; roomId = null; mySlot = null; clearSession(); const eo = document.getElementById("endOverlay"); if (eo) eo.remove(); renderLandingScreen(); }
function confirmLeaveMidGame() { showModal(`<div class="big-text">退室しますか？</div><div style="font-size:12px;color:#f4b400;margin-bottom:10px;">対戦中でも自分の画面から抜けられます。</div><button class="danger" onclick="window.__leaveConfirmed()">退室する</button><button class="secondary" onclick="window.__closeModal()">キャンセル</button>`); }
window.__leaveConfirmed = () => { closeModal(); leaveRoom(); };

function renderGame(st) { if (st.status === "waiting") renderWaiting(st); else renderPlaying(st); }

function renderWaiting(st) {
  app.innerHTML = `
    <div class="page-pad">
      <div class="duel-header"><div class="duel-title">トランプ人狼</div></div>
      <div class="room-id-card"><div class="room-id-label">ROOM ID</div><div class="room-id-value">${roomId}</div><button class="copy-btn" id="copyIdBtn">📋 コピー</button></div>
      <div class="waiting-panel flat-section panel">
        <div class="flat-label">対戦相手を待っています</div>
        <div class="player-slot-row"><div class="player-slot ${st.players.A ? "ready" : ""}">A ${st.players.A ? "✓" : "…"}</div><div class="vs-mark">VS</div><div class="player-slot ${st.players.B ? "ready" : ""}">B ${st.players.B ? "✓" : "…"}</div></div>
      </div>
      <div class="settings-panel">
        <label>初期情報タイプ</label>
        <select id="infoTypeSelect"><option value="除外" ${st.settings.infoType === "除外" ? "selected" : ""}>除外（〇ではない）</option><option value="確定" ${st.settings.infoType === "確定" ? "selected" : ""}>確定（〇である）</option></select>
        <label>勝利条件の枚数（3〜7枚）</label>
        <select id="winCountSelect">${WIN_COUNT_OPTIONS.map((n) => `<option value="${n}" ${st.settings.winCount === n ? "selected" : ""}>${n}枚</option>`).join("")}</select>
        <label>ジョーカーの使用コスト（1〜4）</label>
        <select id="jokerCostSelect">${JOKER_COST_OPTIONS.map((n) => `<option value="${n}" ${st.settings.jokerCost === n ? "selected" : ""}>コスト${n}</option>`).join("")}</select>
        <button class="secondary" id="saveSettingsBtn">設定を保存</button>
        <button class="lobby-btn btn-create" id="startBtn" ${!(st.players.A && st.players.B) ? "disabled" : ""}>ゲーム開始</button>
        <button class="danger" id="leaveBtn">退室する</button>
      </div>
    </div>${modalOverlayHtml}`;
  document.getElementById("copyIdBtn").onclick = () => { navigator.clipboard.writeText(roomId).then(() => { const b = document.getElementById("copyIdBtn"); b.textContent = "✓ コピーしました"; setTimeout(() => (b.textContent = "📋 コピー"), 1500); }); };
  document.getElementById("saveSettingsBtn").onclick = async () => { try { await Game.updateSettings(roomId, mySlot, document.getElementById("infoTypeSelect").value, document.getElementById("winCountSelect").value, document.getElementById("jokerCostSelect").value); showSimpleModal("設定を保存しました。"); } catch (e) { showError(e); } };
  document.getElementById("startBtn").onclick = async () => { try { lastSeenSeq = 0; endAnnounced = false; await Game.start(roomId); } catch (e) { showError(e); } };
  document.getElementById("leaveBtn").onclick = leaveRoom;
}

function renderPlaying(st) {
  const isEnded = st.status === "ended";
  const opp = opponent(mySlot);
  const isMyTurn = !isEnded && st.currentTurn === mySlot;

  const playedSet = new Set();
  ["A", "B"].forEach((s) => (st.table[s] || []).forEach((c) => { if (c.type === "citizen") playedSet.add(c.mark + c.number); }));
  const citizenGridHtml = MARKS.map((mk) => NUMBERS.map((n) => statusCellHtml(mk, n, playedSet.has(mk + n))).join("")).join("");
  const oppHandCount = st.hands?.[opp]?.length ?? 0;

  const oppRoleRow = renderFieldRow(st.roleDiscard?.[opp] || [], 6);
  const oppCitizenRow = renderFieldRow(st.table[opp] || [], 6);
  const myCitizenRow = renderFieldRow(st.table[mySlot] || [], 6);
  const myRoleRow = renderFieldRow(st.roleDiscard?.[mySlot] || [], 6);

  const cn = st.constraints ? st.constraints[mySlot] : null;
  let cText = "";
  if (!isEnded && cn) {
    if (cn.type === "forceAttribute") cText = `「${cn.value}」の市民カードを出す必要があります`;
    if (cn.type === "blockRoles") cText = "役職カードが出せません。市民カードを出してください";
    if (cn.type === "forceAccuse") cText = "今回は告発しか行えません";
  }
  const myCost = (st.costPool?.[mySlot] || 0) + (st.playerMeta?.[mySlot]?.virtualCostUnused ? "+1" : "");
  const oppCost = (st.costPool?.[opp] || 0) + (st.playerMeta?.[opp]?.virtualCostUnused ? "+1" : "");
  const seerValues = st.seerHistory?.[mySlot] || [];
  const seerLabel = mySlot === "A" ? "安全な数字" : "安全なマーク";

  let turnChipHtml;
  if (isEnded) { const w = st.winner === mySlot; turnChipHtml = `<div class="chip turn-chip ${w ? "win-chip" : "lose-chip"}">${w ? "🏆 VICTORY" : "💀 DEFEAT"}</div>`; }
  else turnChipHtml = `<div class="chip turn-chip ${isMyTurn ? "my-turn" : "opp-turn"}">${isMyTurn ? "🎯 あなたのターン" : "⌛ 相手のターン"}</div>`;

  const handHtml = (st.hands?.[mySlot] || []).map((c) => handCardHtml(c, isMyTurn && st.phase === "needAction")).join("");
  const mulliganAvailable = !isEnded && st.firstPlayer === mySlot && !st.playerMeta[mySlot].mulliganUsed && !st.playerMeta[mySlot].hasDrawnYet && countCitizens(st.hands[mySlot]) === 0 && st.currentTurn === mySlot;
  const handActionsHtml = isEnded
    ? `<button class="success-btn" id="rematchBtn">🔁 もう一度対戦する</button><button class="danger" id="leaveBtn2">退室する</button>`
    : `${isMyTurn && st.phase === "needDraw" ? `<button id="drawBtn">🎴 山札から引く</button>` : ""}${mulliganAvailable ? `<button class="warning-btn" id="mulliganBtn">🔄 引き直す</button>` : ""}`;

  const wolfHint = st.info?.[mySlot] ? `🔎 ${st.info[mySlot]}` : "";
  const constraintLine = cText ? `<span class="constraint-txt">⚠️ ${cText}</span>` : "";
  const wolfHintRowHtml = !isEnded && (wolfHint || constraintLine) ? `<div class="wolf-hint-row">${wolfHint}${constraintLine}</div>` : "";
  const seerRowHtml = `<div class="center-seer-row"><span class="seer-label">占い師で把握した${seerLabel}：</span>${seerValues.length > 0 ? seerValues.map((v) => `<span class="seer-item">${v}</span>`).join("") : `<span style="opacity:0.6;">まだありません</span>`}</div>`;

  app.innerHTML = `
    <div class="board-screen">
      <div class="zone-header">
        <div class="opp-hand-block">
          <div class="opp-hand-mini"><div class="card card-back mini-back"></div><span class="opp-hand-count">×${oppHandCount}</span></div>
          <div class="opp-cost-line">コスト：${oppCost}</div>
        </div>
        <div class="header-right"><button class="leave-btn-mini" id="leaveHeaderBtn">退室</button><div class="citizen-mini-grid">${citizenGridHtml}</div></div>
      </div>

      <div class="zone-opp-field">
        <div class="slot-row">${oppRoleRow}</div>
        <div class="slot-row">${oppCitizenRow}</div>
      </div>

      <div class="zone-center">
        <div class="center-top-grid">
          <div class="side-icon-col"><button class="center-log-btn" id="logToggleBtn">📜</button></div>
          <div class="center-stack">
            <div class="center-action-row">${turnChipHtml}${!isEnded ? `<button class="accuse-btn" id="accuseFab">告発</button>` : ""}</div>
            <div class="cost-line"><span class="cost-mine">あなたのコスト：${myCost}</span><span class="cost-opp">相手のコスト：${oppCost}</span></div>
          </div>
          <div class="side-icon-col"><div class="deck-pile"><span class="deck-pile-label">山札</span><span class="deck-pile-count">${st.drawPile?.length ?? 0}枚</span></div></div>
        </div>
        ${wolfHintRowHtml}
        ${seerRowHtml}
      </div>

      <div class="zone-my-field">
        <div class="slot-row">${myCitizenRow}</div>
        <div class="slot-row">${myRoleRow}</div>
      </div>

      <div class="zone-hand">
        <div class="hand-actions-row">${handActionsHtml}</div>
        <div class="hand-fan-row">${handHtml}</div>
      </div>

      <div class="toast-layer" id="toastLayer"></div>
    </div>

    <div class="sheet-overlay" id="sheetOverlay">
      <div class="sheet"><div class="sheet-handle"></div>
        <h3 style="margin:0 0 12px;font-size:15px;">人狼を告発する</h3>
        <div style="display:flex;gap:8px;margin-bottom:10px;">
          <select id="accuseMark">${MARKS.map((m) => `<option value="${m}">${m}</option>`).join("")}</select>
          <select id="accuseNumber">${NUMBERS.map((n) => `<option value="${n}">${n}</option>`).join("")}</select>
        </div>
        <button class="danger" id="submitAccuse">告発する（外すと即敗北）</button>
        <button class="secondary" id="cancelAccuse">キャンセル</button>
      </div>
    </div>
    ${modalOverlayHtml}`;

  document.getElementById("leaveHeaderBtn").onclick = confirmLeaveMidGame;
  const drawBtn = document.getElementById("drawBtn"); if (drawBtn) drawBtn.onclick = () => Game.draw(roomId, mySlot).catch(showError);
  const mulliganBtn = document.getElementById("mulliganBtn"); if (mulliganBtn) mulliganBtn.onclick = () => showModal(`<div style="color:#f4b400;font-size:13px;margin-bottom:10px;">⚠️ 手札を相手に公開してから引き直します。よろしいですか？</div><button class="warning-btn" onclick="window.__mulligan()">引き直す</button><button class="secondary" onclick="window.__closeModal()">キャンセル</button>`);
  document.querySelectorAll(".hand-card").forEach((btn) => {
    btn.onclick = () => {
      const cardId = btn.dataset.cardId; const card = st.hands[mySlot].find((c) => c.id === cardId); if (!card) return;
      if (card.type === "citizen") showModal(`<div>このカードを出しますか？</div><button onclick="window.__playCitizen('${cardId}')">はい</button><button class="secondary" onclick="window.__closeModal()">キャンセル</button>`);
      else confirmPlayRole(card);
    };
  });
  const logBtn = document.getElementById("logToggleBtn"); if (logBtn) logBtn.onclick = () => showModal(`<div class="flat-label" style="margin-bottom:8px;">ゲームログ</div><div class="log-box" style="text-align:left;">${(st.log || []).map((l) => `<div>${l}</div>`).join("")}</div><button onclick="window.__closeModal()" style="margin-top:12px;">閉じる</button>`);
  const accuseFab = document.getElementById("accuseFab"); if (accuseFab) accuseFab.onclick = openSheet;
  const cancelAccuse = document.getElementById("cancelAccuse"); if (cancelAccuse) cancelAccuse.onclick = closeSheet;
  const submitAccuse = document.getElementById("submitAccuse"); if (submitAccuse) submitAccuse.onclick = () => { const m = document.getElementById("accuseMark").value, n = document.getElementById("accuseNumber").value; closeSheet(); showModal(`<div>人狼は「${m}の${n}」だと告発しますか？<br><span style="color:#f4b400;font-size:13px;">外すと即敗北です</span></div><button class="danger" onclick="window.__accuse('${m}', ${n})">告発する</button><button class="secondary" onclick="window.__closeModal()">キャンセル</button>`); };
  const rematchBtn = document.getElementById("rematchBtn"); if (rematchBtn) rematchBtn.onclick = () => { lastSeenSeq = 0; endAnnounced = false; const eo = document.getElementById("endOverlay"); if (eo) eo.remove(); Game.reset(roomId).catch(showError); };
  const leaveBtn2 = document.getElementById("leaveBtn2"); if (leaveBtn2) leaveBtn2.onclick = leaveRoom;

  maybeAnnounceTurn(st);
}

function confirmPlayRole(card) {
  if (card.type === "role" && card.role === "Q") {
    showModal(`<div>怪盗の効果：相手に強制する属性を選んでください</div><select id="qAttrSelect"><option value="mark">マーク</option><option value="number">数字</option></select><select id="qValueSelect"></select><button onclick="window.__playRoleQ('${card.id}')">発動する</button><button class="secondary" onclick="window.__closeModal()">キャンセル</button>`);
    const a = document.getElementById("qAttrSelect"), v = document.getElementById("qValueSelect");
    const r = () => { v.innerHTML = a.value === "mark" ? MARKS.map((m) => `<option value="${m}">${m}</option>`).join("") : NUMBERS.map((n) => `<option value="${n}">${n}</option>`).join(""); };
    a.onchange = r; r(); return;
  }
  const label = card.type === "joker" ? "ジョーカー" : "この役職カード";
  showModal(`<div>${label}を使用しますか？</div><button onclick="window.__playRole('${card.id}', {})">使用する</button><button class="secondary" onclick="window.__closeModal()">キャンセル</button>`);
}

function maybeAnnounceTurn(st) {
  if (st.status !== "playing") return;
  const la = st.lastAction;
  if (!la || la.seq === lastSeenSeq) return;
  lastSeenSeq = la.seq;
  requestAnimationFrame(() => {
    let btn = null;
    if (la.isRole) {
      const rowSel = la.actorSlot === mySlot ? ".zone-my-field .slot-row:last-child" : ".zone-opp-field .slot-row:first-child";
      const cards = document.querySelectorAll(`${rowSel} .field-card`);
      if (cards.length) btn = cards[cards.length - 1];
    } else if (la.cardKey) {
      btn = document.querySelector(`.field-card[data-cardkey="${la.cardKey}"]`);
    }
    if (btn) playSummonEffect(btn);
  });
  const actorText = la.actorSlot === mySlot ? "あなたが" : "相手が";
  const nextText = st.currentTurn === mySlot ? "🎯 あなたのターン" : "⌛ 相手のターン";
  showToast(`${actorText}カードを出しました`, nextText);
}

window.__closeModal = closeModal;
window.__playCitizen = (id) => { closeModal(); Game.playCitizen(roomId, mySlot, id).catch(showError); };
window.__playRole = (id, o) => {
  closeModal();
  Game.playRole(roomId, mySlot, id, o).catch((err) => {
    if (err.payload?.emergencyAvailable) showModal(`<div style="color:#f4b400;font-size:13px;margin-bottom:10px;">⚠️ コストが足りません。手札に市民カードがなく、コストも0のため、緊急セット（裏向きで出す）が可能です。</div><button class="warning-btn" onclick="window.__playRole('${id}', {emergencySet:true})">緊急セットする</button><button class="secondary" onclick="window.__closeModal()">キャンセル</button>`);
    else if (err.payload?.kForcedFacedownAvailable) showModal(`<div style="color:#f4b400;font-size:13px;margin-bottom:10px;">⚠️ 騎士の効果により、役職カードは効果を発動できません。手札に市民カードが無いため、裏向きで場に出されます。</div><button class="warning-btn" onclick="window.__playRole('${id}', {forceFacedownByBlock:true})">裏向きで出す</button><button class="secondary" onclick="window.__closeModal()">キャンセル</button>`);
    else showError(err);
  });
};
window.__playRoleQ = (id) => { const a = document.getElementById("qAttrSelect").value, v = document.getElementById("qValueSelect").value; window.__playRole(id, { attr: a, value: a === "number" ? Number(v) : v }); };
window.__accuse = (m, n) => { closeModal(); Game.accuse(roomId, mySlot, m, n).catch(showError); };
window.__mulligan = () => { closeModal(); Game.mulligan(roomId, mySlot).catch(showError); };

function renderCreditBadge() { if (document.getElementById("grokCredit")) return; const el = document.createElement("div"); el.id = "grokCredit"; el.className = "grok-credit"; el.textContent = "✨ Created with Grok"; document.body.appendChild(el); }
renderCreditBadge();

const session = loadSession();
if (session && session.roomId && session.slot) { roomId = session.roomId; mySlot = session.slot; renderLoading(); startWatching(); }
else { renderLandingScreen(); }
