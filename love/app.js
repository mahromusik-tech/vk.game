// ==========================================================================
// Вдвоём — конфигурация Supabase
// ==========================================================================
const SUPABASE_URL = "https://dnkbkytudvhnglnluecc.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_qXCffsva69vx26EmgR8SGg_ZaTa6mjh";
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const QUESTIONS_PER_GAME = 10;
const NEXT_QUESTION_DELAY_MS = 3000;
const MONTH_NAMES = ["Январь","Февраль","Март","Апрель","Май","Июнь","Июль","Август","Сентябрь","Октябрь","Ноябрь","Декабрь"];
const DOW_LABELS = ["Пн","Вт","Ср","Чт","Пт","Сб","Вс"];

// ==========================================================================
// Состояние приложения
// ==========================================================================
const state = {
  me: null, partner: null, couple: null, tgPhoto: null,
  questionBank: [], activityTypes: [], achievementDefs: [],
  myAchievementCodes: new Set(),
  activityLogs: new Map(), // activity_type_id -> Set(iso dates)
  session: null, currentQuestionIndex: -1,
  youAnswered: false, partnerAnswered: false,
  answeredQuestionIndices: new Set(),
  channels: { me: null, couple: null, session: null },
  advanceTimer: null,
  unreadCount: 0, notifCache: [],
  cal: { year: 0, month: 0, typeId: null },
};

// ==========================================================================
// Утилиты
// ==========================================================================
const $ = (id) => document.getElementById(id);
const show = (el) => { el.hidden = false; };
const hide = (el) => { el.hidden = true; };
const pad2 = (n) => String(n).padStart(2, "0");

function genCode(len = 6) {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  let out = "";
  for (let i = 0; i < len; i++) out += alphabet[Math.floor(Math.random() * alphabet.length)];
  return out;
}
function shuffle(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}
function displayName(p) { return p ? (p.first_name || p.username || "Игрок") : "—"; }
function initials(p) { return (displayName(p) || "🙂").slice(0, 1).toUpperCase(); }
function setAvatar(el, p, photoUrl) {
  if (photoUrl) el.innerHTML = `<img src="${photoUrl}" alt="">`;
  else el.textContent = initials(p);
}
function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function todayISO() {
  const d = new Date();
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}
function isoToDayNum(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return Math.floor(Date.UTC(y, m - 1, d) / 86400000);
}
function pluralRu(n, [one, few, many]) {
  const n100 = Math.abs(n) % 100, n10 = n100 % 10;
  if (n100 > 10 && n100 < 20) return many;
  if (n10 === 1) return one;
  if (n10 > 1 && n10 < 5) return few;
  return many;
}
function formatDateHuman(iso) {
  const [y, m, d] = iso.split("-").map(Number);
  return `${d} ${MONTH_NAMES[m - 1].toLowerCase()} ${y}`;
}
function formatDuration(startIso) {
  const start = new Date(startIso + "T00:00:00");
  const now = new Date();
  if (start > now) return `начнётся ${formatDateHuman(startIso)}`;
  let years = now.getFullYear() - start.getFullYear();
  let months = now.getMonth() - start.getMonth();
  let days = now.getDate() - start.getDate();
  if (days < 0) { months -= 1; days += new Date(now.getFullYear(), now.getMonth(), 0).getDate(); }
  if (months < 0) { months += 12; years -= 1; }
  const parts = [];
  if (years > 0) parts.push(`${years} ${pluralRu(years, ["год", "года", "лет"])}`);
  if (years > 0 || months > 0) parts.push(`${months} ${pluralRu(months, ["месяц", "месяца", "месяцев"])}`);
  parts.push(`${days} ${pluralRu(days, ["день", "дня", "дней"])}`);
  return parts.join(" ");
}

