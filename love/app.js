// ==========================================================================
// Вдвоём — конфигурация Supabase
// ==========================================================================
const SUPABASE_URL = "https://dnkbkytudvhnglnluecc.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_qXCffsva69vx26EmgR8SGg_ZaTa6mjh";
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const QUESTIONS_PER_GAME = 10;
const NEXT_QUESTION_DELAY_MS = 3000;

// ==========================================================================
// Состояние приложения
// ==========================================================================
const state = {
  me: null,          // строка из таблицы players
  partner: null,      // строка из таблицы players (или null)
  couple: null,        // строка из таблицы couples (или null)
  questionBank: [],     // все вопросы {id, text}
  session: null,          // текущая игровая сессия
  currentQuestionIndex: -1,
  youAnswered: false,
  partnerAnswered: false,
  answeredQuestionIndices: new Set(), // индексы, для которых уже показали обе бабблы
  channels: { couple: null, session: null },
  advanceTimer: null,
};

// ==========================================================================
// Утилиты DOM
// ==========================================================================
const $ = (id) => document.getElementById(id);
const show = (el) => { el.hidden = false; };
const hide = (el) => { el.hidden = true; };

function showView(name) {
  ["loading", "menu", "game", "end"].forEach((v) => hide($(`view-${v}`)));
  show($(`view-${name}`));
}

function genCode(len = 6) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < len; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}

function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function displayName(p) {
  if (!p) return "—";
  return p.first_name || p.username || "Игрок";
}

function initials(p) {
  const n = displayName(p);
  return n.slice(0, 1).toUpperCase() || "🙂";
}

function setAvatar(el, p, photoUrl) {
  if (photoUrl) {
    el.innerHTML = `<img src="${photoUrl}" alt="">`;
  } else {
    el.textContent = initials(p) || "🙂";
  }
}

// ==========================================================================
// Telegram / идентификация пользователя
// ==========================================================================
function getTelegramUser() {
  try {
    const tg = window.Telegram && window.Telegram.WebApp;
    if (tg && tg.initDataUnsafe && tg.initDataUnsafe.user) {
      tg.ready();
      tg.expand();
      try { tg.setHeaderColor && tg.setHeaderColor("#1c1024"); } catch (e) {}
      try { tg.setBackgroundColor && tg.setBackgroundColor("#1c1024"); } catch (e) {}
      const u = tg.initDataUnsafe.user;
      return {
        telegram_id: u.id,
        username: u.username || null,
        first_name: u.first_name || u.username || "Игрок",
        photo_url: u.photo_url || null,
      };
    }
  } catch (e) { /* not in telegram */ }

  // Фолбэк для теста в обычном браузере (вне Telegram)
  let guestId = localStorage.getItem("guest_id");
  if (!guestId) {
    guestId = "guest_" + Math.floor(Math.random() * 1e12);
    localStorage.setItem("guest_id", guestId);
  }
  let guestName = localStorage.getItem("guest_name");
  if (!guestName) {
    guestName = "Гость " + Math.floor(Math.random() * 900 + 100);
    localStorage.setItem("guest_name", guestName);
  }
  // используем строку -> стабильный псевдо-bigint через хэш
  let hash = 0;
  for (let i = 0; i < guestId.length; i++) hash = (hash * 31 + guestId.charCodeAt(i)) % 9007199254740991;
  return { telegram_id: hash, username: null, first_name: guestName, photo_url: null };
}

// ==========================================================================
// Игроки / привязка партнёра
// ==========================================================================
async function ensurePlayer(tgUser) {
  const { data: existing, error: selErr } = await sb
    .from("players")
    .select("*")
    .eq("telegram_id", tgUser.telegram_id)
    .maybeSingle();
  if (selErr) throw selErr;

  if (existing) {
    if (existing.first_name !== tgUser.first_name || existing.username !== tgUser.username) {
      const { data: updated } = await sb
        .from("players")
        .update({ first_name: tgUser.first_name, username: tgUser.username })
        .eq("id", existing.id)
        .select()
        .single();
      return updated || existing;
    }
    return existing;
  }

  for (let attempt = 0; attempt < 6; attempt++) {
    const code = genCode();
    const { data: inserted, error: insErr } = await sb
      .from("players")
      .insert({
        telegram_id: tgUser.telegram_id,
        username: tgUser.username,
        first_name: tgUser.first_name,
        game_code: code,
      })
      .select()
      .single();
    if (!insErr) return inserted;
    // 23505 = unique_violation -> код занят, пробуем другой
    if (insErr.code !== "23505") throw insErr;
  }
  throw new Error("Не удалось создать игрока, попробуйте ещё раз");
}

