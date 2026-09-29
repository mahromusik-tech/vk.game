-- ============================================================================
-- "Вдвоём" — схема Supabase v2 (профиль, приглашения, активности, ачивки)
-- Скрипт идемпотентный — его можно выполнить повторно поверх уже
-- существующей базы (созданной первой версией supabase-setup.sql).
-- Dashboard → SQL Editor → New query → вставить целиком → Run.
-- ============================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- 1. Игроки (без изменений, создаётся если отсутствует)
-- ---------------------------------------------------------------------------
create table if not exists players (
  id           uuid primary key default gen_random_uuid(),
  telegram_id  bigint unique not null,
  username     text,
  first_name   text,
  game_code    text unique not null,
  partner_id   uuid references players(id) on delete set null,
  created_at   timestamptz not null default now()
);

-- у игрока может быть только один партнёр (симметрично)
do $$ begin
  if not exists (select 1 from pg_constraint where conname = 'uq_players_partner') then
    alter table players add constraint uq_players_partner unique (partner_id);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 2. Пары + дата начала отношений
-- ---------------------------------------------------------------------------
create table if not exists couples (
  id          uuid primary key default gen_random_uuid(),
  player1_id  uuid not null references players(id) on delete cascade,
  player2_id  uuid not null references players(id) on delete cascade,
  started_at  date not null default current_date,
  created_at  timestamptz not null default now(),
  unique (player1_id, player2_id)
);
alter table couples add column if not exists started_at date not null default current_date;

-- ---------------------------------------------------------------------------
-- 3. Запросы на создание пары
-- ---------------------------------------------------------------------------
create table if not exists partner_requests (
  id             uuid primary key default gen_random_uuid(),
  from_player_id uuid not null references players(id) on delete cascade,
  to_player_id   uuid not null references players(id) on delete cascade,
  started_at     date not null default current_date,
  status         text not null default 'pending' check (status in ('pending','accepted','declined','cancelled')),
  created_at     timestamptz not null default now()
);
create index if not exists idx_partner_requests_to on partner_requests(to_player_id, status);

-- ---------------------------------------------------------------------------
-- 4. Уведомления (приглашения, достижения, системные сообщения)
-- ---------------------------------------------------------------------------
create table if not exists notifications (
  id         uuid primary key default gen_random_uuid(),
  player_id  uuid not null references players(id) on delete cascade,
  type       text not null, -- partner_request | partner_accepted | partner_declined | achievement
  title      text not null,
  body       text,
  data       jsonb not null default '{}'::jsonb,
  is_read    boolean not null default false,
  created_at timestamptz not null default now()
);
create index if not exists idx_notifications_player on notifications(player_id, is_read);

-- ---------------------------------------------------------------------------
-- 5. Вопросы для игры (без изменений)
-- ---------------------------------------------------------------------------
create table if not exists questions (
  id   serial primary key,
  text text not null
);

-- ---------------------------------------------------------------------------
-- 6. Игровые сессии и ответы (без изменений)
-- ---------------------------------------------------------------------------
create table if not exists game_sessions (
  id             uuid primary key default gen_random_uuid(),
  couple_id      uuid not null references couples(id) on delete cascade,
  question_ids   int[] not null,
  current_index  int not null default 0,
  status         text not null default 'active' check (status in ('active', 'finished')),
  created_at     timestamptz not null default now()
);

create table if not exists answers (
  id              uuid primary key default gen_random_uuid(),
  session_id      uuid not null references game_sessions(id) on delete cascade,
  question_index  int not null,
  player_id       uuid not null references players(id) on delete cascade,
  answer_text     text not null,
  created_at      timestamptz not null default now(),
  unique (session_id, question_index, player_id)
);

-- ---------------------------------------------------------------------------
-- 7. Типы активностей ("Прогулка", "Секс" и т.д.) + отметки по дням
-- ---------------------------------------------------------------------------
create table if not exists activity_types (
  id     serial primary key,
  code   text unique not null,
  label  text not null,
  emoji  text not null,
  sort   int not null default 0
);

create table if not exists activity_logs (
  id               uuid primary key default gen_random_uuid(),
  couple_id        uuid not null references couples(id) on delete cascade,
  activity_type_id int not null references activity_types(id) on delete cascade,
  log_date         date not null,
  created_by       uuid not null references players(id) on delete cascade,
  created_at       timestamptz not null default now(),
  unique (couple_id, activity_type_id, log_date)
);
create index if not exists idx_activity_logs_lookup on activity_logs(couple_id, activity_type_id);

