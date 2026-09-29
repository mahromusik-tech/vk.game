// ВАЖНО: смените пароль ниже перед тем, как публиковать репозиторий.
// Это единственная защита страницы — если репозиторий публичный, страница
// физически доступна по прямой ссылке любому, кто узнает её адрес.
const ADMIN_PASSPHRASE = "change-me-please";

const SUPABASE_URL = "https://dnkbkytudvhnglnluecc.supabase.co";
const SUPABASE_ANON_KEY = "sb_publishable_qXCffsva69vx26EmgR8SGg_ZaTa6mjh";
const sb = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

const $ = (id) => document.getElementById(id);
let themes = [], achievements = [];
let foundPlayer = null, foundPartner = null, foundCouple = null;

function setMsg(id, text, ok) {
  const el = $(id);
  el.textContent = text;
  el.className = "msg " + (ok ? "ok" : "err");
}

async function loadRefData() {
  const [{ data: t }, { data: a }] = await Promise.all([
    sb.from("themes").select("*").order("price_stars"),
    sb.from("achievements").select("*").order("id"),
  ]);
  themes = t || []; achievements = a || [];
  $("theme-select").innerHTML = themes.map((t) => `<option value="${t.id}">${t.emoji} ${t.title} (${t.price_stars}⭐)</option>`).join("");
  $("achv-select").innerHTML = achievements.map((a) => `<option value="${a.id}">${a.emoji} ${a.title}</option>`).join("");
}

async function findCoupleForPlayer(meId, partnerId) {
  const { data } = await sb.from("couples").select("*")
    .or(`and(player1_id.eq.${meId},player2_id.eq.${partnerId}),and(player1_id.eq.${partnerId},player2_id.eq.${meId})`)
    .maybeSingle();
  return data || null;
}

async function search() {
  const code = $("search-code").value.trim().toUpperCase();
  setMsg("search-msg", "", true);
  $("result-card").style.display = "none";
  $("actions-card").style.display = "none";
  if (!code) { setMsg("search-msg", "Введите код", false); return; }

  const { data: player } = await sb.from("players").select("*").eq("game_code", code).maybeSingle();
  if (!player) { setMsg("search-msg", "Игрок с таким кодом не найден", false); return; }

  foundPlayer = player;
  foundPartner = player.partner_id ? (await sb.from("players").select("*").eq("id", player.partner_id).maybeSingle()).data : null;
  foundCouple = foundPartner ? await findCoupleForPlayer(player.id, foundPartner.id) : null;

  renderResult();
  setMsg("search-msg", "Найдено", true);
}

function levelOf(xp) { const level = Math.floor((xp || 0) / 150) + 1; return `Ур. ${level} (${xp || 0} XP)`; }

async function renderResult() {
  $("result-card").style.display = "block";
  let html = `<div class="player-line"><span>Игрок</span><b>${escapeHtml(foundPlayer.first_name || "—")} (код ${foundPlayer.game_code})</b></div>`;
  if (foundPartner) {
    html += `<div class="player-line"><span>Партнёр</span><b>${escapeHtml(foundPartner.first_name || "—")} (код ${foundPartner.game_code})</b></div>`;
  } else {
    html += `<div class="player-line"><span>Партнёр</span><b>нет пары</b></div>`;
  }
  if (foundCouple) {
    html += `<div class="player-line"><span>Вместе с</span><b>${foundCouple.started_at}</b></div>`;
    html += `<div class="player-line"><span>Уровень пары</span><b>${levelOf(foundCouple.xp)}</b></div>`;

    const { data: owned } = await sb.from("couple_themes").select("theme_id").eq("couple_id", foundCouple.id);
    const ownedIds = new Set((owned || []).map((r) => r.theme_id));
    const ownedTitles = themes.filter((t) => ownedIds.has(t.id)).map((t) => t.title);
    html += `<div class="badge-list">${ownedTitles.length ? ownedTitles.map((t) => `<span class="badge">${escapeHtml(t)}</span>`).join("") : '<span class="badge">без тем</span>'}</div>`;
  }
  $("players-info").innerHTML = html;
  $("actions-card").style.display = foundCouple ? "block" : "none";
  if (!foundCouple) setMsg("search-msg", "У игрока пока нет пары — выдавать тему/XP пока некому", false);
}

