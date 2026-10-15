-- 002: havale bilgisi (IBAN) + sipariş fonksiyonu ödeme bilgisini de döndürür
alter table public.profiller add column if not exists iban text, add column if not exists hesap_adi text;

drop function if exists public.siparis_ver(uuid, text, text, text, text, text, jsonb);
create or replace function public.siparis_ver(p_satici uuid, p_ad text, p_telefon text, p_adres text, p_odeme text, p_not text, p_kalemler jsonb)
returns jsonb language plpgsql security definer set search_path = public as $$
declare k jsonb; kit public.kitaplar; v_adet int; toplam numeric := 0; kom numeric := 0; kom_yuzde numeric; kal jsonb := '[]'::jsonb; sid uuid; pr public.profiller;
begin
  if p_kalemler is null or jsonb_array_length(p_kalemler) = 0 then raise exception 'Sepet boş'; end if;
  if coalesce(p_ad,'') = '' or coalesce(p_telefon,'') = '' or coalesce(p_adres,'') = '' then raise exception 'Ad, telefon ve adres zorunlu'; end if;
  select * into pr from public.profiller where id = p_satici;
  if not found then raise exception 'Satıcı bulunamadı'; end if;
  for k in select * from jsonb_array_elements(p_kalemler) loop
    v_adet := greatest(1, coalesce((k->>'adet')::int, 1));
    select * into kit from public.kitaplar where id = k->>'kitap_id' and satici = p_satici and satis = 'satista' and fiyat is not null for update;
    if not found then raise exception 'Kitap artık satışta değil: %', k->>'kitap_id'; end if;
    if kit.adet < v_adet then raise exception 'Yeterli adet yok: %', kit.baslik; end if;
    update public.kitaplar set adet = kit.adet - v_adet, satis = case when kit.adet - v_adet <= 0 then 'satildi' else 'satista' end where id = kit.id;
    toplam := toplam + kit.fiyat * v_adet;
    kal := kal || jsonb_build_object('kitap_id', kit.id, 'baslik', kit.baslik, 'yazar', kit.yazar, 'fiyat', kit.fiyat, 'adet', v_adet, 'durum', kit.durum);
  end loop;
  select coalesce(pr.komisyon_yuzde, a.komisyon_yuzde, 0) into kom_yuzde from public.platform_ayar a where a.id = 1;
  kom := round(toplam * coalesce(kom_yuzde, 0) / 100, 2);
  insert into public.siparisler (musteri, satici, ad, telefon, adres, not_, odeme, kalemler, toplam, komisyon)
  values (auth.uid(), p_satici, p_ad, p_telefon, p_adres, p_not, coalesce(nullif(p_odeme,''), 'havale'), kal, toplam, kom) returning id into sid;
  -- müşteriye ödeme/iletişim bilgisi: yalnızca sipariş verene, bu cevapta
  return jsonb_build_object('id', sid, 'toplam', toplam, 'dukkan', pr.dukkan, 'telefon', pr.telefon, 'iban', pr.iban, 'hesap_adi', pr.hesap_adi);
end $$;
grant execute on function public.siparis_ver(uuid, text, text, text, text, text, jsonb) to anon, authenticated;
