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
  function fiyatAyarYukle() {
    const v = LS.get("op_fiyat", {}) || {};
    const f = { oto: v.oto !== false, yuvarla: num(v.yuvarla) || 5,
      sifir: Object.assign({ kaynak: "etiket", yon: 0, yuzde: 0 }, v.sifir || {}),
      ikinci: Object.assign({ kaynak: "min", yon: 0, yuzde: 0 }, v.ikinci || (v.kaynak ? { kaynak: v.kaynak, yon: v.yon, yuzde: v.yuzde } : {})),
      carpan: Object.assign({ "Çok iyi": 70, "İyi": 55, "Orta": 40, "Yıpranmış": 25 }, v.carpan || {}) };
    return f;
  }
  const st = {
    stream: null, track: null, torch: false, detector: null, zx: null, loopId: 0, okuyor: false,
    sonGorme: new Map(), bulunan: [], kitaplar: LS.get("op_kitaplar", []), dukkan: LS.get("op_dukkan", {}),
    ai: Object.assign({ key: "", model: "gemini-3.8-flash" }, LS.get("op_ai", {})),
    fiyat: null, // yardımcılar tanımlanınca yüklenir
    sonToplu: null, kunyeHedef: null,
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
  st.fiyat = fiyatAyarYukle();

  // ---------- sekmeler ----------
  const tabs = [...document.querySelectorAll('nav [role="tab"]')];
  function goTab(id) { for (const t of tabs) { const on = t.id === id; t.setAttribute("aria-selected", on); $(t.getAttribute("aria-controls")).hidden = !on; } LS.set("op_tab", id); }
  tabs.forEach((t) => t.addEventListener("click", () => goTab(t.id)));
  goTab("tab-tara"); // her açılış Tara'dan başlar

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
  function yeniKayit(b, kaynak, guven, bilgi) {
    return { id: uid(), baslik: b.baslik || "", yazar: b.yazar || "", yayinevi: b.yayinevi || "", baski: b.baski ?? "", yil: b.yil ?? "", isbn: b.isbn || "", sayfa: b.sayfa || "", kapak: b.kapak || "",
      kaynak, guven: guven ?? 1, bilgi: bilgi == null ? !!b.baslik : !!bilgi, durum: "İyi", fiyat: "", adet: 1 };
  }
  function listedeVar(isbn) { return isbn && (st.bulunan.some((k) => k.isbn === isbn) || st.kitaplar.some((k) => k.isbn === isbn && k.satis !== "satildi")); }
  // BÜYÜK HARF okumalarını normal yazıma çevir (sırtlar çoğu zaman büyük harf): "İKİ KİŞİLİK ALAN" → "İki Kişilik Alan"
  const KUCUK = new Set(["ve", "ile", "da", "de", "ya", "veya", "bir", "için", "mi", "mı", "mu", "mü", "of", "the", "and"]);
  function yaziDuzelt(s) {
    s = String(s ?? "").trim(); if (!s) return s;
    const harf = s.replace(/[^A-Za-zÇĞİÖŞÜçğıöşü]/g, ""); if (harf.length < 3) return s;
    const buyuk = harf.replace(/[^A-ZÇĞİÖŞÜ]/g, "").length; if (buyuk / harf.length < 0.8) return s; // zaten karışık yazım
    const turkce = /[ÇĞİÖŞÜçğıöşü]/.test(s); // Türkçe harf yoksa büyük I yabancı addır: RICHARD → Richard, KIZ → Kiz (nadir, elle düzeltilir)
    return s.split(/\s+/).map((w, i) => {
      const k = w.replace(/İ/g, "i").replace(/I/g, turkce ? "ı" : "i").toLocaleLowerCase("tr-TR");
      if (i > 0 && KUCUK.has(k)) return k;
      if (/^\d+\.?$/.test(k)) return k;
      const ilk = k[0] === "i" ? "İ" : k[0].toLocaleUpperCase("tr-TR");
      return ilk + k.slice(1);
    }).join(" ");
  }

  // ---------- sıralı arka plan işleri (veritabanı + fiyat): aynı anda 12 istek atınca Google sınır koyuyor ----------
  let kuyruk = Promise.resolve();
  const siraya = (fn) => (kuyruk = kuyruk.then(fn, fn).then(() => new Promise((r) => setTimeout(r, 350))));
  function benzerlik(a, b) {
    const ta = new Set(kat(a).split(" ").filter((t) => t.length > 1)), tb = new Set(kat(b).split(" ").filter((t) => t.length > 1));
    if (!ta.size || !tb.size) return 0; let o = 0; for (const t of ta) if (tb.has(t)) o++; return o / (ta.size + tb.size - o);
  }
  // sırt/kapaktan okunan kitabı ad+yazarla veritabanında bul; bulursa yayınevi/yıl/ISBN/kapak doldur
  async function zenginlestir(k) {
    if (!k.baslik || k.bilgi) return;
    const sorgular = ['intitle:"' + k.baslik + '"' + (k.yazar ? ' inauthor:"' + k.yazar + '"' : ""), k.baslik + (k.yazar ? " " + k.yazar : "")];
    const soyad = kat(k.yazar).split(" ").pop() || "";
    for (const q of sorgular) {
      let l = []; try { l = await googleBooks(q); } catch (e) { continue; }
      const aday = l.find((b) => { const s = benzerlik(b.baslik, k.baslik); const ok = s >= 0.6 || kat(b.baslik).startsWith(kat(k.baslik)) || kat(k.baslik).startsWith(kat(b.baslik)); return ok && (!soyad || !b.yazar || kat(b.yazar).includes(soyad)); });
      if (!aday) continue;
      if (aday.isbn && listedeVar(aday.isbn) && !k.isbn) { k.tekrar = true; }
      k.baslik = aday.baslik || k.baslik; k.yazar = aday.yazar || k.yazar; k.yayinevi = k.yayinevi || aday.yayinevi; k.yil = k.yil || aday.yil; k.isbn = k.isbn || aday.isbn; k.kapak = k.kapak || aday.kapak; k.sayfa = k.sayfa || aday.sayfa; k.bilgi = true;
      break;
    }
    bulunanGoster();
  }

  // ---------- fiyat kuralı ----------
  const yuvarla = (p, y) => { y = Math.max(1, num(y) || 1); return Math.max(y, Math.round(p / y) * y); };
  function fiyatHesapla(k) {
    const f = st.fiyat, p = k.piyasa; if (!p || (!p.n && p.etiket == null)) return null;
    const sifir = k.durum === "Yeni", kural = sifir ? f.sifir : f.ikinci;
    let x = p[kural.kaynak]; if (x == null) x = p.etiket ?? p.max ?? p.min; if (x == null) return null; // etiket yoksa en pahalı (etikete en yakın), o da yoksa en ucuz
    x *= 1 + (num(kural.yon) || 0) * Math.abs(num(kural.yuzde) || 0) / 100;
    if (!sifir) x *= (num(f.carpan[k.durum]) ?? 100) / 100;
    return yuvarla(x, f.yuvarla);
  }
  function fiyatUygula(k) { if (!st.fiyat.oto || k.fiyatElle) return; const p = fiyatHesapla(k); if (p != null) { k.fiyat = p; k.fiyatOto = true; } }
  async function piyasaFiyat(k) {
    if (!st.ai.key || !st.fiyat.oto || k.piyasa || st.aramaKapali) return;
    k.piyasa = { n: 0, bekliyor: true }; bulunanGoster();
    try {
      const soru = "Türkiye'de şu kitabın internetteki güncel satış fiyatlarını bul: " + (k.isbn ? "ISBN " + k.isbn + ", " : "") + "\"" + k.baslik + "\"" + (k.yazar ? " — " + k.yazar : "") + (k.yayinevi ? " (" + k.yayinevi + ")" : "") +
        ". Yeni kitap satan mağazalara bak: kitapyurdu, dr, idefix, trendyol, hepsiburada, amazon.com.tr, bkmkitap, kitapsepeti, pandora. Her mağaza için indirimli satış fiyatını (\"fiyat\") ve varsa üstü çizili etiket/liste fiyatını (\"etiket\") TL olarak ver. Sadece bu kitabın (aynı ISBN/aynı baskı) fiyatını al; başka kitabı, e-kitabı, ikinci eli alma. Bulamazsan boş dizi ver. Yalnızca JSON döndür: [{\"site\":\"kitapyurdu\",\"fiyat\":123.5,\"etiket\":180}]";
      const liste = await geminiAra(soru);
      const gecerli = (v) => v != null && v > 5 && v < 20000;
      const f = (Array.isArray(liste) ? liste : []).map((x) => num(x && x.fiyat)).filter(gecerli).sort((a, b) => a - b);
      const et = (Array.isArray(liste) ? liste : []).map((x) => num(x && x.etiket)).filter(gecerli).sort((a, b) => a - b);
      const etiket = et.length ? et[Math.floor(et.length / 2)] : null; // mağazalar aynı etiketi yazar; ortancası sapmayı atar
      if (!f.length && etiket == null) { k.piyasa = { n: 0 }; }
      else k.piyasa = { n: f.length, min: f[0] ?? null, max: f[f.length - 1] ?? null, orta: f.length ? f[Math.floor(f.length / 2)] : null, etiket };
    } catch (e) {
      if (aramaKapali(e)) { k.piyasa = { n: 0, hata: "internet araması bu Google paketinde kapalı" }; st.aramaKapali = true; durum("Fiyat arama için Google hesabında faturalandırma açılması gerekiyor (AI Studio → Set up billing; ayda 5.000 arama bedava). Kapak/sırt okuma bundan etkilenmez.", true); }
      else k.piyasa = { n: 0, hata: (e && (e.message || e.code)) || "hata" };
    }
    fiyatUygula(k); bulunanGoster();
  }

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
    if (b && b.baslik) { const k = st.bulunan[i]; siraya(() => piyasaFiyat(k)); }
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
  async function izinDurumu() {
    try { if (navigator.permissions && navigator.permissions.query) return (await navigator.permissions.query({ name: "camera" })).state; } catch (e) {}
    return "";
  }
  function adresKopyala() {
    const a = location.origin + location.pathname;
    const ok = () => durum("Adres kopyalandı. Tarayıcı uygulamasını aç, adres çubuğuna yapıştır.");
    if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(a).then(ok, () => window.prompt("Adresi kopyala:", a));
    else window.prompt("Adresi kopyala:", a);
  }
  async function kameraHata(e) {
    const ad = (e && e.name) || "", msj = (e && e.message) || "", tb = tarayici();
    let m;
    if (/NotAllowed|PermissionDenied|Security/i.test(ad)) {
      const iz = await izinDurumu();
      if (iz === "prompt") {
        m = "Bu pencere kamera izni soramıyor (" + tb + ", uygulama içi pencere gibi görünüyor). Siteyi telefonun <b>Tarayıcı</b> uygulamasında aç: <b>Adresi kopyala</b> → Tarayıcı'yı aç → adres çubuğuna yapıştır → Kamerayı aç → İzin ver.";
      } else {
        m = "Kamera izni verilmedi (" + tb + (iz ? ", durum: " + iz : "") + "). İzin penceresi çıktıysa <b>İzin ver</b>'e bas. Çıkmadıysa: adres çubuğundaki <b>kilit</b> simgesi → İzinler → Kamera → İzin ver; ya da telefon Ayarlar → Uygulamalar → Tarayıcı → İzinler → Kamera.";
      }
      m += ' <button class="btn" type="button" id="adresKopyala">Adresi kopyala</button>';
    } else if (/NotFound|DevicesNotFound/i.test(ad)) {
      m = "Telefonda kamera bulunamadı ya da tarayıcının kamera izni telefon ayarlarında kapalı (Ayarlar → Uygulamalar → " + tb + " → İzinler → Kamera).";
    } else if (/NotReadable|TrackStart|Abort/i.test(ad)) {
      m = "Kamerayı başka bir uygulama kullanıyor. Kamera/WhatsApp gibi açık uygulamaları kapatıp tekrar dene.";
    } else if (/TypeError/i.test(ad) || !window.isSecureContext) {
      m = "Bu sayfa güvenli (https) açılmamış; kamera çalışmaz. Adresin https:// ile başladığından emin ol.";
    } else {
      m = "Kamera açılamadı (" + tb + ", " + (ad || "hata") + (msj ? ": " + esc(msj) : "") + ").";
    }
    m += " Hemen denemek için <b>🖼 Fotoğraftan oku</b>: telefonun kamerası açılır, barkodu çek, fotoğraftan okunur." + chromeLink();
    $("durum").innerHTML = m; $("durum").classList.add("err");
    const k = $("adresKopyala"); if (k) k.addEventListener("click", adresKopyala);
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
      if (v.readyState >= 2) {
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
    if (typeof oto !== "undefined" && oto.acik) surekliAyarla(false);
    $("cam").hidden = true; $("camKontrol").hidden = true; $("basla").hidden = false;
  }
  $("basla").addEventListener("click", kameraAc);
  $("durdur").addEventListener("click", () => { kameraKapat(); durum("Kamera kapatıldı."); });
  $("fener").addEventListener("click", async () => { if (!st.track) return; st.torch = !st.torch; try { await st.track.applyConstraints({ advanced: [{ torch: st.torch }] }); } catch (e) {} });

  function kareAl(maks) {
    const v = $("video"); const c = document.createElement("canvas");
    const s = Math.min(1, (maks || 1600) / Math.max(v.videoWidth, v.videoHeight));
    c.width = Math.round(v.videoWidth * s); c.height = Math.round(v.videoHeight * s);
    c.getContext("2d").drawImage(v, 0, 0, c.width, c.height);
    return c;
  }
  const kanvasBlob = (c) => new Promise((r) => c.toBlob(r, "image/jpeg", 0.86));
  const blobB64 = (blob) => new Promise((res, rej) => { const fr = new FileReader(); fr.onload = () => res(String(fr.result).split(",")[1]); fr.onerror = rej; fr.readAsDataURL(blob); });

  // ---------- kapak / sırt okuma (Gemini) ----------
  const PROMPT_FOTO = `Bu fotoğrafta kitap(lar) var: raf sırtları, kapaklar veya arka kapak barkodları olabilir. Görünen HER kitap için bir nesne üret, hiçbirini atlama.
Alanlar: "baslik", "yazar", "yayinevi", "baski" (kaçıncı baskı, sayı; görünmüyorsa null), "yil" (sayı; görünmüyorsa null), "isbn" (barkodun yanında yazan 13 ya da 10 haneli numara, boşluksuz; görünmüyorsa null), "kaynak" ("kapak", "sirt" veya "barkod"), "guven" (0-1).
Kurallar: Okuyamadığın alanı null bırak, asla uydurma. Kare kenarında yarım kalmış ya da adı güvenle okunamayan kitabı tamamen atla (bir sonraki karede tam görünecek). Sırtlarda yazar genelde üstte/altta küçük yazar, en altta yayınevi logosu olur. Türkçe karakterleri koru. Sırtta BÜYÜK HARF yazsa bile ad ve yazarı normal yazımla ver ("İki Kişilik Alan", "Antonino Ferro"). Yayınevini logodan/kısaltmadan tanıyorsan tam adını yaz (YKY → Yapı Kredi Yayınları). Kitap olmayan nesneleri atla.
Yalnızca JSON dizi döndür: [{"baslik":"...","yazar":"...","yayinevi":"...","baski":null,"yil":null,"isbn":null,"kaynak":"sirt","guven":0.9}]`;
  // Model sırası: seçili model çalışmazsa (hesaba kapalı / kaldırılmış) sıradaki denenir ve kalıcı seçilir.
  const MODELLER = ["gemini-3.8-flash", "gemini-3.6-flash", "gemini-3.5-flash-lite", "gemini-2.5-flash", "gemini-3-flash-preview"];
  const modelHatasi = (e) => (e.code === "http_404" || e.code === "http_400" || e.code === "http_403") && /no longer available|not found|not supported|does not exist|deprecated|is not available/i.test(e.message || "") && !/grounding|google_search|search/i.test(e.message || "");
  const geciciHata = (e) => e.code === "http_503" || e.code === "http_429" || /high demand|overloaded|try again later|resource.?exhausted|unavailable/i.test(e.message || "");
  async function geminiIstek(body) {
    const key = (st.ai.key || "").trim();
    if (!key) throw { code: "anahtar_yok" };
    const sira = [st.ai.model, ...MODELLER].filter((m, i, a) => m && a.indexOf(m) === i);
    let son = null;
    for (let tur = 0; tur < 2; tur++) {
      let kalici = true; // yalnızca "model kapalı" hatalarından sonra bulunan model kalıcı seçilir; yoğunluk geçicidir
      for (const model of sira) {
        const url = "https://generativelanguage.googleapis.com/v1beta/models/" + encodeURIComponent(model) + ":generateContent?key=" + encodeURIComponent(key);
        let kota = false;
        for (let deneme = 0; deneme < 2; deneme++) { // 429 (dakikalık sınır): aynı modeli 2,5 sn sonra bir kez daha dene; model değiştirmek sınırı daha çok zorlar
          let r;
          try { r = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }); }
          catch (e) { son = { code: "baglanti", message: "İnternet bağlantısı yok ya da kesildi" }; kalici = false; break; }
          if (r.ok) {
            if (kalici && model !== st.ai.model) { st.ai.model = model; LS.set("op_ai", st.ai); const s = $("aiModel"); if (s) s.value = model; }
            const j = await r.json();
            return (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || "").join("");
          }
          let m = ""; try { m = (await r.json()).error?.message || ""; } catch (e) {}
          son = { code: "http_" + r.status, message: m };
          if (r.status === 400 && /thinking/i.test(m) && body.generationConfig && body.generationConfig.thinkingConfig) { delete body.generationConfig.thinkingConfig; st.dusunmeYok = true; deneme--; continue; } // bu model düşünme ayarını kabul etmiyor: ayarsız tekrar
          kota = r.status === 429 && !/limit: 0|grounding|google_search/i.test(m);
          if (kota && deneme === 0) { kalici = false; await new Promise((res) => setTimeout(res, 2500)); continue; }
          break;
        }
        if (son && son.code === "baglanti") continue;
        if (aramaKapali(son)) throw son; // arama kotası/paketi: model değiştirmek işe yaramaz
        if (kota) { son.message = "Dakikalık istek sınırı doldu; birkaç saniye sonra tekrar dene."; throw son; }
        if (modelHatasi(son)) continue;
        if (geciciHata(son)) { kalici = false; continue; }
        throw son;
      }
      if (!son || !(geciciHata(son) || son.code === "baglanti")) break;
      await new Promise((res) => setTimeout(res, 2000)); // yoğunluk: 2 sn sonra bir tur daha
    }
    if (son && geciciHata(son)) son.message = "Google'ın modeli şu an yoğun; birkaç saniye sonra tekrar bas.";
    throw son || { code: "model_yok", message: "Çalışan model bulunamadı" };
  }
  async function gemini(parts) {
    const gc = { temperature: 0.1, responseMimeType: "application/json" }; if (!st.dusunmeYok) gc.thinkingConfig = { thinkingBudget: 0 }; // düşünme adımı kapalı: okuma belirgin hızlanır
    const text = await geminiIstek({ contents: [{ parts }], generationConfig: gc });
    const m = text.match(/[\[{][\s\S]*[\]}]/);
    return JSON.parse(m ? m[0] : text);
  }
  // Google aramalı Gemini: fiyat bulma (araçlı istekte JSON modu kullanılamaz, metinden ayıklanır)
  async function geminiAra(soru) {
    const text = await geminiIstek({ contents: [{ parts: [{ text: soru }] }], tools: [{ google_search: {} }], generationConfig: { temperature: 0 } });
    const m = text.match(/\[[\s\S]*\]/);
    try { return JSON.parse(m ? m[0] : text); } catch (e) { return []; }
  }
  const aramaKapali = (e) => /google_search|grounding|search tool|billing|free tier|not enabled|not supported|limit: 0/i.test((e && e.message) || "");
  // aynı kitap (ad+yazar) zaten listede mi? — sürekli okumada üst üste binen kareler için
  // karşılaştırma için Türkçe harf farklarını eşitle (İ/I/ı → i, ş → s …): okuma hataları ve ASCII veritabanı adları için
  const kat = (s) => norm(String(s ?? "").replace(/İ/g, "i").replace(/I/g, "ı")).replace(/[ıi]/g, "i").replace(/ğ/g, "g").replace(/ü/g, "u").replace(/ş/g, "s").replace(/ö/g, "o").replace(/ç/g, "c");
  const sonSayi = (s) => { const m = s.match(/(\d+)\s*$/); return m ? m[1] : ""; };
  function benzerVar(baslik, yazar) {
    const b = kat(baslik); if (b.length < 3) return false;
    const y = kat(yazar).split(" ").pop() || "";
    const tok = (s) => new Set(kat(s).split(" ").filter((t) => t.length > 2));
    const tb = tok(baslik), bn = sonSayi(b);
    const esit = (k) => {
      const kb = kat(k.baslik); if (!kb) return false;
      if (kb === b) return true;
      const kn = sonSayi(kb); if (bn && kn && bn !== kn) return false; // "İnce Memed 1" ≠ "İnce Memed 2"
      const yazarUyar = !y || !k.yazar || kat(k.yazar).includes(y);
      if ((kb.startsWith(b) || b.startsWith(kb)) && Math.min(kb.length, b.length) >= 8) return yazarUyar;
      const kt = tok(k.baslik); let ortak = 0; for (const t of tb) if (kt.has(t)) ortak++;
      const j = ortak / (tb.size + kt.size - ortak || 1);
      return j >= 0.7 && yazarUyar;
    };
    return st.bulunan.some(esit) || st.kitaplar.some((k) => k.satis !== "satildi" && esit(k));
  }
  async function gorselOku(blob, sessiz) {
    st.okuyor = (st.okuyor || 0) + 1;
    try {
      if (!sessiz) durum("Görüntü okunuyor…"); toast("Okunuyor…");
      const b64 = await blobB64(blob);
      let liste = await gemini([{ text: PROMPT_FOTO }, { inline_data: { mime_type: "image/jpeg", data: b64 } }]);
      if (!Array.isArray(liste)) liste = liste && Array.isArray(liste.kitaplar) ? liste.kitaplar : [];
      liste = liste.filter((k) => k && (k.baslik || k.isbn));
      if (!liste.length) { if (!sessiz) durum("Bu karede kitap okunamadı. Daha yakından ve düz tut.", true); toast(sessiz ? "Bu karede kitap yok; kaydırmaya devam" : "Kitap bulunamadı"); return 0; }
      let n = 0, ayni = 0;
      for (const k of liste) {
        const isbn = isbnDuzelt(k.isbn || "");
        if (isbn && listedeVar(isbn)) { ayni++; continue; }
        if (!isbn && benzerVar(k.baslik || "", k.yazar || "")) { ayni++; continue; }
        const kayit = yeniKayit({ baslik: yaziDuzelt(k.baslik || ""), yazar: yaziDuzelt(k.yazar || ""), yayinevi: yaziDuzelt(k.yayinevi || ""), baski: k.baski ?? "", yil: k.yil ?? "", isbn }, k.kaynak || "kapak", num(k.guven) ?? 0.6, false);
        st.bulunan.unshift(kayit); n++;
        // veritabanı ve fiyat: sırayla, arka planda (liste hemen görünür, alanlar bulundukça dolar)
        siraya(async () => {
          if (!st.bulunan.includes(kayit)) return;
          if (isbn) { const b = await isbnBilgi(isbn); if (b && b.baslik) Object.assign(kayit, { baslik: b.baslik, yazar: b.yazar || kayit.yazar, yayinevi: b.yayinevi || kayit.yayinevi, yil: b.yil || kayit.yil, kapak: b.kapak, sayfa: b.sayfa || kayit.sayfa, bilgi: true }); bulunanGoster(); }
          else await zenginlestir(kayit);
          if (kayit.baslik) await piyasaFiyat(kayit);
        });
      }
      bulunanGoster(); if (n) { flash(); bip(); }
      st.otoSayac = (st.otoSayac || 0) + n;
      if (sessiz) toast((n ? "+" + n + " kitap · " : "Bu karedekiler zaten listede · ") + (typeof sayacMetni === "function" ? sayacMetni() : st.otoSayac + " kitap"));
      else { durum(n + " kitap okundu" + (ayni ? ", " + ayni + " tanesi zaten listedeydi" : "") + ". Kontrol et, fiyatı denetle, kaydet."); toast(n + " kitap eklendi"); }
      return n;
    } catch (e) {
      const k = e && e.code;
      if (k === "anahtar_yok") { durum("Kapak/sırt okuma için Ayarlar'dan Gemini anahtarı gir. Barkod okuma anahtarsız çalışır.", true); toast("Anahtar yok: Ayarlar"); surekliAyarla(false); }
      else if (k === "http_429") durum("Ücretsiz kota doldu; birkaç dakika sonra tekrar dene.", true);
      else if (k === "http_400" || k === "http_403") durum("Anahtar geçersiz ya da yetkisiz: " + (e.message || ""), true);
      else durum("Okuma başarısız: " + (e.message || k || "bağlantı"), true);
      toast(sessiz ? "Okunamadı; birkaç saniye sonra yine denenecek" : "Okunamadı; tekrar dene");
      return -1;
    } finally { st.okuyor = Math.max(0, (st.okuyor || 1) - 1); }
  }
  $("kapakOku").addEventListener("click", async () => { if (!st.stream) return; const c = kareAl(); flash(); await gorselOku(await kanvasBlob(c)); });

  // ---------- sürekli okuma: telefon sabitlenince ve yeni raf parçası görünce kare kendiliğinden gönderilir ----------
  const oto = { acik: false, dongu: 0, sonOrnek: null, sonGonder: null, sabit: 0, sonZaman: 0 };
  function ornekAl() {
    const v = $("video"); const c = ornekAl.c || (ornekAl.c = document.createElement("canvas")); c.width = 32; c.height = 24;
    const x = c.getContext("2d", { willReadFrequently: true }); x.drawImage(v, 0, 0, 32, 24);
    const d = x.getImageData(0, 0, 32, 24).data; const g = new Uint8Array(768);
    for (let i = 0; i < 768; i++) g[i] = (d[i * 4] * 3 + d[i * 4 + 1] * 6 + d[i * 4 + 2]) / 10;
    return g;
  }
  function fark(a, b) { if (!a || !b) return 255; let s = 0; for (let i = 0; i < a.length; i++) s += Math.abs(a[i] - b[i]); return s / a.length; }
  function surekliAyarla(ac) {
    oto.acik = !!ac; const b = $("surekli"); b.textContent = oto.acik ? "🎥 Sürekli oku: AÇIK" : "🎥 Sürekli oku: KAPALI"; b.classList.toggle("primary", !oto.acik); b.classList.toggle("danger", oto.acik);
    if (oto.acik) { oto.sonGonder = null; oto.sabit = 0; oto.sonZaman = 0; st.otoSayac = 0; toast("Kamerayı rafta yavaşça kaydır, kısa dur…"); durum("Sürekli okuma açık: her yeni raf parçası kendiliğinden okunur."); surekliDongu(); }
    else { oto.dongu++; if (st.stream) toast("Sürekli okuma kapalı"); }
  }
  async function surekliDongu() {
    const my = ++oto.dongu; const v = $("video");
    while (oto.acik && oto.dongu === my && st.stream) {
      await new Promise((r) => setTimeout(r, 120));
      if (v.readyState < 2 || document.hidden) continue;
      let g; try { g = ornekAl(); } catch (e) { continue; }
      const hareket = fark(g, oto.sonOrnek); oto.sonOrnek = g;
      oto.sabit = hareket < 8 ? oto.sabit + 1 : 0;
      const yeni = fark(g, oto.sonGonder), gecen = Date.now() - oto.sonZaman;
      // çekim okumayı beklemez: telefon ~¼ sn sabitlenip yeni bir raf parçası görünce kare sıraya alınır, sen ilerlersin
      if (oto.sabit >= 2 && yeni > 10 && gecen > 1000 && kareKuyruk.length < 40) {
        oto.sonGonder = g; oto.sonZaman = Date.now();
        kareSirayaAl();
      } else if (oto.sabit === 2 && yeni <= 10) toast("Bu kısım alındı; rafta ilerle · " + sayacMetni());
    }
  }
  // ---- kare kuyruğu: çekilen kareler arka planda ikişer ikişer okunur; kamera kapansa da sürer ----
  const kareKuyruk = []; let kareIsleyen = 0; const ESZAMANLI = 2;
  const sayacMetni = () => { const b = kareKuyruk.length + kareIsleyen; return (b ? "sırada " + b + " kare · " : "") + (st.otoSayac || 0) + " kitap"; };
  function klik() {
    try { const ac = bip.ac || (bip.ac = new (window.AudioContext || window.webkitAudioContext)()); const o = ac.createOscillator(), g = ac.createGain(); o.frequency.value = 520; g.gain.value = 0.05; o.connect(g); g.connect(ac.destination); o.start(); o.stop(ac.currentTime + 0.04); } catch (e) {}
  }
  function kareSirayaAl() {
    let c; try { c = kareAl(1280); } catch (e) { return; }
    flash(); klik();
    kanvasBlob(c).then((b) => { kareKuyruk.push(b); toast("Kare alındı · " + sayacMetni()); kareIsle(); });
  }
  function kareIsle() {
    while (kareIsleyen < ESZAMANLI && kareKuyruk.length) {
      const b = kareKuyruk.shift(); kareIsleyen++;
      gorselOku(b, true).catch(() => -1).then((n) => {
        kareIsleyen--;
        if (n < 0) { b.deneme = (b.deneme || 0) + 1; if (b.deneme <= 3) { kareKuyruk.unshift(b); setTimeout(kareIsle, 3000); return; } } // geçici hata: kareyi atma, 3 sn sonra yeniden dene (en çok 3 kez)
        if (!kareKuyruk.length && !kareIsleyen) { toast("Hepsi okundu · " + (st.otoSayac || 0) + " kitap"); if (!st.stream) durum("Arka plandaki kareler okundu: " + (st.otoSayac || 0) + " kitap. Kontrol et, kaydet."); }
        else kareIsle();
      });
    }
  }
  $("surekli").addEventListener("click", () => { if (!st.stream) return; if (!st.ai.key) { durum("Sürekli okuma için Ayarlar'dan Gemini anahtarı gir.", true); return; } surekliAyarla(!oto.acik); });

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
          <div class="row" style="margin-top:4px"><span class="chip">${esc(k.kaynak)}</span><span class="chip ${g}">${k.bekliyor ? "bilgi aranıyor" : k.bilgi ? "veritabanından" : "okuma %" + Math.round((k.guven || 0) * 100)}</span>${k.tekrar ? '<span class="chip warn">zaten listede olabilir</span>' : ""}</div></div>
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
          <label class="field">Fiyat (₺)<input data-k="fiyat" inputmode="decimal" value="${esc(k.fiyat)}" placeholder="${st.fiyat.oto ? "bulunuyor…" : "yaz"}"></label>
          <label class="field">Adet<input data-k="adet" inputmode="numeric" value="${esc(k.adet)}"></label>
        </div>
        <div class="row"><span class="hint grow">${piyasaMetni(k)}</span><button class="btn" type="button" data-fiyat="${i}">₺ Fiyat bul</button><button class="btn" type="button" data-kunye="${i}">📄 Künye çek</button></div></div>`;
    }).join("");
  }
  function piyasaMetni(k) {
    const p = k.piyasa;
    if (!p) return st.ai.key ? "" : "Otomatik fiyat için Ayarlar'dan Gemini anahtarı gir.";
    if (p.bekliyor) return "İnternet fiyatları aranıyor…";
    if (p.hata) return "Fiyat aranamadı: " + esc(p.hata);
    if (!p.n && p.etiket == null) return "İnternette satış fiyatı bulunamadı; fiyatı elle yaz.";
    return (p.etiket != null ? "Etiket " + tl(p.etiket) + " · " : "") + (p.n ? "internet " + tl(p.min) + (p.n > 1 ? " – " + tl(p.max) : "") + " (" + p.n + " mağaza)" : "") + (k.fiyatOto ? " · kurala göre " + tl(num(k.fiyat)) : k.fiyatElle ? " · elle girildi" : "");
  }
  $("bulunan").addEventListener("input", (e) => {
    const card = e.target.closest("[data-i]"); const k = e.target.dataset.k; if (!card || !k) return; const it = st.bulunan[+card.dataset.i]; if (!it) return;
    it[k] = e.target.value;
    if (k === "fiyat") { it.fiyatElle = true; it.fiyatOto = false; }
  });
  $("bulunan").addEventListener("change", (e) => {
    const card = e.target.closest("[data-i]"); if (!card || e.target.dataset.k !== "durum") return; const it = st.bulunan[+card.dataset.i]; if (!it) return;
    it.durum = e.target.value; if (it.fiyatOto || num(it.fiyat) == null) { it.fiyatElle = false; fiyatUygula(it); bulunanGoster(); }
  });
  $("bulunan").addEventListener("click", (e) => {
    const b = e.target.closest("[data-sil]"); if (b) { st.bulunan.splice(+b.dataset.sil, 1); bulunanGoster(); return; }
    const f = e.target.closest("[data-fiyat]"); if (f) { const it = st.bulunan[+f.dataset.fiyat]; if (!it) return; if (!st.ai.key) { durum("Fiyat bulma için Ayarlar'dan Gemini anahtarı gir.", true); return; } it.piyasa = null; it.fiyatElle = false; st.aramaKapali = false; st.fiyat.oto ? piyasaFiyat(it) : durum("Ayarlar'da otomatik fiyat kapalı.", true); return; }
    const ky = e.target.closest("[data-kunye]"); if (ky) { const it = st.bulunan[+ky.dataset.kunye]; if (!it) return; if (!st.ai.key) { durum("Künye okuma için Ayarlar'dan Gemini anahtarı gir.", true); return; } st.kunyeHedef = it.id; $("kunyeDosya").click(); }
  });
  $("kunyeDosya").addEventListener("change", async (e) => {
    const f = e.target.files && e.target.files[0]; e.target.value = ""; const it = st.bulunan.find((x) => x.id === st.kunyeHedef); if (!f || !it) return;
    durum("Künye okunuyor…");
    try {
      const bmp = await createImageBitmap(f, { imageOrientation: "from-image" }); const c = document.createElement("canvas"); const s = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
      c.width = Math.round(bmp.width * s); c.height = Math.round(bmp.height * s); c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
      const r = await gemini([{ text: "Bu fotoğraf bir kitabın künye (copyright/baskı bilgisi) sayfası. Şunları oku: \"baski\" (kaçıncı baskı, sayı; 'Birinci basım', '3. baskı' gibi), \"yil\" (bu baskının yılı, sayı), \"yayinevi\", \"isbn\" (boşluksuz). Okuyamadığını null bırak, uydurma. Yalnızca JSON nesne döndür: {\"baski\":3,\"yil\":2021,\"yayinevi\":\"...\",\"isbn\":\"...\"}" }, { inline_data: { mime_type: "image/jpeg", data: await blobB64(await kanvasBlob(c)) } }]);
      const o = Array.isArray(r) ? r[0] || {} : r || {};
      if (num(o.baski) != null) it.baski = num(o.baski); if (num(o.yil) != null) it.yil = num(o.yil); if (o.yayinevi && !it.yayinevi) it.yayinevi = o.yayinevi; if (!it.isbn && isbnDuzelt(o.isbn || "")) it.isbn = isbnDuzelt(o.isbn);
      bulunanGoster(); durum(num(o.baski) != null ? o.baski + ". baskı okundu." : "Künyede baskı sayısı okunamadı; elle yaz.");
    } catch (err) { durum("Künye okunamadı: " + ((err && (err.message || err.code)) || "hata"), true); }
  });
  $("temizle").addEventListener("click", () => { st.bulunan = []; bulunanGoster(); durum("Liste boşaltıldı."); });
  $("kaydet").addEventListener("click", () => {
    if (!st.bulunan.length) return;
    const eksik = st.bulunan.findIndex((k) => !String(k.baslik).trim());
    if (eksik >= 0) { durum("Kayıt " + (eksik + 1) + ": kitap adı boş; yaz ya da Çıkar.", true); return; }
    const simdi = new Date().toISOString(); let fiyatsiz = 0;
    for (const k of st.bulunan) { if (num(k.fiyat) == null) fiyatsiz++; st.kitaplar.unshift({ ...k, baslik: String(k.baslik).trim(), fiyat: num(k.fiyat), adet: Math.max(1, Math.round(num(k.adet) ?? 1)), baski: num(k.baski), yil: num(k.yil), satis: "satista", eklenme: simdi, bekliyor: undefined }); }
    LS.set("op_kitaplar", st.kitaplar);
    const n = st.bulunan.length; st.bulunan = []; bulunanGoster(); kitaplarGoster();
    durum(n + " kitap kaydedildi (Kitaplarım)." + (fiyatsiz ? " " + fiyatsiz + " tanesinin fiyatı yok; Kitaplarım'dan gir, fiyatsız kitap vitrine çıkmaz." : ""));
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
          <div class="row" style="margin-top:4px">${k.satis === "satildi" ? '<span class="chip warn">satıldı</span>' : (num(k.fiyat) == null ? '<span class="chip bad">fiyat yok</span>' : '<span class="chip ok">satışta</span>')}<span class="chip">${esc(k.durum)}</span></div></div>
        <div style="text-align:right"><div class="price">${tl(num(k.fiyat))}</div><div class="meta">${esc(k.adet || 1)} adet</div></div></div>
      <div class="fields">
        <label class="field">Fiyat (₺)<input data-k="fiyat" inputmode="decimal" value="${esc(k.fiyat ?? "")}" placeholder="yaz"></label>
        <label class="field">Durum<select data-k="durum">${DURUMLAR.map((d) => `<option${d === k.durum ? " selected" : ""}>${d}</option>`).join("")}</select></label>
        <label class="field">Adet<input data-k="adet" inputmode="numeric" value="${esc(k.adet ?? 1)}"></label>
      </div>
      <div class="row">${k.satis === "satildi" ? '<button class="btn" data-act="geri">Tekrar satışa koy</button>' : '<button class="btn" data-act="satildi">Satıldı</button>'}<button class="btn danger" data-act="sil">Sil</button></div></div>`).join("");
  }
  $("ara").addEventListener("input", kitaplarGoster);
  $("liste").addEventListener("change", (e) => {
    const f = e.target.dataset.k; const card = e.target.closest("[data-id]"); if (!f || !card) return;
    const k = st.kitaplar.find((x) => x.id === card.dataset.id); if (!k) return;
    if (f === "fiyat") k.fiyat = num(e.target.value); else if (f === "adet") k.adet = Math.max(1, Math.round(num(e.target.value) ?? 1)); else k[f] = e.target.value;
    LS.set("op_kitaplar", st.kitaplar); kitaplarGoster();
  });
  $("liste").addEventListener("click", (e) => {
    const b = e.target.closest("[data-act]"); if (!b) return; const id = b.closest("[data-id]").dataset.id; const k = st.kitaplar.find((x) => x.id === id); if (!k) return;
    if (b.dataset.act === "satildi") k.satis = "satildi";
    if (b.dataset.act === "geri") k.satis = "satista";
    if (b.dataset.act === "sil") { if (b.dataset.onay !== "1") { b.dataset.onay = "1"; b.textContent = "Emin misin? Sil"; return; } st.kitaplar = st.kitaplar.filter((x) => x.id !== id); }
    LS.set("op_kitaplar", st.kitaplar); kitaplarGoster();
  });
  // toplu fiyat (zam / indirim), geri alınabilir
  $("tUygula").addEventListener("click", () => {
    const y = Math.abs(num($("tYuzde").value) || 0); if (!y) { $("tDurum").textContent = "Yüzde yaz (örn. 10)."; return; }
    const yon = num($("tYon").value) || 1, q = norm($("ara").value);
    const hedef = st.kitaplar.filter((k) => num(k.fiyat) != null && (!q || norm(k.baslik + " " + k.yazar + " " + k.isbn).includes(q)));
    if (!hedef.length) { $("tDurum").textContent = "Fiyatı olan kitap yok."; return; }
    st.sonToplu = hedef.map((k) => [k.id, k.fiyat]);
    for (const k of hedef) k.fiyat = yuvarla(num(k.fiyat) * (1 + yon * y / 100), st.fiyat.yuvarla);
    LS.set("op_kitaplar", st.kitaplar); kitaplarGoster();
    $("tDurum").textContent = hedef.length + " kitabın fiyatı %" + y + (yon > 0 ? " yükseltildi." : " düşürüldü.") + " Yanlışsa Geri al."; $("tGeriAl").hidden = false;
  });
  $("tGeriAl").addEventListener("click", () => {
    if (!st.sonToplu) return;
    for (const [id, f] of st.sonToplu) { const k = st.kitaplar.find((x) => x.id === id); if (k) k.fiyat = f; }
    st.sonToplu = null; LS.set("op_kitaplar", st.kitaplar); kitaplarGoster(); $("tGeriAl").hidden = true; $("tDurum").textContent = "Fiyatlar geri alındı.";
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
  $("aiKey").value = st.ai.key || ""; $("aiModel").value = MODELLER.includes(st.ai.model) ? st.ai.model : "gemini-3.8-flash";
  const aiHint = () => { $("aiHint").textContent = st.ai.key ? "Anahtar kayıtlı: Kapak/sırt oku ve fotoğraftan okuma açık." : "Anahtar girilmemiş. Barkod okuma anahtarsız çalışır; kapak ve sırt okuma için bir Gemini API anahtarı gerekir."; };
  aiHint();
  $("aiKaydet").addEventListener("click", () => { st.ai = { key: $("aiKey").value.trim(), model: $("aiModel").value }; st.aramaKapali = false; LS.set("op_ai", st.ai); $("aiDurum").textContent = "Kaydedildi."; aiHint(); });
  $("aiTest").addEventListener("click", async () => {
    st.ai = { key: $("aiKey").value.trim(), model: $("aiModel").value }; LS.set("op_ai", st.ai); aiHint();
    $("aiDurum").textContent = "Deneniyor…";
    let okuma;
    try { const r = await gemini([{ text: 'Yalnızca şu JSON\'u döndür: {"ok":true}' }]); okuma = r && r.ok ? "Okuma çalışıyor (" + st.ai.model + ")." : "Cevap geldi ama beklenmedik."; }
    catch (e) { $("aiDurum").textContent = e.code === "anahtar_yok" ? "Anahtar boş." : "Hata: " + (e.message || e.code); return; }
    $("aiDurum").textContent = okuma + " Fiyat arama deneniyor…";
    try { await geminiAra("Yalnızca şu JSON'u döndür: [{\"site\":\"deneme\",\"fiyat\":1}]"); st.aramaKapali = false; $("aiDurum").textContent = okuma + " Fiyat arama çalışıyor."; }
    catch (e) { st.aramaKapali = aramaKapali(e); $("aiDurum").textContent = okuma + (st.aramaKapali ? " Fiyat arama bu Google paketinde kapalı: AI Studio'da 'Set up billing' açılınca çalışır (ayda 5.000 arama bedava)." : " Fiyat arama hatası: " + (e.message || e.code)); }
  });

  // fiyat kuralı
  const CARPAN_ID = { "Çok iyi": "fc_Cokiyi", "İyi": "fc_Iyi", "Orta": "fc_Orta", "Yıpranmış": "fc_Yipranmis" };
  const IKINCI = DURUMLAR.filter((d) => d !== "Yeni");
  function fiyatFormuYukle() {
    const f = st.fiyat; $("fOto").value = f.oto ? "1" : "0"; $("fYuvarla").value = String(f.yuvarla);
    $("fsKaynak").value = f.sifir.kaynak; $("fsYon").value = String(f.sifir.yon); $("fsYuzde").value = f.sifir.yuzde;
    $("fKaynak").value = f.ikinci.kaynak; $("fYon").value = String(f.ikinci.yon); $("fYuzde").value = f.ikinci.yuzde;
    for (const d of IKINCI) $(CARPAN_ID[d]).value = f.carpan[d] ?? 100;
  }
  fiyatFormuYukle();
  $("fKaydet").addEventListener("click", () => {
    const carpan = {}; for (const d of IKINCI) carpan[d] = Math.min(300, Math.max(1, num($(CARPAN_ID[d]).value) ?? 100));
    st.fiyat = { oto: $("fOto").value === "1", yuvarla: num($("fYuvarla").value) || 5,
      sifir: { kaynak: $("fsKaynak").value, yon: num($("fsYon").value) || 0, yuzde: Math.abs(num($("fsYuzde").value) || 0) },
      ikinci: { kaynak: $("fKaynak").value, yon: num($("fYon").value) || 0, yuzde: Math.abs(num($("fYuzde").value) || 0) }, carpan };
    LS.set("op_fiyat", st.fiyat); fiyatFormuYukle();
    for (const k of st.bulunan) if (!k.fiyatElle) fiyatUygula(k);
    bulunanGoster(); $("fDurum").textContent = "Kaydedildi.";
  });

  kitaplarGoster(); bulunanGoster();
  window.addEventListener("pagehide", kameraKapat);
})();
