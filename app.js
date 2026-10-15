/* OkurPazarı — raf tarama (sürüm 0.1)
   Barkod: cihaz içi (BarcodeDetector veya ZXing). Kitap bilgisi: Google Books + Open Library (anahtarsız).
   Kapak/sırt: Gemini (anahtar Ayarlar'dan). Kayıt: şimdilik telefonun yerel deposu (localStorage). */
(() => {
  "use strict";
  const $ = (id) => document.getElementById(id);
  const DURUMLAR = ["Yeni", "Çok iyi", "İyi", "Orta", "Yıpranmış"];
  const LS = {
    get(k, d) { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  };
  const st = {
    stream: null, track: null, torch: false, detector: null, zx: null, loopId: 0, okuyor: false,
    sonGorme: new Map(), bulunan: [], kitaplar: LS.get("op_kitaplar", []), dukkan: LS.get("op_dukkan", {}),
    ai: LS.get("op_ai", { key: "", model: "gemini-2.5-flash" }),
  };

  // ---------- yardımcılar ----------
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const num = (v) => { const n = parseFloat(String(v ?? "").replace(",", ".")); return Number.isFinite(n) ? n : null; };
  const tl = (v) => (v == null ? "—" : new Intl.NumberFormat("tr-TR", { style: "currency", currency: "TRY", maximumFractionDigits: 2 }).format(v));
  const norm = (s) => String(s ?? "").toLocaleLowerCase("tr-TR").replace(/[^a-zçğıöşü0-9 ]/g, "").replace(/\s+/g, " ").trim();
  const durum = (msg, err) => { $("durum").textContent = msg; $("durum").classList.toggle("err", !!err); };
  const toast = (msg) => { $("toast").textContent = msg; };
  const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  function isbnDuzelt(raw) {
    const d = String(raw || "").replace(/[^0-9Xx]/g, "").toUpperCase();
    if (/^97[89]\d{10}$/.test(d)) return d;
    if (/^\d{9}[\dX]$/.test(d)) return d;
    return "";
  }
  function bip() {
    try {
      const ac = bip.ac || (bip.ac = new (window.AudioContext || window.webkitAudioContext)());
      const o = ac.createOscillator(), g = ac.createGain();
      o.frequency.value = 1320; g.gain.value = 0.06; o.connect(g); g.connect(ac.destination); o.start(); o.stop(ac.currentTime + 0.09);
    } catch (e) {}
  }
  function flash() { const f = $("flash"); f.classList.add("on"); setTimeout(() => f.classList.remove("on"), 60); }

  // ---------- sekmeler ----------
  const tabs = [...document.querySelectorAll('nav [role="tab"]')];
  function goTab(id) { for (const t of tabs) { const on = t.id === id; t.setAttribute("aria-selected", on); $(t.getAttribute("aria-controls")).hidden = !on; } LS.set("op_tab", id); }
  tabs.forEach((t) => t.addEventListener("click", () => goTab(t.id)));
  { const s = LS.get("op_tab", null); if (s && tabs.find((t) => t.id === s)) goTab(s); }

  // ---------- kitap bilgisi (anahtarsız) ----------
  async function googleBooks(q) {
    const r = await fetch("https://www.googleapis.com/books/v1/volumes?maxResults=3&printType=books&q=" + encodeURIComponent(q), { cache: "no-store" });
    if (!r.ok) throw new Error("gb " + r.status);
    const j = await r.json();
    return (j.items || []).map((it) => {
      const v = it.volumeInfo || {}; const id = (v.industryIdentifiers || []);
      const i13 = id.find((x) => x.type === "ISBN_13"), i10 = id.find((x) => x.type === "ISBN_10");
      return { baslik: [v.title, v.subtitle].filter(Boolean).join(": "), yazar: (v.authors || []).join(", "), yayinevi: v.publisher || "", yil: (v.publishedDate || "").slice(0, 4),
        sayfa: v.pageCount || "", isbn: (i13 && i13.identifier) || (i10 && i10.identifier) || "", kapak: ((v.imageLinks || {}).thumbnail || "").replace(/^http:/, "https:"), dil: v.language || "" };
    });
  }
  async function openLibrary(isbn) {
    const r = await fetch("https://openlibrary.org/api/books?bibkeys=ISBN:" + isbn + "&format=json&jscmd=data");
    if (!r.ok) throw new Error("ol " + r.status);
    const d = (await r.json())["ISBN:" + isbn];
    if (!d) return null;
    return { baslik: d.title || "", yazar: (d.authors || []).map((a) => a.name).join(", "), yayinevi: (d.publishers || []).map((p) => p.name).join(", "), yil: String(d.publish_date || "").match(/\d{4}/)?.[0] || "",
      sayfa: d.number_of_pages || "", isbn, kapak: (d.cover && (d.cover.medium || d.cover.small)) || "", dil: "" };
  }
  async function isbnBilgi(isbn) {
    let b = null;
    try { const l = await googleBooks("isbn:" + isbn); if (l.length) b = l[0]; } catch (e) {}
    if (!b || !b.baslik) { try { b = (await openLibrary(isbn)) || b; } catch (e) {} }
    return b;
  }
  function yeniKayit(b, kaynak, guven) {
    return { id: uid(), baslik: b.baslik || "", yazar: b.yazar || "", yayinevi: b.yayinevi || "", baski: b.baski ?? "", yil: b.yil ?? "", isbn: b.isbn || "", sayfa: b.sayfa || "", kapak: b.kapak || "",
      kaynak, guven: guven ?? 1, bilgi: !!b.baslik, durum: "İyi", fiyat: "", adet: 1 };
  }
  function listedeVar(isbn) { return isbn && (st.bulunan.some((k) => k.isbn === isbn) || st.kitaplar.some((k) => k.isbn === isbn && k.satis !== "satildi")); }

  async function isbnGeldi(raw, nasil) {
    const isbn = isbnDuzelt(raw); if (!isbn) return false;
    const t = Date.now(), son = st.sonGorme.get(isbn) || 0; st.sonGorme.set(isbn, t);
    if (t - son < 2500) return true;              // kare kare aynı barkod: tek sayılır
    flash(); bip();
    if (listedeVar(isbn)) { toast("Bu kitap zaten listede (" + isbn + ")"); return true; }
    const yer = yeniKayit({ isbn }, nasil || "barkod", 1); yer.bekliyor = true;
    st.bulunan.unshift(yer); bulunanGoster();
    toast("ISBN " + isbn + " okundu, bilgi aranıyor…");
    const b = await isbnBilgi(isbn);
    const i = st.bulunan.findIndex((k) => k.id === yer.id); if (i < 0) return true;
    if (b) Object.assign(st.bulunan[i], { baslik: b.baslik, yazar: b.yazar, yayinevi: b.yayinevi, yil: b.yil, sayfa: b.sayfa, kapak: b.kapak, bilgi: !!b.baslik });
    st.bulunan[i].bekliyor = false;
    toast(b && b.baslik ? b.baslik + " eklendi" : "Bilgi bulunamadı (" + isbn + "): adını elle yaz ya da kapağı okut");
    bulunanGoster();
    return true;
  }

  // ---------- kamera ----------
  function tarayici() {
    const u = navigator.userAgent || "";
    if (/HuaweiBrowser|HONORBrowser/i.test(u)) return "Huawei Tarayıcı";
    if (/SamsungBrowser/i.test(u)) return "Samsung Internet";
    if (/MiuiBrowser|XiaoMi/i.test(u)) return "Mi Tarayıcı";
    if (/OPR\/|Opera/i.test(u)) return "Opera";
    if (/EdgA|Edg\//i.test(u)) return "Edge";
    if (/Firefox|FxiOS/i.test(u)) return "Firefox";
    if (/; wv\)|FBAN|FBAV|Instagram|WhatsApp|Line\//i.test(u)) return "uygulama içi tarayıcı";
    if (/CriOS/i.test(u)) return "Chrome (iPhone)";
    if (/Chrome\//i.test(u)) return "Chrome";
    if (/Safari\//i.test(u)) return "Safari";
    return "bilinmeyen tarayıcı";
  }
  const ANDROID = /Android/i.test(navigator.userAgent || "");
  function chromeLink() {
    if (!ANDROID) return "";
    const h = location.href.replace(/^https?:\/\//, "");
    return ' <a class="btn" href="intent://' + esc(h) + '#Intent;scheme=https;package=com.android.chrome;end">Chrome ile aç</a>';
  }
  function kameraHata(e) {
    const ad = (e && e.name) || "", msj = (e && e.message) || "", tb = tarayici();
    let m;
    if (/NotAllowed|PermissionDenied|Security/i.test(ad)) {
      m = "Kamera izni verilmedi (" + tb + "). İzin penceresi çıktıysa <b>İzin ver</b>'e bas. Çıkmadıysa: adres çubuğundaki <b>kilit</b> simgesi → İzinler → Kamera → İzin ver.";
    } else if (/NotFound|DevicesNotFound/i.test(ad)) {
      m = "Telefonda kamera bulunamadı ya da tarayıcının kamera izni telefon ayarlarında kapalı (Ayarlar → Uygulamalar → " + tb + " → İzinler → Kamera).";
    } else if (/NotReadable|TrackStart|Abort/i.test(ad)) {
      m = "Kamerayı başka bir uygulama kullanıyor. Kamera/WhatsApp gibi açık uygulamaları kapatıp tekrar dene.";
    } else if (/TypeError/i.test(ad) || !window.isSecureContext) {
      m = "Bu sayfa güvenli (https) açılmamış; kamera çalışmaz. Adresin https:// ile başladığından emin ol.";
    } else {
      m = "Kamera açılamadı (" + tb + ", " + (ad || "hata") + (msj ? ": " + esc(msj) : "") + ").";
    }
    m += " Olmazsa <b>Chrome</b> ile aç; ya da <b>🖼 Fotoğraftan oku</b> ile telefonun kamerasından fotoğraf çek, barkodlar fotoğraftan okunur." + chromeLink();
    $("durum").innerHTML = m; $("durum").classList.add("err");
  }
  async function kameraAc() {
    if (!window.isSecureContext) { kameraHata({ name: "TypeError" }); return; }
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      $("durum").innerHTML = "Bu tarayıcı (" + tarayici() + ") canlı kamerayı desteklemiyor. Sayfayı <b>Chrome</b> ile aç ya da <b>🖼 Fotoğraftan oku</b> ile fotoğraf çek." + chromeLink();
      $("durum").classList.add("err"); return;
    }
    durum("Kamera izni isteniyor… çıkan pencerede İzin ver'e bas.");
    const denemeler = [
      { audio: false, video: { facingMode: { ideal: "environment" }, width: { ideal: 1920 }, height: { ideal: 1080 } } },
      { audio: false, video: { facingMode: "environment" } },
      { audio: false, video: true },
    ];
    let hata = null; st.stream = null;
    for (const c of denemeler) {
      try { st.stream = await navigator.mediaDevices.getUserMedia(c); hata = null; break; }
      catch (e) { hata = e; if (/NotAllowed|PermissionDenied|Security/i.test((e && e.name) || "")) break; }
    }
    if (!st.stream) { kameraHata(hata); return; }
    const v = $("video"); v.srcObject = st.stream; st.track = st.stream.getVideoTracks()[0];
    try { await v.play(); } catch (e) {}
    $("cam").hidden = false; $("camKontrol").hidden = false; $("basla").hidden = true;
    const cap = st.track.getCapabilities ? st.track.getCapabilities() : {};
    $("fener").hidden = !cap.torch;
    st.detector = null;
    if ("BarcodeDetector" in window) {
      try { const f = await BarcodeDetector.getSupportedFormats(); if (f.includes("ean_13")) st.detector = new BarcodeDetector({ formats: ["ean_13", "ean_8", "upc_a"] }); } catch (e) {}
    }
    if (st.detector) { toast("Barkodu çerçeveye getir"); dongu(); }
    else if (window.ZXing) {
      try {
        const hints = new Map(); hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, [ZXing.BarcodeFormat.EAN_13, ZXing.BarcodeFormat.EAN_8, ZXing.BarcodeFormat.UPC_A]); hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
        st.zx = new ZXing.BrowserMultiFormatReader(hints, 300);
        st.zx.decodeFromStream(st.stream, v, (res) => { if (res) isbnGeldi(res.getText(), "barkod"); });
        toast("Barkodu çerçeveye getir");
      } catch (e) { toast("Barkod okuyucu başlatılamadı; Kapak/sırt oku ile devam et."); }
    } else toast("Barkod okuyucu yok; Kapak/sırt oku ile devam et.");
    durum("Kamera açık. Barkodu çerçeveye getir; barkodsuz kitapta Kapak/sırt oku.");
  }
  async function dongu() {
    const my = ++st.loopId; const v = $("video");
    while (st.loopId === my && st.stream) {
      if (v.readyState >= 2 && !st.okuyor) {
        try { const codes = await st.detector.detect(v); for (const c of codes) await isbnGeldi(c.rawValue, "barkod"); } catch (e) {}
      }
      await new Promise((r) => setTimeout(r, 220));
    }
  }
  function kameraKapat() {
    st.loopId++;
    try { st.zx && st.zx.reset(); } catch (e) {} st.zx = null;
    try { st.stream && st.stream.getTracks().forEach((t) => t.stop()); } catch (e) {}
    st.stream = null; st.track = null;
    $("cam").hidden = true; $("camKontrol").hidden = true; $("basla").hidden = false;
  }
  $("basla").addEventListener("click", kameraAc);
  $("durdur").addEventListener("click", () => { kameraKapat(); durum("Kamera kapatıldı."); });
  $("fener").addEventListener("click", async () => { if (!st.track) return; st.torch = !st.torch; try { await st.track.applyConstraints({ advanced: [{ torch: st.torch }] }); } catch (e) {} });

  function kareAl() {
    const v = $("video"); const c = document.createElement("canvas");
    const s = Math.min(1, 1600 / Math.max(v.videoWidth, v.videoHeight));
    c.width = Math.round(v.videoWidth * s); c.height = Math.round(v.videoHeight * s);
    c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
    return c;
  }
  const kanvasBlob = (c) => new Promise((r) => c.toBlob(r, "image/jpeg", 0.86));
  const blobB64 = (blob) => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(",")[1]); fr.onerror = rej; fr.readAsDataURL(blob); });

  // ---------- kapak / sırt okuma (Gemini) ----------
  const PROMPT_FOTO = `Bu fotoğrafta kitap(lar) var: raf sırtları, kapaklar veya arka kapak barkodları olabilir. Görünen HER kitap için bir nesne üret, hiçbirini atlama.
Alanlar: "baslik", "yazar", "yayinevi", "baski" (kaçıncı baskı, sayı; görünmüyorsa null), "yil" (sayı; görünmüyorsa null), "isbn" (barkodun yanında yazan 13 ya da 10 haneli numara, boşluksuz; görünmüyorsa null), "kaynak" ("kapak", "sirt" veya "barkod"), "guven" (0-1).
Kurallar: Okuyamadığın alanı null bırak, asla uydurma. Sırtlarda yazar genelde üstte/altta küçük yazar, en altta yayınevi logosu olur. Türkçe karakterleri koru. Kitap olmayan nesneleri atla.
Yalnızca JSON dizi döndür: [{"baslik":"...","yazar":"...","yayinevi":"...","baski":null,"yil":null,"isbn":null,"kaynak":"sirt","guven":0.9}]`;
  async function gemini(parts, model) {
    const key = (st.ai.key || "").trim();
    if (!key) throw { code: "anahtar_yok" };
    const url = "https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(model || st.ai.model || "gemini-2.5-flash") + ":generateContent?key=" + encodeURIComponent(key);
    const r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ contents: [{ parts }], generationConfig: { temperature: 0.1, responseMimeType: "application/json" } }) });
    if (!r.ok) { let m = ""; try { m = (await r.json()).error?.message || ""; } catch (e) {} throw { code: "http_" + r.status, message: m }; }
    const j = await r.json();
    const text = (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
    const m = text.match(/[\[{][\s\S]*[\]}]/);
    return JSON.parse(m ? m[0] : text);
  }
  async function gorselOku(blob) {
    st.okuyor = true;
    try {
      durum("Görüntü okunuyor…"); toast("Okunuyor…");
      const b64 = await blobB64(blob);
      let liste = await gemini([{ text: PROMPT_FOTO }, { inline_data: { mime_type: "image/jpeg", data: b64 } }]);
      if (!Array.isArray(liste)) liste = liste && Array.isArray(liste.kitaplar) ? liste.kitaplar : [];
      liste = liste.filter((k) => k && (k.baslik || k.isbn));
      if (!liste.length) { durum("Bu karede kitap okunamadı. Daha yakından ve düz tut.", true); toast("Kitap bulunamadı"); return; }
      let n = 0;
      for (const k of liste) {
        const isbn = isbnDuzelt(k.isbn || "");
        if (isbn && listedeVar(isbn)) continue;
        const kayit = yeniKayit({ baslik: k.baslik || "", yazar: k.yazar || "", yayinevi: k.yayinevi || "", baski: k.baski ?? "", yil: k.yil ?? "", isbn }, k.kaynak || "kapak", num(k.guven) ?? 0.6);
        if (isbn) { const b = await isbnBilgi(isbn); if (b && b.baslik) Object.assign(kayit, { baslik: b.baslik, yazar: b.yazar || kayit.yazar, yayinevi: b.yayinevi || kayit.yayinevi, yil: b.yil || kayit.yil, kapak: b.kapak, bilgi: true }); }
        else if (kayit.baslik && !kayit.kapak) { try { const l = await googleBooks("intitle:" + kayit.baslik + (kayit.yazar ? " inauthor:" + kayit.yazar : "")); if (l.length && norm(l[0].baslik).startsWith(norm(kayit.baslik).slice(0, 12))) { kayit.kapak = l[0].kapak; if (!kayit.isbn) kayit.isbn = l[0].isbn; if (!kayit.yayinevi) kayit.yayinevi = l[0].yayinevi; } } catch (e) {} }
        st.bulunan.unshift(kayit); n++;
      }
      bulunanGoster(); flash(); bip();
      durum(n + " kitap okundu. Kontrol et, fiyat yaz, kaydet."); toast(n + " kitap eklendi");
    } catch (e) {
      const k = e && e.code;
      if (k === "anahtar_yok") { durum("Kapak/sırt okuma için Ayarlar'dan Gemini anahtarı gir. Barkod okuma anahtarsız çalışır.", true); toast("Anahtar yok: Ayarlar"); }
      else if (k === "http_429") durum("Ücretsiz kota doldu; birkaç dakika sonra tekrar dene.", true);
      else if (k === "http_400" || k === "http_403") durum("Anahtar geçersiz ya da yetkisiz: " + (e.message || ""), true);
      else durum("Okuma başarısız: " + (e.message || k || "bağlantı"), true);
    } finally { st.okuyor = false; }
  }
  $("kapakOku").addEventListener("click", async () => { if (!st.stream) return; const c = kareAl(); flash(); await gorselOku(await kanvasBlob(c)); });

  // fotoğraftan: barkod + (anahtar varsa) görsel okuma
  $("dosya").addEventListener("change", async (e) => {
    const files = [...e.target.files]; e.target.value = "";
    if (!files.length) return;
    durum("Fotoğraf okunuyor…");
    for (const f of files.slice(0, 10)) {
      let bulundu = false;
      try {
        let bmp;
        try { bmp = await createImageBitmap(f, { imageOrientation: "from-image" }); }
        catch (err) { const img = new Image(); img.src = URL.createObjectURL(f); await img.decode(); bmp = img; URL.revokeObjectURL(img.src); }
        const w = bmp.width || bmp.naturalWidth, h = bmp.height || bmp.naturalHeight;
        const c = document.createElement("canvas"); const s = Math.min(1, 1600 / Math.max(w, h));
        c.width = Math.round(w * s); c.height = Math.round(h * s); c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
        if ("BarcodeDetector" in window) { try { const d = new BarcodeDetector({ formats: ["ean_13", "ean_8", "upc_a"] }); for (const r of await d.detect(c)) { st.sonGorme.delete(isbnDuzelt(r.rawValue)); if (await isbnGeldi(r.rawValue, "barkod")) bulundu = true; } } catch (err) {} }
        if (!bulundu && window.ZXing) {
          try {
            const hints = new Map(); hints.set(ZXing.DecodeHintType.POSSIBLE_FORMATS, [ZXing.BarcodeFormat.EAN_13, ZXing.BarcodeFormat.EAN_8, ZXing.BarcodeFormat.UPC_A]); hints.set(ZXing.DecodeHintType.TRY_HARDER, true);
            const rd = new ZXing.BrowserMultiFormatReader(hints); const img = new Image(); img.src = c.toDataURL("image/jpeg", 0.9); await img.decode();
            const r = await rd.decodeFromImageElement(img); if (r) { st.sonGorme.delete(isbnDuzelt(r.getText())); bulundu = await isbnGeldi(r.getText(), "barkod"); }
          } catch (err) {}
        }
        if (st.ai.key) await gorselOku(await kanvasBlob(c));
        else if (!bulundu) durum("Fotoğrafta barkod bulunamadı; barkodu yakından, düz ve net çek. Kapak/sırt okuma için Ayarlar'dan anahtar gir.", true);
        else durum("Fotoğraftan okundu.");
      } catch (err) { durum("Fotoğraf okunamadı (" + ((err && err.name) || "hata") + ").", true); }
    }
  });

  // elle: ISBN ya da ad
  async function elleEkle() {
    const t = $("elle").value.trim(); if (!t) return;
    const isbn = isbnDuzelt(t);
    if (isbn) { st.sonGorme.delete(isbn); await isbnGeldi(isbn, "elle"); $("elle").value = ""; return; }
    durum("Aranıyor: " + t);
    try {
      const l = await googleBooks(t);
      if (l.length) { st.bulunan.unshift(yeniKayit(l[0], "arama", 0.7)); durum(l[0].baslik + " eklendi; doğru kitap değilse düzelt."); }
      else { st.bulunan.unshift(yeniKayit({ baslik: t }, "elle", 0.5)); durum("Veritabanında yok; adı yazıldı, kalanını doldur."); }
      $("elle").value = ""; bulunanGoster();
    } catch (e) { st.bulunan.unshift(yeniKayit({ baslik: t }, "elle", 0.5)); bulunanGoster(); durum("Arama yapılamadı; adı yazıldı."); }
  }
  $("elleEkle").addEventListener("click", elleEkle);
  $("elle").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); elleEkle(); } });

  // ---------- bulunanlar ----------
  function bulunanGoster() {
    const host = $("bulunan"); $("bulunanBand").hidden = !st.bulunan.length; $("bulunanSay").textContent = st.bulunan.length;
    host.innerHTML = st.bulunan.map((k, i) => {
      const g = k.bekliyor ? "warn" : k.bilgi || k.guven >= 0.75 ? "ok" : "warn";
      return `<div class="card" data-i="${i}">
        <div class="book">
          ${k.kapak ? `<img src="${esc(k.kapak)}" alt="">` : `<div style="width:56px;height:80px;border-radius:4px;background:var(--surface)"></div>`}
          <div style="min-width:0"><div class="title">${esc(k.baslik || (k.bekliyor ? "Aranıyor…" : "Adı okunamadı"))}</div><div class="meta">${esc(k.yazar || "")}${k.yayinevi ? " · " + esc(k.yayinevi) : ""}${k.yil ? " · " + esc(k.yil) : ""}${k.isbn ? " · ISBN " + esc(k.isbn) : ""}</div>
          <div class="row" style="margin-top:4px"><span class="chip">${esc(k.kaynak)}</span><span class="chip ${g}">${k.bekliyor ? "bilgi aranıyor" : k.bilgi ? "veritabanından" : "okuma %" + Math.round((k.guven || 0) * 100)}</span></div></div>
          <button class="btn danger" type="button" data-sil="${i}">Çıkar</button>
        </div>
        <div class="fields">
          <label class="field wide">Kitap adı<input data-k="baslik" value="${esc(k.baslik)}" placeholder="zorunlu"></label>
          <label class="field">Yazar<input data-k="yazar" value="${esc(k.yazar)}"></label>
          <label class="field">Yayınevi<input data-k="yayinevi" value="${esc(k.yayinevi)}"></label>
          <label class="field">Baskı<input data-k="baski" inputmode="numeric" value="${esc(k.baski)}"></label>
          <label class="field">Yıl<input data-k="yil" inputmode="numeric" value="${esc(k.yil)}"></label>
          <label class="field">ISBN<input data-k="isbn" inputmode="numeric" value="${esc(k.isbn)}"></label>
          <label class="field">Durum<select data-k="durum">${DURUMLAR.map((d) => `<option ${d === k.durum ? "selected" : ""}>${d}</option>`).join("")}</select></label>
          <label class="field">Fiyat (₺)<input data-k="fiyat" inputmode="decimal" value="${esc(k.fiyat)}" placeholder="zorunlu"></label>
          <label class="field">Adet<input data-k="adet" inputmode="numeric" value="${esc(k.adet)}"></label>
        </div></div>`;
    }).join("");
  }
  $("bulunan").addEventListener("input", (e) => { const card = e.target.closest("[data-i]"); const k = e.target.dataset.k; if (!card || !k) return; const it = st.bulunan[+card.dataset.i]; if (it) it[k] = e.target.value; });
  $("bulunan").addEventListener("click", (e) => { const b = e.target.closest("[data-sil]"); if (!b) return; st.bulunan.splice(+b.dataset.sil, 1); bulunanGoster(); });
  $("temizle").addEventListener("click", () => { st.bulunan = []; bulunanGoster(); durum("Liste boşaltıldı."); });
  $("kaydet").addEventListener("click", () => {
    const eksik = st.bulunan.findIndex((k) => !String(k.baslik).trim() || num(k.fiyat) == null);
    if (eksik >= 0) { durum("Kayıt " + (eksik + 1) + ": kitap adı ve fiyat zorunlu.", true); return; }
    const simdi = new Date().toISOString();
    for (const k of st.bulunan) st.kitaplar.unshift({ ...k, baslik: String(k.baslik).trim(), fiyat: num(k.fiyat), adet: Math.max(1, Math.round(num(k.adet) ?? 1)), baski: num(k.baski), yil: num(k.yil), satis: "satista", eklenme: simdi, bekliyor: undefined });
    LS.set("op_kitaplar", st.kitaplar);
    const n = st.bulunan.length; st.bulunan = []; bulunanGoster(); kitaplarGoster();
    durum(n + " kitap kaydedildi (Kitaplarım).");
  });

  // ---------- kitaplarım ----------
  function kitaplarGoster() {
    const q = norm($("ara").value); const host = $("liste");
    const satista = st.kitaplar.filter((k) => k.satis !== "satildi");
    $("ozet").textContent = satista.length ? satista.length + " kayıt · raf değeri " + tl(satista.reduce((a, k) => a + (num(k.fiyat) || 0) * (num(k.adet) || 1), 0)) : "";
    const l = st.kitaplar.filter((k) => !q || norm(k.baslik + " " + k.yazar + " " + k.isbn).includes(q));
    if (!l.length) { host.innerHTML = `<div class="empty">${st.kitaplar.length ? "Aramana uyan kayıt yok." : "Henüz kitap yok. Tara sekmesinden rafını okut."}</div>`; return; }
    host.innerHTML = l.map((k) => `<div class="card" data-id="${esc(k.id)}">
      <div class="book">${k.kapak ? `<img src="${esc(k.kapak)}" alt="">` : `<div style="width:56px;height:80px;border-radius:4px;background:var(--surface)"></div>`}
        <div style="min-width:0"><div class="title">${esc(k.baslik)}</div><div class="meta">${esc(k.yazar || "")}${k.yayinevi ? " · " + esc(k.yayinevi) : ""}${k.baski ? " · " + esc(k.baski) + ". baskı" : ""}${k.isbn ? " · " + esc(k.isbn) : ""}</div>
          <div class="row" style="margin-top:4px">${k.satis === "satildi" ? '<span class="chip warn">satıldı</span>' : '<span class="chip ok">satışta</span>'}<span class="chip">${esc(k.durum)}</span></div></div>
        <div style="text-align:right"><div class="price">${tl(num(k.fiyat))}</div><div class="meta">${esc(k.adet || 1)} adet</div></div></div>
      <div class="row">${k.satis === "satildi" ? '<button class="btn" data-act="geri">Tekrar satışa koy</button>' : '<button class="btn" data-act="satildi">Satıldı</button>'}<button class="btn danger" data-act="sil">Sil</button></div></div>`).join("");
  }
  $("ara").addEventListener("input", kitaplarGoster);
  $("liste").addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]"); if (!b) return; const id = b.closest("[data-id]").dataset.id; const k = st.kitaplar.find((x) => x.id === id); if (!k) return;
    if (b.dataset.act === "satildi") k.satis = "satildi";
    if (b.dataset.act === "geri") k.satis = "satista";
    if (b.dataset.act === "sil") { if (b.dataset.onay !== "1") { b.dataset.onay = "1"; b.textContent = "Emin misin? Sil"; return; } st.kitaplar = st.kitaplar.filter((x) => x.id !== id); }
    LS.set("op_kitaplar", st.kitaplar); kitaplarGoster();
  });
  $("disaAktar").addEventListener("click", async () => {
    const satir = [["baslik", "yazar", "yayinevi", "baski", "yil", "isbn", "durum", "fiyat", "adet", "satis"].join(";")];
    for (const k of st.kitaplar) satir.push([k.baslik, k.yazar, k.yayinevi, k.baski ?? "", k.yil ?? "", k.isbn, k.durum, k.fiyat ?? "", k.adet ?? 1, k.satis].map((v) => '"' + String(v ?? "").replace(/"/g, '""') + '"').join(";"));
    const csv = satir.join("\n"); const ta = $("aktarim"); ta.hidden = false; ta.value = csv;
    try { if (navigator.share) { await navigator.share({ title: "OkurPazarı kitap listesi", text: csv }); return; } } catch (e) {}
    try { await navigator.clipboard.writeText(csv); $("ozet").textContent = "Liste panoya kopyalandı (Excel'e yapıştır)."; } catch (e) { ta.select(); }
  });

  // ---------- ayarlar ----------
  $("dAd").value = st.dukkan.ad || ""; $("dSehir").value = st.dukkan.sehir || ""; $("dTel").value = st.dukkan.telefon || "";
  $("dKaydet").addEventListener("click", () => { st.dukkan = { ad: $("dAd").value.trim(), sehir: $("dSehir").value.trim(), telefon: $("dTel").value.trim() }; LS.set("op_dukkan", st.dukkan); $("dDurum").textContent = "Kaydedildi."; $("kimlik").textContent = (st.dukkan.ad || "kitapçı") + " · raf tarama"; });
  if (st.dukkan.ad) $("kimlik").textContent = st.dukkan.ad + " · raf tarama";
  $("aiKey").value = st.ai.key || ""; $("aiModel").value = st.ai.model || "gemini-2.5-flash";
  const aiHint = () => { $("aiHint").textContent = st.ai.key ? "Anahtar kayıtlı: Kapak/sırt oku ve fotoğraftan okuma açık." : "Anahtar girilmemiş. Barkod okuma anahtarsız çalışır; kapak ve sırt okuma için bir Gemini API anahtarı gerekir."; };
  aiHint();
  $("aiKaydet").addEventListener("click", () => { st.ai = { key: $("aiKey").value.trim(), model: $("aiModel").value }; LS.set("op_ai", st.ai); $("aiDurum").textContent = "Kaydedildi."; aiHint(); });
  $("aiTest").addEventListener("click", async () => {
    st.ai = { key: $("aiKey").value.trim(), model: $("aiModel").value }; LS.set("op_ai", st.ai); aiHint();
    $("aiDurum").textContent = "Deneniyor…";
    try { const r = await gemini([{ text: 'Yalnızca şu JSON\'u döndür: {"ok":true}' }]); $("aiDurum").textContent = r && r.ok ? "Çalışıyor." : "Cevap geldi ama beklenmedik."; }
    catch (e) { $("aiDurum").textContent = e.code === "anahtar_yok" ? "Anahtar boş." : "Hata: " + (e.message || e.code); }
  });

  kitaplarGoster(); bulunanGoster();
  window.addEventListener("pagehide", kameraKapat);
})();
