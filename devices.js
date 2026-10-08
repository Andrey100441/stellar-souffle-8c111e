import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import qrcode from "https://esm.sh/qrcode-generator@1.4.4";
import { setupAuth } from "./auth.js?v=36";
import { describeUserAgent } from "./device-name.js?v=1";

const SUPABASE_URL = "https://xdegfnbinprrfoxpcvpf.supabase.co";
const SUPABASE_KEY = "sb_publishable_8k0lb6crF1cjE0aziGtoZA_ojJh4IID";
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// «Мои устройства»: подключение нового устройства по QR-коду / коду и список входов с отключением.
// Код создаёт и проверяет база (public.device_pair_*); здесь — показ, ожидание и подтверждение.

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmt = (t) => (t ? new Date(t).toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" }) : "—");

let dashboardStarted = false;
let pairing = null; // { id, expires_at }
let pollTimer = null;
let tickTimer = null;

function showError(msg) {
  const el = $("#errorBanner");
  el.textContent = msg;
  el.hidden = !msg;
}
function message(text, kind) {
  const el = $("#pairMessage");
  el.textContent = text;
  el.className = "login-message " + kind;
  el.hidden = !text;
}

async function loadDevices() {
  const { data, error } = await supabase.rpc("my_devices");
  if (error) {
    showError("Ошибка загрузки устройств: " + error.message);
    return;
  }
  $("#devicesBody").innerHTML = data
    .map(
      (d) => `
    <tr data-id="${esc(d.session_id)}">
      <td>${esc(d.name || describeUserAgent(d.user_agent))}${d.is_current ? ' <span class="muted">(это устройство)</span>' : ""}</td>
      <td class="muted" title="${esc(d.user_agent)}">${esc(describeUserAgent(d.user_agent))}${d.ip ? " · " + esc(d.ip) : ""}</td>
      <td>${fmt(d.created_at)}</td>
      <td>${fmt(d.last_active)}</td>
      <td class="row-actions">${d.is_current ? "" : '<button type="button" class="btn-secondary btn-small" data-act="revoke">Отключить</button>'}</td>
    </tr>`
    )
    .join("");
}

function stopPairing() {
  clearInterval(pollTimer);
  clearInterval(tickTimer);
  pairing = null;
  $("#pairBox").hidden = true;
  $("#confirmBox").hidden = true;
  $("#pairStart").disabled = false;
}

async function startPairing() {
  showError("");
  message("");
  $("#pairStart").disabled = true;
  const { data, error } = await supabase.rpc("device_pair_start");
  if (error) {
    $("#pairStart").disabled = false;
    message(error.message, "error");
    return;
  }
  pairing = { id: data.id, expires_at: data.expires_at };
  const pretty = data.code.slice(0, 4) + "-" + data.code.slice(4);
  // Код во фрагменте (#c=…): не попадает в журналы сервера и в Referer.
  const url = new URL("pair.html", window.location.href).href.split("#")[0] + "#c=" + data.code;
  const qr = qrcode(0, "M");
  qr.addData(url);
  qr.make();
  $("#pairQr").innerHTML = qr.createSvgTag({ cellSize: 5, margin: 2, scalable: true });
  $("#pairCodeShow").textContent = pretty;
  $("#pairUrl").textContent = new URL("pair.html", window.location.href).href;
  $("#pairBox").hidden = false;

  const tick = () => {
    if (!pairing) return;
    const s = Math.max(0, Math.round((new Date(pairing.expires_at) - Date.now()) / 1000));
    $("#pairLeft").textContent = Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  };
  tick();
  tickTimer = setInterval(tick, 1000);
  pollTimer = setInterval(pollPairing, 2000);
}

let polling = false;
async function pollPairing() {
  if (!pairing || polling) return;
  polling = true;
  try {
    const { data, error } = await supabase.rpc("device_pair_status", { p_id: pairing.id });
    if (error) throw error;
    pairing.expires_at = data.expires_at;
    if (data.status === "claimed") {
      $("#pairBox").hidden = true;
      if ($("#confirmBox").hidden) {
        $("#confirmName").textContent = "«" + (data.device_name || "Новое устройство") + "»";
        $("#confirmUa").textContent = "Определено как: " + describeUserAgent(data.device_ua);
        $("#confirmBox").hidden = false;
      }
    } else if (data.status === "consumed") {
      stopPairing();
      message("Устройство «" + (data.device_name || "") + "» подключено.", "success");
      loadDevices();
    } else if (data.status === "expired") {
      stopPairing();
      message("Код истёк. Нажмите «Подключить другое устройство», чтобы получить новый.", "error");
    } else if (data.status === "cancelled" || data.status === "rejected") {
      stopPairing();
    }
  } catch (e) {
    stopPairing();
    message("Ошибка: " + e.message, "error");
  } finally {
    polling = false;
  }
}

async function decide(approve) {
  if (!pairing) return;
  $("#confirmYes").disabled = $("#confirmNo").disabled = true;
  const { error } = await supabase.rpc("device_pair_decide", { p_id: pairing.id, p_approve: approve });
  $("#confirmYes").disabled = $("#confirmNo").disabled = false;
  $("#confirmBox").hidden = true;
  if (error) {
    stopPairing();
    message(error.message, "error");
    return;
  }
  if (approve) {
    message("Подтверждено, новое устройство входит…", "success");
  } else {
    stopPairing();
    message("Подключение отклонено.", "error");
  }
}

async function revoke(tr) {
  const name = tr.querySelector("td").textContent.trim();
  if (!confirm(`Отключить «${name}»? На этом устройстве придётся войти заново.`)) return;
  const { error } = await supabase.rpc("revoke_my_device", { p_session_id: tr.dataset.id });
  if (error) {
    showError("Ошибка: " + error.message);
    return;
  }
  loadDevices();
}

async function initDashboard() {
  if (dashboardStarted) return;
  dashboardStarted = true;
  $("#pairStart").addEventListener("click", startPairing);
  $("#pairCancel").addEventListener("click", async () => {
    if (pairing) await supabase.rpc("device_pair_cancel", { p_id: pairing.id });
    stopPairing();
  });
  $("#confirmYes").addEventListener("click", () => decide(true));
  $("#confirmNo").addEventListener("click", () => decide(false));
  $("#devicesBody").addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-act='revoke']");
    if (btn) revoke(btn.closest("tr"));
  });
  await loadDevices();
}

setupAuth(supabase, "devices.html", () => initDashboard());