function escapeHtml(str) {
  return String(str ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

async function grantTheme() {
  if (!foundCouple) return;
  const themeId = Number($("theme-select").value);
  const { error } = await sb.from("couple_themes").upsert(
    { couple_id: foundCouple.id, theme_id: themeId, source: "admin_grant" },
    { onConflict: "couple_id,theme_id" }
  );
  setMsg("theme-msg", error ? "Ошибка: " + error.message : "Тема выдана ✅", !error);
  if (!error) renderResult();
}

async function grantAchievement() {
  if (!foundCouple) return;
  const achId = Number($("achv-select").value);
  const ids = [foundPlayer.id, foundPartner.id];
  for (const pid of ids) {
    const { data: already } = await sb.from("player_achievements").select("id").eq("player_id", pid).eq("achievement_id", achId).maybeSingle();
    if (already) continue;
    await sb.from("player_achievements").insert({ player_id: pid, achievement_id: achId });
    const ach = achievements.find((a) => a.id === achId);
    await sb.from("notifications").insert({ player_id: pid, type: "achievement", title: `Новое достижение: ${ach?.title || ""}`, body: ach?.description || "" });
  }
  setMsg("achv-msg", "Достижение выдано обоим ✅", true);
}

async function adjustXp() {
  if (!foundCouple) return;
  const amount = Number($("xp-amount").value);
  if (!amount) { setMsg("xp-msg", "Введите ненулевое число", false); return; }
  const { error } = await sb.rpc("increment_couple_xp", { p_couple_id: foundCouple.id, p_amount: amount });
  if (!error) { foundCouple.xp = (foundCouple.xp || 0) + amount; renderResult(); }
  setMsg("xp-msg", error ? "Ошибка: " + error.message : `Готово, новый XP: ${foundCouple.xp}`, !error);
}

async function loadPayments() {
  const { data } = await sb.from("star_payments").select("*").order("created_at", { ascending: false }).limit(20);
  const rows = (data || []).map((p) => {
    const theme = themes.find((t) => t.id === p.theme_id);
    return `<tr><td>${new Date(p.created_at).toLocaleString("ru-RU")}</td><td>${theme ? theme.title : p.theme_id}</td><td>${p.amount_stars}⭐</td><td>${p.status}</td></tr>`;
  }).join("");
  $("payments-table").innerHTML = `<table><tr><th>Когда</th><th>Тема</th><th>Сумма</th><th>Статус</th></tr>${rows || '<tr><td colspan="4">Пока пусто</td></tr>'}</table>`;
}

document.addEventListener("DOMContentLoaded", () => {
  if (sessionStorage.getItem("admin_ok") === "1") unlockApp();

  $("pass-btn").addEventListener("click", () => {
    if ($("pass-input").value === ADMIN_PASSPHRASE) { sessionStorage.setItem("admin_ok", "1"); unlockApp(); }
    else setMsg("pass-msg", "Неверный пароль", false);
  });
  $("pass-input").addEventListener("keydown", (e) => { if (e.key === "Enter") $("pass-btn").click(); });

  $("search-btn").addEventListener("click", search);
  $("search-code").addEventListener("keydown", (e) => { if (e.key === "Enter") search(); });
  $("grant-theme-btn").addEventListener("click", grantTheme);
  $("grant-achv-btn").addEventListener("click", grantAchievement);
  $("xp-btn").addEventListener("click", adjustXp);
  $("load-payments-btn").addEventListener("click", loadPayments);
});

async function unlockApp() {
  $("gate").style.display = "none";
  $("app").style.display = "block";
  await loadRefData();
}
