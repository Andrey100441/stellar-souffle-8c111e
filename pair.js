import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { describeUserAgent } from "./device-name.js?v=1";
import { resolveStartPage } from "./start-page.js?v=5";

const SUPABASE_URL = "https://xdegfnbinprrfoxpcvpf.supabase.co";
const SUPABASE_KEY = "sb_publishable_8k0lb6crF1cjE0aziGtoZA_ojJh4IID";
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Новое устройство: вводит код (или открывает ссылку из QR, код приходит в #c=…), называет себя
// и ждёт, пока на уже вошедшем устройстве нажмут «Подключить». Всё решает Edge Function
// device-pair; здесь только одноразовый секрет этого подключения (в памяти страницы).

const $ = (sel) => document.querySelector(sel);
let pollTimer = null;
let tickTimer = null;

function message(text, kind) {
  const el = $("#pairMessage");
  el.textContent = text;
  el.className = "login-message " + kind;
  el.hidden = !text;
}

const formatCode = (v) => {
  const s = v.toUpperCase().replace(/[^A-Z0-9]/g, "").slice(0, 8);
  return s.length > 4 ? s.slice(0, 4) + "-" + s.slice(4) : s;
};

async function call(body) {
  const { data, error } = await supabase.functions.invoke("device-pair", { body });
  if (error) {
    let msg = error.message;
    try {
      const j = await error.context.json();
      if (j?.error) msg = j.error;
    } catch (_) {}
    throw new Error(msg);
  }
  return data;
}

function stopWaiting() {
  clearInterval(pollTimer);
  clearInterval(tickTimer);
  $("#waitBlock").hidden = true;
  $("#claimForm").hidden = false;
  $("#claimBtn").disabled = false;
}

function startWaiting(claim, name) {
  $("#claimForm").hidden = true;
  $("#waitBlock").hidden = false;
  $("#waitName").textContent = "«" + name + "»";
  // Подтвердить можно в течение ~2 минут после ввода кода (столько ждёт и база).
  const deadline = Date.now() + 2 * 60 * 1000;
  const tick = () => {
    const s = Math.max(0, Math.round((deadline - Date.now()) / 1000));
    $("#waitLeft").textContent = Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  };
  tick();
  tickTimer = setInterval(tick, 1000);

  let busy = false;
  pollTimer = setInterval(async () => {
    if (busy) return;
    busy = true;
    try {
      const r = await call({ action: "poll", id: claim.id, secret: claim.secret });
      if (r.status === "approved" && r.token_hash) {
        clearInterval(pollTimer);
        clearInterval(tickTimer);
        const { error } = await supabase.auth.verifyOtp({ token_hash: r.token_hash, type: "magiclink" });
        if (error) throw error;
        await supabase.rpc("name_my_device", { p_name: name });
        message("Устройство подключено. Открываю приложение…", "success");
        // Новое устройство открывает стартовую страницу пользователя, а не случайную.
        const start = await resolveStartPage(supabase);
        setTimeout(() => window.location.replace(start), 600);
        return;
      }
      if (r.status === "rejected") {
        stopWaiting();
        message("Подключение отклонено на другом устройстве.", "error");
      } else if (r.status !== "waiting") {
        stopWaiting();
        message("Код истёк или уже использован. Создайте новый код на другом устройстве.", "error");
      }
    } catch (e) {
      stopWaiting();
      message(e.message, "error");
    } finally {
      busy = false;
    }
  }, 2000);
}

async function init() {
  const { data } = await supabase.auth.getSession();
  if (data?.session) {
    message("Это устройство уже подключено (" + data.session.user.email + ").", "success");
    $("#claimForm").hidden = true;
    $(".pair-foot").innerHTML = '<a href="index.html">Открыть приложение</a>';
    return;
  }

  $("#pairName").value = describeUserAgent(navigator.userAgent);
  // Код из QR-ссылки приходит во фрагменте (#c=…): фрагмент не уходит на сервер и в журналы.
  const fromQr = new URLSearchParams(window.location.hash.replace(/^#/, "")).get("c");
  if (fromQr) {
    $("#pairCode").value = formatCode(fromQr);
    history.replaceState(null, "", window.location.pathname);
  }
  $("#pairCode").addEventListener("input", (e) => (e.target.value = formatCode(e.target.value)));

  $("#claimForm").addEventListener("submit", async (e) => {
    e.preventDefault();
    message("");
    const name = $("#pairName").value.trim() || describeUserAgent(navigator.userAgent);
    $("#claimBtn").disabled = true;
    try {
      const claim = await call({ action: "claim", code: $("#pairCode").value, device_name: name });
      startWaiting(claim, name);
    } catch (err) {
      $("#claimBtn").disabled = false;
      message(err.message, "error");
    }
  });

  $("#waitCancel").addEventListener("click", () => {
    stopWaiting();
    message("Отменено. Можно ввести новый код.", "error");
  });
}

init();
