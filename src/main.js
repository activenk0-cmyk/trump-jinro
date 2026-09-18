import "./style.css";
import { db } from "./firebase.js";
import {
  doc,
  getDoc,
  runTransaction,
  onSnapshot,
} from "firebase/firestore";

// ============================================================
// 定数・純粋ロジック（ゲームルールは変更なし）
// ============================================================
const MARKS = ["♠", "♥", "♣", "♦"];
const NUMBERS = [1, 2, 3, 4];
const RED_MARKS = ["♥", "♦"];
const WIN_COUNT_OPTIONS = [3, 4, 5, 6, 7];
const JOKER_COST_OPTIONS = [1, 2, 3, 4];
const SESSION_KEY = "trump_jinro_session";

// --- スプライト割り当て ---
const SPRITE_SUIT_ORDER = ["♣", "♦", "♥", "♠"];
const SPRITE_RANK_ORDER = ["1", "2", "3", "4", "J", "Q", "K"];
const SPRITE_COLS = 6;
// 各行の background-position-y（Y軸1.4倍マージン補正・指定値）
const SPRITE_ROW_Y = ["0%", "24.5%", "49.5%", "74.5%", "99.5%"];

function getSpriteIndex(card) {
  if (card.type === "joker") {
    return 28 + (Number(card.id) % 2 === 0 ? 0 : 1);
  }
  const suitIdx = SPRITE_SUIT_ORDER.indexOf(card.mark);
  const rankKey = card.type === "citizen" ? String(card.number) : card.role;
  const rankIdx = SPRITE_RANK_ORDER.indexOf(rankKey);
  if (suitIdx === -1 || rankIdx === -1) return null;
  return suitIdx * 7 + rankIdx;
}

function spriteBackgroundPosition(index) {
  const col = index % SPRITE_COLS;
  const row = Math.floor(index / SPRITE_COLS);
  const x = (col / (SPRITE_COLS - 1)) * 100;
  const y = SPRITE_ROW_Y[row] || "0%";
  return `${x}% ${y}`;
}

class GameActionError extends Error {
  constructor(message, payload) {
    super(message);
    this.payload = payload || {};
  }
}

function opponent(slot) {
  return slot === "A" ? "B" : "A";
}

function addLog(state, text) {
  if (!state.log) state.log = [];
  state.log.push(text);
  if (state.log.length > 50) state.log = state.log.slice(-50);
}

function setLastAction(state, actorSlot, description) {
  if (typeof state.turnSeq !== "number") state.turnSeq = 0;
  state.turnSeq += 1;
  state.lastAction = { actorSlot, description, seq: state.turnSeq };
}

function buildDeck() {
  const deck = [];
  let id = 0;
  MARKS.forEach((mark) => {
    NUMBERS.forEach((num) =>
      deck.push({ id: String(id++), type: "citizen", mark, number: num })
    );
  });
  MARKS.forEach((mark) => {
    ["J", "Q", "K"].forEach((role) =>
      deck.push({ id: String(id++), type: "role", role, mark })
    );
  });
  deck.push({ id: String(id++), type: "joker" });
  deck.push({ id: String(id++), type: "joker" });
  return deck;
}