async function fetchPartner(partnerId) {
  if (!partnerId) return null;
  const { data } = await sb.from("players").select("*").eq("id", partnerId).maybeSingle();
  return data || null;
}

async function findOrCreateCouple(meId, partnerId) {
  const { data: existing } = await sb
    .from("couples")
    .select("*")
    .or(`and(player1_id.eq.${meId},player2_id.eq.${partnerId}),and(player1_id.eq.${partnerId},player2_id.eq.${meId})`)
    .maybeSingle();
  if (existing) return existing;

  const { data: created, error } = await sb
    .from("couples")
    .insert({ player1_id: meId, player2_id: partnerId })
    .select()
    .single();
  if (error) throw error;
  return created;
}

async function joinPartner(rawCode) {
  const code = rawCode.trim().toUpperCase();
  const msgEl = $("join-msg");
  msgEl.classList.remove("ok");
  if (!code) { msgEl.textContent = "Введите код партнёра"; return; }
  if (code === state.me.game_code) { msgEl.textContent = "Это ваш собственный код 🙂"; return; }

  const { data: partnerRow, error } = await sb
    .from("players")
    .select("*")
    .eq("game_code", code)
    .maybeSingle();
  if (error || !partnerRow) { msgEl.textContent = "Код не найден. Проверьте и попробуйте снова"; return; }

  await sb.from("players").update({ partner_id: partnerRow.id }).eq("id", state.me.id);
  await sb.from("players").update({ partner_id: state.me.id }).eq("id", partnerRow.id);

  state.me.partner_id = partnerRow.id;
  state.partner = partnerRow;
  state.couple = await findOrCreateCouple(state.me.id, partnerRow.id);

  msgEl.textContent = "Готово! Вы в паре 💞";
  msgEl.classList.add("ok");
  renderPairing();
  subscribeCoupleChannel();
}

async function unpairPartner() {
  if (!state.partner) return;
  await sb.from("players").update({ partner_id: null }).eq("id", state.me.id);
  await sb.from("players").update({ partner_id: null }).eq("id", state.partner.id);
  state.me.partner_id = null;
  state.partner = null;
  state.couple = null;
  if (state.channels.couple) { sb.removeChannel(state.channels.couple); state.channels.couple = null; }
  renderPairing();
}

// ==========================================================================
// Вопросы
// ==========================================================================
async function loadQuestionBank() {
  const { data, error } = await sb.from("questions").select("id, text").order("id");
  if (error || !data || !data.length) {
    console.error("Не удалось загрузить вопросы из БД", error);
    return [];
  }
  return data;
}

function questionTextById(id) {
  const q = state.questionBank.find((q) => q.id === id);
  return q ? q.text : "…";
}

// ==========================================================================
// Рендер: меню / привязка партнёра
// ==========================================================================
function renderMe() {
  $("you-name").textContent = displayName(state.me);
  setAvatar($("you-avatar"), state.me, state.tgPhoto);
  $("my-code").textContent = state.me.game_code;
}

function renderPairing() {
  const hasPartner = !!state.partner;
  $("pair-block-empty").hidden = hasPartner;
  $("pair-block-ready").hidden = !hasPartner;
  $("lobby-waiting").hidden = true;
  if (hasPartner) {
    $("partner-name").textContent = displayName(state.partner);
    setAvatar($("partner-avatar"), state.partner, null);
  }
}

// ==========================================================================
// Realtime: канал пары (моя карточка игрока + игровые сессии)
// ==========================================================================
function subscribeCoupleChannel() {
  if (!state.couple || state.channels.couple) return;
  const ch = sb
    .channel(`couple-${state.couple.id}`)
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "players", filter: `id=eq.${state.me.id}` },
      async (payload) => {
        const row = payload.new;
        if (row.partner_id && (!state.partner || state.partner.id !== row.partner_id)) {
          state.partner = await fetchPartner(row.partner_id);
          state.couple = await findOrCreateCouple(state.me.id, state.partner.id);
          renderPairing();
        }
        if (!row.partner_id && state.partner) {
          state.partner = null;
          renderPairing();
        }
      }
    )
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "game_sessions", filter: `couple_id=eq.${state.couple.id}` },
      (payload) => {
        if (payload.new.status === "active" && (!state.session || state.session.id !== payload.new.id)) {
          enterGame(payload.new);
        }
      }
    )
    .subscribe();
  state.channels.couple = ch;
}