-- ---------------------------------------------------------------------------
-- 8. Достижения
-- ---------------------------------------------------------------------------
create table if not exists achievements (
  id          serial primary key,
  code        text unique not null,
  title       text not null,
  description text not null,
  emoji       text not null
);

create table if not exists player_achievements (
  id             uuid primary key default gen_random_uuid(),
  player_id      uuid not null references players(id) on delete cascade,
  achievement_id int not null references achievements(id) on delete cascade,
  unlocked_at    timestamptz not null default now(),
  unique (player_id, achievement_id)
);

-- ---------------------------------------------------------------------------
-- 9. Индексы
-- ---------------------------------------------------------------------------
create index if not exists idx_answers_session on answers(session_id);
create index if not exists idx_sessions_couple on game_sessions(couple_id);
create index if not exists idx_players_partner on players(partner_id);

-- ---------------------------------------------------------------------------
-- 10. RLS — открытые политики (см. пояснение в README про безопасность)
-- ---------------------------------------------------------------------------
alter table players             enable row level security;
alter table couples             enable row level security;
alter table partner_requests    enable row level security;
alter table notifications       enable row level security;
alter table questions           enable row level security;
alter table game_sessions       enable row level security;
alter table answers             enable row level security;
alter table activity_types      enable row level security;
alter table activity_logs       enable row level security;
alter table achievements        enable row level security;
alter table player_achievements enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where policyname = 'players_all') then
    create policy "players_all" on players for all using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where policyname = 'couples_all') then
    create policy "couples_all" on couples for all using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where policyname = 'partner_requests_all') then
    create policy "partner_requests_all" on partner_requests for all using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where policyname = 'notifications_all') then
    create policy "notifications_all" on notifications for all using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where policyname = 'questions_ro') then
    create policy "questions_ro" on questions for select using (true);
  end if;
  if not exists (select 1 from pg_policies where policyname = 'sessions_all') then
    create policy "sessions_all" on game_sessions for all using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where policyname = 'answers_all') then
    create policy "answers_all" on answers for all using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where policyname = 'activity_types_ro') then
    create policy "activity_types_ro" on activity_types for select using (true);
  end if;
  if not exists (select 1 from pg_policies where policyname = 'activity_logs_all') then
    create policy "activity_logs_all" on activity_logs for all using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies where policyname = 'achievements_ro') then
    create policy "achievements_ro" on achievements for select using (true);
  end if;
  if not exists (select 1 from pg_policies where policyname = 'player_achievements_all') then
    create policy "player_achievements_all" on player_achievements for all using (true) with check (true);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 11. Realtime — публикация для live-обновлений
-- ---------------------------------------------------------------------------
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='game_sessions') then
    alter publication supabase_realtime add table game_sessions;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='answers') then
    alter publication supabase_realtime add table answers;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='players') then
    alter publication supabase_realtime add table players;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='notifications') then
    alter publication supabase_realtime add table notifications;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='activity_logs') then
    alter publication supabase_realtime add table activity_logs;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='player_achievements') then
    alter publication supabase_realtime add table player_achievements;
  end if;
end $$;