function shuffleArr(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

function countCitizens(hand) {
  return hand.filter((c) => c.type === "citizen").length;
}

function cardLabel(card) {
  if (card.type === "citizen") return card.mark + card.number;
  if (card.type === "role") return card.role + "(" + card.mark + ")";
  if (card.type === "joker") return "ジョーカー";
  return "?";
}

function createDefaultRoomState() {
  return {
    status: "waiting",
    players: { A: false, B: false },
    settings: { infoType: "除外", winCount: 6, jokerCost: 4 },
    log: [],
  };
}

function validateTurnAction(state, slot, requiredPhase) {
  if (state.status !== "playing")
    throw new GameActionError("ゲームは進行中ではありません。");
  if (state.currentTurn !== slot)
    throw new GameActionError("あなたのターンではありません。");
  if (state.phase !== requiredPhase)
    throw new GameActionError("今はその操作を行えるタイミングではありません。");
}

function finishTurn(state, slot) {
  state.constraints[slot] = null;
  state.currentTurn = opponent(slot);
  state.phase = "needDraw";
}

function endGame(state, winnerSlot, reason) {
  state.status = "ended";
  state.winner = winnerSlot;
  state.reason = reason;
  addLog(state, "🎉 ゲーム終了：プレイヤー" + winnerSlot + "の勝利（" + reason + "）");
}

function reduceJoin(state, slot) {
  if (state.status === "waiting") {
    if (!state.players[slot]) {
      state.players[slot] = true;
      addLog(state, "プレイヤー" + slot + "が入室しました。");
    }
  } else if (!state.players[slot]) {
    throw new GameActionError("このルームは既にゲームが開始されているため、新規参加できません。");
  }
  return state;
}

function reduceUpdateSettings(state, slot, infoType, winCount, jokerCost) {
  if (state.status !== "waiting")
    throw new GameActionError("ゲーム開始後は設定を変更できません。");
  state.settings = { infoType, winCount: Number(winCount), jokerCost: Number(jokerCost) };
  addLog(state, `設定が更新されました（初期情報:${infoType} / 勝利枚数:${winCount} / ジョーカーコスト:${jokerCost}）`);
  return state;
}

function reduceStartGame(state) {
  if (state.status !== "waiting")
    throw new GameActionError("既にゲームが開始されています。");
  if (!state.players.A || !state.players.B)
    throw new GameActionError("両方のプレイヤーの入室を待っています。");

  const deck = shuffleArr(buildDeck());
  const handA = deck.splice(0, 3);
  const handB = deck.splice(0, 3);

  const wolfMark = MARKS[Math.floor(Math.random() * MARKS.length)];
  const wolfNumber = NUMBERS[Math.floor(Math.random() * NUMBERS.length)];

  let infoA, infoB;
  if (state.settings.infoType === "確定") {
    infoA = `人狼のマークは「${wolfMark}」です。`;
    infoB = `人狼の数字は「${wolfNumber}」です。`;
  } else {
    const otherMarks = MARKS.filter((m) => m !== wolfMark);
    const otherNumbers = NUMBERS.filter((n) => n !== wolfNumber);
    const exMark = otherMarks[Math.floor(Math.random() * otherMarks.length)];
    const exNum = otherNumbers[Math.floor(Math.random() * otherNumbers.length)];
    infoA = `人狼のマークは「${exMark}」ではありません。`;
    infoB = `人狼の数字は「${exNum}」ではありません。`;
  }

  const firstPlayer = Math.random() < 0.5 ? "A" : "B";
  const secondPlayer = firstPlayer === "A" ? "B" : "A";

  state.status = "playing";
  state.wolf = { mark: wolfMark, number: wolfNumber };
  state.hands = { A: handA, B: handB };
  state.drawPile = deck;
  state.table = { A: [], B: [] };
  state.discard = [];
  state.info = { A: infoA, B: infoB };
  state.seerHistory = { A: [], B: [] };
  state.seerRevealLog = { A: [], B: [] };
  state.roleDiscard = { A: [], B: [] };
  state.constraints = { A: null, B: null };
  state.firstPlayer = firstPlayer;
  state.costPool = { A: 0, B: 0 };
  state.turnSeq = 0;
  state.lastAction = null;
  state.playerMeta = {
    A: { virtualCostUnused: secondPlayer === "A", mulliganUsed: false, hasDrawnYet: false },
    B: { virtualCostUnused: secondPlayer === "B", mulliganUsed: false, hasDrawnYet: false },
  };
  state.currentTurn = firstPlayer;
  state.phase = "needDraw";
  state.winner = null;
  state.reason = null;

  addLog(state, "ゲームを開始しました。先攻：プレイヤー" + firstPlayer);
  return state;
}

function reduceResetRoom(state) {
  const settings = state.settings;
  const players = state.players;
  const log = state.log || [];
  const nextState = { status: "waiting", players, settings, log };
  addLog(nextState, "同じルームで新しいゲームの準備を始めました。");
  return nextState;
}

function reduceDraw(state, slot) {
  validateTurnAction(state, slot, "needDraw");
  if (state.drawPile.length > 0) {
    state.hands[slot].push(state.drawPile.pop());
  } else {
    addLog(state, "山札が尽きているため、" + slot + "は引けませんでした。");
  }
  state.playerMeta[slot].hasDrawnYet = true;
  state.phase = "needAction";
  return state;
}

function checkConstraintForCitizenPlay(state, slot, card) {
  const constraint = state.constraints[slot];
  if (!constraint) return;
  if (constraint.type === "forceAccuse") {
    throw new GameActionError("前のターンの効果により、今回は告発しか行えません。");
  }
  if (constraint.type === "forceAttribute") {
    const qualifying = state.hands[slot].filter(
      (c) =>
        c.type === "citizen" &&
        (constraint.attr === "mark" ? c.mark === constraint.value : c.number === constraint.value)
    );
    if (qualifying.length > 0) {
      const matches =
        constraint.attr === "mark" ? card.mark === constraint.value : card.number === constraint.value;
      if (!matches)
        throw new GameActionError(`前のターンの効果により、「${constraint.value}」の付いた市民カードを出す必要があります。`);
    }
  }
}

function reducePlayCitizen(state, slot, cardId) {
  validateTurnAction(state, slot, "needAction");
  const hand = state.hands[slot];
  const idx = hand.findIndex((c) => c.id === cardId);
  if (idx === -1) throw new GameActionError("指定されたカードが手札にありません。");
  const card = hand[idx];
  if (card.type !== "citizen") throw new GameActionError("市民カードではありません。");

  checkConstraintForCitizenPlay(state, slot, card);

  hand.splice(idx, 1);
  const isWolf = card.mark === state.wolf.mark && card.number === state.wolf.number;
  state.table[slot].push(card);

  if (isWolf) {
    addLog(state, `${slot}が${card.mark}${card.number}を出し、人狼でした。`);
    endGame(state, opponent(slot), "人狼死");
  } else {
    addLog(state, `${slot}が${card.mark}${card.number}を出しました（セーフ）。`);
    state.costPool[slot] = (state.costPool[slot] || 0) + 1;
    const escapeCount = state.table[slot].filter((c) => c.type === "citizen").length;
    if (escapeCount >= state.settings.winCount) endGame(state, slot, "市民脱出");
  }

  if (state.status === "playing") {
    setLastAction(state, slot, card.mark + card.number);
    finishTurn(state, slot);
  }
  return state;
}

function computeSeerResult(state, slot) {
  const wolf = state.wolf;
  if (slot === "A") {
    const history = state.seerHistory.A;
    const candidates = NUMBERS.filter((n) => n !== wolf.number && !history.includes(n));
    if (candidates.length === 0)
      throw new GameActionError("これ以上、開示できる安全な数字がありません。");
    const v = candidates[Math.floor(Math.random() * candidates.length)];
    return { value: v, text: `安全な数字は「${v}」です。` };
  } else {
    const history = state.seerHistory.B;
    const candidates = MARKS.filter((m) => m !== wolf.mark && !history.includes(m));
    if (candidates.length === 0)
      throw new GameActionError("これ以上、開示できる安全なマークがありません。");
    const v = candidates[Math.floor(Math.random() * candidates.length)];
    return { value: v, text: `安全なマークは「${v}」です。` };
  }
}

function reducePlayRole(state, slot, cardId, options = {}) {
  validateTurnAction(state, slot, "needAction");

  const hand = state.hands[slot];
  const idx = hand.findIndex((c) => c.id === cardId);
  if (idx === -1) throw new GameActionError("指定されたカードが手札にありません。");
  const card = hand[idx];
  if (card.type !== "role" && card.type !== "joker")
    throw new GameActionError("役職カードではありません。");

  const constraint = state.constraints[slot];
  if (constraint) {
    if (constraint.type === "forceAccuse") {
      throw new GameActionError("前のターンの効果により、今回は告発しか行えません。");
    }
    if (constraint.type === "forceAttribute") {
      const qualifying = hand.filter(
        (c) =>
          c.type === "citizen" &&
          (constraint.attr === "mark" ? c.mark === constraint.value : c.number === constraint.value)
      );
      if (qualifying.length > 0) {
        throw new GameActionError(`前のターンの効果により、市民カード（「${constraint.value}」の付いたもの）を出す必要があります。`);
      }
    }
    if (constraint.type === "blockRoles") {
      const hasCitizen = countCitizens(hand) > 0;
      if (hasCitizen) {
        throw new GameActionError("前のターンの効果により、役職カードは出せません。市民カードを出してください。");
      }
      if (!options.forceFacedownByBlock) {
        throw new GameActionError(
          "騎士の効果：手札に市民カードが無いため、この役職カードは効果を発動できません。裏向きで場に出します。",
          { kForcedFacedownAvailable: true }
        );
      }
      hand.splice(idx, 1);
      state.table[slot].push({ type: "facedown" });
      state.costPool[slot] = (state.costPool[slot] || 0) + 1;
      setLastAction(state, slot, "役職カード（裏向き・騎士効果）");
      addLog(state, `${slot}は騎士の効果により、役職カードしか手札になく、裏向きで場に出しました。`);
      finishTurn(state, slot);
      return state;
    }
  }

  const requiredCost = card.type === "joker" ? state.settings.jokerCost : 1;
  const availableCost = state.costPool[slot] || 0;
  const meta = state.playerMeta[slot];
  const hasEnoughByPool = availableCost >= requiredCost;
  const hasEnoughWithVirtual =
    !hasEnoughByPool && meta.virtualCostUnused && availableCost + 1 >= requiredCost;

  if (!hasEnoughByPool && !hasEnoughWithVirtual) {
    const citizenInHand = countCitizens(hand);
    const totalAvailable = availableCost + (meta.virtualCostUnused ? 1 : 0);
    const emergencyEligible = citizenInHand === 0 && totalAvailable === 0;

    if (options.emergencySet && emergencyEligible) {
      hand.splice(idx, 1);
      state.table[slot].push({ type: "facedown" });
      state.costPool[slot] = (state.costPool[slot] || 0) + 1;
      setLastAction(state, slot, "役職カード（裏向き）");
      addLog(state, `${slot}が緊急セットで役職カードを裏向きに出しました。`);
      finishTurn(state, slot);
      return state;
    }
    throw new GameActionError("コストが足りません。", { emergencyAvailable: emergencyEligible });
  }

  let pendingSeer = null;
  if (card.type === "role" && card.role === "J") {
    pendingSeer = computeSeerResult(state, slot);
  }
  if (card.type === "role" && card.role === "Q") {
    if (!options.attr || (options.attr !== "mark" && options.attr !== "number") || !options.value) {
      throw new GameActionError("怪盗の効果には、指定するマークまたは数字が必要です。");
    }
  }

  if (hasEnoughByPool) {
    state.costPool[slot] = availableCost - requiredCost;
  } else {
    meta.virtualCostUnused = false;
    const remaining = requiredCost - 1;
    state.costPool[slot] = Math.max(0, availableCost - remaining);
  }

  hand.splice(idx, 1);
  state.discard.push(card);
  state.roleDiscard[slot].push(card);

  let actionDescription = "";
  if (card.type === "role" && card.role === "J") {
    state.seerHistory[slot].push(pendingSeer.value);
    state.seerRevealLog[slot].push(pendingSeer.text);
    addLog(state, `${slot}が占い師を使用しました。`);
    actionDescription = "占い師(J)";
  } else if (card.type === "role" && card.role === "Q") {
    state.constraints[opponent(slot)] = { type: "forceAttribute", attr: options.attr, value: options.value };
    addLog(state, `${slot}が怪盗を使用し、相手に「${options.value}」を強制しました。`);
    actionDescription = "怪盗(Q)";
  } else if (card.type === "role" && card.role === "K") {
    state.constraints[opponent(slot)] = { type: "blockRoles" };
    addLog(state, `${slot}が騎士を使用しました。相手は次のターン役職カードを出せません。`);
    actionDescription = "騎士(K)";
  } else if (card.type === "joker") {
    state.constraints[opponent(slot)] = { type: "forceAccuse" };
    addLog(state, `${slot}がジョーカーを使用しました。相手は次のターン告発を強制されます。`);
    actionDescription = "ジョーカー";
  }

  setLastAction(state, slot, actionDescription);
  finishTurn(state, slot);
  return state;
}

function reduceAccuse(state, slot, mark, number) {
  validateTurnAction(state, slot, "needAction");

  const constraint = state.constraints[slot];
  if (constraint && constraint.type !== "forceAccuse") {
    if (constraint.type === "forceAttribute") {
      const qualifying = state.hands[slot].filter(
        (c) =>
          c.type === "citizen" &&
          (constraint.attr === "mark" ? c.mark === constraint.value : c.number === constraint.value)
      );
      if (qualifying.length > 0)
        throw new GameActionError("前のターンの効果により、市民カードを出す必要があるため告発できません。");
    }
    if (constraint.type === "blockRoles") {
      const hasCitizen = state.hands[slot].some((c) => c.type === "citizen");
      if (hasCitizen)
        throw new GameActionError("前のターンの効果により、市民カードを出す必要があるため告発できません。");
    }
  }

  const success = mark === state.wolf.mark && Number(number) === state.wolf.number;
  if (success) endGame(state, slot, "告発成功");
  else endGame(state, opponent(slot), "告発失敗");
  state.constraints[slot] = null;
  return state;
}

function reduceMulligan(state, slot) {
  if (state.status !== "playing") throw new GameActionError("ゲームが進行中ではありません。");
  if (state.firstPlayer !== slot)
    throw new GameActionError("マリガン（手札の引き直し）は先攻プレイヤーのみ使用できます。");
  if (state.currentTurn !== slot) throw new GameActionError("今はあなたのターンではありません。");

  const meta = state.playerMeta[slot];
  if (meta.mulliganUsed) throw new GameActionError("この対局では既に引き直し済みです。");
  if (meta.hasDrawnYet)
    throw new GameActionError("マリガンは、ゲーム開始後に最初の山札を引く前のみ使用できます。");

  const hand = state.hands[slot];
  if (countCitizens(hand) > 0) throw new GameActionError("手札に市民カードがあるため、引き直しはできません。");

  const oldHandText = hand.map(cardLabel).join("、");
  state.drawPile = state.drawPile.concat(hand);
  state.hands[slot] = [];
  shuffleArr(state.drawPile);
  for (let i = 0; i < 3; i++) state.hands[slot].push(state.drawPile.pop());
  meta.mulliganUsed = true;
  addLog(state, `プレイヤー${slot}が手札（${oldHandText}）を公開して引き直しました。`);
  return state;
}

// ============================================================
// Firestore 通信レイヤー
// ============================================================
function normalizeRoomId(roomId) {
  return String(roomId || "").trim().toUpperCase().slice(0, 6);
}
function generateRoomId() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let id = "";
  for (let i = 0; i < 6; i++) id += chars[Math.floor(Math.random() * chars.length)];
  return id;
}
function roomRef(id) {
  return doc(db, "rooms", normalizeRoomId(id));
}
async function runAction(id, mutateFn) {
  const ref = roomRef(id);
  return runTransaction(db, async (tx) => {
    const snap = await tx.get(ref);
    let state = snap.exists() ? JSON.parse(JSON.stringify(snap.data())) : createDefaultRoomState();
    const nextState = mutateFn(state) || state;
    nextState.updatedAt = Date.now();
    tx.set(ref, nextState);
    return nextState;
  });
}