// ==========================================================================
// Telegram / идентификация пользователя
// ==========================================================================
function getTelegramUser() {
  try {
    const tg = window.Telegram && window.Telegram.WebApp;
    if (tg && tg.initDataUnsafe && tg.initDataUnsafe.user) {
      tg.ready(); tg.expand();
      try { tg.setHeaderColor && tg.setHeaderColor("#1c1024"); } catch (e) {}
      try { tg.setBackgroundColor && tg.setBackgroundColor("#1c1024"); } catch (e) {}
      const u = tg.initDataUnsafe.user;
      return { telegram_id: u.id, username: u.username || null, first_name: u.first_name || u.username || "Игрок", photo_url: u.photo_url || null };
    }
  } catch (e) { /* не в Telegram */ }

  let guestId = localStorage.getItem("guest_id");
  if (!guestId) { guestId = "guest_" + Math.floor(Math.random() * 1e12); localStorage.setItem("guest_id", guestId); }
  let guestName = localStorage.getItem("guest_name");
  if (!guestName) { guestName = "Гость " + Math.floor(Math.random() * 900 + 100); localStorage.setItem("guest_name", guestName); }
  let hash = 0;
  for (let i = 0; i < guestId.length; i++) hash = (hash * 31 + guestId.charCodeAt(i)) % 9007199254740991;
  return { telegram_id: hash, username: null, first_name: guestName, photo_url: null };
}

// ==========================================================================
// Игроки
// ==========================================================================
async function ensurePlayer(tgUser) {
  const { data: existing } = await sb.from("players").select("*").eq("telegram_id", tgUser.telegram_id).maybeSingle();
  if (existing) {
    if (existing.first_name !== tgUser.first_name || existing.username !== tgUser.username) {
      const { data: updated } = await sb.from("players").update({ first_name: tgUser.first_name, username: tgUser.username }).eq("id", existing.id).select().single();
      return updated || existing;
    }
    return existing;
  }
  for (let attempt = 0; attempt < 6; attempt++) {
    const code = genCode();
    const { data: inserted, error } = await sb.from("players")
      .insert({ telegram_id: tgUser.telegram_id, username: tgUser.username, first_name: tgUser.first_name, game_code: code })
      .select().single();
    if (!error) return inserted;
    if (error.code !== "23505") throw error;
  }
  throw new Error("Не удалось создать игрока");
}
async function fetchPartner(partnerId) {
  if (!partnerId) return null;
  const { data } = await sb.from("players").select("*").eq("id", partnerId).maybeSingle();
  return data || null;
}
async function findOrCreateCouple(meId, partnerId, startedAt) {
  const { data: existing } = await sb.from("couples").select("*")
    .or(`and(player1_id.eq.${meId},player2_id.eq.${partnerId}),and(player1_id.eq.${partnerId},player2_id.eq.${meId})`)
    .maybeSingle();
  if (existing) return existing;
  const { data: created, error } = await sb.from("couples")
    .insert({ player1_id: meId, player2_id: partnerId, started_at: startedAt || todayISO() })
    .select().single();
  if (error) throw error;
  return created;
}

// ==========================================================================
// Запросы на пару
// ==========================================================================
async function sendPartnerRequest(rawCode, startedAtStr) {
  const msgEl = $("request-msg");
  msgEl.classList.remove("ok");
  const code = rawCode.trim().toUpperCase();
  if (!code) { msgEl.textContent = "Введите код партнёра"; return; }
  if (code === state.me.game_code) { msgEl.textContent = "Это ваш собственный код 🙂"; return; }
  if (!startedAtStr) { msgEl.textContent = "Укажите дату начала отношений"; return; }

  const { data: target } = await sb.from("players").select("*").eq("game_code", code).maybeSingle();
  if (!target) { msgEl.textContent = "Код не найден. Проверьте и попробуйте снова"; return; }
  if (target.partner_id) { msgEl.textContent = "У этого игрока уже есть партнёр"; return; }

  const { data: existingReq } = await sb.from("partner_requests").select("id")
    .eq("from_player_id", state.me.id).eq("to_player_id", target.id).eq("status", "pending").maybeSingle();
  if (existingReq) { msgEl.textContent = "Запрос уже отправлен, ждём ответа"; msgEl.classList.add("ok"); return; }

  const { data: req, error } = await sb.from("partner_requests")
    .insert({ from_player_id: state.me.id, to_player_id: target.id, started_at: startedAtStr })
    .select().single();
  if (error) { msgEl.textContent = "Не получилось отправить запрос, попробуйте ещё раз"; return; }

  await sb.from("notifications").insert({
    player_id: target.id, type: "partner_request", title: "Запрос на пару",
    body: `${displayName(state.me)} хочет стать вашей парой 💌`,
    data: { request_id: req.id, from_player_id: state.me.id, started_at: startedAtStr },
  });
  msgEl.textContent = "Запрос отправлен! Ждём подтверждения 💌";
  msgEl.classList.add("ok");
}

