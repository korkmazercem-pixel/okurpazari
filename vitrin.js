/* OkurPazarı — müşteri vitrini: arama, sepet, sipariş (üyelik gerekmez) */
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const { sb, tl, esc, hataMetni } = window.OP;
  const LS = { get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } }, set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} } };
  const SAYFA = 40;
  const st = { q: "", sehir: "", durum: "", sira: "yeni", liste: [], sayfa: 0, bitti: false, sepet: LS.get("op_sepet", []), musteri: LS.get("op_musteri", {}) };

  function kapakHtml(k, sinif) {
    return k.kapak ? `<img src="${esc(k.kapak)}" alt="" loading="lazy" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'yok',textContent:${JSON.stringify(k.baslik || "")}}))">` : `<div class="yok">${esc(k.baslik)}</div>`;
  }
  function kartHtml(k) {
    const sepette = st.sepet.find((s) => s.id === k.id);
    return `<div class="kart" data-id="${esc(k.id)}">
      <div class="kapak">${kapakHtml(k)}<span class="durum">${esc(k.durum || "")}</span></div>
      <div class="govde"><div class="baslik">${esc(k.baslik)}</div><div class="yazar">${esc(k.yazar || "")}${k.yayinevi ? " · " + esc(k.yayinevi) : ""}${k.yil ? " · " + esc(k.yil) : ""}</div><div class="dukkan">${esc(k.dukkan || "Kitapçı")}${k.sehir ? " · " + esc(k.sehir) : ""}</div>
        <div class="alt"><span class="fiyat">${tl(k.fiyat)}</span><button class="btn small ${sepette ? "" : "primary"}" data-ekle="${esc(k.id)}" type="button">${sepette ? "Sepette ✓" : "Sepete ekle"}</button></div></div></div>`;
  }
  async function ara(sifirla) {
    if (!sb) { $("bos").hidden = false; $("bos").textContent = "Vitrin şu an açılamıyor (bağlantı)."; return; }
    if (sifirla) { st.sayfa = 0; st.liste = []; st.bitti = false; $("izgara").innerHTML = ""; }
    $("sayi").textContent = "Aranıyor…";
    let s = sb.from("vitrin").select("*");
    const q = st.q.trim();
    if (q) { const isbn = q.replace(/[^0-9Xx]/g, ""); if (/^\d{9,13}X?$/i.test(isbn) && isbn.length >= 10) s = s.eq("isbn", isbn); else { const t = q.replace(/[%,()]/g, " ").trim(); s = s.or(`baslik.ilike.%${t}%,yazar.ilike.%${t}%,yayinevi.ilike.%${t}%`); } }
    if (st.sehir) s = s.eq("sehir", st.sehir);
    if (st.durum) s = s.eq("durum", st.durum);
    if (st.sira === "ucuz") s = s.order("fiyat", { ascending: true }); else if (st.sira === "pahali") s = s.order("fiyat", { ascending: false }); else s = s.order("eklenme", { ascending: false });
    s = s.range(st.sayfa * SAYFA, st.sayfa * SAYFA + SAYFA - 1);
    const { data, error } = await s;
    if (error) { $("sayi").textContent = ""; $("bos").hidden = false; $("bos").textContent = "Vitrin okunamadı: " + hataMetni(error); return; }
    const yeni = data || []; st.liste = st.liste.concat(yeni); st.bitti = yeni.length < SAYFA;
    $("izgara").insertAdjacentHTML("beforeend", yeni.map(kartHtml).join(""));
    $("bos").hidden = st.liste.length > 0; if (!st.liste.length) $("bos").innerHTML = q ? 'Aradığın kitap bulunamadı. Başka bir ad dene ya da <a href="sat.html">istek bırak</a>.' : "Vitrinde henüz kitap yok. İlk kitapçılar yüklüyor…";
    $("dahaFazla").hidden = st.bitti; $("sayi").textContent = st.liste.length ? st.liste.length + (st.bitti ? " kitap" : "+ kitap") : "";
    sehirleriDoldur();
  }
  let sehirlerYuklendi = false;
  async function sehirleriDoldur() {
    if (sehirlerYuklendi || !sb) return; sehirlerYuklendi = true;
    const { data } = await sb.from("vitrin").select("sehir").not("sehir", "is", null).limit(1000);
    const set = [...new Set((data || []).map((r) => (r.sehir || "").trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, "tr"));
    $("fSehir").innerHTML = '<option value="">Tüm şehirler</option>' + set.map((x) => `<option${x === st.sehir ? " selected" : ""}>${esc(x)}</option>`).join("");
  }
  $("araForm").addEventListener("submit", (e) => { e.preventDefault(); st.q = $("q").value; ara(true); });
  $("fSehir").addEventListener("change", () => { st.sehir = $("fSehir").value; ara(true); });
  $("fDurum").addEventListener("change", () => { st.durum = $("fDurum").value; ara(true); });
  $("fSira").addEventListener("change", () => { st.sira = $("fSira").value; ara(true); });
  $("dahaFazla").addEventListener("click", () => { st.sayfa++; ara(false); });

  // ---------- sepet ----------
  function sepetKaydet() { LS.set("op_sepet", st.sepet); $("sepetSay").textContent = st.sepet.reduce((a, s) => a + (s.adet || 1), 0); }
  $("izgara").addEventListener("click", (e) => {
    const b = e.target.closest("[data-ekle]"); if (!b) return;
    const k = st.liste.find((x) => x.id === b.dataset.ekle); if (!k) return;
    const var_ = st.sepet.find((s) => s.id === k.id);
    if (var_) { sepetAc(); return; }
    st.sepet.push({ id: k.id, baslik: k.baslik, yazar: k.yazar, fiyat: k.fiyat, kapak: k.kapak, durum: k.durum, satici: k.satici, dukkan: k.dukkan, sehir: k.sehir, stok: k.adet, adet: 1 });
    sepetKaydet(); b.textContent = "Sepette ✓"; b.classList.remove("primary");
  });
  function sepetGoster() {
    const host = $("sepetIcerik"); $("sonuc").hidden = true;
    if (!st.sepet.length) { host.innerHTML = '<div class="bos">Sepet boş.</div>'; $("odemeAlan").hidden = true; return; }
    const gruplar = {}; for (const s of st.sepet) (gruplar[s.satici] = gruplar[s.satici] || []).push(s);
    host.innerHTML = Object.values(gruplar).map((g) => `<div class="grup">${esc(g[0].dukkan || "Kitapçı")}${g[0].sehir ? " · " + esc(g[0].sehir) : ""}</div>` + g.map((s) => `<div class="satir" data-sid="${esc(s.id)}">${s.kapak ? `<img src="${esc(s.kapak)}" alt="">` : '<div class="k"></div>'}<div><div class="baslik">${esc(s.baslik)}</div><div class="yazar">${esc(s.yazar || "")} · ${esc(s.durum || "")}</div><div class="fiyat">${tl(s.fiyat)}</div></div>
      <div style="display:grid;gap:4px;justify-items:end"><div><button class="btn small" data-az="${esc(s.id)}" type="button">−</button> <b>${s.adet}</b> <button class="btn small" data-cok="${esc(s.id)}" type="button">+</button></div><button class="btn small danger" data-cikar="${esc(s.id)}" type="button">Çıkar</button></div></div>`).join("")).join("");
    $("odemeAlan").hidden = false; $("sepetToplam").textContent = tl(st.sepet.reduce((a, s) => a + Number(s.fiyat || 0) * s.adet, 0));
    $("oAd").value = st.musteri.ad || ""; $("oTel").value = st.musteri.telefon || ""; $("oAdres").value = st.musteri.adres || "";
  }
  function sepetAc() { sepetGoster(); $("sepetPanel").hidden = false; }
  $("sepetAc").addEventListener("click", sepetAc);
  $("sepetKapat").addEventListener("click", () => { $("sepetPanel").hidden = true; });
  $("sepetPanel").addEventListener("click", (e) => { if (e.target === $("sepetPanel")) $("sepetPanel").hidden = true; });
  $("sepetIcerik").addEventListener("click", (e) => {
    const az = e.target.closest("[data-az]"), cok = e.target.closest("[data-cok]"), cik = e.target.closest("[data-cikar]");
    const id = (az || cok || cik || {}).dataset && (az || cok || cik).dataset[az ? "az" : cok ? "cok" : "cikar"]; if (!id) return;
    const s = st.sepet.find((x) => x.id === id); if (!s) return;
    if (az) s.adet = Math.max(1, s.adet - 1); if (cok) s.adet = Math.min(s.stok || 99, s.adet + 1); if (cik) st.sepet = st.sepet.filter((x) => x.id !== id);
    sepetKaydet(); sepetGoster(); if (cik) { const b = document.querySelector(`[data-ekle="${CSS.escape(id)}"]`); if (b) { b.textContent = "Sepete ekle"; b.classList.add("primary"); } }
  });
  $("siparisVer").addEventListener("click", async () => {
    const ad = $("oAd").value.trim(), tel = $("oTel").value.trim(), adres = $("oAdres").value.trim(), odeme = $("oOdeme").value, not_ = $("oNot").value.trim();
    $("oHata").textContent = "";
    if (!ad || !tel || !adres) { $("oHata").textContent = "Ad, telefon ve adres gerekli."; return; }
    st.musteri = { ad, telefon: tel, adres }; LS.set("op_musteri", st.musteri);
    $("siparisVer").disabled = true; $("siparisVer").textContent = "Gönderiliyor…";
    const gruplar = {}; for (const s of st.sepet) (gruplar[s.satici] = gruplar[s.satici] || []).push(s);
    const sonuclar = [];
    for (const [satici, g] of Object.entries(gruplar)) {
      const { data, error } = await sb.rpc("siparis_ver", { p_satici: satici, p_ad: ad, p_telefon: tel, p_adres: adres, p_odeme: odeme, p_not: not_ || null, p_kalemler: g.map((s) => ({ kitap_id: s.id, adet: s.adet })) });
      if (error) sonuclar.push({ dukkan: g[0].dukkan, hata: hataMetni(error) }); else { sonuclar.push({ dukkan: g[0].dukkan, no: data }); st.sepet = st.sepet.filter((s) => s.satici !== satici); }
    }
    sepetKaydet(); $("siparisVer").disabled = false; $("siparisVer").textContent = "Siparişi gönder";
    const basarili = sonuclar.filter((s) => s.no);
    if (basarili.length) {
      $("sepetIcerik").innerHTML = ""; $("odemeAlan").hidden = st.sepet.length === 0;
      $("sonuc").hidden = false;
      $("sonuc").innerHTML = `<div class="bos" style="border-style:solid;border-color:var(--ok)"><div class="ok">Siparişin alındı 🎉</div><p>${basarili.map((s) => esc(s.dukkan || "Kitapçı") + " — sipariş no " + esc(String(s.no).slice(0, 8).toUpperCase())).join("<br>")}</p><p class="not">Kitapçı seni ${esc(tel)} numarasından arayacak ya da WhatsApp'tan yazacak; ödeme ve kargo orada netleşir.</p>${sonuclar.filter((s) => s.hata).map((s) => `<p class="hata">${esc(s.dukkan || "")}: ${esc(s.hata)}</p>`).join("")}</div>`;
      document.querySelectorAll("[data-ekle]").forEach((b) => { if (!st.sepet.find((s) => s.id === b.dataset.ekle)) { b.textContent = "Sepete ekle"; b.classList.add("primary"); } });
      ara(true);
    } else $("oHata").textContent = sonuclar.map((s) => (s.dukkan || "") + ": " + s.hata).join(" · ");
  });

  // başlangıç
  sepetKaydet();
  const u = new URLSearchParams(location.search); if (u.get("q")) { st.q = u.get("q"); $("q").value = st.q; }
  ara(true);
})();
