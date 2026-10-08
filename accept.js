import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { describeUserAgent } from "./device-name.js?v=1";
import { resolveStartPage } from "./start-page.js?v=5";

const SUPABASE_URL = "https://xdegfnbinprrfoxpcvpf.supabase.co";
const SUPABASE_KEY = "sb_publishable_8k0lb6crF1cjE0aziGtoZA_ojJh4IID";
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Принятие приглашения. Ссылка из письма приводит сюда с token_hash в адресе, но вход
// происходит только по нажатию кнопки: почтовые сканеры, которые сами открывают ссылки,
// приглашение не израсходуют. Запасной путь — почта + 6-значный код из того же письма.

const $ = (sel) => document.querySelector(sel);
const params = new URLSearchParams(window.location.search);
const tokenHash = params.get("token_hash");
const type = params.get("type") || "invite";

// token_hash не должен оставаться в истории браузера и уходить дальше в Referer.
if (tokenHash) history.replaceState(null, "", window.location.pathname);

function message(text, kind) {
  const el = $("#acceptMessage");
  el.textContent = text;
  el.className = "login-message " + kind;
  el.hidden = false;
}

async function done(session) {
  await supabase.rpc("name_my_device", { p_name: describeUserAgent(navigator.userAgent) });
  message("Готово, вы вошли как " + session.user.email + ". Открываю приложение…", "success");
  const start = await resolveStartPage(supabase);
  setTimeout(() => window.location.replace(start), 800);
}

function friendly(error) {
  return /expired|invalid/i.test(error.message)
    ? "Приглашение недействительно или устарело. Попросите администратора отправить его ещё раз."
    : "Не удалось принять приглашение: " + error.message;
}

if (tokenHash && ["invite", "email", "magiclink"].includes(type)) {
  $("#linkBlock").hidden = false;
  $("#acceptBtn").addEventListener("click", async () => {
    const btn = $("#acceptBtn");
    btn.disabled = true;
    btn.textContent = "Вход…";
    const { data, error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type });
    if (error || !data?.session) {
      btn.textContent = "Принять приглашение и войти";
      message(error ? friendly(error) : "Не удалось войти.", "error");
      $("#linkBlock").hidden = true;
      $("#codeBlock").hidden = false;
      return;
    }
    done(data.session);
  });
} else {
  $("#codeBlock").hidden = false;
}

$("#codeBlock").addEventListener("submit", async (e) => {
  e.preventDefault();
  const btn = $("#acceptCodeBtn");
  btn.disabled = true;
  const { data, error } = await supabase.auth.verifyOtp({
    email: $("#acceptEmail").value.trim(),
    token: $("#acceptCode").value.trim(),
    type: "invite",
  });
  btn.disabled = false;
  if (error || !data?.session) {
    message(error ? friendly(error) : "Не удалось войти.", "error");
    return;
  }
  done(data.session);
});