async function acceptPartnerRequest(req) {
  const fromId = req.from_player_id;
  let r = await sb.from("partner_requests").update({ status: "accepted" }).eq("id", req.id); if (r.error) throw r.error;
  r = await sb.from("players").update({ partner_id: fromId }).eq("id", state.me.id); if (r.error) throw r.error;
  r = await sb.from("players").update({ partner_id: state.me.id }).eq("id", fromId); if (r.error) throw r.error;

  state.me.partner_id = fromId;
  state.couple = await findOrCreateCouple(state.me.id, fromId, req.started_at);
  state.partner = await fetchPartner(fromId);
  state.activityLogs = await loadActivityLogs(state.couple.id);
  subscribeCoupleChannel();

  await sb.from("notifications").insert({
    player_id: fromId, type: "partner_accepted", title: "Партнёр подтвердил пару",
    body: `${displayName(state.me)} принял(а) ваш запрос 💞`,
  });

  renderProfileUI(); renderActivitiesUI(); refreshGameTabVisibility();
  await awardToBoth("first_pair");
}

async function unpairPartner() {
  if (!state.partner) return;
  if (!confirm("Точно отвязать партнёра? История активностей останется в базе.")) return;
  await sb.from("players").update({ partner_id: null }).eq("id", state.me.id);
  await sb.from("players").update({ partner_id: null }).eq("id", state.partner.id);
  state.me.partner_id = null; state.partner = null; state.couple = null;
  state.activityLogs = new Map(); state.session = null;
  if (state.channels.couple) { sb.removeChannel(state.channels.couple); state.channels.couple = null; }
  if (state.channels.session) { sb.removeChannel(state.channels.session); state.channels.session = null; }
  renderProfileUI(); renderActivitiesUI(); refreshGameTabVisibility();
}

async function refreshAfterPairing() {
  const { data: fresh } = await sb.from("players").select("*").eq("id", state.me.id).single();
  state.me = fresh;
  state.partner = await fetchPartner(state.me.partner_id);
  if (!state.partner) return;
  state.couple = await findOrCreateCouple(state.me.id, state.partner.id, null);
  state.activityLogs = await loadActivityLogs(state.couple.id);
  subscribeCoupleChannel();
  renderProfileUI(); renderActivitiesUI(); refreshGameTabVisibility();
  const { data: activeExisting } = await sb.from("game_sessions").select("*").eq("couple_id", state.couple.id).eq("status", "active").maybeSingle();
  if (activeExisting) enterGame(activeExisting);
}