-- ============================================================================
-- 12. Сиды: вопросы (вставятся, только если таблица ещё пуста)
-- ============================================================================
insert into questions (text)
select v.text from (values
('Какая моя привычка тебя больше всего умиляет?'),
('Опиши наше первое свидание одним словом.'),
('Какое моё качество ты бы хотел(а) перенять?'),
('Если бы мы могли телепортироваться куда угодно прямо сейчас, куда бы ты выбрал(а)?'),
('Какая наша совместная фотография твоя любимая и почему?'),
('Что я делаю, когда злюсь, и как ты это терпишь?'),
('Опиши меня тремя словами.'),
('Какой подарок от меня запомнился тебе больше всего?'),
('Если бы у нас был семейный герб, что бы на нём было изображено?'),
('Какую песню ты бы назвал(а) нашей?'),
('Что тебе снилось обо мне хоть раз?'),
('Какая моя суперсила, по-твоему?'),
('В чём мы с тобой похожи больше всего?'),
('Чем мы отличаемся сильнее всего?'),
('Какое совместное решение было самым удачным?'),
('Если бы мы завели питомца, кого бы выбрал(а)?'),
('Какая моя фраза застряла у тебя в голове?'),
('Опиши идеальное воскресенье с тобой.'),
('Что я готовлю лучше всего (или хуже всего)?'),
('Какой была твоя первая мысль обо мне?'),
('Если бы наши отношения были фильмом, как бы он назывался?'),
('Что тебя удивило во мне больше всего за время отношений?'),
('Какая наша традиция тебе нравится больше всего?'),
('Куда бы ты хотел(а) поехать со мной в следующий отпуск?'),
('Какой мой недостаток ты научился(лась) любить?'),
('Что мы вместе делаем лучше, чем поодиночке?'),
('Какое моё увлечение тебе непонятно, но мило?'),
('Если бы можно было прожить один наш день заново, какой бы выбрал(а)?'),
('Какая моя привычка иногда тебя раздражает (по-доброму)?'),
('Что тебе больше всего запомнилось из моих комплиментов?'),
('Каким ты видишь нас через 10 лет?'),
('Какой момент ты бы назвал переломным в наших отношениях?'),
('Что я умею делать руками лучше тебя?'),
('Какая наша ссора закончилась смешнее всего?'),
('Если бы я был(а) супергероем, какая у меня была бы способность?'),
('Какую мою черту характера ты заметил(а) не сразу?'),
('Что нас объединяет, кроме отношений?'),
('Какое место у нас "наше особенное"?'),
('Если бы мы писали книгу о нас, как назывался бы её первый эпизод?'),
('Что ты ценишь во мне больше всего именно сегодня?'),
('Какая моя привычка в быту тебя веселит?'),
('Что я говорю чаще всего, когда мы ссоримся?'),
('Какой сюрприз от меня был для тебя самым неожиданным?'),
('Если бы у нас была одна суперспособность на двоих, какая?'),
('Какую мелочь я делаю, которая показывает, что я забочусь?'),
('Что тебе нравится в том, как мы миримся после ссор?'),
('Какой наш совместный смешной момент вспоминается чаще всего?'),
('Что бы ты хотел(а) чаще слышать от меня?'),
('Какая моя привычка напоминает тебе, почему ты меня выбрал(а)?'),
('Если бы можно было добавить один пункт в наши отношения прямо сейчас, что бы это было?')
) as v(text)
where not exists (select 1 from questions);

-- ============================================================================
-- 13. Сиды: типы активностей (upsert по code)
-- ============================================================================
insert into activity_types (code, label, emoji, sort) values
('walk',      'Прогулка',        '🚶', 1),
('sex',       'Секс',            '💋', 2),
('slept_over','Спали вместе',    '🌙', 3),
('met',       'Виделись',        '👀', 4),
('date',      'Свидание',        '🍷', 5),
('gift',      'Подарок',         '🎁', 6)
on conflict (code) do nothing;

-- ============================================================================
-- 14. Сиды: достижения (upsert по code)
-- ============================================================================
insert into achievements (code, title, description, emoji) values
('first_pair',  'Пара сформирована', 'Создали пару в приложении',                   '💞'),
('first_game',  'Первая игра',       'Прошли первую совместную игру до конца',       '🎮'),
('ten_games',   'Знатоки друг друга','Сыграли вместе 10 игр',                        '🧠'),
('streak_7',    'Неделя вместе',     'Серия в 7 дней подряд по любой активности',     '🔥'),
('streak_30',   'Месяц привычки',    'Серия в 30 дней подряд по любой активности',    '🏆'),
('walk_10',     'Любители прогулок', '10 отметок «Прогулка»',                         '🚶')
on conflict (code) do nothing;

-- ============================================================================
-- v3: выбор игр (классика / 36 вопросов / угадай ответ), уровень пары,
--     магазин тем за Telegram Stars. Идемпотентно, безопасно перезапускать.
-- ============================================================================

-- ---------------------------------------------------------------------------
-- 15. Типы игр
-- ---------------------------------------------------------------------------
create table if not exists game_types (
  code         text primary key,        -- 'classic' | 'deep36' | 'guess'
  title        text not null,
  description  text not null,
  emoji        text not null,
  mechanic     text not null check (mechanic in ('answer_only','answer_and_guess')),
  question_pool text not null,          -- значение questions.pool
  rounds       int not null,            -- сколько вопросов в игре
  ordered      boolean not null default false, -- играть по порядку, без перемешивания
  sort         int not null default 0
);

-- ---------------------------------------------------------------------------
-- 16. Вопросы: пул + новый набор "36 вопросов, чтобы влюбиться"
-- ---------------------------------------------------------------------------
alter table questions add column if not exists pool text not null default 'general';

