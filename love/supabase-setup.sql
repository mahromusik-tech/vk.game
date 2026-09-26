-- ============================================================================
-- "Вдвоём" — схема Supabase
-- Выполните этот файл целиком в Supabase: Dashboard → SQL Editor → New query
-- ============================================================================

create extension if not exists "pgcrypto";

-- ---------------------------------------------------------------------------
-- 1. Игроки (телеграм-пользователи)
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

-- ---------------------------------------------------------------------------
-- 2. Пары (связка двух игроков)
-- ---------------------------------------------------------------------------
create table if not exists couples (
  id          uuid primary key default gen_random_uuid(),
  player1_id  uuid not null references players(id) on delete cascade,
  player2_id  uuid not null references players(id) on delete cascade,
  created_at  timestamptz not null default now(),
  unique (player1_id, player2_id)
);

-- ---------------------------------------------------------------------------
-- 3. Банк вопросов
-- ---------------------------------------------------------------------------
create table if not exists questions (
  id   serial primary key,
  text text not null
);

-- ---------------------------------------------------------------------------
-- 4. Игровые сессии (10 случайных вопросов на игру)
-- ---------------------------------------------------------------------------
create table if not exists game_sessions (
  id             uuid primary key default gen_random_uuid(),
  couple_id      uuid not null references couples(id) on delete cascade,
  question_ids   int[] not null,
  current_index  int not null default 0,
  status         text not null default 'active' check (status in ('active', 'finished')),
  created_at     timestamptz not null default now()
);

-- ---------------------------------------------------------------------------
-- 5. Ответы (живые, по одному на игрока на вопрос)
-- ---------------------------------------------------------------------------
create table if not exists answers (
  id              uuid primary key default gen_random_uuid(),
  session_id      uuid not null references game_sessions(id) on delete cascade,
  question_index  int not null,
  player_id       uuid not null references players(id) on delete cascade,
  answer_text     text not null,
  created_at      timestamptz not null default now(),
  unique (session_id, question_index, player_id)
);

create index if not exists idx_answers_session on answers(session_id);
create index if not exists idx_sessions_couple on game_sessions(couple_id);
create index if not exists idx_players_partner on players(partner_id);

-- ---------------------------------------------------------------------------
-- 6. RLS — приложение работает через публичный anon-ключ (без пароля),
--    поэтому политики открыты на уровне приложения-игры для двоих.
--    При желании ужесточить позже, доступ можно ограничить через
--    Supabase Edge Functions или проверку initData Telegram.
-- ---------------------------------------------------------------------------
alter table players       enable row level security;
alter table couples       enable row level security;
alter table questions     enable row level security;
alter table game_sessions enable row level security;
alter table answers       enable row level security;

create policy "players_all"   on players       for all    using (true) with check (true);
create policy "couples_all"   on couples       for all    using (true) with check (true);
create policy "questions_ro"  on questions     for select using (true);
create policy "sessions_all"  on game_sessions for all    using (true) with check (true);
create policy "answers_all"   on answers       for all    using (true) with check (true);

-- ---------------------------------------------------------------------------
-- 7. Realtime — включаем публикацию для live-обновлений
-- ---------------------------------------------------------------------------
alter publication supabase_realtime add table game_sessions;
alter publication supabase_realtime add table answers;
alter publication supabase_realtime add table players;

-- ============================================================================
-- 8. 50 вопросов для игры
-- ============================================================================
insert into questions (text) values
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
('Если бы можно было добавить один пункт в наши отношения прямо сейчас, что бы это было?');