// ==========================================================================
// Игра: запуск / прогресс / ответы
// ==========================================================================
async function startGame() {
  if (!state.couple) return;
  const { data: activeExisting } = await sb
    .from("game_sessions")
    .select("*")
    .eq("couple_id", state.couple.id)
    .eq("status", "active")
    .maybeSingle();
  if (activeExisting) { enterGame(activeExisting); return; }

  const pickedIds = shuffle(state.questionBank.map((q) => q.id)).slice(0, QUESTIONS_PER_GAME);
  const { data: created, error } = await sb
    .from("game_sessions")
    .insert({ couple_id: state.couple.id, question_ids: pickedIds, current_index: 0, status: "active" })
    .select()
    .single();
  if (error) { alert("Не получилось начать игру. Попробуйте ещё раз."); return; }
  enterGame(created);
}

function buildProgressBar(total) {
  const track = $("progress-track");
  track.innerHTML = "";
  for (let i = 0; i < total; i++) {
    const seg = document.createElement("div");
    seg.className = "progress-seg";
    track.appendChild(seg);
  }
}

function updateProgressBar(currentIndex) {
  const segs = document.querySelectorAll("#progress-track .progress-seg");
  segs.forEach((seg, i) => seg.classList.toggle("done", i <= currentIndex));
}

function resetQuestionUI() {
  hide($("slot-partner"));
  hide($("slot-you"));
  hide($("waiting-hint"));
  hide($("next-hint"));
  $("bubble-partner-text").textContent = "";
  $("bubble-you-text").textContent = "";
  const input = $("answer-input");
  input.value = "";
  input.disabled = false;
  $("send-btn").disabled = false;
  state.youAnswered = false;
  state.partnerAnswered = false;
}

function renderQuestion(index) {
  const ids = state.session.question_ids;
  const qId = ids[index];
  $("question-text").textContent = questionTextById(qId);
  $("q-index").textContent = String(index + 1);
  $("q-total").textContent = String(ids.length);
  updateProgressBar(index);
  resetQuestionUI();
}

function enterGame(sessionRow) {
  state.session = sessionRow;
  state.currentQuestionIndex = sessionRow.current_index;
  state.answeredQuestionIndices = new Set();
  buildProgressBar(sessionRow.question_ids.length);
  $("bubble-partner-name").textContent = displayName(state.partner);
  setAvatar($("bubble-partner-avatar"), state.partner, null);
  setAvatar($("bubble-you-avatar"), state.me, state.tgPhoto);
  showView("game");
  renderQuestion(state.currentQuestionIndex);
  subscribeSessionChannel(sessionRow.id);
}

function subscribeSessionChannel(sessionId) {
  if (state.channels.session) { sb.removeChannel(state.channels.session); state.channels.session = null; }
  const ch = sb
    .channel(`session-${sessionId}`)
    .on(
      "postgres_changes",
      { event: "UPDATE", schema: "public", table: "game_sessions", filter: `id=eq.${sessionId}` },
      (payload) => handleSessionUpdate(payload.new)
    )
    .on(
      "postgres_changes",
      { event: "INSERT", schema: "public", table: "answers", filter: `session_id=eq.${sessionId}` },
      (payload) => handleIncomingAnswer(payload.new)
    )
    .subscribe();
  state.channels.session = ch;
}

function handleSessionUpdate(row) {
  state.session = row;
  if (row.status === "finished") {
    if (state.channels.session) { sb.removeChannel(state.channels.session); state.channels.session = null; }
    showView("end");
    return;
  }
  if (row.current_index !== state.currentQuestionIndex) {
    state.currentQuestionIndex = row.current_index;
    renderQuestion(state.currentQuestionIndex);
  }
}

