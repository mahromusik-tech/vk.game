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
