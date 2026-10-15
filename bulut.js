/* OkurPazarı — bulut bağlantısı (Supabase). Kitapçı uygulaması ve vitrin ortak kullanır.
   Buradaki anahtar "publishable" (herkese açık) anahtardır; veri güvenliği satır bazlı kurallarla (RLS) sağlanır. */
window.OP = (() => {
  const CFG = { url: "https://azwapauyzxmymcfbdwgf.supabase.co", key: "sb_publishable_Xi7b62Z3UmLrI_3uk08H5g_n-rEAvF2" };
  let sb = null;
  try { if (window.supabase && window.supabase.createClient) sb = window.supabase.createClient(CFG.url, CFG.key, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: false } }); } catch (e) { sb = null; }
  const DURUMLAR = ["Yeni", "Çok iyi", "İyi", "Orta", "Yıpranmış"];
  const tl = (v) => (v == null || v === "" ? "—" : new Intl.NumberFormat("tr-TR", { style: "currency", currency: "TRY", maximumFractionDigits: 2 }).format(Number(v)));
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  // hata metnini Türkçeleştir
  function hataMetni(e) {
    const m = (e && (e.message || e.error_description || e.msg)) || String(e || "");
    if (/Invalid login credentials/i.test(m)) return "E-posta ya da şifre yanlış.";
    if (/User already registered|already been registered/i.test(m)) return "Bu e-posta zaten kayıtlı; giriş yap.";
    if (/Password should be at least/i.test(m)) return "Şifre en az 6 karakter olmalı.";
    if (/Unable to validate email|invalid format/i.test(m)) return "E-posta adresi geçersiz.";
    if (/Email not confirmed/i.test(m)) return "E-posta doğrulanmamış (yönetici doğrulamayı kapatmalı).";
    if (/rate limit|too many/i.test(m)) return "Çok sık deneme; bir dakika bekle.";
    if (/Failed to fetch|NetworkError|network/i.test(m)) return "İnternet bağlantısı yok.";
    return m;
  }
  async function oturum() { if (!sb) return null; try { const { data } = await sb.auth.getSession(); return data.session || null; } catch (e) { return null; } }
  async function profil() {
    const s = await oturum(); if (!s) return null;
    const { data, error } = await sb.from("profiller").select("*").eq("id", s.user.id).maybeSingle();
    if (error) return { id: s.user.id, email: s.user.email, hata: hataMetni(error) };
    return Object.assign({ id: s.user.id, email: s.user.email }, data || {});
  }
  async function platformAyar() {
    if (!sb) return null;
    const { data } = await sb.from("platform_ayar").select("*").eq("id", 1).maybeSingle();
    return data || null;
  }
  return { sb, CFG, DURUMLAR, tl, esc, hataMetni, oturum, profil, platformAyar };
})();