const Game = {
  createRoom: async () => {
    const id = generateRoomId();
    const state = await runAction(id, (s) => reduceJoin(s, "A"));
    return { id, state };
  },
  joinExisting: async (idInput) => {
    const id = normalizeRoomId(idInput);
    const snap = await getDoc(roomRef(id));
    if (!snap.exists()) throw new GameActionError("そのルームIDが見つかりません。IDを確認してください。");
    const state = await runAction(id, (s) => reduceJoin(s, "B"));
    return { id, state };
  },
  updateSettings: (roomId, slot, infoType, winCount, jokerCost) =>
    runAction(roomId, (s) => reduceUpdateSettings(s, slot, infoType, winCount, jokerCost)),
  start: (roomId) => runAction(roomId, (s) => reduceStartGame(s)),
  reset: (roomId) => runAction(roomId, (s) => reduceResetRoom(s)),
  draw: (roomId, slot) => runAction(roomId, (s) => reduceDraw(s, slot)),
  playCitizen: (roomId, slot, cardId) => runAction(roomId, (s) => reducePlayCitizen(s, slot, cardId)),
  playRole: (roomId, slot, cardId, options) => runAction(roomId, (s) => reducePlayRole(s, slot, cardId, options)),
  accuse: (roomId, slot, mark, number) => runAction(roomId, (s) => reduceAccuse(s, slot, mark, number)),
  mulligan: (roomId, slot) => runAction(roomId, (s) => reduceMulligan(s, slot)),
  subscribe: (roomId, cb) => onSnapshot(roomRef(roomId), (snap) => cb(snap.exists() ? snap.data() : null)),
};