function handleIncomingAnswer(row) {
  if (row.question_index !== state.currentQuestionIndex) return; // ответ на уже прошедший вопрос
  const isMine = row.player_id === state.me.id;
  if (isMine) {
    $("bubble-you-text").textContent = row.answer_text;
    show($("slot-you"));
    state.youAnswered = true;
  } else {
    $("bubble-partner-text").textContent = row.answer_text;
    show($("slot-partner"));
    state.partnerAnswered = true;
  }
  updateWaitingHint();
  maybeScheduleAdvance();
}

function updateWaitingHint() {
  if (state.youAnswered && !state.partnerAnswered) show($("waiting-hint"));
  else hide($("waiting-hint"));
}

function maybeScheduleAdvance() {
  if (!(state.youAnswered && state.partnerAnswered)) return;
  if (state.answeredQuestionIndices.has(state.currentQuestionIndex)) return; // уже запланировано
  state.answeredQuestionIndices.add(state.currentQuestionIndex);
  hide($("waiting-hint"));
  show($("next-hint"));
  $("answer-input").disabled = true;
  $("send-btn").disabled = true;

  const oldIndex = state.currentQuestionIndex;
  const total = state.session.question_ids.length;
  clearTimeout(state.advanceTimer);
  state.advanceTimer = setTimeout(async () => {
    const isLast = oldIndex + 1 >= total;
    const patch = isLast ? { status: "finished" } : { current_index: oldIndex + 1 };
    await sb.from("game_sessions").update(patch).eq("id", state.session.id).eq("current_index", oldIndex);
  }, NEXT_QUESTION_DELAY_MS);
}

async function submitAnswer(text) {
  const value = text.trim();
  if (!value || !state.session) return;
  $("answer-input").disabled = true;
  $("send-btn").disabled = true;
  const { error } = await sb.from("answers").insert({
    session_id: state.session.id,
    question_index: state.currentQuestionIndex,
    player_id: state.me.id,
    answer_text: value,
  });
  if (error) {
    if (error.code !== "23505") { // не дубликат — реальная ошибка
      $("answer-input").disabled = false;
      $("send-btn").disabled = false;
      alert("Не получилось отправить ответ, попробуйте ещё раз.");
    }
  }
}

// ==========================================================================
// Инициализация приложения
// ==========================================================================
async function init() {
  showView("loading");
  const tgUser = getTelegramUser();
  state.tgPhoto = tgUser.photo_url;

  try {
    state.me = await ensurePlayer(tgUser);
    state.questionBank = await loadQuestionBank();
    state.partner = await fetchPartner(state.me.partner_id);
    if (state.partner) state.couple = await findOrCreateCouple(state.me.id, state.partner.id);
  } catch (e) {
    console.error(e);
    $("view-loading").querySelector(".loader-text").textContent =
      "Не удалось подключиться. Проверьте соединение и обновите страницу.";
    return;
  }

  renderMe();
  renderPairing();
  showView("menu");
  if (state.couple) subscribeCoupleChannel();

  // Если у пары уже есть активная игра — сразу входим в неё
  if (state.couple) {
    const { data: activeExisting } = await sb
      .from("game_sessions")
      .select("*")
      .eq("couple_id", state.couple.id)
      .eq("status", "active")
      .maybeSingle();
    if (activeExisting) enterGame(activeExisting);
  }
}

// ==========================================================================
// Обработчики событий UI
// ==========================================================================
document.addEventListener("DOMContentLoaded", () => {
  init();

  $("copy-code-btn").addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(state.me.game_code);
      $("copy-code-btn").textContent = "Скопировано";
      setTimeout(() => ($("copy-code-btn").textContent = "Скопировать"), 1500);
    } catch (e) { /* clipboard недоступен */ }
  });

  $("join-btn").addEventListener("click", () => joinPartner($("partner-code-input").value));
  $("partner-code-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); joinPartner($("partner-code-input").value); }
  });

  $("unpair-btn").addEventListener("click", unpairPartner);
  $("start-game-btn").addEventListener("click", startGame);

  $("answer-form").addEventListener("submit", (e) => {
    e.preventDefault();
    const input = $("answer-input");
    submitAnswer(input.value);
  });

  $("play-again-btn").addEventListener("click", () => { showView("menu"); startGame(); });
  $("to-menu-btn").addEventListener("click", () => { showView("menu"); renderPairing(); });
});