// ==========================================================================
// Уведомления
// ==========================================================================
function updateBellBadge() {
  const badge = $("bell-badge");
  if (state.unreadCount > 0) { badge.textContent = state.unreadCount > 9 ? "9+" : String(state.unreadCount); show(badge); }
  else hide(badge);
}
async function loadUnreadCount() {
  const { count } = await sb.from("notifications").select("id", { count: "exact", head: true }).eq("player_id", state.me.id).eq("is_read", false);
  state.unreadCount = count || 0;
  updateBellBadge();
}
function renderNotifications() {
  const list = $("notif-list");
  if (!state.notifCache.length) { list.innerHTML = '<p class="empty-hint">Пока пусто</p>'; return; }
  list.innerHTML = state.notifCache.map((n) => {
    const time = new Date(n.created_at).toLocaleString("ru-RU", { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
    let actions = "";
    if (n.type === "partner_request") {
      actions = `<div class="notif-actions">
        <button class="btn btn-accept" data-action="accept" data-request="${n.data.request_id}" data-from="${n.data.from_player_id}" data-started="${n.data.started_at}">Принять</button>
        <button class="btn btn-decline" data-action="decline" data-request="${n.data.request_id}">Отклонить</button>
      </div>`;
    }
    return `<div class="notif-item ${n.is_read ? "" : "unread"}">
      <div class="notif-title">${escapeHtml(n.title)}</div>
      ${n.body ? `<div class="notif-body">${escapeHtml(n.body)}</div>` : ""}
      <div class="notif-time">${time}</div>
      ${actions}
    </div>`;
  }).join("");
}
async function openNotifPanel() {
  const { data } = await sb.from("notifications").select("*").eq("player_id", state.me.id).order("created_at", { ascending: false }).limit(30);
  state.notifCache = data || [];
  renderNotifications();
  show($("notif-overlay"));
  const unreadIds = state.notifCache.filter((n) => !n.is_read).map((n) => n.id);
  if (unreadIds.length) {
    await sb.from("notifications").update({ is_read: true }).in("id", unreadIds);
    state.notifCache.forEach((n) => (n.is_read = true));
  }
  state.unreadCount = 0;
  updateBellBadge();
}
let toastTimer;
function showToast(text) {
  const el = $("achv-toast");
  el.textContent = text;
  show(el);
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => hide(el), 3500);
}
function subscribeMyNotifications() {
  const ch = sb.channel(`me-${state.me.id}`)
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "notifications", filter: `player_id=eq.${state.me.id}` }, (payload) => {
      state.unreadCount++;
      updateBellBadge();
      if (payload.new.type === "achievement") showToast(`${payload.new.title}`);
      if (payload.new.type === "partner_accepted") refreshAfterPairing();
      if (!$("notif-overlay").hidden) { state.notifCache.unshift(payload.new); renderNotifications(); }
    })
    .subscribe();
  state.channels.me = ch;
}

// ==========================================================================
// Достижения
// ==========================================================================
async function loadAchievementDefs() {
  const { data } = await sb.from("achievements").select("*").order("id");
  return data || [];
}
function renderAchievements() {
  $("achv-grid").innerHTML = state.achievementDefs.map((a) => {
    const unlocked = state.myAchievementCodes.has(a.code);
    return `<div class="achv-badge ${unlocked ? "unlocked" : ""}" title="${escapeHtml(a.description)}">
      <div class="achv-emoji">${a.emoji}</div><div class="achv-title">${escapeHtml(a.title)}</div>
    </div>`;
  }).join("");
}
async function awardToBoth(code) {
  const ach = state.achievementDefs.find((a) => a.code === code);
  if (!ach) return;
  const ids = state.partner ? [state.me.id, state.partner.id] : [state.me.id];
  for (const pid of ids) {
    const { data: already } = await sb.from("player_achievements").select("id").eq("player_id", pid).eq("achievement_id", ach.id).maybeSingle();
    if (already) continue;
    await sb.from("player_achievements").insert({ player_id: pid, achievement_id: ach.id });
    await sb.from("notifications").insert({ player_id: pid, type: "achievement", title: `Новое достижение: ${ach.title}`, body: ach.description });
    if (pid === state.me.id) { state.myAchievementCodes.add(code); renderAchievements(); showToast(`${ach.emoji} Достижение: ${ach.title}`); }
  }
}
async function checkGameAchievements() {
  const { count } = await sb.from("game_sessions").select("id", { count: "exact", head: true }).eq("couple_id", state.couple.id).eq("status", "finished");
  if (count >= 1) await awardToBoth("first_game");
  if (count >= 10) await awardToBoth("ten_games");
}
async function checkActivityAchievements(typeId) {
  const set = state.activityLogs.get(typeId) || new Set();
  const { best } = computeStreak(set);
  if (best >= 7) await awardToBoth("streak_7");
  if (best >= 30) await awardToBoth("streak_30");
  const type = state.activityTypes.find((t) => t.id === typeId);
  if (type && type.code === "walk" && set.size >= 10) await awardToBoth("walk_10");
}