// ============================================================
// セッション保存
// ============================================================
function saveSession() {
  localStorage.setItem(SESSION_KEY, JSON.stringify({ roomId, slot: mySlot }));
}
function loadSession() {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null;
  }
}
function clearSession() {
  localStorage.removeItem(SESSION_KEY);
}

// ============================================================
// UI
// ============================================================
const app = document.getElementById("app");

let roomId = null;
let mySlot = null;
let unsubscribe = null;
let lastSeenSeq = 0;
let endAnnounced = false;

function cardVisualHtml(card, opts = {}) {
  const { interactive = false, disabled = true, dataCardId = null, extraClass = "" } = opts;
  const disabledAttr = disabled ? "disabled" : "";
  const dataAttr = dataCardId ? `data-card-id="${dataCardId}"` : "";
  const interactiveClass = interactive ? "interactive" : "";

  if (card.type === "facedown") {
    return `<button ${disabledAttr} ${dataAttr} class="card card-back ${extraClass}"><span class="card-back-emblem">🐺</span></button>`;
  }

  const idx = getSpriteIndex(card);
  const pos = idx !== null ? spriteBackgroundPosition(idx) : "0% 0%";
  const frameClass =
    card.type === "citizen"
      ? RED_MARKS.includes(card.mark) ? "suit-red" : "suit-black"
      : card.type === "role"
      ? "role-frame"
      : "joker-frame";

  return `<button ${disabledAttr} ${dataAttr}
      class="card ${frameClass} ${interactiveClass} ${extraClass}"
      style="background-image:url('/cards.png'); background-position:${pos};"></button>`;
}

// 手札専用：カード種別で枠クラスを分ける（市民=銀 / 役職=金）
function handCardHtml(card, canAct) {
  const kindClass = card.type === "citizen" ? "citizen-hand" : "role-hand";
  return cardVisualHtml(card, {
    interactive: canAct,
    disabled: !canAct,
    dataCardId: card.id,
    extraClass: "hand-card " + kindClass,
  });
}