insert into questions (text, pool)
select v.text, 'deep36' from (values
('Если бы ты мог(ла) поужинать с любым человеком в мире, кого бы выбрал(а)?'),
('Что для тебя означает «идеальное утро»?'),
('Каким был твой самый нелепый детский страх?'),
('Если бы завтра ты проснулся(лась) с новым талантом, каким бы хотел(а) его получить?'),
('Какая мелодия или звук моментально поднимает тебе настроение?'),
('Опиши, каким был твой типичный день в 10 лет.'),
('Какая еда напоминает тебе о доме?'),
('Если бы у тебя был свободный год без забот о деньгах, чем бы ты занялся(лась)?'),
('Какая у тебя есть привычка, о которой мало кто знает?'),
('Что бы ты выбрал(а): путешествовать всю жизнь без денег или жить богато, не выходя из города?'),
('Какой фильм или книга изменили то, как ты смотришь на мир?'),
('Если бы можно было мгновенно выучить один язык, какой бы выбрал(а)?'),
('Когда ты в последний раз плакал(а) при других людях и почему?'),
('Что в жизни ты сделал(а), чем действительно гордишься, но редко об этом говоришь?'),
('Какое качество в людях ты не готов(а) терпеть?'),
('Расскажи о моменте, когда почувствовал(а) себя по-настоящему одиноким(ой).'),
('Что тебе легче всего простить, а что — почти невозможно?'),
('Какой была самая большая ложь, которую ты когда-либо говорил(а) близкому человеку?'),
('Если бы ты знал(а), что через год умрёшь, что бы изменил(а) в своей жизни прямо сейчас?'),
('Какое воспоминание о семье ты бы хотел(а) пережить заново?'),
('Что тебя пугает в старении?'),
('Расскажи о человеке, который сильнее всего на тебя повлиял, и почему.'),
('Какую черту характера ты унаследовал(а) от родителей и не хочешь этого?'),
('Когда ты в последний раз чувствовал(а) себя по-настоящему счастливым(ой) без особой причины?'),
('Что для тебя самое страшное в отношениях с кем-либо?'),
('Расскажи, каким было твоё самое трудное решение и почему оно было таким.'),
('Что бы ты хотел(а), чтобы я знал(а) о тебе, но боишься сказать?'),
('Как ты понимаешь, что кому-то действительно доверяешь?'),
('Какая твоя самая большая неуверенность в себе прямо сейчас?'),
('Если бы наши отношения закончились завтра, о чём бы ты жалел(а) больше всего?'),
('Что тебе нужно от меня в трудные моменты, чего я иногда не даю?'),
('Расскажи о моменте, когда тебе было стыдно, и как ты с этим справился(лась).'),
('Какая твоя самая большая мечта, в которую ты боишься поверить?'),
('Что заставляет тебя чувствовать себя по-настоящему любимым(ой)?'),
('Если бы ты мог(ла) попросить у меня одну вещь прямо сейчас, что бы это было?'),
('Что, по-твоему, делает нас парой, способной пройти через что угодно?')
) as v(text)
where not exists (select 1 from questions where pool = 'deep36');

insert into game_types (code, title, description, emoji, mechanic, question_pool, rounds, ordered, sort) values
('classic', 'Вопрос на двоих',            '10 случайных вопросов, живые ответы',                                   '💬', 'answer_only',        'general', 10, false, 1),
('deep36',  '36 вопросов, чтобы влюбиться','Классические вопросы для сближения — от лёгких до самых личных, по порядку', '🕯️', 'answer_only',   'deep36',  36, true,  2),
('guess',   'Угадай ответ партнёра',      'Отвечайте сами и угадывайте ответ второй половинки — сверяетесь сразу',  '🎯', 'answer_and_guess',  'general', 10, false, 3)
on conflict (code) do nothing;

alter table game_sessions add column if not exists game_type_code text not null default 'classic' references game_types(code);
alter table game_sessions add column if not exists xp_awarded boolean not null default false;
alter table answers add column if not exists guess_text text;

-- ---------------------------------------------------------------------------
-- 17. Уровень пары (XP)
-- ---------------------------------------------------------------------------
alter table couples add column if not exists xp int not null default 0;

create or replace function increment_couple_xp(p_couple_id uuid, p_amount int)
returns void as $$
  update couples set xp = xp + p_amount where id = p_couple_id;
$$ language sql;