// ==========================================================================
// Активности / стрики / календарь
// ==========================================================================
async function loadActivityTypes() {
  const { data } = await sb.from("activity_types").select("*").order("sort");
  return data || [];
}
async function loadActivityLogs(coupleId) {
  const { data } = await sb.from("activity_logs").select("activity_type_id, log_date").eq("couple_id", coupleId);
  const map = new Map();
  (data || []).forEach((row) => {
    if (!map.has(row.activity_type_id)) map.set(row.activity_type_id, new Set());
    map.get(row.activity_type_id).add(row.log_date);
  });
  return map;
}
function computeStreak(datesSet) {
  if (!datesSet.size) return { current: 0, best: 0 };
  const days = [...datesSet].map(isoToDayNum).sort((a, b) => a - b);
  let best = 1, run = 1;
  for (let i = 1; i < days.length; i++) {
    if (days[i] === days[i - 1] + 1) run++;
    else if (days[i] !== days[i - 1]) run = 1;
    if (run > best) best = run;
  }
  const set = new Set(days);
  const todayNum = isoToDayNum(todayISO());
  let cursor = set.has(todayNum) ? todayNum : (set.has(todayNum - 1) ? todayNum - 1 : null);
  let current = 0;
  while (cursor !== null && set.has(cursor)) { current++; cursor--; }
  return { current, best };
}
function renderActivityGrid() {
  const grid = $("activities-grid");
  grid.innerHTML = state.activityTypes.map((t) => {
    const set = state.activityLogs.get(t.id) || new Set();
    const { current } = computeStreak(set);
    return `<button class="activity-card" data-type="${t.id}">
      <div class="activity-emoji">${t.emoji}</div>
      <div class="activity-label">${escapeHtml(t.label)}</div>
      <div class="activity-streak ${current ? "" : "zero"}">${current ? "🔥 " + current + " дн. подряд" : "нет серии"}</div>
    </button>`;
  }).join("");
}
function renderActivitiesUI() {
  const hasPartner = !!state.partner;
  $("activities-empty").hidden = hasPartner;
  $("activities-grid").hidden = !hasPartner;
  if (hasPartner) renderActivityGrid();
}
function renderCalendar() {
  const { year, month, typeId } = state.cal;
  $("cal-month-label").textContent = `${MONTH_NAMES[month]} ${year}`;
  const grid = $("cal-grid");
  grid.innerHTML = "";
  DOW_LABELS.forEach((l) => { const el = document.createElement("div"); el.className = "cal-dow"; el.textContent = l; grid.appendChild(el); });
  const firstDow = (new Date(year, month, 1).getDay() + 6) % 7;
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const marked = state.activityLogs.get(typeId) || new Set();
  const today = todayISO();
  for (let i = 0; i < firstDow; i++) { const el = document.createElement("div"); el.className = "cal-day outside"; grid.appendChild(el); }
  for (let day = 1; day <= daysInMonth; day++) {
    const iso = `${year}-${pad2(month + 1)}-${pad2(day)}`;
    const btn = document.createElement("button");
    btn.className = "cal-day" + (marked.has(iso) ? " marked" : "") + (iso === today ? " today" : "");
    btn.textContent = String(day);
    btn.addEventListener("click", () => toggleActivityDay(typeId, iso));
    grid.appendChild(btn);
  }
  const { current, best } = computeStreak(marked);
  $("activity-current-streak").textContent = current;
  $("activity-best-streak").textContent = best;
}
function openActivityDetail(type) {
  const now = new Date();
  state.cal = { year: now.getFullYear(), month: now.getMonth(), typeId: type.id };
  $("activity-title").textContent = `${type.emoji} ${type.label}`;
  renderCalendar();
  show($("activity-overlay"));
}
async function toggleActivityDay(typeId, iso) {
  const set = state.activityLogs.get(typeId) || new Set();
  if (set.has(iso)) {
    await sb.from("activity_logs").delete().eq("couple_id", state.couple.id).eq("activity_type_id", typeId).eq("log_date", iso);
    set.delete(iso);
  } else {
    const { error } = await sb.from("activity_logs").insert({ couple_id: state.couple.id, activity_type_id: typeId, log_date: iso, created_by: state.me.id });
    if (!error) set.add(iso);
  }
  state.activityLogs.set(typeId, set);
  renderCalendar();
  renderActivityGrid();
  checkActivityAchievements(typeId);
}