function renderSlotsHtml(cards, minSlots, extraClass) {
  const items = cards.map((c) => cardVisualHtml(c, { extraClass }));
  const totalSlots = Math.max(minSlots, items.length);
  while (items.length < totalSlots) items.push(`<div class="field-slot empty"></div>`);
  return items.join("");
}

function statusCellHtml(mark, num, played) {
  const cls = RED_MARKS.includes(mark) ? "mark-red" : "mark-black";
  return `<div class="status-cell ${cls} ${played ? "played" : ""}">${mark}${num}</div>`;
}

function showModal(html) {
  const overlay = document.getElementById("modalOverlay");
  document.getElementById("modalContent").innerHTML = html;
  overlay.classList.add("show");
}
function closeModal() {
  const overlay = document.getElementById("modalOverlay");
  if (overlay) overlay.classList.remove("show");
}
function showSimpleModal(text) {
  showModal(`<div class="big-text">${text}</div><button onclick="window.__closeModal()">閉じる</button>`);
}
function showError(err) {
  const msg = err instanceof Error ? err.message : String(err);
  showSimpleModal("⚠️ " + msg);
}
function openSheet() {
  document.getElementById("sheetOverlay").classList.add("show");
}
function closeSheet() {
  const overlay = document.getElementById("sheetOverlay");
  if (overlay) overlay.classList.remove("show");
}

const modalOverlayHtml = `<div class="modal-overlay" id="modalOverlay"><div class="modal-box"><div id="modalContent"></div></div></div>`;

function showToast(titleHtml, subHtml) {
  const layer = document.getElementById("toastLayer");
  if (!layer) return;
  const el = document.createElement("div");
  el.className = "toast-banner";
  el.innerHTML = `<div class="toast-title">${titleHtml}</div><div class="toast-sub">${subHtml}</div>`;
  layer.appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));
  setTimeout(() => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 350);
  }, 2200);
}

function showEndOverlay(state) {
  if (document.getElementById("endOverlay")) return;
  const won = state.winner === mySlot;
  const el = document.createElement("div");
  el.id = "endOverlay";
  el.className = "end-overlay";
  el.innerHTML = `
    <div class="end-overlay-inner">
      <div class="end-overlay-title ${won ? "victory" : "defeat"}">${won ? "VICTORY" : "DEFEAT"}</div>
      <div class="end-overlay-sub">勝因：${state.reason} ／ 人狼の正体：${state.wolf.mark}${state.wolf.number}</div>
      <button class="success-btn" id="endOverlayCloseBtn">結果を見る</button>
    </div>`;
  document.body.appendChild(el);
  requestAnimationFrame(() => el.classList.add("show"));
  document.getElementById("endOverlayCloseBtn").onclick = () => {
    el.classList.remove("show");
    setTimeout(() => el.remove(), 350);
  };
}

// --- ランディング ---
function renderLandingScreen() {
  app.innerHTML = `
    <div class="page-pad">
      <div class="landing-wrap">
        <div class="landing-logo">🐺</div>
        <div class="landing-title">トランプ人狼</div>
        <div class="landing-sub">DUAL BLIND DUEL</div>
        <div class="landing-buttons">
          <button class="hero-btn hero-btn-create" id="createRoomBtn"><span class="hero-btn-icon">🏰</span><span>部屋を作る</span></button>
          <button class="hero-btn hero-btn-join" id="showJoinFormBtn"><span class="hero-btn-icon">🚪</span><span>部屋に入る</span></button>
        </div>
        <div class="join-form" id="joinForm" style="display:none;">
          <label>ルームID</label>
          <input type="text" id="joinIdInput" placeholder="例：AB3XQ9" maxlength="6" />
          <button class="hero-btn-join-submit" id="submitJoinBtn">入室する</button>
        </div>
      </div>
    </div>
    ${modalOverlayHtml}`;
  document.getElementById("createRoomBtn").onclick = handleCreateRoom;
  document.getElementById("showJoinFormBtn").onclick = () => {
    document.getElementById("joinForm").style.display = "block";
    document.getElementById("joinIdInput").focus();
  };
  document.getElementById("submitJoinBtn").onclick = handleJoinRoomSubmit;
}
function renderLoading() {
  app.innerHTML = `<div class="page-pad"><div class="landing-wrap"><div class="loading-text">読み込み中...</div></div></div>${modalOverlayHtml}`;
}

async function handleCreateRoom() {
  try {
    const { id } = await Game.createRoom();
    roomId = id; mySlot = "A"; saveSession();
    lastSeenSeq = 0; endAnnounced = false;
    startWatching();
  } catch (err) { showError(err); }
}
async function handleJoinRoomSubmit() {
  const val = document.getElementById("joinIdInput").value;
  if (!val || !val.trim()) { showSimpleModal("ルームIDを入力してください。"); return; }
  try {
    const { id, state } = await Game.joinExisting(val);
    roomId = id; mySlot = "B"; saveSession();
    lastSeenSeq = (state.lastAction && state.lastAction.seq) || 0;
    endAnnounced = state.status === "ended";
    startWatching();
  } catch (err) { showError(err); }
}

function startWatching() {
  if (unsubscribe) unsubscribe();
  unsubscribe = Game.subscribe(roomId, (state) => {
    if (!state) {
      clearSession(); renderLandingScreen();
      showSimpleModal("ルームが見つかりませんでした。");
      return;
    }
    renderGame(state);
    if (state.status === "ended" && !endAnnounced) {
      endAnnounced = true;
      showEndOverlay(state);
    }
  });
}
function leaveRoom() {
  if (unsubscribe) unsubscribe();
  unsubscribe = null;
  roomId = null; mySlot = null;
  clearSession();
  const eo = document.getElementById("endOverlay");
  if (eo) eo.remove();
  renderLandingScreen();
}
function confirmLeaveMidGame() {
  showModal(`
    <div class="big-text">退室しますか？</div>
    <div style="font-size:12px;color:#f4b400;margin-bottom:10px;">対戦中でも自分の画面から抜けられます。</div>
    <button class="danger" onclick="window.__leaveConfirmed()">退室する</button>
    <button class="secondary" onclick="window.__closeModal()">キャンセル</button>`);
}
window.__leaveConfirmed = () => { closeModal(); leaveRoom(); };

