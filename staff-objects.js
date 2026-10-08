import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { setupAuth } from "./auth.js?v=36";
import { initCrumbs, applyUrlFilters, urlParam, STAFF_PAGES } from "./crumbs.js?v=2";

const SUPABASE_URL = "https://xdegfnbinprrfoxpcvpf.supabase.co";
const SUPABASE_KEY = "sb_publishable_8k0lb6crF1cjE0aziGtoZA_ojJh4IID";
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Аналитика «Персонал по объектам»: сотрудник × объект × рудник за выбранный период из
// staff_objects_data (журнал персонала laibour_summ + work; база сама ограничивает
// областью пользователя). Периоды — как на «Персонале» (staff-details.js) плюс «Всё время».

let dashboardStarted = false;
let people = []; // [{staff_id, famaly, pos, organization, home_mine, places:[{object, mine, orders, hours, first_day, last_day}], ...итоги}]
let sortKey = "hours";
let sortDir = -1;

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fN = (v) => Number(v || 0).toLocaleString("ru-RU", { maximumFractionDigits: 1 });
const MONTHS_RU_SHORT = ["янв", "фев", "мар", "апр", "май", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
const dmy = (s) => (s ? `${s.slice(8, 10)}.${s.slice(5, 7)}.${s.slice(2, 4)}` : "—");

function showError(msg) {
  const el = $("#errorBanner");
  el.textContent = msg;
  el.hidden = false;
}
function clearError() {
  $("#errorBanner").hidden = true;
}
function setLoading(on) {
  $("#loadingIndicator").style.display = on ? "block" : "none";
}

// ---------- периоды (как на «Персонале») ----------
let periods = {};
let currentPeriodKey = "r12";
function computePeriods(years) {
  const today = new Date();
  const y0 = today.getUTCFullYear(), m0 = today.getUTCMonth();
  const startOfMonth = (y, m) => new Date(Date.UTC(y, m, 1));
  const endOfMonth = (y, m) => new Date(Date.UTC(y, m + 1, 0));
  const p = {};
  p.r12 = { key: "r12", name: "12 мес", from: startOfMonth(y0, m0 - 11), to: endOfMonth(y0, m0) };
  for (const y of [...new Set(years)].sort((a, b) => a - b)) {
    const isCurrent = y === y0;
    p[y] = { key: String(y), name: isCurrent ? `${y} (янв–${MONTHS_RU_SHORT[m0]})` : String(y), from: startOfMonth(y, 0), to: isCurrent ? endOfMonth(y, m0) : endOfMonth(y, 11) };
  }
  p.all = { key: "all", name: "Всё время", from: null, to: null };
  return p;
}
function renderPeriodToggle() {
  const order = ["r12", ...Object.keys(periods).filter((k) => k !== "r12" && k !== "all"), "all"];
  $("#periodToggle").innerHTML = order.map((k) => `<button type="button" class="${k === currentPeriodKey ? "on" : ""}" data-period="${k}">${esc(periods[k].name)}</button>`).join("");
  for (const btn of $("#periodToggle").querySelectorAll("button")) {
    btn.addEventListener("click", () => {
      if (btn.dataset.period === currentPeriodKey) return;
      currentPeriodKey = btn.dataset.period;
      renderPeriodToggle();
      loadData();
    });
  }
}

let loadSeq = 0;
async function loadData() {
  clearError();
  setLoading(true);
  const seq = ++loadSeq;
  try {
    const P = periods[currentPeriodKey];
    const iso = (d) => (d ? d.toISOString().slice(0, 10) : null);
    const { data, error } = await supabase.rpc("staff_objects_data", { p_from: iso(P.from), p_to: iso(P.to) });
    if (seq !== loadSeq) return; // пока грузилось, выбрали другой период
    if (error) throw error;
    if (error) throw error;
    const byId = new Map();
    for (const r of data) {
      if (!byId.has(r.staff_id)) byId.set(r.staff_id, { staff_id: r.staff_id, famaly: r.famaly, pos: r.pos, organization: r.organization, home_mine: r.home_mine, home_object: r.home_object, places: [] });
      byId.get(r.staff_id).places.push(r);
    }
    people = [...byId.values()].map((p) => {
      p.places.sort((a, b) => b.hours - a.hours);
      p.orders = p.places.reduce((s, x) => s + Number(x.orders), 0);
      p.hours = p.places.reduce((s, x) => s + Number(x.hours), 0);
      p.nObj = new Set(p.places.map((x) => x.object)).size;
      p.first_day = p.places.map((x) => x.first_day).sort()[0];
      p.last_day = p.places.map((x) => x.last_day).sort().at(-1);
      return p;
    });
    const objects = [...new Set(data.map((r) => r.object).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ru"));
    const mines = [...new Set(data.map((r) => r.mine).filter(Boolean))].sort((a, b) => a.localeCompare(b, "ru"));
    const keepObj = $("#fObject").value, keepMine = $("#fMine").value;
    $("#fObject").innerHTML = `<option value="">Все объекты</option>` + objects.map((o) => `<option>${esc(o)}</option>`).join("");
    $("#fMine").innerHTML = `<option value="">Все рудники</option>` + mines.map((o) => `<option>${esc(o)}</option>`).join("");
    if (objects.includes(keepObj)) $("#fObject").value = keepObj;
    if (mines.includes(keepMine)) $("#fMine").value = keepMine;
    render();
  } catch (e) {
    showError("Ошибка загрузки данных: " + e.message);
  } finally {
    if (seq === loadSeq) setLoading(false);
  }
}

function render() {
  applyUrlFilters([["object", "#fObject"], ["mine", "#fMine"]]); // пришли по крошкам с другой формы (один раз)
  const obj = $("#fObject").value, mine = $("#fMine").value, q = $("#fSearch").value.trim().toLowerCase(), multi = $("#fMulti").checked;
  const rows = people
    .filter((p) => (!obj || p.places.some((x) => x.object === obj)) && (!mine || p.places.some((x) => x.mine === mine)))
    .filter((p) => !q || String(p.famaly).toLowerCase().includes(q))
    .filter((p) => !multi || p.nObj > 1)
    .sort((a, b) => {
      const va = a[sortKey], vb = b[sortKey];
      return (typeof va === "number" ? va - vb : String(va ?? "").localeCompare(String(vb ?? ""), "ru")) * sortDir;
    });
  $("#summary").textContent = `Сотрудников: ${rows.length}; из них на нескольких объектах: ${rows.filter((p) => p.nObj > 1).length}. Часов: ${fN(rows.reduce((s, p) => s + p.hours, 0))}.`;
  $("#dataTableBody").innerHTML = rows.map((p) => `<tr>
      <td><b>${esc(p.famaly)}</b></td><td>${esc(p.pos && p.pos !== "нет данных" ? p.pos : "—")}</td><td>${esc(p.organization || "—")}</td>
      <td>${esc(p.home_mine || "—")}</td>
      <td>${p.places.map((x) => `<span class="so-tag${x.mine === p.home_mine ? " home" : ""}" title="${dmy(x.first_day)} – ${dmy(x.last_day)}, машин: ${x.machines}">${esc(x.object)} / ${esc(x.mine)} · ${fN(x.hours)} ч · ${x.orders} нар.</span>`).join("")}</td>
      <td class="num">${p.nObj}</td><td class="num">${fN(p.orders)}</td><td class="num">${fN(p.hours)}</td>
      <td>${dmy(p.first_day)} – ${dmy(p.last_day)}</td></tr>`).join("") || `<tr><td colspan="9" class="hint-text">Нет данных</td></tr>`;
}

function initDashboard() {
  if (dashboardStarted) return;
  dashboardStarted = true;
  // Крошки: год (если выбран год, а не «12 мес» / «Всё время»), объект и шахта.
  initCrumbs($("#crumbs"), STAFF_PAGES, "staff-objects.html", {
    year: () => (/^\d{4}$/.test(currentPeriodKey) ? currentPeriodKey : ""),
    object: () => $("#fObject").value,
    mine: () => $("#fMine").value,
  });
  for (const id of ["#fObject", "#fMine", "#fMulti"]) $(id).addEventListener("change", render);
  $("#fSearch").addEventListener("input", render);
  document.querySelectorAll("#dataTable th[data-sort]").forEach((th) => th.addEventListener("click", () => {
    const k = th.dataset.sort;
    sortDir = sortKey === k ? -sortDir : ["hours", "orders", "nObj", "last_day"].includes(k) ? -1 : 1;
    sortKey = k;
    render();
  }));
  (async () => {
    setLoading(true);
    const { data: yearsData } = await supabase.from("v_staff_years").select("*");
    const years = (yearsData || []).map((r) => r.year ?? r.reporting_year ?? Object.values(r)[0]).filter(Boolean).map(Number);
    periods = computePeriods(years.length ? years : [new Date().getUTCFullYear()]);
    if (periods[urlParam("year")]) currentPeriodKey = urlParam("year"); // пришли по крошкам с выбранным годом
    renderPeriodToggle();
    await loadData();
  })();
}

setupAuth(supabase, "staff-objects.html", () => initDashboard());