// ==========================================================================
// Канал пары: старт игр партнёром + live-отметки активностей
// ==========================================================================
function subscribeCoupleChannel() {
  if (!state.couple || state.channels.couple) return;
  const ch = sb.channel(`couple-${state.couple.id}`)
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "game_sessions", filter: `couple_id=eq.${state.couple.id}` }, (payload) => {
      if (payload.new.status === "active" && (!state.session || state.session.id !== payload.new.id)) enterGame(payload.new);
    })
    .on("postgres_changes", { event: "*", schema: "public", table: "activity_logs", filter: `couple_id=eq.${state.couple.id}` }, () => {
      loadActivityLogs(state.couple.id).then((map) => {
        state.activityLogs = map;
        renderActivityGrid();
        if (!$("activity-overlay").hidden) renderCalendar();
      });
    })
    .subscribe();
  state.channels.couple = ch;
}

// ==========================================================================
// Вопросы / игра
// ==========================================================================
async function loadQuestionBank() {
  const { data } = await sb.from("questions").select("id, text").order("id");
  return data || [];
}
function questionTextById(id) { return (state.questionBank.find((q) => q.id === id) || {}).text || "…"; }

function refreshGameTabVisibility() {
  const hasPartner = !!state.partner;
  const inSession = !!(state.session && state.session.status === "active");
  $("game-empty").hidden = hasPartner;
  $("game-idle").hidden = !hasPartner || inSession;
  $("game-live").hidden = !inSession;
  $("game-end").hidden = true;
}
async function startGame() {
  if (!state.couple) return;
  const { data: activeExisting } = await sb.from("game_sessions").select("*").eq("couple_id", state.couple.id).eq("status", "active").maybeSingle();
  if (activeExisting) { enterGame(activeExisting); return; }
  const pickedIds = shuffle(state.questionBank.map((q) => q.id)).slice(0, QUESTIONS_PER_GAME);
  const { data: created, error } = await sb.from("game_sessions")
    .insert({ couple_id: state.couple.id, question_ids: pickedIds, current_index: 0, status: "active" })
    .select().single();
  if (error) { alert("Не получилось начать игру. Попробуйте ещё раз."); return; }
  enterGame(created);
}
function buildProgressBar(total) {
  const track = $("progress-track");
  track.innerHTML = "";
  for (let i = 0; i < total; i++) { const seg = document.createElement("div"); seg.className = "progress-seg"; track.appendChild(seg); }
}
function updateProgressBar(currentIndex) {
  document.querySelectorAll("#progress-track .progress-seg").forEach((seg, i) => seg.classList.toggle("done", i <= currentIndex));
}
function resetQuestionUI() {
  hide($("slot-partner")); hide($("slot-you")); hide($("waiting-hint")); hide($("next-hint"));
  $("bubble-partner-text").textContent = ""; $("bubble-you-text").textContent = "";
  const input = $("answer-input");
  input.value = ""; input.disabled = false; $("send-btn").disabled = false;
  state.youAnswered = false; state.partnerAnswered = false;
}
function renderQuestion(index) {
  const ids = state.session.question_ids;
  $("question-text").textContent = questionTextById(ids[index]);
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
  $("game-empty").hidden = true; $("game-idle").hidden = true; $("game-end").hidden = true; $("game-live").hidden = false;
  renderQuestion(state.currentQuestionIndex);
  subscribeSessionChannel(sessionRow.id);
}
function subscribeSessionChannel(sessionId) {
  if (state.channels.session) { sb.removeChannel(state.channels.session); state.channels.session = null; }
  const ch = sb.channel(`session-${sessionId}`)
    .on("postgres_changes", { event: "UPDATE", schema: "public", table: "game_sessions", filter: `id=eq.${sessionId}` }, (payload) => handleSessionUpdate(payload.new))
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "answers", filter: `session_id=eq.${sessionId}` }, (payload) => handleIncomingAnswer(payload.new))
    .subscribe();
  state.channels.session = ch;
}
function handleSessionUpdate(row) {
  state.session = row;
  if (row.status === "finished") {
    if (state.channels.session) { sb.removeChannel(state.channels.session); state.channels.session = null; }
    $("game-live").hidden = true; $("game-end").hidden = false;
    checkGameAchievements();
    return;
  }
  if (row.current_index !== state.currentQuestionIndex) { state.currentQuestionIndex = row.current_index; renderQuestion(state.currentQuestionIndex); }
}
function handleIncomingAnswer(row) {
  if (row.question_index !== state.currentQuestionIndex) return;
  if (row.player_id === state.me.id) { $("bubble-you-text").textContent = row.answer_text; show($("slot-you")); state.youAnswered = true; }
  else { $("bubble-partner-text").textContent = row.answer_text; show($("slot-partner")); state.partnerAnswered = true; }
  if (state.youAnswered && !state.partnerAnswered) show($("waiting-hint")); else hide($("waiting-hint"));
  maybeScheduleAdvance();
}
function maybeScheduleAdvance() {
  if (!(state.youAnswered && state.partnerAnswered)) return;
  if (state.answeredQuestionIndices.has(state.currentQuestionIndex)) return;
  state.answeredQuestionIndices.add(state.currentQuestionIndex);
  hide($("waiting-hint")); show($("next-hint"));
  $("answer-input").disabled = true; $("send-btn").disabled = true;
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
  $("answer-input").disabled = true; $("send-btn").disabled = true;
  const { error } = await sb.from("answers").insert({ session_id: state.session.id, question_index: state.currentQuestionIndex, player_id: state.me.id, answer_text: value });
  if (error && error.code !== "23505") { $("answer-input").disabled = false; $("send-btn").disabled = false; alert("Не получилось отправить ответ, попробуйте ещё раз."); }
}