// --- ゲーム画面 ---
function renderGame(state) {
  if (state.status === "waiting") renderWaiting(state);
  else renderPlaying(state);
}

function renderWaiting(state) {
  app.innerHTML = `
    <div class="page-pad">
      <div class="duel-header"><div class="duel-title">🐺 トランプ人狼</div></div>
      <div class="room-id-card">
        <div class="room-id-label">ROOM ID</div>
        <div class="room-id-value">${roomId}</div>
        <button class="copy-btn" id="copyIdBtn">📋 コピー</button>
      </div>
      <div class="waiting-panel flat-section panel">
        <div class="flat-label">🕒 対戦相手を待っています</div>
        <div class="player-slot-row">
          <div class="player-slot ${state.players.A ? "ready" : ""}">A ${state.players.A ? "✅" : "…"}</div>
          <div class="vs-mark">VS</div>
          <div class="player-slot ${state.players.B ? "ready" : ""}">B ${state.players.B ? "✅" : "…"}</div>
        </div>
      </div>
      <div class="settings-panel">
        <label>初期情報タイプ</label>
        <select id="infoTypeSelect">
          <option value="除外" ${state.settings.infoType === "除外" ? "selected" : ""}>除外（〇ではない）</option>
          <option value="確定" ${state.settings.infoType === "確定" ? "selected" : ""}>確定（〇である）</option>
        </select>
        <label>勝利条件の枚数（3〜7枚）</label>
        <select id="winCountSelect">
          ${WIN_COUNT_OPTIONS.map((n) => `<option value="${n}" ${state.settings.winCount === n ? "selected" : ""}>${n}枚</option>`).join("")}
        </select>
        <label>ジョーカーの使用コスト（1〜4）</label>
        <select id="jokerCostSelect">
          ${JOKER_COST_OPTIONS.map((n) => `<option value="${n}" ${state.settings.jokerCost === n ? "selected" : ""}>コスト${n}</option>`).join("")}
        </select>
        <button class="secondary" id="saveSettingsBtn">設定を保存</button>
        <button class="hero-btn-create" id="startBtn" ${!(state.players.A && state.players.B) ? "disabled" : ""}>⚔️ ゲーム開始</button>
        <button class="danger" id="leaveBtn">退室する</button>
      </div>
    </div>
    ${modalOverlayHtml}`;

  document.getElementById("copyIdBtn").onclick = () => {
    navigator.clipboard.writeText(roomId).then(() => {
      const btn = document.getElementById("copyIdBtn");
      btn.textContent = "✅ コピーしました";
      setTimeout(() => (btn.textContent = "📋 コピー"), 1500);
    });
  };
  document.getElementById("saveSettingsBtn").onclick = async () => {
    const infoType = document.getElementById("infoTypeSelect").value;
    const winCount = document.getElementById("winCountSelect").value;
    const jokerCost = document.getElementById("jokerCostSelect").value;
    try {
      await Game.updateSettings(roomId, mySlot, infoType, winCount, jokerCost);
      showSimpleModal("設定を保存しました。");
    } catch (err) { showError(err); }
  };
  document.getElementById("startBtn").onclick = async () => {
    try { lastSeenSeq = 0; endAnnounced = false; await Game.start(roomId); }
    catch (err) { showError(err); }
  };
  document.getElementById("leaveBtn").onclick = leaveRoom;
}

