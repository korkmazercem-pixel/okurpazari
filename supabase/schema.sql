-- OkurPazarı — veritabanı şeması (Supabase / Postgres)
-- Supabase SQL Editor'da bir kez çalıştırılır. Tekrar çalıştırmak güvenlidir (if not exists / or replace).

create extension if not exists pgcrypto;

-- ---------- profiller: her kullanıcı (kitapçı / müşteri / yönetici) ----------
create table if not exists public.profiller (
  id uuid primary key references auth.users(id) on delete cascade,
  rol text not null default 'musteri' check (rol in ('kitapci','musteri','admin')),
  ad text, dukkan text, sehir text, telefon text, adres text,
  komisyon_yuzde numeric,            -- boşsa platform varsayılanı geçerli
  olusturma timestamptz not null default now()
);

-- yönetici mi? (RLS politikalarında kullanılır)
create or replace function public.yonetici_mi() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.profiller where id = auth.uid() and rol = 'admin');
$$;

-- kayıt olan kullanıcıya profil aç; ilk kullanıcı yönetici olur
create or replace function public.yeni_kullanici() returns trigger
language plpgsql security definer set search_path = public as $$
declare r text;
begin
  r := coalesce(new.raw_user_meta_data->>'rol', 'musteri');
  if r not in ('kitapci','musteri') then r := 'musteri'; end if;
  if not exists (select 1 from public.profiller where rol = 'admin') then r := 'admin'; end if;
  insert into public.profiller (id, rol, ad, dukkan, sehir, telefon)
  values (new.id, r, new.raw_user_meta_data->>'ad', new.raw_user_meta_data->>'dukkan', new.raw_user_meta_data->>'sehir', new.raw_user_meta_data->>'telefon')
  on conflict (id) do nothing;
  return new;
end $$;
drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created after insert on auth.users for each row execute procedure public.yeni_kullanici();

-- ---------- kitaplar: kitapçının envanteri ----------
create table if not exists public.kitaplar (
  id text primary key,                                   -- uygulamanın ürettiği kimlik
  satici uuid not null references public.profiller(id) on delete cascade,
  baslik text not null, yazar text, yayinevi text, baski int, yil int, isbn text, sayfa int, kapak text,
  durum text not null default 'İyi',
  fiyat numeric, adet int not null default 1,
  satis text not null default 'satista' check (satis in ('satista','satildi','pasif')),
  kaynak text, piyasa jsonb,
  eklenme timestamptz not null default now(), guncelleme timestamptz not null default now()
);
create index if not exists kitaplar_satici on public.kitaplar (satici);
create index if not exists kitaplar_isbn on public.kitaplar (isbn);
create index if not exists kitaplar_arama on public.kitaplar using gin (to_tsvector('simple', coalesce(baslik,'') || ' ' || coalesce(yazar,'') || ' ' || coalesce(yayinevi,'')));

create or replace function public.guncelleme_damgasi() returns trigger language plpgsql as $$
begin new.guncelleme := now(); return new; end $$;
drop trigger if exists kitaplar_guncelleme on public.kitaplar;
create trigger kitaplar_guncelleme before update on public.kitaplar for each row execute procedure public.guncelleme_damgasi();

-- vitrin: herkese açık, yalnızca satıştaki ve fiyatlı kitaplar + dükkânın adı/şehri (telefon/adres gizli)
create or replace view public.vitrin as
  select k.id, k.baslik, k.yazar, k.yayinevi, k.baski, k.yil, k.isbn, k.kapak, k.durum, k.fiyat, k.adet, k.satici, k.eklenme,
         p.dukkan, p.sehir
  from public.kitaplar k join public.profiller p on p.id = k.satici
  where k.satis = 'satista' and k.fiyat is not null and k.adet > 0;
grant select on public.vitrin to anon, authenticated;

-- ---------- siparişler ----------
create table if not exists public.siparisler (
  id uuid primary key default gen_random_uuid(),
  musteri uuid references public.profiller(id) on delete set null,   -- üye değilse boş
  satici uuid not null references public.profiller(id) on delete cascade,
  ad text not null, telefon text not null, adres text not null, not_ text,
  odeme text not null default 'havale' check (odeme in ('havale','kapida','whatsapp')),
  durum text not null default 'yeni' check (durum in ('yeni','onaylandi','kargoda','teslim','iptal')),
  kalemler jsonb not null,                       -- [{kitap_id, baslik, fiyat, adet}]
  toplam numeric not null default 0, komisyon numeric not null default 0,
  olusturma timestamptz not null default now(), guncelleme timestamptz not null default now()
);
create index if not exists siparisler_satici on public.siparisler (satici, olusturma desc);
drop trigger if exists siparisler_guncelleme on public.siparisler;
create trigger siparisler_guncelleme before update on public.siparisler for each row execute procedure public.guncelleme_damgasi();