// ==========================================================================
// Рендер профиля
// ==========================================================================
function renderMe() {
  $("you-name").textContent = displayName(state.me);
  setAvatar($("you-avatar"), state.me, state.tgPhoto);
  $("my-code-inline").textContent = state.me.game_code;
}
function updateDurationDisplay() {
  if (!state.couple) return;
  $("duration-value").textContent = formatDuration(state.couple.started_at);
  $("started-at-label").textContent = formatDateHuman(state.couple.started_at);
}
function renderProfileUI() {
  const hasPartner = !!state.partner;
  $("no-partner-block").hidden = hasPartner;
  $("has-partner-block").hidden = !hasPartner;
  if (hasPartner) { $("partner-name").textContent = displayName(state.partner); setAvatar($("partner-avatar"), state.partner, null); updateDurationDisplay(); }
}

// ==========================================================================
// Вкладки
// ==========================================================================
function switchTab(name) {
  ["profile", "activities", "game"].forEach((t) => { $(`tab-${t}`).hidden = t !== name; });
  document.querySelectorAll(".tab-btn").forEach((b) => b.classList.toggle("active", b.dataset.tab === name));
}

// ==========================================================================
// Инициализация
// ==========================================================================
async function init() {
  const tgUser = getTelegramUser();
  state.tgPhoto = tgUser.photo_url;
  try {
    const [me, questionBank, activityTypes, achievementDefs] = await Promise.all([
      ensurePlayer(tgUser), loadQuestionBank(), loadActivityTypes(), loadAchievementDefs(),
    ]);
    state.me = me; state.questionBank = questionBank; state.activityTypes = activityTypes; state.achievementDefs = achievementDefs;

    subscribeMyNotifications(); // сразу — партнёр может принять/пригласить в любой момент
    loadUnreadCount();

    const { data: myAch } = await sb.from("player_achievements").select("achievement_id").eq("player_id", me.id);
    const idToCode = new Map(achievementDefs.map((a) => [a.id, a.code]));
    state.myAchievementCodes = new Set((myAch || []).map((r) => idToCode.get(r.achievement_id)).filter(Boolean));

    if (me.partner_id) {
      state.partner = await fetchPartner(me.partner_id);
      state.couple = await findOrCreateCouple(me.id, me.partner_id, null);
      subscribeCoupleChannel();
      state.activityLogs = await loadActivityLogs(state.couple.id);
    }
  } catch (e) {
    console.error(e);
    document.querySelector("#view-loading .loader-text").textContent = "Не удалось подключиться. Обновите страницу.";
    return;
  }

  renderMe(); renderProfileUI(); renderActivitiesUI(); renderAchievements(); refreshGameTabVisibility();
  hide($("view-loading")); show($("app-main"));

  if (state.couple) {
    const { data: activeExisting } = await sb.from("game_sessions").select("*").eq("couple_id", state.couple.id).eq("status", "active").maybeSingle();
    if (activeExisting) enterGame(activeExisting);
  }
  setInterval(updateDurationDisplay, 60000);
}