function renderPlaying(state) {
  const isEnded = state.status === "ended";
  const opp = opponent(mySlot);
  const isMyTurn = !isEnded && state.currentTurn === mySlot;

  const playedSet = new Set();
  ["A", "B"].forEach((s) =>
    (state.table[s] || []).forEach((c) => { if (c.type === "citizen") playedSet.add(c.mark + c.number); })
  );
  const citizenGridHtml = MARKS.map((mark) =>
    NUMBERS.map((num) => statusCellHtml(mark, num, playedSet.has(mark + num))).join("")
  ).join("");
  const oppHandCount = state.hands?.[opp]?.length ?? 0;

  const oppRoleRow = renderSlotsHtml(state.roleDiscard?.[opp] || [], 6, "field-card");
  const oppCitizenRow = renderSlotsHtml(state.table[opp] || [], 6, "field-card");
  const myCitizenRow = renderSlotsHtml(state.table[mySlot] || [], 6, "field-card");
  const myRoleRow = renderSlotsHtml(state.roleDiscard?.[mySlot] || [], 6, "field-card");

  const constraint = state.constraints ? state.constraints[mySlot] : null;
  let constraintText = "";
  if (!isEnded && constraint) {
    if (constraint.type === "forceAttribute") constraintText = `「${constraint.value}」の市民カードを出す必要があります`;
    if (constraint.type === "blockRoles") constraintText = "役職カードが出せません。市民カードを出してください";
    if (constraint.type === "forceAccuse") constraintText = "今回は告発しか行えません";
  }

  const myCost = (state.costPool?.[mySlot] || 0) + (state.playerMeta?.[mySlot]?.virtualCostUnused ? "+1" : "");
  const oppCost = (state.costPool?.[opp] || 0) + (state.playerMeta?.[opp]?.virtualCostUnused ? "+1" : "");

  const seerLog = state.seerRevealLog?.[mySlot] || [];
  // 「安全な数字（マーク）」を抽出（表示の横並び用）
  const seerValues = (state.seerHistory?.[mySlot] || []);
  const seerLabel = mySlot === "A" ? "安全な数字" : "安全なマーク";
  const latestSeerText = seerLog.length > 0 ? seerLog[seerLog.length - 1] : "";

  let turnChipHtml;
  if (isEnded) {
    const won = state.winner === mySlot;
    turnChipHtml = `<div class="chip turn-chip ${won ? "win-chip" : "lose-chip"}">${won ? "🏆 VICTORY" : "💀 DEFEAT"}</div>`;
  } else {
    turnChipHtml = `<div class="chip turn-chip ${isMyTurn ? "my-turn" : "opp-turn"}">${isMyTurn ? "🎯 あなたのターン" : "⌛ 相手のターン"}</div>`;
  }

  const handHtml = (state.hands?.[mySlot] || [])
    .map((card) => handCardHtml(card, isMyTurn && state.phase === "needAction"))
    .join("");

  const mulliganAvailable =
    !isEnded &&
    state.firstPlayer === mySlot &&
    !state.playerMeta[mySlot].mulliganUsed &&
    !state.playerMeta[mySlot].hasDrawnYet &&
    countCitizens(state.hands[mySlot]) === 0 &&
    state.currentTurn === mySlot;

  const handActionsHtml = isEnded
    ? `<button class="success-btn" id="rematchBtn">🔁 もう一度対戦する</button>
       <button class="danger" id="leaveBtn2">退室する</button>`
    : `${isMyTurn && state.phase === "needDraw" ? `<button id="drawBtn">🎴 山札から引く</button>` : ""}
       ${mulliganAvailable ? `<button class="warning-btn" id="mulliganBtn">🔄 引き直す</button>` : ""}`;

  // 中央上段：中央メッセージ（初期情報＋制約）
  let centerMessage = state.info?.[mySlot] ? `🔎 ${state.info[mySlot]}` : "";
  if (isEnded) centerMessage = `勝因：${state.reason} ／ 人狼：${state.wolf.mark}${state.wolf.number}`;
  const centerConstraint = constraintText ? `<span class="constraint-txt">⚠️ ${constraintText}</span>` : "";

  // 中央下段：占い師で把握した安全情報の横並び
  const seerRow = `
    <span class="seer-label">占い師で把握した${seerLabel}：</span>
    ${seerValues.length > 0
      ? seerValues.map((v) => `<span class="seer-item">${v}</span>`).join("")
      : `<span style="opacity:0.6;">まだありません</span>`}`;

  app.innerHTML = `
    <div class="board-screen">

      <!-- ① ヘッダー -->
      <div class="zone-header">
        <div class="opp-hand-block">
          <div class="opp-hand-mini">
            <div class="card card-back mini-back"></div>
            <span class="opp-hand-count">×${oppHandCount}</span>
          </div>
          <div class="opp-cost-line">コスト：${oppCost}</div>
        </div>
        <div class="header-right">
          <button class="leave-btn-mini" id="leaveHeaderBtn">🚪 退室</button>
          <div class="citizen-mini-grid">${citizenGridHtml}</div>
        </div>
      </div>

      <!-- ② 相手フィールド：役職(外)→市民(内) -->
      <div class="zone-opp-field">
        <div class="slot-row">${oppRoleRow}</div>
        <div class="slot-row">${oppCitizenRow}</div>
      </div>

      <!-- ③ 中央ステータス（2段） -->
      <div class="zone-center">
        <div class="center-top-row">
          <button class="center-log-btn" id="logToggleBtn">📜</button>
          <div class="center-message">
            ${centerMessage || (latestSeerText ? `🔮 ${latestSeerText}` : "&nbsp;")}
            ${centerConstraint}
          </div>
          <div class="deck-pile">
            <span class="deck-pile-label">山札</span>
            <span class="deck-pile-count">${state.drawPile?.length ?? 0}枚</span>
          </div>
        </div>

        <div class="center-action-row">
          ${turnChipHtml}
          <div class="chip">💠 ${myCost}</div>
          ${!isEnded ? `<button class="accuse-btn" id="accuseFab">⚔️ 告発</button>` : ""}
        </div>

        <div class="center-bottom-row">${seerRow}</div>
      </div>

      <!-- ④ 自分フィールド：市民(内)→役職(外) -->
      <div class="zone-my-field">
        <div class="slot-row">${myCitizenRow}</div>
        <div class="slot-row">${myRoleRow}</div>
      </div>

      <!-- ⑤ 自分の手札 -->
      <div class="zone-hand">
        <div class="hand-actions-row">${handActionsHtml}</div>
        <div class="hand-fan-row">${handHtml}</div>
      </div>

      <div class="toast-layer" id="toastLayer"></div>
    </div>

    <div class="sheet-overlay" id="sheetOverlay">
      <div class="sheet">
        <div class="sheet-handle"></div>
        <h3 style="margin:0 0 12px;font-size:15px;">⚔️ 人狼を告発する</h3>
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

  const drawBtn = document.getElementById("drawBtn");
  if (drawBtn) drawBtn.onclick = () => Game.draw(roomId, mySlot).catch(showError);

  const mulliganBtn = document.getElementById("mulliganBtn");
  if (mulliganBtn)
    mulliganBtn.onclick = () => {
      showModal(`
        <div style="color:#f4b400;font-size:13px;margin-bottom:10px;">⚠️ 手札を相手に公開してから引き直します。よろしいですか？</div>
        <button class="warning-btn" onclick="window.__mulligan()">引き直す</button>
        <button class="secondary" onclick="window.__closeModal()">キャンセル</button>`);
    };

  document.querySelectorAll(".hand-card").forEach((btn) => {
    btn.onclick = () => {
      const cardId = btn.dataset.cardId;
      const card = state.hands[mySlot].find((c) => c.id === cardId);
      if (!card) return;
      if (card.type === "citizen") {
        showModal(`
          <div>このカードを出しますか？</div>
          <button onclick="window.__playCitizen('${cardId}')">はい</button>
          <button class="secondary" onclick="window.__closeModal()">キャンセル</button>`);
      } else {
        confirmPlayRole(card);
      }
    };
  });

  const logBtn = document.getElementById("logToggleBtn");
  if (logBtn)
    logBtn.onclick = () => {
      showModal(`
        <div class="flat-label" style="margin-bottom:8px;">📝 ゲームログ</div>
        <div class="log-box" style="text-align:left;">${(state.log || []).map((l) => `<div>${l}</div>`).join("")}</div>
        <button onclick="window.__closeModal()" style="margin-top:12px;">閉じる</button>`);
    };

  const accuseFab = document.getElementById("accuseFab");
  if (accuseFab) accuseFab.onclick = openSheet;
  const cancelAccuse = document.getElementById("cancelAccuse");
  if (cancelAccuse) cancelAccuse.onclick = closeSheet;
  const submitAccuse = document.getElementById("submitAccuse");
  if (submitAccuse)
    submitAccuse.onclick = () => {
      const mark = document.getElementById("accuseMark").value;
      const num = document.getElementById("accuseNumber").value;
      closeSheet();
      showModal(`
        <div>人狼は「${mark}の${num}」だと告発しますか？<br><span style="color:#f4b400;font-size:13px;">外すと即敗北です</span></div>
        <button class="danger" onclick="window.__accuse('${mark}', ${num})">告発する</button>
        <button class="secondary" onclick="window.__closeModal()">キャンセル</button>`);
    };

  const rematchBtn = document.getElementById("rematchBtn");
  if (rematchBtn)
    rematchBtn.onclick = () => {
      lastSeenSeq = 0; endAnnounced = false;
      const eo = document.getElementById("endOverlay");
      if (eo) eo.remove();
      Game.reset(roomId).catch(showError);
    };
  const leaveBtn2 = document.getElementById("leaveBtn2");
  if (leaveBtn2) leaveBtn2.onclick = leaveRoom;

  maybeAnnounceTurn(state);
}

function confirmPlayRole(card) {
  if (card.type === "role" && card.role === "Q") {
    showModal(`
      <div>怪盗の効果：相手に強制する属性を選んでください</div>
      <select id="qAttrSelect"><option value="mark">マーク</option><option value="number">数字</option></select>
      <select id="qValueSelect"></select>
      <button onclick="window.__playRoleQ('${card.id}')">発動する</button>
      <button class="secondary" onclick="window.__closeModal()">キャンセル</button>`);
    const attrSel = document.getElementById("qAttrSelect");
    const valSel = document.getElementById("qValueSelect");
    const refresh = () => {
      valSel.innerHTML =
        attrSel.value === "mark"
          ? MARKS.map((m) => `<option value="${m}">${m}</option>`).join("")
          : NUMBERS.map((n) => `<option value="${n}">${n}</option>`).join("");
    };
    attrSel.onchange = refresh;
    refresh();
    return;
  }
  const label = card.type === "joker" ? "ジョーカー" : "この役職カード";
  showModal(`
    <div>${label}を使用しますか？</div>
    <button onclick="window.__playRole('${card.id}', {})">使用する</button>
    <button class="secondary" onclick="window.__closeModal()">キャンセル</button>`);
}

function maybeAnnounceTurn(state) {
  if (state.status !== "playing") return;
  const la = state.lastAction;
  if (!la || la.seq === lastSeenSeq) return;
  lastSeenSeq = la.seq;
  const actorText = la.actorSlot === mySlot ? "あなたが" : "相手が";
  const nextText = state.currentTurn === mySlot ? "🎯 あなたのターン" : "⌛ 相手のターン";
  showToast(`${actorText}カードを出しました`, nextText);
}

window.__closeModal = closeModal;
window.__playCitizen = (cardId) => { closeModal(); Game.playCitizen(roomId, mySlot, cardId).catch(showError); };
window.__playRole = (cardId, options) => {
  closeModal();
  Game.playRole(roomId, mySlot, cardId, options).catch((err) => {
    if (err.payload?.emergencyAvailable) {
      showModal(`
        <div style="color:#f4b400;font-size:13px;margin-bottom:10px;">⚠️ コストが足りません。手札に市民カードがなく、コストも0のため、緊急セット（裏向きで出す）が可能です。</div>
        <button class="warning-btn" onclick="window.__playRole('${cardId}', {emergencySet:true})">緊急セットする</button>
        <button class="secondary" onclick="window.__closeModal()">キャンセル</button>`);
    } else if (err.payload?.kForcedFacedownAvailable) {
      showModal(`
        <div style="color:#f4b400;font-size:13px;margin-bottom:10px;">⚠️ 騎士の効果により、役職カードは効果を発動できません。手札に市民カードが無いため、裏向きで場に出されます。</div>
        <button class="warning-btn" onclick="window.__playRole('${cardId}', {forceFacedownByBlock:true})">裏向きで出す</button>
        <button class="secondary" onclick="window.__closeModal()">キャンセル</button>`);
    } else { showError(err); }
  });
};
window.__playRoleQ = (cardId) => {
  const attr = document.getElementById("qAttrSelect").value;
  const value = document.getElementById("qValueSelect").value;
  window.__playRole(cardId, { attr, value: attr === "number" ? Number(value) : value });
};
window.__accuse = (mark, num) => { closeModal(); Game.accuse(roomId, mySlot, mark, num).catch(showError); };
window.__mulligan = () => { closeModal(); Game.mulligan(roomId, mySlot).catch(showError); };

function renderCreditBadge() {
  if (document.getElementById("grokCredit")) return;
  const el = document.createElement("div");
  el.id = "grokCredit";
  el.className = "grok-credit";
  el.textContent = "✨ Created with Grok";
  document.body.appendChild(el);
}
renderCreditBadge();

const session = loadSession();
if (session && session.roomId && session.slot) {
  roomId = session.roomId;
  mySlot = session.slot;
  renderLoading();
  startWatching();
} else {
  renderLandingScreen();
}