-- ---------------------------------------------------------------------------
-- 18. Темы оформления + владение темами по паре
-- ---------------------------------------------------------------------------
create table if not exists themes (
  id           serial primary key,
  code         text unique not null,
  title        text not null,
  price_stars  int not null default 0,
  emoji        text not null,
  colors       jsonb not null  -- {bg,bg2,pink,pinkDeep,lavender,gold}
);

create table if not exists couple_themes (
  id          uuid primary key default gen_random_uuid(),
  couple_id   uuid not null references couples(id) on delete cascade,
  theme_id    int not null references themes(id) on delete cascade,
  source      text not null default 'purchase' check (source in ('purchase','admin_grant','free')),
  unlocked_at timestamptz not null default now(),
  unique (couple_id, theme_id)
);

alter table couples add column if not exists active_theme_id int references themes(id);

insert into themes (code, title, price_stars, emoji, colors) values
('midnight_garden', 'Полночный сад',   75,  '🌌', '{"bg":"#0f1a14","bg2":"#16261d","pink":"#7fd8a0","pinkDeep":"#3fae6c","lavender":"#a5c9ff","gold":"#e8d27a"}'),
('sunset_summer',   'Летний закат',    75,  '🌇', '{"bg":"#2a1408","bg2":"#3a1d0c","pink":"#ff9d5c","pinkDeep":"#ff6a3d","lavender":"#ffd27a","gold":"#ffe27a"}'),
('mint_fresh',      'Мятная свежесть', 60,  '🌿', '{"bg":"#0c1f1c","bg2":"#123027","pink":"#7fe8d0","pinkDeep":"#3fc9a8","lavender":"#9fd8ff","gold":"#ffe08a"}'),
('golden_night',    'Золотая ночь',    150, '🖤', '{"bg":"#0a0a0c","bg2":"#161616","pink":"#e8c76a","pinkDeep":"#c9a13a","lavender":"#8f8fa0","gold":"#fff0b0"}'),
('cloud_pink',      'Розовое облако',  50,  '☁️', '{"bg":"#221420","bg2":"#2c1a2a","pink":"#ffc2d6","pinkDeep":"#ff9dbd","lavender":"#d8c9ff","gold":"#ffe6b0"}')
on conflict (code) do nothing;

-- ---------------------------------------------------------------------------
-- 19. Платежи Telegram Stars
-- ---------------------------------------------------------------------------
create table if not exists star_payments (
  id                 uuid primary key default gen_random_uuid(),
  player_id          uuid not null references players(id) on delete cascade,
  couple_id          uuid not null references couples(id) on delete cascade,
  theme_id           int not null references themes(id) on delete cascade,
  invoice_payload    text unique not null,
  amount_stars       int not null,
  status             text not null default 'pending' check (status in ('pending','paid','failed')),
  telegram_charge_id text,
  created_at         timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 20. RLS для новых таблиц
-- ---------------------------------------------------------------------------
alter table game_types     enable row level security;
alter table themes         enable row level security;
alter table couple_themes  enable row level security;
alter table star_payments  enable row level security;

do $$ begin
  if not exists (select 1 from pg_policies where policyname = 'game_types_ro') then
    create policy "game_types_ro" on game_types for select using (true);
  end if;
  if not exists (select 1 from pg_policies where policyname = 'themes_ro') then
    create policy "themes_ro" on themes for select using (true);
  end if;
  if not exists (select 1 from pg_policies where policyname = 'couple_themes_all') then
    create policy "couple_themes_all" on couple_themes for all using (true) with check (true);
  end if;
  -- star_payments: клиент может создать и читать записи, но НЕ обновлять статус —
  -- пометить заявку "paid" может только вебхук-функция (сервисным ключом, в обход RLS).
  if not exists (select 1 from pg_policies where policyname = 'star_payments_select') then
    create policy "star_payments_select" on star_payments for select using (true);
  end if;
  if not exists (select 1 from pg_policies where policyname = 'star_payments_insert') then
    create policy "star_payments_insert" on star_payments for insert with check (true);
  end if;
end $$;

-- ---------------------------------------------------------------------------
-- 21. Realtime для новых таблиц
-- ---------------------------------------------------------------------------
do $$ begin
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='couples') then
    alter publication supabase_realtime add table couples;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='couple_themes') then
    alter publication supabase_realtime add table couple_themes;
  end if;
  if not exists (select 1 from pg_publication_tables where pubname='supabase_realtime' and tablename='star_payments') then
    alter publication supabase_realtime add table star_payments;
  end if;
end $$;