// ==========================================================================
// Обработчики UI
// ==========================================================================
document.addEventListener("DOMContentLoaded", () => {
  $("started-at-input").value = todayISO();
  $("started-at-input").max = todayISO();
  init();

  document.querySelectorAll(".tab-btn").forEach((b) => b.addEventListener("click", () => switchTab(b.dataset.tab)));

  $("copy-code-btn").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText(state.me.game_code); $("copy-code-btn").textContent = "Скопировано"; setTimeout(() => ($("copy-code-btn").textContent = "Копировать"), 1500); } catch (e) {}
  });
  $("send-request-btn").addEventListener("click", () => sendPartnerRequest($("partner-code-input").value, $("started-at-input").value));
  $("unpair-btn").addEventListener("click", unpairPartner);

  $("bell-btn").addEventListener("click", openNotifPanel);
  $("notif-close-btn").addEventListener("click", () => hide($("notif-overlay")));
  $("notif-list").addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-action]");
    if (!btn) return;
    if (btn.dataset.action === "accept") {
      btn.disabled = true;
      try { await acceptPartnerRequest({ id: btn.dataset.request, from_player_id: btn.dataset.from, started_at: btn.dataset.started }); hide($("notif-overlay")); }
      catch (err) { alert("Не получилось принять запрос — возможно, у одного из вас уже есть партнёр."); btn.disabled = false; }
    } else if (btn.dataset.action === "decline") {
      btn.disabled = true;
      await sb.from("partner_requests").update({ status: "declined" }).eq("id", btn.dataset.request);
      btn.closest(".notif-item").remove();
    }
  });

  $("activities-grid").addEventListener("click", (e) => {
    const card = e.target.closest(".activity-card");
    if (!card) return;
    const type = state.activityTypes.find((t) => t.id === Number(card.dataset.type));
    if (type) openActivityDetail(type);
  });
  $("activity-close-btn").addEventListener("click", () => hide($("activity-overlay")));
  $("cal-prev-btn").addEventListener("click", () => { state.cal.month--; if (state.cal.month < 0) { state.cal.month = 11; state.cal.year--; } renderCalendar(); });
  $("cal-next-btn").addEventListener("click", () => { state.cal.month++; if (state.cal.month > 11) { state.cal.month = 0; state.cal.year++; } renderCalendar(); });

  $("start-game-btn").addEventListener("click", startGame);
  $("play-again-btn").addEventListener("click", startGame);
  $("answer-form").addEventListener("submit", (e) => { e.preventDefault(); submitAnswer($("answer-input").value); });
});
