-- =====================================================================================
-- Soapcube Racing · Supabase database setup
--
-- Paste ALL of this into Supabase → SQL Editor → New query → Run.
-- It's safe to run again after an update: it only creates or replaces things,
-- it never deletes players or their progress.
--
-- What it makes:
--   profiles         one row per player: racer name, best times, unlocked cars,
--                    career progress, purchases. Created automatically on sign-up.
--   purchase_events  every RevenueCat purchase event, as a log (server only).
--   money            cash (won in races) and gold (bought), kept on the profile; every change is in wallet_log.
--                    race_tickets: a single-player race is only paid if it was started and lasted long enough.
--                    gold_products: which store product gives how much gold.
--   car shop         car_prices: every car's price in cash and in gold (the stock car, Shutter RR, is everyone's); profiles.cars: the cars each player bought.
--   functions        the only way the game changes a profile, each one checks its input:
--                    get_profile, sync_best, set_racer_name, racer_name_check, save_career, delete_account,
--                    race_start, race_finish (single player winnings), car_shop, buy_car,
--                    and, for the game server only: rc_event (RevenueCat webhook), award_online_race (online winnings).
-- =====================================================================================


-- ---------- 1. Tables -----------------------------------------------------------------

create table if not exists public.profiles (
  id             uuid primary key references auth.users (id) on delete cascade,  -- deleting the account deletes the profile
  racer_name     text not null,
  email          text,
  created_at     timestamptz not null default now(),
  last_seen      timestamptz,
  best           jsonb not null default '{}'::jsonb,  -- best times in seconds: {"pebble": 95.5, "pebble-survival": 212.3, ...}
  unlocked       jsonb,                               -- cars unlocked; null = every car (until career mode decides otherwise)
  career         jsonb not null default '{}'::jsonb,  -- career mode progress, kept as the game sends it
  owned_products jsonb not null default '[]'::jsonb,  -- one-time purchases (store product ids), kept up to date by RevenueCat
  entitlements   jsonb not null default '[]'::jsonb   -- active RevenueCat entitlements
);
-- racer names are unique, ignoring upper/lower case
create unique index if not exists profiles_racer_name_key on public.profiles (lower(racer_name));

-- money: cash (green paper money, won in races) and gold (ingots, bought). Never below zero.
alter table public.profiles add column if not exists cash bigint not null default 0;
alter table public.profiles add column if not exists gold bigint not null default 0;
do $$ begin
  alter table public.profiles add constraint profiles_money_not_negative check (cash >= 0 and gold >= 0);
exception when duplicate_object then null; end $$;

-- every change to a player's money, and why. "ref" names what it was for, so nothing is ever paid twice.
create table if not exists public.wallet_log (
  id       bigserial primary key,
  user_id  uuid not null references auth.users (id) on delete cascade,
  at       timestamptz not null default now(),
  reason   text not null,                       -- 'race', 'online race', 'gold purchase', 'gold refund', ...
  cash     bigint not null default 0,           -- change (+ won, - spent)
  gold     bigint not null default 0,
  ref      text,                                -- 'ticket:<id>', 'online:<race>', 'rc:<purchase event id>'
  detail   jsonb
);
create unique index if not exists wallet_log_ref_key on public.wallet_log (user_id, ref);
create index if not exists wallet_log_user_at on public.wallet_log (user_id, at desc);

-- single-player races: the game opens a ticket when the race starts and cashes it in at the finish
create table if not exists public.race_tickets (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users (id) on delete cascade,
  track       text not null,
  mode        text not null,                    -- 'normal' (12 cars) or 'survival' (50 cars)
  cars        int  not null,
  started_at  timestamptz not null default now(),
  claimed_at  timestamptz
);
create index if not exists race_tickets_user on public.race_tickets (user_id, started_at desc);

-- gold you can buy: store product id -> ingots. Add or change packs here (the same ids go in App Store / Play / RevenueCat).
create table if not exists public.gold_products (
  product_id text primary key,
  gold       int not null check (gold > 0)
);
insert into public.gold_products (product_id, gold) values
  ('gold_100', 100), ('gold_300', 300), ('gold_500', 500)          -- $1.99, $4.99, $6.99
on conflict (product_id) do nothing;
delete from public.gold_products where product_id in ('gold_10', 'gold_55', 'gold_120');   -- the first, never sold, packs

