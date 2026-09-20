// public/effects.js
// トランプ人狼 - 派手演出アドオン（既存ファイルは一切変更しません）
(function () {
  const STYLE_ID = "tj-fx-style";
  if (!document.getElementById(STYLE_ID)) {
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      /* 市民カード：緑のほわほわオーラ（手札） */
      .hand-card.suit-black, .hand-card.suit-red {
        animation: tjAuraPulse 2.2s ease-in-out infinite;
      }
      @keyframes tjAuraPulse {
        0%, 100% {
          box-shadow: 0 2px 6px rgba(0,0,0,0.6), inset 0 0 0 1px rgba(255,255,255,0.1),
                      0 0 6px rgba(90,255,140,0.35);
        }
        50% {
          box-shadow: 0 2px 6px rgba(0,0,0,0.6), inset 0 0 0 1px rgba(255,255,255,0.1),
                      0 0 24px rgba(90,255,140,0.9), 0 0 42px rgba(90,255,140,0.35);
        }
      }

      /* 役職カード：キラキラ光の帯（手札・場の両方） */
      .card.role-frame {
        position: relative;
      }
      .card.role-frame::after {
        content: "";
        position: absolute;
        inset: 0;
        background: linear-gradient(115deg, transparent 35%, rgba(255,255,255,0.9) 50%, transparent 65%);
        background-size: 260% 260%;
        mix-blend-mode: screen;
        animation: tjSparkle 2.4s linear infinite;
        pointer-events: none;
      }
      @keyframes tjSparkle {
        0%   { background-position: -140% -140%; }
        100% { background-position: 140% 140%; }
      }

      /* リーチ演出：勝利まであと1枚の枠がぷおんぷおん */
      .field-slot.empty.tj-reach {
        border-color: #ffd700 !important;
        background: rgba(255,215,0,0.14) !important;
        animation: tjReachPump 0.85s ease-in-out infinite;
      }
      @keyframes tjReachPump {
        0%, 100% { transform: scale(1);    box-shadow: 0 0 8px rgba(255,215,0,0.4); }
        50%      { transform: scale(1.18); box-shadow: 0 0 26px rgba(255,215,0,0.95); }
      }
    `;
    document.head.appendChild(style);
  }

  // 自分の市民カード列を見て「あと1枠で勝利」を検出する
  function applyReachEffect() {
    document.querySelectorAll(".field-slot.tj-reach").forEach((el) => el.classList.remove("tj-reach"));
    const row = document.querySelector(".zone-my-field .slot-row:first-child");
    if (!row) return;
    const slots = Array.from(row.children);
    const emptySlots = slots.filter((el) => el.classList.contains("field-slot") && el.classList.contains("empty"));
    if (emptySlots.length === 1) {
      emptySlots[0].classList.add("tj-reach");
    }
  }

  let scheduled = false;
  function scheduleRun() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; applyReachEffect(); });
  }

  // main.js は再描画のたびに innerHTML を丸ごと入れ替えるため、
  // MutationObserver でDOM変化を監視して効果を再適用する
  const observer = new MutationObserver(scheduleRun);
  observer.observe(document.body, { childList: true, subtree: true });

  scheduleRun();
})();