-- sipariş verme: fiyatı sunucudaki değerden alır, stoğu düşer (müşteri fiyatla oynayamaz)
create or replace function public.siparis_ver(p_satici uuid, p_ad text, p_telefon text, p_adres text, p_odeme text, p_not text, p_kalemler jsonb)
returns uuid language plpgsql security definer set search_path = public as $$
declare k jsonb; kit public.kitaplar; v_adet int; toplam numeric := 0; kom numeric := 0; kom_yuzde numeric; kal jsonb := '[]'::jsonb; sid uuid;
begin
  if p_kalemler is null or jsonb_array_length(p_kalemler) = 0 then raise exception 'Sepet boş'; end if;
  if coalesce(p_ad,'') = '' or coalesce(p_telefon,'') = '' or coalesce(p_adres,'') = '' then raise exception 'Ad, telefon ve adres zorunlu'; end if;
  for k in select * from jsonb_array_elements(p_kalemler) loop
    v_adet := greatest(1, coalesce((k->>'adet')::int, 1));
    select * into kit from public.kitaplar where id = k->>'kitap_id' and satici = p_satici and satis = 'satista' and fiyat is not null for update;
    if not found then raise exception 'Kitap artık satışta değil: %', k->>'kitap_id'; end if;
    if kit.adet < v_adet then raise exception 'Yeterli adet yok: %', kit.baslik; end if;
    update public.kitaplar set adet = kit.adet - v_adet, satis = case when kit.adet - v_adet <= 0 then 'satildi' else 'satista' end where id = kit.id;
    toplam := toplam + kit.fiyat * v_adet;
    kal := kal || jsonb_build_object('kitap_id', kit.id, 'baslik', kit.baslik, 'yazar', kit.yazar, 'fiyat', kit.fiyat, 'adet', v_adet, 'durum', kit.durum);
  end loop;
  select coalesce(p.komisyon_yuzde, a.komisyon_yuzde, 0) into kom_yuzde from public.profiller p, public.platform_ayar a where p.id = p_satici and a.id = 1;
  kom := round(toplam * coalesce(kom_yuzde, 0) / 100, 2);
  insert into public.siparisler (musteri, satici, ad, telefon, adres, not_, odeme, kalemler, toplam, komisyon)
  values (auth.uid(), p_satici, p_ad, p_telefon, p_adres, p_not, coalesce(nullif(p_odeme,''), 'havale'), kal, toplam, kom) returning id into sid;
  return sid;
end $$;
grant execute on function public.siparis_ver(uuid, text, text, text, text, text, jsonb) to anon, authenticated;

-- ---------- teklifler: "kitaplarımı toplu satmak istiyorum" talepleri ----------
create table if not exists public.teklifler (
  id uuid primary key default gen_random_uuid(),
  ad text not null, telefon text not null, sehir text, adres text, not_ text,
  kitaplar jsonb not null,                       -- [{baslik, yazar, isbn, durum, piyasa_min, teklif}]
  toplam_teklif numeric,
  durum text not null default 'yeni' check (durum in ('yeni','gorusuldu','alindi','red')),
  olusturma timestamptz not null default now()
);

-- ---------- platform ayarları (tek satır; yalnızca yönetici değiştirir) ----------
create table if not exists public.platform_ayar (
  id int primary key default 1 check (id = 1),
  komisyon_yuzde numeric not null default 0,
  abonelik_aylik numeric not null default 0,
  alim_kurali jsonb not null default '{"kaynak":"min","yuzde":25,"carpan":{"Yeni":60,"Çok iyi":50,"İyi":40,"Orta":30,"Yıpranmış":15}}',
  whatsapp text,                                  -- platformun iletişim numarası (toplu alım için)
  guncelleme timestamptz not null default now()
);
insert into public.platform_ayar (id) values (1) on conflict (id) do nothing;

-- ---------- satır güvenliği (RLS) ----------
alter table public.profiller enable row level security;
alter table public.kitaplar enable row level security;
alter table public.siparisler enable row level security;
alter table public.teklifler enable row level security;
alter table public.platform_ayar enable row level security;

drop policy if exists profil_oku on public.profiller;
create policy profil_oku on public.profiller for select using (id = auth.uid() or public.yonetici_mi());
drop policy if exists profil_ekle on public.profiller;
create policy profil_ekle on public.profiller for insert with check (id = auth.uid());
drop policy if exists profil_guncelle on public.profiller;
create policy profil_guncelle on public.profiller for update using (id = auth.uid() or public.yonetici_mi()) with check (id = auth.uid() or public.yonetici_mi());

drop policy if exists kitap_oku on public.kitaplar;
create policy kitap_oku on public.kitaplar for select using (satici = auth.uid() or public.yonetici_mi() or (satis = 'satista' and fiyat is not null));
drop policy if exists kitap_ekle on public.kitaplar;
create policy kitap_ekle on public.kitaplar for insert with check (satici = auth.uid() or public.yonetici_mi());
drop policy if exists kitap_guncelle on public.kitaplar;
create policy kitap_guncelle on public.kitaplar for update using (satici = auth.uid() or public.yonetici_mi());
drop policy if exists kitap_sil on public.kitaplar;
create policy kitap_sil on public.kitaplar for delete using (satici = auth.uid() or public.yonetici_mi());

drop policy if exists siparis_oku on public.siparisler;
create policy siparis_oku on public.siparisler for select using (satici = auth.uid() or musteri = auth.uid() or public.yonetici_mi());
drop policy if exists siparis_guncelle on public.siparisler;
create policy siparis_guncelle on public.siparisler for update using (satici = auth.uid() or public.yonetici_mi());
-- ekleme yalnızca siparis_ver() üzerinden (security definer)

drop policy if exists teklif_ekle on public.teklifler;
create policy teklif_ekle on public.teklifler for insert with check (true);
drop policy if exists teklif_oku on public.teklifler;
create policy teklif_oku on public.teklifler for select using (public.yonetici_mi());
drop policy if exists teklif_guncelle on public.teklifler;
create policy teklif_guncelle on public.teklifler for update using (public.yonetici_mi());

drop policy if exists ayar_oku on public.platform_ayar;
create policy ayar_oku on public.platform_ayar for select using (true);
drop policy if exists ayar_guncelle on public.platform_ayar;
create policy ayar_guncelle on public.platform_ayar for update using (public.yonetici_mi());

-- yönetici için toplu bakış: satıcı listesi (telefon dahil) — RLS üzerinden zaten görür
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on all tables in schema public to anon, authenticated;