-- the car shop: every car (its number = its place in the game's car list) and what it costs, in cash or in gold.
-- The stock car (starter) belongs to everyone. Change prices here; the game reads them through car_shop().
create table if not exists public.car_prices (
  car     int primary key check (car >= 0),
  name    text not null,
  cash    bigint not null check (cash >= 0),
  gold    int not null check (gold >= 0),
  starter boolean not null default false
);
insert into public.car_prices (car, name, cash, gold, starter) values
  (0, 'Sparu', 85000, 20, false), (1, 'Manto V8', 150000, 30, false), (2, 'Channer', 70000, 15, false),
  (3, 'Ryper', 110000, 25, false), (4, 'Portello 12', 650000, 100, false), (5, 'Portello 11', 400000, 70, false),
  (6, 'Shutter RR', 40000, 10, true), (7, 'Collogiallo', 180000, 35, false), (8, 'Koetale ZZ', 3000000, 350, false),
  (9, 'P119', 200000, 40, false), (10, 'CM33', 280000, 50, false), (11, '3EM', 120000, 25, false),
  (12, 'GT44', 45000, 10, false), (13, 'DRZ1', 5000000, 525, false), (14, '3000M', 100000, 25, false),
  (15, 'Shielder', 150000, 30, false), (16, 'GT11', 90000, 20, false), (17, 'Shimita', 55000, 15, false),
  (18, 'Katsuki', 60000, 15, false), (19, 'Carato', 75000, 20, false), (20, 'M20', 1500000, 200, false),
  (21, 'Tiremu S', 30000, 10, false), (22, 'Mosi 4R4', 220000, 45, false), (23, 'Retta C18', 35000, 10, false),
  (24, 'Stellos', 550000, 90, false)
on conflict (car) do nothing;
update public.car_prices set starter = (car = 6) where starter <> (car = 6);   -- one stock car for everyone: the Shutter RR
-- (a test build briefly had 5x gold prices: put any car still on those back to the real price list)
update public.car_prices c set gold = v.gold from (values (0, 100, 20), (1, 160, 30), (2, 85, 15), (3, 120, 25), (4, 500, 100), (5, 340, 70), (6, 55, 10), (7, 180, 35), (8, 1725, 350), (9, 200, 40), (10, 260, 50), (11, 130, 25), (12, 60, 10), (13, 2600, 525), (14, 110, 25), (15, 160, 30), (16, 100, 20), (17, 70, 15), (18, 75, 15), (19, 90, 20), (20, 1000, 200), (21, 45, 10), (22, 210, 45), (23, 50, 10), (24, 440, 90)) as v(car, wrong, gold)
  where c.car = v.car and c.gold = v.wrong;
-- the cars a player has bought (car numbers); starter cars aren't listed, everyone has them
alter table public.profiles add column if not exists cars jsonb not null default '[]'::jsonb;

create table if not exists public.purchase_events (
  id          text primary key,              -- RevenueCat's event id (repeats of the same event are ignored)
  user_id     uuid,                          -- the player, if we know them (kept as a record even after an account is deleted)
  type        text not null,                 -- INITIAL_PURCHASE, NON_RENEWING_PURCHASE, CANCELLATION, ...
  product_id  text,
  store       text,
  environment text,                          -- SANDBOX or PRODUCTION
  received_at timestamptz not null default now(),
  event       jsonb not null
);


-- ---------- 2. Who can see what ---------------------------------------------------------
-- Players can read their own profile and nothing else. Nobody writes tables directly:
-- every change goes through the functions below.

alter table public.profiles enable row level security;
alter table public.purchase_events enable row level security;
alter table public.wallet_log enable row level security;
alter table public.race_tickets enable row level security;
alter table public.gold_products enable row level security;
alter table public.car_prices enable row level security;

drop policy if exists "Players read their own profile" on public.profiles;
create policy "Players read their own profile" on public.profiles
  for select to authenticated using ((select auth.uid()) = id);

revoke all on public.profiles from anon;
revoke insert, update, delete, truncate on public.profiles from authenticated;
revoke all on public.purchase_events from anon, authenticated;
revoke all on public.wallet_log, public.race_tickets, public.gold_products, public.car_prices from anon, authenticated;   -- money only moves through the functions below


-- ---------- 3. Racer names --------------------------------------------------------------

-- names that look like the game's guest names (an adjective + an animal, e.g. "SunnyOtter42") are kept for guests
create or replace function public.phd_guest_like(n text) returns boolean
language sql immutable set search_path = '' as $$
  select exists (select 1 from unnest(array['zippy','rusty','turbo','lucky','swift','mighty','sneaky','jolly','brave','sunny','dusty','nifty','bouncy','gritty','plucky','speedy']) a
                 where lower(n) like a || '%')
     and exists (select 1 from unnest(array['otter','badger','falcon','gecko','panda','moose','ferret','lynx','koala','beaver','heron','marmot','puffin','wombat','yak','hare']) b
                 where position(b in lower(n)) > 0);
$$;

-- names that aren't allowed (swearing, slurs, sexual, hateful), in the languages of the game.
-- Leetspeak (0=o, 1=i, 3=e, 4=a, 5=s, 7=t, 8=b) and doubled letters don't get round it.
-- The same list is in the game (instant feedback) and the game server (private server names).
create or replace function public.phd_name_bad(n text) returns boolean
language plpgsql immutable set search_path = '' as $$
declare raw text := lower(coalesce(n, '')); t text; c text; p text; w text;
  roots text[] := array['f+u+c+k', 'fuk(?![uoa])', 'fvck', 'fcuk', 'phuck', 'motherf', 'sh+i+t(?!a)', 'cunt', 'n+i+g+g', 'n+i+g+(a+h?|u+h)$', 'n+i+g+e+r(?!ia)', 'nigr', 'f+a+g+o+t', 'kike', 'chink', 'wetback', 'raghead', 'towelhead', 'zipperhead', 'beaner', 'r+e+t+a+r+d', 'tranny', 'whore', 'slut', 'bitch', 'bastard', 'asshole', 'dickhead', 'pussy', 'penis', 'vagina', 'dildo', 'porn', '(^|[^e])rapist', 'pa?edophil', 'molest', 'hitler', 'siegheil', 'heilhit', 'whitepower', 'whitepride', 'nazi$', 'nazis$', 'kkk', 'killyourself', 'wanker', 'cazzo', 'minchia', 'stronz', 'puttan(?!esc)', 'vaffancul', 'fancul', 'culattone', 'frocio', 'ricchion', '(^|[^e])negro(?!n)', 'terrone', 'zoccola', 'coglion', 'porcodio', 'porcamadonna', 'dioporco', 'diocane', 'mignotta', 'bastardo', 'pendejo', 'cabron', 'maricon', 'gilipollas', 'mierda', 'culero', 'chinga', 'sudaca', 'hijodeputa', 'putain', 'salope', 'connard', 'connasse', 'encule', 'bougnoul', 'salaud', '(^|[^e])negre', 'niquetamere', 'scheiss', 'ficken', 'fotze', 'hurensohn', 'wichser', 'schwuchtel', 'neger', 'spast', 'missgeburt', 'arschloch', 'kanake', 'caralho', 'buceta', 'viado', 'merda', 'cuzao', 'filhodaputa'];
  exact text[] := array['ass', 'arse', 'cum', 'fag', 'fags', 'coon', 'dyke', 'cock', 'rape', 'pedo', 'paedo', 'spic', 'puta', 'puto', 'marica', 'figa', 'pede', 'nique', 'foda', 'tits', 'dick', 'anal', 'anus', 'nazi', 'nazis', 'sex', 'wank', 'twat', 'piss', 'jap', 'gook', 'paki', 'nig', 'negr', 'porra', 'troia', 'culo', 'kys', 'fdp', 'putas', 'putos'];
begin
  if raw ~ '1488' then return true; end if;
  t := regexp_replace(translate(raw, '0134578', 'oieastb'), '[^a-z]', '', 'g');
  c := regexp_replace(t, '(.)\1+', '\1', 'g');
  foreach p in array roots loop
    if t ~ p or c ~ p then return true; end if;
  end loop;
  if t = any(exact) or c = any(exact) then return true; end if;
  for w in select (regexp_matches(coalesce(n, ''), '([A-Z]?[a-z0-9]+|[A-Z0-9]+(?![a-z]))', 'g'))[1] loop
    w := regexp_replace(translate(lower(w), '0134578', 'oieastb'), '[^a-z]', '', 'g');
    if w = any(exact) or regexp_replace(w, '(.)\1+', '\1', 'g') = any(exact) then return true; end if;
  end loop;
  return false;
end $$;

-- a starting racer name from the email: "ivan.rossi@x.com" -> "ivan_rossi" (or "ivan_rossi2", ... if taken)
create or replace function public.phd_name_from_email(addr text) returns text
language plpgsql set search_path = '' as $$
declare b text; n text; k int;
begin
  b := left(trim(both '_' from regexp_replace(split_part(coalesce(addr, ''), '@', 1), '[^A-Za-z0-9_]+', '_', 'g')), 12);
  if b = '' or public.phd_name_bad(b) then b := 'racer'; end if;
  if length(b) < 3 then b := left(b || 'racer', 5); end if;
  for k in 1..100 loop
    n := case when k = 1 then b else left(b, 12) || k end;
    if not public.phd_guest_like(n) and not exists (select 1 from public.profiles p where lower(p.racer_name) = lower(n)) then
      return n;
    end if;
  end loop;
  return 'racer' || substr(md5(random()::text), 1, 6);
end $$;


-- ---------- 4. Creating the profile --------------------------------------------------------

create or replace function public.phd_ensure_profile(uid uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare em text; want text; nm text; i int;
begin
  if exists (select 1 from public.profiles where id = uid) then return; end if;
  select u.email, btrim(coalesce(u.raw_user_meta_data ->> 'racer_name', '')) into em, want from auth.users u where u.id = uid;
  if not found then return; end if;
  for i in 1..5 loop
    begin
      -- the racer name picked when registering, if it's allowed and still free; otherwise one made from the email
      if want ~ '^[A-Za-z0-9_]{3,16}$' and not public.phd_guest_like(want) and not public.phd_name_bad(want)
         and not exists (select 1 from public.profiles p where lower(p.racer_name) = lower(want)) then nm := want;
      else nm := public.phd_name_from_email(em); end if;
      insert into public.profiles (id, racer_name, email) values (uid, nm, lower(em))
      on conflict (id) do nothing;
      return;
    exception when unique_violation then
      -- someone took that name a moment ago: try again with the next one
    end;
  end loop;
end $$;

-- every new sign-up gets a profile straight away (if this ever failed, get_profile makes it later, so sign-up never breaks)
create or replace function public.phd_on_signup() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  begin
    perform public.phd_ensure_profile(new.id);
  exception when others then
    raise warning 'phd_on_signup: %', sqlerrm;
  end;
  return new;
end $$;

drop trigger if exists phd_on_signup on auth.users;
create trigger phd_on_signup after insert on auth.users
  for each row execute function public.phd_on_signup();


-- ---------- 5. What the game calls ------------------------------------------------------

-- the signed-in player's profile (also notes when they were last seen)
create or replace function public.get_profile() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); p public.profiles;
begin
  if uid is null then raise exception 'Sign in first.' using errcode = '42501'; end if;
  perform public.phd_ensure_profile(uid);
  update public.profiles set last_seen = now() where id = uid returning * into p;
  if p.id is null then raise exception 'No profile for this account.' using errcode = 'P0002'; end if;
  return jsonb_build_object(
    'racer_name', p.racer_name, 'email', p.email, 'created_at', p.created_at,
    'best', p.best, 'unlocked', p.unlocked, 'career', p.career,
    'owned_products', p.owned_products, 'entitlements', p.entitlements,
    'cash', p.cash, 'gold', p.gold, 'cars', p.cars);
end $$;

-- best times: keeps the faster of what's saved and what the game sends
-- keys: track id (+ "-survival" or "-ta" for Time attack), 2–16 lower-case letters; times between 15 s and 1 hour
create or replace function public.sync_best(best jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); cur jsonb; k text; v jsonb; t numeric; n int := 0;
begin
  if uid is null then raise exception 'Sign in first.' using errcode = '42501'; end if;
  if best is null or jsonb_typeof(best) <> 'object' then raise exception 'Best times must be a list of track: seconds.'; end if;
  perform public.phd_ensure_profile(uid);
  select p.best into cur from public.profiles p where p.id = uid for update;
  for k, v in select key, value from jsonb_each(best) loop
    n := n + 1;
    exit when n > 64;
    continue when k !~ '^[a-z]{2,16}(-survival|-ta)?$' or jsonb_typeof(v) <> 'number';
    t := (v #>> '{}')::numeric;
    continue when t < 15 or t > 3600;
    continue when cur ? k and jsonb_typeof(cur -> k) = 'number' and (cur ->> k)::numeric <= t;
    cur := cur || jsonb_build_object(k, round(t, 3));
  end loop;
  update public.profiles set best = cur where id = uid;
  return public.get_profile();
end $$;

-- change racer name: 3–16 letters, numbers or _, unique, not a guest-style name
create or replace function public.set_racer_name(new_name text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); n text := btrim(coalesce(new_name, ''));
begin
  if uid is null then raise exception 'Sign in first.' using errcode = '42501'; end if;
  if n !~ '^[A-Za-z0-9_]{3,16}$' then raise exception 'Racer name: 3–16 letters, numbers or _'; end if;
  if public.phd_guest_like(n) then raise exception 'That looks like a guest name. Pick another one.'; end if;
  if public.phd_name_bad(n) then raise exception 'That name isn''t allowed. Pick another one.'; end if;
  if exists (select 1 from public.profiles p where lower(p.racer_name) = lower(n) and p.id <> uid) then
    raise exception 'That racer name is taken.';
  end if;
  perform public.phd_ensure_profile(uid);
  begin
    update public.profiles set racer_name = n where id = uid;
  exception when unique_violation then
    raise exception 'That racer name is taken.';
  end;
  return public.get_profile();
end $$;

-- is this racer name OK? '' = yes, otherwise the reason. Asked while registering, before the account exists.
create or replace function public.racer_name_check(new_name text) returns text
language plpgsql stable security definer set search_path = '' as $$
declare n text := btrim(coalesce(new_name, ''));
begin
  if n !~ '^[A-Za-z0-9_]{3,16}$' then return 'Racer name: 3–16 letters, numbers or _'; end if;
  if public.phd_guest_like(n) then return 'That looks like a guest name. Pick another one.'; end if;
  if public.phd_name_bad(n) then return 'That name isn''t allowed. Pick another one.'; end if;
  if exists (select 1 from public.profiles p where lower(p.racer_name) = lower(n) and p.id is distinct from auth.uid()) then
    return 'That racer name is taken.';
  end if;
  return '';
end $$;

-- career mode progress (an object, up to 16 KB)
create or replace function public.save_career(data jsonb) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'Sign in first.' using errcode = '42501'; end if;
  if data is null or jsonb_typeof(data) <> 'object' then raise exception 'Career data must be an object.'; end if;
  if length(data::text) > 16384 then raise exception 'Career data too large.'; end if;
  perform public.phd_ensure_profile(uid);
  update public.profiles set career = data where id = uid;
  return public.get_profile();
end $$;

-- delete my account: removes the sign-in, the profile and everything in it, and signs out every device
create or replace function public.delete_account() returns void
language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid();
begin
  if uid is null then raise exception 'Sign in first.' using errcode = '42501'; end if;
  delete from auth.users where id = uid;
end $$;


-- ---------- 6. Purchases (RevenueCat → game server → here) ---------------------------------
-- The game logs in to RevenueCat with the player's Supabase user id, so every event names the player.
-- One-time purchases end up in owned_products, entitlements in entitlements; refunds take them away again.

create or replace function public.phd_uuids(j jsonb) returns uuid[]
language sql immutable set search_path = '' as $$
  select coalesce(array_agg(distinct lower(x)::uuid), '{}')
  from (
    select case when jsonb_typeof(j) = 'array' then null else j #>> '{}' end x
    union all
    select jsonb_array_elements_text(case when jsonb_typeof(j) = 'array' then j else '[]'::jsonb end)
  ) s
  where x ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
$$;

create or replace function public.phd_jsonb_union(a jsonb, b jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  select coalesce(jsonb_agg(x order by x), '[]'::jsonb) from (
    select jsonb_array_elements_text(case when jsonb_typeof(a) = 'array' then a else '[]'::jsonb end) x
    union
    select jsonb_array_elements_text(case when jsonb_typeof(b) = 'array' then b else '[]'::jsonb end)
  ) s;
$$;

create or replace function public.phd_jsonb_minus(a jsonb, b jsonb) returns jsonb
language sql immutable set search_path = '' as $$
  select coalesce(jsonb_agg(x order by x), '[]'::jsonb) from (
    select jsonb_array_elements_text(case when jsonb_typeof(a) = 'array' then a else '[]'::jsonb end) x
    except
    select jsonb_array_elements_text(case when jsonb_typeof(b) = 'array' then b else '[]'::jsonb end)
  ) s;
$$;

create or replace function public.rc_event(body jsonb) returns text
language plpgsql security definer set search_path = '' as $$
declare
  e    jsonb := case when body ? 'event' then body -> 'event' else body end;   -- the whole webhook body, or just its "event"
  t    text  := e ->> 'type';
  prod jsonb := case when e ->> 'product_id' is null then '[]'::jsonb else jsonb_build_array(e ->> 'product_id') end;
  ents jsonb := public.phd_jsonb_union(e -> 'entitlement_ids',
                  case when e ->> 'entitlement_id' is null then '[]'::jsonb else jsonb_build_array(e ->> 'entitlement_id') end);
  ids  uuid[];
  uid  uuid;
  src  uuid[];
  dst  uuid[];
  op   jsonb;
  oe   jsonb;
  gp   int;
begin
  if e ->> 'id' is null or t is null then raise exception 'Not a RevenueCat event.'; end if;

  -- whose purchase: app_user_id, then the original id and aliases (whichever is a player here)
  ids := public.phd_uuids(e -> 'app_user_id') || public.phd_uuids(e -> 'original_app_user_id') || public.phd_uuids(e -> 'aliases');
  select p.id into uid from public.profiles p where p.id = any(ids) limit 1;

  insert into public.purchase_events (id, user_id, type, product_id, store, environment, event)
  values (e ->> 'id', uid, t, e ->> 'product_id', e ->> 'store', e ->> 'environment', e)
  on conflict (id) do nothing;
  if not found then return 'duplicate'; end if;

  if t = 'TRANSFER' then
    -- purchases moved to another account (e.g. "Restore purchases" while signed in as someone else)
    src := public.phd_uuids(e -> 'transferred_from');
    dst := public.phd_uuids(e -> 'transferred_to');
    select coalesce(jsonb_agg(distinct v), '[]'::jsonb) into op
      from public.profiles p, jsonb_array_elements(p.owned_products) v where p.id = any(src);
    select coalesce(jsonb_agg(distinct v), '[]'::jsonb) into oe
      from public.profiles p, jsonb_array_elements(p.entitlements) v where p.id = any(src);
    update public.profiles set owned_products = '[]'::jsonb, entitlements = '[]'::jsonb where id = any(src) and not (id = any(dst));
    update public.profiles set owned_products = public.phd_jsonb_union(owned_products, op),
                               entitlements   = public.phd_jsonb_union(entitlements, oe)
      where id = any(dst);
    return 'transferred';
  end if;

  if uid is null then return 'no player'; end if;   -- logged anyway; nothing to change

  -- gold packs are used up (consumables): they add gold instead of going into owned_products
  select g.gold into gp from public.gold_products g where g.product_id = e ->> 'product_id';
  if gp is not null then
    if t in ('INITIAL_PURCHASE', 'NON_RENEWING_PURCHASE', 'REFUND_REVERSED') then
      perform public.phd_wallet_add(uid, 'gold purchase', 0, gp, 'rc:' || (e ->> 'id'), jsonb_build_object('product', e ->> 'product_id', 'store', e ->> 'store', 'environment', e ->> 'environment'));
      return 'gold +' || gp;
    elsif t = 'CANCELLATION' and e ->> 'cancel_reason' = 'CUSTOMER_SUPPORT' then   -- refunded: the gold goes again (as much as is left)
      perform public.phd_wallet_add(uid, 'gold refund', 0, -gp, 'rc:' || (e ->> 'id'), jsonb_build_object('product', e ->> 'product_id'));
      return 'gold -' || gp;
    end if;
    return 'logged';
  end if;

  if t in ('INITIAL_PURCHASE', 'RENEWAL', 'NON_RENEWING_PURCHASE', 'UNCANCELLATION', 'PRODUCT_CHANGE',
           'SUBSCRIPTION_EXTENDED', 'TEMPORARY_ENTITLEMENT_GRANT', 'REFUND_REVERSED') then
    update public.profiles set
      owned_products = case when t in ('NON_RENEWING_PURCHASE', 'REFUND_REVERSED') then public.phd_jsonb_union(owned_products, prod) else owned_products end,
      entitlements   = public.phd_jsonb_union(entitlements, ents)
    where id = uid;
    return 'granted';
  elsif t = 'CANCELLATION' and e ->> 'cancel_reason' = 'CUSTOMER_SUPPORT' then   -- refunded by Apple/Google
    update public.profiles set owned_products = public.phd_jsonb_minus(owned_products, prod),
                               entitlements   = public.phd_jsonb_minus(entitlements, ents)
    where id = uid;
    return 'refunded';
  elsif t = 'EXPIRATION' then
    update public.profiles set entitlements = public.phd_jsonb_minus(entitlements, ents) where id = uid;
    return 'expired';
  end if;
  return 'logged';
end $$;


-- ---------- 7. Money ---------------------------------------------------------------------------
-- The game never sets a balance: it can only say "I started a race" and "I finished it in this place",
-- and the database works out the prize. Online races are paid by the game server, which saw the race.

-- add (or take) money, once per ref; never below zero. true = done, false = already done before
create or replace function public.phd_wallet_add(uid uuid, why text, dcash bigint, dgold bigint, r text, d jsonb) returns boolean
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.wallet_log (user_id, reason, cash, gold, ref, detail) values (uid, why, dcash, dgold, r, d)
  on conflict (user_id, ref) do nothing;
  if not found then return false; end if;
  update public.profiles set cash = greatest(0, cash + dcash), gold = greatest(0, gold + dgold) where id = uid;
  return true;
end $$;

-- the quickest a race on each track can possibly take, in seconds (about 60% of the fastest AI driver's time)
create or replace function public.phd_track_min(t text) returns numeric
language sql immutable set search_path = '' as $$
  select case t when 'pebble' then 60 when 'city' then 75 when 'nomahe' then 85 when 'tokiyama' then 64
                when 'whitecow' then 65 when 'aloma' then 80 when 'mesozon' then 100 end::numeric;
$$;

-- the prize: the bigger the field, the bigger the purse (12 cars: 3,050 for 1st, 50 cars: 9,900);
-- it falls off towards the back, and finishing last (or not finishing in time) still pays 10%
create or replace function public.phd_race_prize(place int, cars int, finished boolean) returns int
language sql immutable set search_path = '' as $$
  select case when cars < 2 or cars > 50 or place < 1 or place > cars then 0
    else (round(round(400 * power(cars, 0.82)) *
           (case when finished then 0.1 + 0.9 * power((cars - place)::numeric / (cars - 1), 1.5) else 0.1 end) / 50) * 50)::int end;
$$;

-- single player: a race starts (Quick race, Custom race, Career, Survival; Time attack has no prize)
create or replace function public.race_start(track text, mode text) returns uuid
language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); id uuid;
begin
  if uid is null then raise exception 'Sign in first.' using errcode = '42501'; end if;
  if public.phd_track_min(track) is null then raise exception 'Unknown track.'; end if;
  if mode not in ('normal', 'survival') then raise exception 'Unknown race mode.'; end if;
  perform public.phd_ensure_profile(uid);
  -- one open race at a time (starting again forfeits the last one), and old tickets are cleared away
  delete from public.race_tickets t where t.user_id = uid and (t.claimed_at is null or t.started_at < now() - interval '2 days');
  insert into public.race_tickets (user_id, track, mode, cars) values (uid, track, mode, case when mode = 'survival' then 50 else 12 end)
  returning race_tickets.id into id;
  return id;
end $$;

-- single player: the race is over. Pays the prize for that place, once, if the race lasted long enough.
create or replace function public.race_finish(ticket uuid, place int) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); tk public.race_tickets; secs numeric; prize int := 0; why text := 'paid'; p public.profiles;
begin
  if uid is null then raise exception 'Sign in first.' using errcode = '42501'; end if;
  select * into tk from public.race_tickets t where t.id = ticket and t.user_id = uid for update;
  if tk.id is null then raise exception 'That race isn''t open.'; end if;
  if tk.claimed_at is not null then raise exception 'That race has already been paid.'; end if;
  if place is null or place < 1 or place > tk.cars then raise exception 'Place must be between 1 and %.', tk.cars; end if;
  secs := extract(epoch from now() - tk.started_at);
  update public.race_tickets set claimed_at = now() where id = tk.id;
  if secs < public.phd_track_min(tk.track) then why := 'too fast';            -- quicker than anyone can drive it: no prize
  elsif secs > 3 * 3600 then why := 'expired';
  elsif (select count(*) from public.wallet_log w where w.user_id = uid and w.reason = 'race' and w.at > now() - interval '1 day') >= 150 then why := 'daily limit';
  else
    prize := public.phd_race_prize(place, tk.cars, true);
    perform public.phd_wallet_add(uid, 'race', prize, 0, 'ticket:' || tk.id,
      jsonb_build_object('track', tk.track, 'mode', tk.mode, 'place', place, 'cars', tk.cars, 'secs', round(secs, 1)));
  end if;
  select * into p from public.profiles where id = uid;
  return jsonb_build_object('earned', prize, 'result', why, 'cash', p.cash, 'gold', p.gold);
end $$;

-- online races: the game server pays each signed-in racer (once per race) for where they came
create or replace function public.award_online_race(player uuid, race text, place int, cars int, finished boolean, track text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare prize int; done boolean; p public.profiles;
begin
  if player is null or coalesce(race, '') = '' then raise exception 'Missing player or race.'; end if;
  if cars < 2 or cars > 50 or place < 1 or place > cars then raise exception 'Bad place or field size.'; end if;
  if not exists (select 1 from public.profiles where id = player) then return jsonb_build_object('earned', 0, 'result', 'no player'); end if;
  prize := public.phd_race_prize(place, cars, finished);
  done := public.phd_wallet_add(player, 'online race', prize, 0, 'online:' || race,
    jsonb_build_object('track', track, 'place', place, 'cars', cars, 'finished', finished));
  select * into p from public.profiles where id = player;
  return jsonb_build_object('earned', case when done then prize else 0 end, 'result', case when done then 'paid' else 'duplicate' end, 'cash', p.cash, 'gold', p.gold);
end $$;


-- ---------- 7b. The car shop ---------------------------------------------------------------------

-- the price list (anyone can read it, also before signing in)
create or replace function public.car_shop() returns jsonb
language sql stable security definer set search_path = '' as $$
  select coalesce(jsonb_agg(jsonb_build_object('car', c.car, 'name', c.name, 'cash', c.cash, 'gold', c.gold, 'starter', c.starter) order by c.car), '[]'::jsonb)
  from public.car_prices c;
$$;

-- buy a car with cash ('cash') or gold ('gold'). The price comes from car_prices, never from the game.
create or replace function public.buy_car(car int, pay text) returns jsonb
language plpgsql security definer set search_path = '' as $$
declare uid uuid := auth.uid(); pr public.car_prices; p public.profiles;
begin
  if uid is null then raise exception 'Sign in first.' using errcode = '42501'; end if;
  if pay not in ('cash', 'gold') then raise exception 'Pay with cash or gold.'; end if;
  select * into pr from public.car_prices c where c.car = buy_car.car;
  if pr.car is null then raise exception 'There''s no such car.'; end if;
  perform public.phd_ensure_profile(uid);
  select * into p from public.profiles where id = uid for update;          -- one purchase at a time per player
  if pr.starter or p.cars @> to_jsonb(pr.car) then raise exception 'You already own this car.'; end if;
  if pay = 'cash' and p.cash < pr.cash then raise exception 'Not enough cash.'; end if;
  if pay = 'gold' and p.gold < pr.gold then raise exception 'Not enough gold.'; end if;
  perform public.phd_wallet_add(uid, 'car', case when pay = 'cash' then -pr.cash else 0 end, case when pay = 'gold' then -pr.gold else 0 end,
    'car:' || pr.car || ':' || extract(epoch from clock_timestamp())::text, jsonb_build_object('car', pr.car, 'name', pr.name, 'pay', pay));
  update public.profiles set cars = cars || to_jsonb(pr.car) where id = uid returning * into p;
  return jsonb_build_object('car', pr.car, 'cash', p.cash, 'gold', p.gold, 'cars', p.cars);
end $$;


-- ---------- 8. Who can call which function ------------------------------------------------

-- internal helpers: nobody calls these directly
revoke execute on function public.phd_guest_like(text), public.phd_name_bad(text), public.phd_name_from_email(text), public.phd_ensure_profile(uuid),
  public.phd_on_signup(), public.phd_uuids(jsonb), public.phd_jsonb_union(jsonb, jsonb), public.phd_jsonb_minus(jsonb, jsonb),
  public.phd_wallet_add(uuid, text, bigint, bigint, text, jsonb), public.phd_track_min(text), public.phd_race_prize(int, int, boolean)
  from public, anon, authenticated;

-- signed-in players
revoke execute on function public.get_profile(), public.sync_best(jsonb), public.set_racer_name(text),
  public.save_career(jsonb), public.delete_account(), public.race_start(text, text), public.race_finish(uuid, int),
  public.buy_car(int, text) from public, anon;
grant execute on function public.get_profile(), public.sync_best(jsonb), public.set_racer_name(text),
  public.save_career(jsonb), public.delete_account(), public.race_start(text, text), public.race_finish(uuid, int),
  public.buy_car(int, text) to authenticated;

-- anyone (also before signing in): checking a racer name while registering
revoke execute on function public.racer_name_check(text), public.car_shop() from public;
grant execute on function public.racer_name_check(text), public.car_shop() to anon, authenticated;

-- the game server only (with the secret / service_role key)
revoke execute on function public.rc_event(jsonb), public.award_online_race(uuid, text, int, int, boolean, text) from public, anon, authenticated;
grant execute on function public.rc_event(jsonb), public.award_online_race(uuid, text, int, int, boolean, text) to service_role;
