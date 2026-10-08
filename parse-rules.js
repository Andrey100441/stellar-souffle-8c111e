import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { setupAuth } from "./auth.js?v=36";
import { applyRules, hasWord, normText } from "./parse-rules-engine.js?v=4";
import { guardUnsaved } from "./unsaved.js?v=1";

const SUPABASE_URL = "https://xdegfnbinprrfoxpcvpf.supabase.co";
const SUPABASE_KEY = "sb_publishable_8k0lb6crF1cjE0aziGtoZA_ojJh4IID";
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// «Словарь разбора ремонтов» (только администратор): правила по площадкам (периоды ЕО, слова → тип /
// подсистема и отказ / причина, инициатор по типу и причине), ИИ, справочники.
// Правила площадки сохраняются кнопкой «Сохранить правила»; действия со справочниками — сразу.
// Все проверки повторяет база (repair_parse_rules_save, dict_*).

const $ = (q) => document.querySelector(q);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const fmtN = (n) => Number(n || 0).toLocaleString("ru-RU");
const clone = (o) => JSON.parse(JSON.stringify(o));

let DB = null;   // { sites, ai, ai_models, mines } — как в базе
let DICT = null; // справочники: types, subs, fails, reasons, damages, rules [тип, инициатор, причина], log
let site = "*";
const edit = {};          // правки правил по площадкам (вид для страницы: слова строкой через запятую)
const dirtySites = new Set();
let ai = null, dirtyAI = false;
let tab = "types";

// ---------- справочники: названия ----------
const L = (k) => (DICT?.[k] || []).map((x) => [x.id, x.name]);
const name = (k, id) => (DICT?.[k] || []).find((x) => x.id === Number(id))?.name || (id == null || id === "" ? "" : `#${id}`);
const opts = (list, sel, empty) => (empty != null ? `<option value="">${esc(empty)}</option>` : "") + list.map(([id, n]) => `<option value="${id}"${Number(sel) === id ? " selected" : ""}>${esc(n)}</option>`).join("");

// ---------- правила: вид базы ↔ вид страницы ----------
const EMPTY = { eo: [], type: [], sub: [], reason: [], dmg: [], model: [] };
function toUI(r) {
  r = r || EMPTY;
  const eo = clone(r.eo || []);
  while (eo.length < 2) eo.push({ on: false, from: eo.length ? "19:00" : "07:00", to: eo.length ? "21:00" : "09:00", type: 3 });
  const w = (a) => (a || []).join(", ");
  return {
    eo,
    type: (r.type || []).map((x) => ({ type: x.type, words: w(x.words) })),
    sub: (r.sub || []).map((x) => ({ sub: x.sub, fail: x.fail ?? "", words: w(x.words) })),
    reason: (r.reason || []).map((x) => ({ reason: x.reason, words: w(x.words) })),
    dmg: (r.dmg || []).map((x) => ({ type: x.type, reason: x.reason, dmg: x.dmg })),
    model: (r.model || []).map((x) => ({ model: x.model, words: w(x.words) })),
  };
}
const splitWords = (s) => String(s || "").split(",").map((x) => x.trim()).filter(Boolean);
function toDB(u) {
  return {
    eo: u.eo.map((p) => ({ on: !!p.on, from: p.from, to: p.to, type: p.type === "" ? null : Number(p.type) })),
    type: u.type.map((x) => ({ type: Number(x.type) || null, words: splitWords(x.words) })),
    sub: u.sub.map((x) => ({ sub: Number(x.sub) || null, fail: x.fail === "" || x.fail == null ? null : Number(x.fail), words: splitWords(x.words) })),
    reason: u.reason.map((x) => ({ reason: Number(x.reason) || null, words: splitWords(x.words) })),
    dmg: u.dmg.map((x) => ({ type: Number(x.type) || null, reason: Number(x.reason) || null, dmg: x.dmg === "" ? null : Number(x.dmg) })),
    model: u.model.map((x) => ({ model: String(x.model || "").trim(), words: splitWords(x.words) })),
  };
}
const hasOwn = (m) => m === "*" || !!DB.sites[m] || !!edit[m]?.__new;
const effDB = (m) => DB.sites[m] || DB.sites["*"] || EMPTY;          // как действует сейчас (сохранённое)
const siteName = (m) => (m === "*" ? "Общие правила (все рудники)" : m);
// Правила выбранной площадки на странице: правки, если есть; иначе сохранённые (свои или общие — только чтение).
function C() {
  if (edit[site]) return edit[site];
  if (hasOwn(site)) return (edit[site] = toUI(DB.sites[site]));
  return toUI(DB.sites["*"]);
}
const readOnly = () => site !== "*" && !hasOwn(site);
function markDirty() {
  if (!readOnly()) dirtySites.add(site);
  $("#dirty").hidden = !(dirtySites.size || dirtyAI);
}

function showError(msg) {
  const el = $("#errorBanner");
  el.textContent = msg || "";
  el.hidden = !msg;
  if (msg) el.scrollIntoView({ block: "nearest" });
}
async function rpc(fn, args) {
  const { data, error } = await supabase.rpc(fn, args);
  if (error) throw new Error(error.message);
  return data;
}

// ---------- загрузка ----------
async function loadAll() {
  [DB, DICT, REPL_LOG, SF] = await Promise.all([rpc("repair_parse_rules"), rpc("dict_admin_list"), rpc("dict_replace_list"), rpc("dict_sub_fails")]);
  ai = { ...(DB.ai || { enabled: true, model: "claude-haiku-4-5-20251001" }) };
}

// ---------- отрисовка ----------
function render() {
  renderSite();
  const R = C(), T = L("types"), RS = L("reasons"), DM = L("damages"), SB = L("subs");
  $("#eoRows").innerHTML = R.eo.map((p, i) => `<div class="pr-inline" data-eo="${i}">
      <label class="switch"><input type="checkbox" data-eof="on"${p.on ? " checked" : ""} /></label> Период ${i + 1}: если работа открыта с
      <input type="time" data-eof="from" value="${esc(p.from)}" /> до <input type="time" data-eof="to" value="${esc(p.to)}" /> → <select data-eof="type">${opts(T, p.type)}</select></div>`).join("");
  $("#tblType tbody").innerHTML = R.type.map((x, i) => `<tr data-i="${i}">
      <td class="cat"><select data-f="type">${opts(T, x.type)}</select></td>
      <td><textarea data-f="words">${esc(x.words)}</textarea><div class="wchips" data-chips="${i}"></div></td>
      <td><button class="pr-mv" data-mv="-1" title="Выше">↑</button> <button class="pr-mv" data-mv="1" title="Ниже">↓</button> <button class="pr-x" data-del title="Удалить строку">×</button></td></tr>`).join("");
  renderOverlaps("type");
  $("#tblSub tbody").innerHTML = R.sub.map((x, i) => {
    const fl = DICT.fails.filter((f) => f.subs.includes(Number(x.sub)) || f.id === Number(x.fail)).map((f) => [f.id, f.name]);
    return `<tr data-i="${i}">
      <td class="cat"><select data-f="sub">${opts(SB, x.sub)}</select></td>
      <td><select data-f="fail">${opts(fl, x.fail, "— любой —")}</select></td>
      <td><textarea data-f="words">${esc(x.words)}</textarea><div class="wchips" data-chips="${i}"></div></td>
      <td><button class="pr-x" data-del title="Удалить строку">×</button></td></tr>`;
  }).join("");
  renderOverlaps("sub");
  $("#tblReason tbody").innerHTML = R.reason.map((x, i) => `<tr data-i="${i}">
      <td class="cat"><select data-f="reason">${opts(RS, x.reason)}</select></td>
      <td><textarea data-f="words">${esc(x.words)}</textarea></td>
      <td><button class="pr-x" data-del title="Удалить строку">×</button></td></tr>`).join("");
  $("#tblDmg tbody").innerHTML = R.dmg.map((x, i) => {
    const allowed = DM.filter(([id]) => DICT.rules.some((r) => r[0] === Number(x.type) && r[2] === Number(x.reason) && r[1] === id));
    return `<tr data-i="${i}">
      <td><select data-f="type">${opts(T, x.type)}</select></td>
      <td><select data-f="reason">${opts(RS, x.reason)}</select></td>
      <td><select data-f="dmg">${allowed.length ? opts(allowed, x.dmg, "— выберите —") : '<option value="">нет разрешённых вариантов</option>'}</select></td>
      <td><button class="pr-x" data-del title="Удалить строку">×</button></td></tr>`;
  }).join("");
  $("#tblModel tbody").innerHTML = R.model.map((x, i) => `<tr data-i="${i}">
      <td class="cat"><input type="text" data-f="model" list="modelList" value="${esc(x.model)}" placeholder="KOMATSU" /></td>
      <td><textarea data-f="words">${esc(x.words)}</textarea></td>
      <td><button class="pr-x" data-del title="Удалить строку">×</button></td></tr>`).join("");
  // Подсказки: марки (первое слово модели) и модели из справочника техники.
  const brands = [...new Set((DB.models || []).map((m) => m.split(/\s+/)[0]))];
  $("#modelList").innerHTML = [...new Set([...brands, ...(DB.models || [])])].map((m) => `<option value="${esc(m)}"></option>`).join("");
  $("#aiOn").checked = !!ai.enabled;
  $("#aiLabel").textContent = ai.enabled ? "Включён" : "Выключен";
  $("#aiLabel").className = ai.enabled ? "ai-on" : "ai-off";
  $("#aiModel").value = ai.model;
  $("#aiModel").disabled = !ai.enabled;
  renderDict();
  renderSf();
  $("#dirty").hidden = !(dirtySites.size || dirtyAI);
}

function renderSite() {
  const all = ["*", ...DB.mines];
  const lab = (m) => siteName(m) + (m !== "*" && hasOwn(m) ? " — свои правила" : "") + (dirtySites.has(m) ? " •" : "");
  $("#site").innerHTML = all.map((m) => `<option value="${esc(m)}"${m === site ? " selected" : ""}>${esc(lab(m))}</option>`).join("");
  const ts = $("#testSite"), cur = ts.value || DB.mines[0] || "";
  ts.innerHTML = DB.mines.map((m) => `<option${m === cur ? " selected" : ""}>${esc(m)}</option>`).join("");
  $("#ownWrap").hidden = site === "*";
  $("#ownRules").checked = hasOwn(site);
  const ro = readOnly();
  const off = site !== "*" && DB.inactive_sites?.[site];
  $("#siteState").textContent = site === "*" ? "Действуют на всех рудниках без своих правил"
    : ro ? "Сейчас использует общие правила (показаны, только чтение)" + (off ? ` · свои правила отключены ${new Date(off.at).toLocaleDateString("ru-RU")}, их можно вернуть галочкой` : "")
    : "Свои правила рудника";
  document.querySelectorAll(".site-sec").forEach((sec) => {
    sec.classList.toggle("ro", ro);
    sec.querySelector(".badge-site").textContent = siteName(site);
    const n = sec.querySelector(".inherit-note");
    n.hidden = !ro;
    n.textContent = "Рудник использует общие правила. Чтобы задать свои — включите «Свои правила для этого рудника» вверху.";
  });
}

// ---------- разделы 1 и 3: пересечения слов-триггеров ----------
// Слова строки — фишками под полем; слово, которое (в той же или другой форме: «пробит» — «пробита»,
// по тому же сравнению, что и разбор) есть ещё в другой строке раздела, подсвечивается, в подсказке — где ещё.
const wordsMeet = (a, b) => {
  const x = normText(a).trim(), y = normText(b).trim();
  if (!x || !y) return false;
  return x === y || hasWord(normText(a), b) || hasWord(normText(b), a) || (Math.min(x.length, y.length) >= 4 && (x.startsWith(y) || y.startsWith(x)));
};
// Подпись строки в подсказке: раздел 1 — тип работ, раздел 3 — подсистема / отказ.
const OV_LABEL = {
  type: (r) => L("types").find(([v]) => Number(v) === Number(r.type))?.[1] || "тип не выбран",
  sub: (r) => (L("subs").find(([v]) => Number(v) === Number(r.sub))?.[1] || "подсистема не выбрана") + (r.fail ? " / " + (name("fails", r.fail) || "") : ""),
};
function renderOverlaps(key) {
  const rows = C()[key] || [], label = OV_LABEL[key];
  const lists = rows.map((r) => splitWords(r.words));
  const tbl = key === "type" ? "#tblType" : "#tblSub";
  lists.forEach((words, i) => {
    const box = document.querySelector(`${tbl} [data-chips="${i}"]`);
    if (!box) return;
    box.innerHTML = words.map((w) => {
      const where = [];
      lists.forEach((other, j) => {
        if (j === i) return;
        const hit = other.filter((o) => wordsMeet(w, o));
        if (hit.length) where.push(`строка ${j + 1} (${label(rows[j])}): ${hit.join(", ")}`);
      });
      return where.length
        ? `<span class="wchip ov" title="${esc("Слово дублируется: " + where.join("; "))}">${esc(w)}</span>`
        : `<span class="wchip">${esc(w)}</span>`;
    }).join("");
  });
}

// ---------- правки правил ----------
const TBL = { tblType: "type", tblSub: "sub", tblReason: "reason", tblDmg: "dmg", tblModel: "model" };
document.addEventListener("change", (e) => {
  if (!DB || e.target.closest("#xferModal") || e.target.closest("#replModal") || e.target.closest("#tblDict") || e.target.closest("#sfCard")) return;
  const id = e.target.id;
  if (id === "site") { site = e.target.value; render(); return; }
  if (id === "testSite" || id === "testTime") return;
  if (id === "ownRules") { toggleOwn(e.target.checked); return; }
  if (id === "aiOn") { ai.enabled = e.target.checked; dirtyAI = true; render(); return; }
  if (id === "aiModel") { ai.model = e.target.value; dirtyAI = true; render(); return; }
  if (readOnly()) return;
  const eo = e.target.closest("[data-eo]");
  if (eo) {
    const p = C().eo[eo.dataset.eo], f = e.target.dataset.eof;
    p[f] = f === "on" ? e.target.checked : f === "type" ? Number(e.target.value) : e.target.value;
    markDirty(); render(); return;
  }
  const tr = e.target.closest("tr[data-i]");
  if (tr && e.target.dataset.f && e.target.tagName === "SELECT") { // поле «модель» — текст, сохраняется в input
    const key = TBL[tr.closest("table").id], row = C()[key][tr.dataset.i], f = e.target.dataset.f;
    row[f] = e.target.value === "" ? "" : Number(e.target.value);
    if (key === "sub" && f === "sub") row.fail = "";
    markDirty(); render();
  }
});
document.addEventListener("input", (e) => {
  if (!DB || readOnly()) return;
  const tr = e.target.closest("tr[data-i]");
  if (tr && (e.target.tagName === "TEXTAREA" || e.target.dataset.f === "model") && TBL[tr.closest("table")?.id]) {
    C()[TBL[tr.closest("table").id]][tr.dataset.i][e.target.dataset.f] = e.target.value;
    markDirty();
    if (tr.closest("#tblType")) renderOverlaps("type"); // подсветка пересечений — сразу при вводе
    else if (tr.closest("#tblSub")) renderOverlaps("sub");
  }
});
document.addEventListener("click", (e) => {
  if (!DB) return;
  const add = e.target.closest("[data-add]");
  if (add && !readOnly()) {
    const k = add.dataset.add, T0 = DICT.types[0]?.id, R0 = DICT.reasons.find((r) => r.rules.length)?.id;
    C()[k].push(k === "model" ? { model: "", words: "" } : k === "type" ? { type: T0, words: "" } : k === "sub" ? { sub: DICT.subs[0]?.id, fail: "", words: "" } : k === "reason" ? { reason: R0, words: "" } : { type: T0, reason: R0, dmg: "" });
    markDirty(); render(); return;
  }
  const tr = e.target.closest("tr[data-i]");
  if (!tr || readOnly() || !TBL[tr.closest("table")?.id]) return;
  const arr = C()[TBL[tr.closest("table").id]], i = Number(tr.dataset.i);
  if (e.target.closest("[data-del]")) { arr.splice(i, 1); markDirty(); render(); }
  const mv = e.target.closest("[data-mv]");
  if (mv) { const j = i + Number(mv.dataset.mv); if (j >= 0 && j < arr.length) { [arr[i], arr[j]] = [arr[j], arr[i]]; markDirty(); render(); } }
});

async function toggleOwn(on) {
  if (on) {
    // Отключённые раньше правила рудника хранятся — предлагаем вернуть их; иначе начинаем с копии общих.
    const off = DB.inactive_sites?.[site];
    const back = off && confirm(`У рудника «${site}» есть свои правила, отключённые ${new Date(off.at).toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" })}.

ОК — вернуть их, Отмена — начать с копии общих правил.
Изменения вступят в силу после «Сохранить правила».`);
    edit[site] = toUI(back ? off.rules : DB.sites["*"]);
    edit[site].__new = true;
    dirtySites.add(site);
    render();
    return;
  }
  if (!confirm(`Отключить свои правила рудника «${site}»? Он будет работать по общим правилам.

Свои правила сохранятся — их можно вернуть галочкой «Свои правила для этого рудника».`)) { render(); return; }
  try {
    if (DB.sites[site]) await rpc("repair_parse_rules_save", { p_site: site, p_rules: null });
    delete edit[site]; dirtySites.delete(site);
    await loadAll(); render();
  } catch (err) { showError("Ошибка: " + err.message); render(); }
}

async function saveAll() {
  showError("");
  const btn = $("#saveBtn");
  btn.disabled = true;
  try {
    for (const m of [...dirtySites]) {
      await rpc("repair_parse_rules_save", { p_site: m, p_rules: toDB(edit[m]) });
      delete edit[m]; dirtySites.delete(m);
    }
    if (dirtyAI) { await rpc("repair_parse_ai_save", { p_enabled: ai.enabled, p_model: ai.model }); dirtyAI = false; }
    await loadAll();
    render();
    btn.textContent = "Сохранено ✓";
    setTimeout(() => (btn.textContent = "Сохранить правила"), 1800);
  } catch (err) {
    showError("Не сохранено: " + err.message + (site !== [...dirtySites][0] && dirtySites.size ? ` (площадка «${siteName([...dirtySites][0])}»)` : ""));
  } finally { btn.disabled = false; }
}
function resetAll() {
  if ((dirtySites.size || dirtyAI) && !confirm("Отменить все несохранённые изменения правил?")) return;
  for (const m of Object.keys(edit)) delete edit[m];
  dirtySites.clear(); dirtyAI = false; ai = { ...DB.ai };
  render();
}
// Уход со страницы с несохранёнными правками (меню, ссылки, закрытие вкладки) — предложить сохранить.
// Смена площадки вверху правки не теряет: они хранятся по площадкам и сохраняются вместе.
const sfChanged = () => {
  if (sfSel == null || sfSub == null) return false;
  const saved = sfSaved();
  return sfMxDirty || sfSel.size !== saved.size || [...saved].some((f) => !sfSel.has(f));
};
const dictPending = () => [...document.querySelectorAll("#tblDict .row-save")].some((el) => !el.hidden);
guardUnsaved({
  isDirty: () => !!(dirtySites.size || dirtyAI || sfChanged() || dictPending()),
  describe: () => [
    ...[...dirtySites].map((m) => `правила: ${siteName(m)}`),
    ...(dirtyAI ? ["настройки ИИ-разбора"] : []),
    ...(sfChanged() ? [`раздел 2: список отказов «${name("subs", sfSub)}»`] : []),
    ...(dictPending() ? ["раздел 7: изменённые названия или «где разрешена» — сохраняются кнопкой в строке, «Сохранить» здесь их не сохраняет"] : []),
  ],
  save: async () => {
    if (dirtySites.size || dirtyAI) await saveAll();
    if (sfChanged()) await sfSave();
  },
});

// ---------- обмен правилами между площадками ----------
const PARTS = { eo: "Периоды ЕО", type: "Слова: тип работ", sub: "Подсистема и отказ", reason: "Причина", dmg: "Инициатор", model: "Модели техники" };
const keyOf = (part, r) => (part === "sub" ? `${r.sub}|${r.fail ?? ""}` : part === "dmg" ? `${r.type}|${r.reason}` : part === "type" ? String(r.type) : part === "model" ? String(r.model).toUpperCase() : String(r.reason));
const eoTxt = (eo) => (eo || []).filter((x) => x.on).map((x) => `${x.from}–${x.to}`).join(", ") || "выключены";
function transfer(src, dst, parts, mode) {
  const out = clone(dst);
  for (const part of parts) {
    if (part === "eo" || mode === "replace") { out[part] = clone(src[part] || []); continue; }
    out[part] = out[part] || [];
    const idx = new Map(out[part].map((r, i) => [keyOf(part, r), i]));
    for (const row of src[part] || []) {
      const k = keyOf(part, row);
      if (!idx.has(k)) { out[part].push(clone(row)); continue; }
      if (part === "dmg") continue;
      const cur = out[part][idx.get(k)], have = new Set(cur.words);
      cur.words = [...cur.words, ...row.words.filter((w) => !have.has(w))];
    }
  }
  return out;
}
function diffText(before, after, parts) {
  const lines = [];
  for (const part of parts) {
    if (part === "eo") { if (eoTxt(before.eo) !== eoTxt(after.eo)) lines.push(`Периоды ЕО: ${eoTxt(before.eo)} → ${eoTxt(after.eo)}`); continue; }
    if (part === "dmg") {
      const b = new Set((before.dmg || []).map((r) => `${r.type}|${r.reason}|${r.dmg}`)), a = new Set((after.dmg || []).map((r) => `${r.type}|${r.reason}|${r.dmg}`));
      const add = [...a].filter((x) => !b.has(x)).length, del = [...b].filter((x) => !a.has(x)).length;
      if (add || del) lines.push(`Инициатор: ${[add ? "+" + add + " правил" : "", del ? "−" + del + " правил" : ""].filter(Boolean).join(", ")}`);
      continue;
    }
    const all = (rs) => new Set((rs || []).flatMap((r) => r.words.map((w) => keyOf(part, r) + ":" + w)));
    const b = all(before[part]), a = all(after[part]);
    const add = [...a].filter((x) => !b.has(x)).map((x) => x.split(":").pop()), del = [...b].filter((x) => !a.has(x)).length;
    if (add.length || del) lines.push(`${PARTS[part]}: ${[add.length ? `+${add.length} слов (${add.slice(0, 6).join(", ")}${add.length > 6 ? "…" : ""})` : "", del ? `−${del} слов` : ""].filter(Boolean).join(", ")}`);
  }
  return lines;
}
let xfer = null;
const xParts = () => [...document.querySelectorAll("#xferParts input:checked")].map((x) => x.value);
const xMode = () => document.querySelector("input[name=xferMode]:checked").value;
const xFrom = () => (xfer.mode === "import" ? $("#xferFromSel").value : site);
const xTo = () => (xfer.mode === "import" ? [site] : [...document.querySelectorAll("#xferTo input:checked")].map((x) => x.value));
// Источник: сохранённые правила площадки (несохранённые правки в обмене не участвуют).
const srcRules = (m) => effDB(m);
function openXfer(mode) {
  if (dirtySites.size) { showError("Сначала сохраните или отмените изменения правил — обмен работает с сохранёнными правилами."); return; }
  xfer = { mode };
  const others = ["*", ...DB.mines].filter((m) => m !== site);
  $("#xferTitle").textContent = mode === "import" ? `Импорт правил в «${siteName(site)}»` : `Экспорт правил «${siteName(site)}»`;
  $("#xferFrom").innerHTML = mode === "import"
    ? `<select id="xferFromSel">${others.map((m) => `<option value="${esc(m)}">${esc(siteName(m))}${m !== "*" && !DB.sites[m] ? " (использует общие)" : ""}</option>`).join("")}</select>`
    : `<b>${esc(siteName(site))}</b>`;
  $("#xferTo").innerHTML = mode === "import" ? `<b>${esc(siteName(site))}</b>`
    : others.map((m) => `<label class="combo"><input type="checkbox" value="${esc(m)}" /> ${esc(siteName(m))}</label>`).join("<br>");
  $("#xferModal").hidden = false;
  xferPreview();
}
function xferPreview() {
  const parts = xParts(), to = xTo();
  if (!to.length || !parts.length) {
    $("#xferPreview").innerHTML = `<span class="none">${!to.length ? "Отметьте, на какие площадки переносить." : "Отметьте, что переносить."}</span>`;
    $("#xferOk").disabled = true; return;
  }
  $("#xferOk").disabled = false;
  const src = srcRules(xFrom());
  $("#xferPreview").innerHTML = "<b>Что изменится:</b>" + to.map((t) => {
    const before = effDB(t), lines = diffText(before, transfer(src, before, parts, xMode()), parts);
    const note = t !== "*" && !DB.sites[t] ? " — сейчас использует общие; станут свои правила" : "";
    return `<div style="margin-top:6px"><b>${esc(siteName(t))}</b>${esc(note)}${lines.length ? `<ul>${lines.map((l) => `<li>${esc(l)}</li>`).join("")}</ul>` : '<div class="none">без изменений</div>'}</div>`;
  }).join("");
}
const closeXfer = () => { $("#xferModal").hidden = true; xfer = null; };
async function applyXfer() {
  const parts = xParts(), mode = xMode(), src = srcRules(xFrom());
  $("#xferOk").disabled = true;
  try {
    for (const t of xTo()) await rpc("repair_parse_rules_save", { p_site: t, p_rules: transfer(src, effDB(t), parts, mode) });
    closeXfer();
    await loadAll(); render();
  } catch (err) { showError("Не перенесено: " + err.message); $("#xferOk").disabled = false; }
}

// ---------- справочники ----------
const KIND = { types: "Тип работ", subs: "Подсистема", fails: "Отказ", reasons: "Причина", damages: "Инициатор" };
const DICT_HINT = {
  types: "Переименование меняет название во всех работах и отчётах (значение хранится ключом). Удалить можно только тип, который нигде не используется.",
  subs: "Новая подсистема появится в форме ввода, когда её добавят в шаблон модели. Переименование обновит и шаги ТО. Удалить можно только неиспользованную.",
  fails: "Новый отказ появится в форме ввода, когда его добавят в шаблон модели. Удалить можно только неиспользованный.",
  reasons: "Отметьте, для каких «тип работ / инициатор» причина разрешена — только там она предлагается в форме ввода.",
  damages: "Инициатор — кто виноват в простое. Название — одно слово. Удалить можно только неиспользованного.",
};
function renderDict() {
  document.querySelectorAll("#dictTabs .tab").forEach((b) => b.classList.toggle("on", b.dataset.dict === tab));
  $("#dictHint").textContent = DICT_HINT[tab];
  const rows = DICT[tab] || [];
  // Где ещё записано значение без работ (та же проверка, что перед удалением в базе).
  // Детали и персонал нарядов — копии работ для отчётов (у ТО в них другая кодировка), отдельно не показываются: только запрещают удаление.
  const OTHER = { "13wza_details": "отчёты", "13wza_details_staff": "отчёты", "наряды формы": "наряды формы ввода", "шаблоны": "шаблоны моделей",
    "исключения шаблонов": "исключения шаблонов", "словарь разбора": "словарь разбора (площадок)", "шаги ТО": "шаги ТО", "правила причин": "правила причин", "настройки повторов": "настройки повторов" };
  const otherTxt = (x) => [...new Set(Object.keys(x.other || {}).map((k) => OTHER[k] || k))].join(", ");
  const uses = (x) => `<td class="uses clip">${x.uses ? `<a href="#" data-works title="Открыть эти работы в журнале ремонтов">${fmtN(x.uses)} работ</a>` : "—"}</td>`;
  const del = (x) => (x.uses ? `<button class="btn-secondary btn-small" data-repl title="Заменить это значение другим в записанных работах площадки и периода">Заменить…</button> ` : "")
    + `<button class="pr-x" data-ddel ${x.uses ? `disabled title="Используется в ${fmtN(x.uses)} работах — удалить нельзя, можно переименовать"` : otherTxt(x) ? `disabled title="Есть в: ${esc(otherTxt(x))} — удалить нельзя, можно переименовать"` : 'title="Удалить"'}>×</button>`;
  // «В форме»: снятая галочка скрывает значение из формы ввода и ИИ (dict_set_visible, применяется сразу).
  const visTh = "<th class='vis' title='Показывать в форме ввода'>В форме</th>";
  const visCell = (x) => `<td class="vis"><input type="checkbox" data-vis title="Показывать в форме ввода"${x.hidden ? "" : " checked"} /></td>`;
  const trOpen = (x) => `<tr data-did="${x.id}"${x.hidden ? ' class="dict-hidden"' : ""}>${visCell(x)}`;
  const nameCell = (x) => `<td><input type="text" data-dn value="${esc(x.name)}" data-orig="${esc(x.name)}" /><div class="row-save" hidden><button class="btn-secondary btn-small" data-dsave>Сохранить название</button></div></td>`;
  $("#tblDict").classList.toggle("dict-plain", tab !== "reasons" && tab !== "fails");
  if (tab === "reasons") {
    const combos = [];
    for (const t of DICT.types) for (const d of DICT.damages) combos.push([t.id, d.id, `${t.name} / ${d.name}`]);
    $("#tblDict thead").innerHTML = "<tr>" + visTh + "<th style='width:24%'>Причина</th><th>Разрешена для (тип работ / инициатор)</th><th class='num'>В работах</th><th class='act'></th></tr>";
    $("#tblDict tbody").innerHTML = rows.map((x) => `${trOpen(x)}${nameCell(x)}
      <td>${combos.map(([t, d, l]) => `<label class="combo"><input type="checkbox" data-combo="${t},${d}"${x.rules.some((r) => r[0] === t && r[1] === d) ? " checked" : ""} /> ${esc(l)}</label>`).join("")}
        <div class="row-save" data-rsave hidden><button class="btn-secondary btn-small" data-rulesave>Сохранить «где разрешена»</button></div></td>
      ${uses(x)}<td class="act">${del(x)}</td></tr>`).join("");
  } else if (tab === "fails") {
    $("#tblDict thead").innerHTML = "<tr>" + visTh + "<th style='width:32%'>Отказ</th><th>Подсистемы (по шаблонам моделей)</th><th class='num'>В работах</th><th class='act'></th></tr>";
    $("#tblDict tbody").innerHTML = rows.map((x) => `${trOpen(x)}${nameCell(x)}
      ${((t) => `<td class="uses clip" title="${esc(t)}">${esc(t)}</td>`)(x.subs.map((s) => name("subs", s)).join(", ") || "нет в шаблонах")}${uses(x)}<td class="act">${del(x)}</td></tr>`).join("");
  } else {
    $("#tblDict thead").innerHTML = `<tr>${visTh}<th>${KIND[tab]}</th><th class='num'>В работах</th><th class='act'></th></tr>`;
    $("#tblDict tbody").innerHTML = rows.map((x) => `${trOpen(x)}${nameCell(x)}${uses(x)}<td class="act">${del(x)}</td></tr>`).join("");
  }
  renderReplLog();
  const ACT = { add: "добавлено", rename: "переименовано", delete: "удалено", rules: "где разрешена", hide: "скрыто в форме", show: "показано в форме" };
  $("#tblLog tbody").innerHTML = (DICT.log || []).length
    ? DICT.log.map((l) => `<tr><td>${esc(new Date(l.at).toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" }))}</td><td>${esc(KIND[l.kind] || l.kind)}</td><td>${esc(ACT[l.action] || l.action)}</td>
        <td>${esc(l.action === "rename" ? `«${l.old}» → «${l.new}»` : l.action === "add" ? `«${l.new}»` : l.action === "delete" ? `«${l.old}»` : name(l.kind, l.id))}</td></tr>`).join("")
    : '<tr><td colspan="4" class="uses">Изменений ещё не было.</td></tr>';
}
function dictStatus(text, kind) {
  const el = $("#dictStatus");
  el.textContent = text || "";
  el.className = "dict-status login-message " + (kind || "success");
  el.hidden = !text;
}
async function reloadAfterDict() {
  await loadAll();
  // правки правил в памяти сохраняются; справочники и списки выбора — свежие
  render();
}
// Пересчёт сводок, где названия хранятся готовыми (по одной за запрос). Не бросает ошибку: изменение
// данных к этому моменту уже сохранено — возвращает текст для сообщения («» — всё пересчитано).
async function refreshSummaries(show = (t) => dictStatus(t, "success")) {
  const failed = [];
  for (let step = 1; step <= 6; step++) {
    show(`Пересчёт сводок ${step}/6…`);
    try { await rpc("dict_refresh_summaries", { p_step: step }); } catch (err) { failed.push(`шаг ${step}: ${err.message}`); }
  }
  return failed.length ? ` Пересчёт сводок завершился не полностью (${failed.join("; ")}) — эти отчёты могут показывать старые данные; повторите действие позже или сообщите разработчику.` : "";
}
$("#dictTabs").addEventListener("click", (e) => { const t = e.target.closest(".tab"); if (t) { tab = t.dataset.dict; renderDict(); } });
$("#tblDict").addEventListener("input", (e) => {
  const tr = e.target.closest("tr[data-did]");
  if (e.target.dataset.dn != null) tr.querySelector(".row-save").hidden = e.target.value.trim() === e.target.dataset.orig;
});
$("#tblDict").addEventListener("change", async (e) => {
  if (e.target.dataset.vis != null) {
    const cb = e.target, tr = cb.closest("tr[data-did]"), id = Number(tr.dataset.did), x = DICT[tab].find((r) => r.id === id);
    const visible = cb.checked;
    cb.disabled = true;
    try {
      await rpc("dict_set_visible", { p_kind: tab, p_id: id, p_visible: visible });
      x.hidden = !visible;
      tr.classList.toggle("dict-hidden", !visible);
      dictStatus(`«${x.name}» ${visible ? "снова показывается" : "скрыто"} в форме ввода.`);
      loadAll().then(() => { if (DICT) renderDict(); }).catch(() => {}); // журнал изменений — свежий
    } catch (err) {
      cb.checked = !visible; // не сохранилось — вернуть, как было
      dictStatus("Не изменено: " + err.message, "error");
    } finally { cb.disabled = false; }
    return;
  }
  if (e.target.dataset.combo) e.target.closest("tr").querySelector("[data-rsave]").hidden = false;
});
$("#tblDict").addEventListener("click", async (e) => {
  const clip = e.target.closest("td.clip");
  if (clip && !e.target.closest("a")) { clip.classList.toggle("full"); return; } // обрезанный текст — полностью по нажатию
  const tr = e.target.closest("tr[data-did]");
  if (!tr) return;
  const id = Number(tr.dataset.did), x = DICT[tab].find((r) => r.id === id);
  if (e.target.closest("[data-repl]")) { openRepl(tab, id); return; }
  if (e.target.closest("[data-works]")) { e.preventDefault(); openWorks(tab, x, e.target.closest("[data-works]")); return; }
  try {
    if (e.target.closest("[data-dsave]")) {
      const nv = tr.querySelector("[data-dn]").value.trim();
      if (!confirm(`Переименовать «${x.name}» → «${nv}»?\n\nНовое название сразу будет во всех работах и отчётах (${fmtN(x.uses)} работ). После этого будут пересчитаны сводки — это займёт до минуты.`)) return;
      dictStatus("Переименование…");
      const r = await rpc("dict_rename", { p_kind: tab, p_id: id, p_name: nv });
      const warn = await refreshSummaries();
      const copies = Object.entries(r.copies || {}).filter(([, n]) => n).map(([k, n]) => `${k}: ${fmtN(n)}`).join(", ");
      dictStatus(`Готово: «${r.old}» → «${r.new}».${warn || " Сводки пересчитаны (персонал — в течение минуты)."}${copies ? " Обновлены копии названий — " + copies + "." : ""}`, warn ? "error" : "success");
      await reloadAfterDict();
    } else if (e.target.closest("[data-ddel]") && !e.target.disabled) {
      if (!confirm(`Удалить «${x.name}» из справочника?`)) return;
      await rpc("dict_delete", { p_kind: tab, p_id: id });
      dictStatus(`«${x.name}» удалено.`);
      await reloadAfterDict();
    } else if (e.target.closest("[data-rulesave]")) {
      const pairs = [...tr.querySelectorAll("input[data-combo]:checked")].map((c) => c.dataset.combo.split(",").map(Number));
      await rpc("dict_reason_rules_save", { p_reason: id, p_pairs: pairs });
      dictStatus(`«${x.name}»: сохранено, где причина разрешена.`);
      await reloadAfterDict();
    }
  } catch (err) { dictStatus("Ошибка: " + err.message, "error"); }
});
$("#dictAdd").addEventListener("click", async () => {
  const nv = $("#dictNewName").value.trim();
  if (!nv) { $("#dictNewName").focus(); return; }
  try {
    await rpc("dict_add", { p_kind: tab, p_name: nv });
    $("#dictNewName").value = "";
    dictStatus(`Добавлено: «${nv}»${tab === "reasons" ? " — отметьте ниже, где причина разрешена" : tab === "subs" || tab === "fails" ? " — в форме появится после добавления в шаблон модели" : ""}.`);
    await reloadAfterDict();
  } catch (err) { dictStatus("Ошибка: " + err.message, "error"); }
});

// ---------- «N работ» → журнал ремонтов с этими работами ----------
// Журнал открывается по списку нарядов (?wo=…&src=…): так видны работы за все месяцы сразу.
const WORK_COL = { types: "type_id", subs: "subsystem_id", fails: "failure_id", reasons: "reason_id", damages: "initiator_id" };
const WORKS_MAX = 3000; // нарядов в одной ссылке (длина адреса)
async function openWorks(kind, x, link) {
  const win = window.open("", "_blank"); // вкладка открывается сразу, иначе браузер заблокирует её после запроса
  const label = link.textContent;
  link.textContent = "Ищу работы…";
  try {
    const ids = new Set();
    for (let from = 0; ids.size <= WORKS_MAX; from += 1000) {
      const { data, error } = await supabase.from("v_repair_details").select("work_order").eq(WORK_COL[kind], x.id).order("work_order", { ascending: false }).range(from, from + 999);
      if (error) throw new Error(error.message);
      for (const r of data) if (r.work_order != null) ids.add(r.work_order);
      if (data.length < 1000) break;
    }
    if (!ids.size) { win?.close(); dictStatus(`«${x.name}»: в журнале ремонтов таких работ не найдено.`, "error"); return; }
    const list = [...ids].sort((a, b) => b - a).slice(0, WORKS_MAX);
    const cut = ids.size > WORKS_MAX;
    const url = `repair-details.html?wo=${list.join(",")}&src=${encodeURIComponent(`${KIND[kind]}: ${x.name}${cut ? ` (последние ${fmtN(WORKS_MAX)} нарядов)` : ""}`)}`;
    if (win) win.location.href = url; else window.location.href = url;
    if (cut) dictStatus(`«${x.name}»: нарядов больше ${fmtN(WORKS_MAX)} — в журнале открыты последние ${fmtN(WORKS_MAX)}.`, "error");
  } catch (err) {
    win?.close();
    dictStatus("Не удалось открыть работы: " + err.message, "error");
  } finally { link.textContent = label; }
}

// ---------- Заменить значение в записанных работах (по площадке и периоду) ----------
let REPL_LOG = [];
let repl = null; // { kind, id }
let replTimer = null, replSeq = 0, replInfo = null;
const REPORTS = {
  types: "Доступность и надёжность (простой, MTBF, MTTR), Состояние парка, Журнал ремонтов, История ТО, Персонал",
  subs: "Журнал ремонтов, Аварийный простой по подсистемам, Состояние парка, Персонал",
  fails: "Журнал ремонтов, Аварийный простой по подсистемам",
  reasons: "Причины аварийных отказов, Журнал ремонтов, Персонал",
  damages: "Простой по виновнику (рудник/сервис), Журнал ремонтов, Персонал",
};
const ruDate = (d) => (d ? String(d).slice(0, 10).split("-").reverse().join(".") : "");
const replIsNew = () => $("#replTo").value === "new";
const replToName = () => (replIsNew() ? $("#replNew").value.trim() : name(repl.kind, $("#replTo").value));
async function loadReplLog() { REPL_LOG = await rpc("dict_replace_list"); }

function openRepl(kind, id) {
  repl = { kind, id };
  $("#replTitle").textContent = "Заменить: " + KIND[kind].toLowerCase();
  $("#replFrom").innerHTML = `<b>${esc(name(kind, id))}</b>`;
  $("#replTo").innerHTML = opts(L(kind).filter(([i]) => i !== id), "", "— выберите —") + '<option value="new">+ Новое значение…</option>';
  $("#replNew").value = ""; $("#replNew").hidden = true;
  $("#replSite").innerHTML = [["*", "Все рудники"], ...DB.mines.map((m) => [m, m])].map(([v, l]) => `<option value="${esc(v)}"${v === site ? " selected" : ""}>${esc(l)}</option>`).join("");
  $("#replD1").value = ""; $("#replD2").value = "";
  $("#replRules").checked = true;
  $("#replAgree").checked = false;
  $("#replStatus").hidden = true;
  $("#replModal").hidden = false;
  replPreview(true);
}
const closeRepl = () => { $("#replModal").hidden = true; repl = null; };

// Предпросмотр: сколько записей изменится (запрос к базе, с небольшой задержкой при вводе).
function replPreview(now) {
  $("#replNew").hidden = !replIsNew();
  clearTimeout(replTimer);
  replTimer = setTimeout(doPreview, now ? 0 : 350);
  renderReplPreview();
}
async function doPreview() {
  if (!repl) return;
  const seq = ++replSeq;
  replInfo = { loading: true };
  renderReplPreview();
  try {
    const r = await rpc("dict_replace_preview", { p_kind: repl.kind, p_from: repl.id, p_site: $("#replSite").value, p_d1: $("#replD1").value || null, p_d2: $("#replD2").value || null });
    if (seq === replSeq) { replInfo = r; renderReplPreview(); }
  } catch (err) { if (seq === replSeq) { replInfo = { error: err.message }; renderReplPreview(); } }
}
function renderReplPreview() {
  if (!repl) return;
  const toOk = replIsNew() ? !!$("#replNew").value.trim() : !!$("#replTo").value;
  const st = $("#replSite").value, d1 = $("#replD1").value, d2 = $("#replD2").value;
  const per = d1 || d2 ? `с ${d1 ? ruDate(d1) : "начала данных"} по ${d2 ? ruDate(d2) : "сегодня"}` : "за всё время";
  const I = replInfo || {};
  let html = "", ok = false;
  if (!toOk) html = '<span class="none">Выберите, на что заменить. Нового значения нет в списке — выберите «+ Новое значение…».</span>';
  else if (I.loading) html = '<span class="none">Считаю, сколько записей изменится…</span>';
  else if (I.error) html = `<span class="warn">Ошибка: ${esc(I.error)}</span>`;
  else if (!I.work) html = `<span class="none">Работ с «${esc(name(repl.kind, repl.id))}» (${esc(st === "*" ? "все рудники" : st)}, ${esc(per)}) нет — менять нечего.</span>`;
  else if (I.work > I.limit) html = `<span class="warn">Слишком много работ за одну замену: ${fmtN(I.work)} (можно не больше ${fmtN(I.limit)}). Разбейте по периодам или площадкам.</span>`;
  else {
    ok = true;
    const toN = replToName(), toId = replIsNew() ? null : Number($("#replTo").value);
    const ruleNote = $("#replRules").checked
      ? (st === "*" ? "Правила словаря: заменится в общих правилах и в своих правилах всех рудников." : DB.sites[st] ? `Правила словаря: заменится в своих правилах рудника ${st}.` : `Правила словаря: у рудника ${st} нет своих правил — будут созданы из общих, уже с заменой.`)
      : "Правила словаря не меняются.";
    let typeWarn = "";
    if (repl.kind === "types") {
      const key = (id) => (id === 1 ? "аварийные" : id === 3 ? "ТО" : null);
      if (key(repl.id) || (toId && key(toId)) || (!toId && 1)) {
        typeWarn = `<div class="warn" style="margin-top:6px">Отчёты считают аварийные работы по ключу «${esc(name("types", 1))}», а ТО — по ключу «${esc(name("types", 3))}» (шаги ТО в форме ввода тоже только у него). `
          + `${key(repl.id) ? `Работы перестанут считаться как ${key(repl.id)}` : "Тип работ в отчётах изменится"}${toId && key(toId) ? ` и будут считаться как ${key(toId)}` : " и попадут в «плановые/прочие»"}.</div>`;
      }
    }
    html = `<b>Будет изменено ${fmtN(I.work)} работ</b> (${esc(st === "*" ? "все рудники" : st)}, ${esc(per)}${I.from ? `; работы с ${ruDate(I.from)} по ${ruDate(I.to)}` : ""}): «${esc(name(repl.kind, repl.id))}» → «${esc(toN)}»${replIsNew() ? " (новое значение, новый ключ)" : ""}.
      <div class="uses" style="margin-top:4px">Также: наряды формы ввода — ${fmtN(I.wo_day)}, детали нарядов — ${fmtN(I["13wza_details"])}, персонал по нарядам — ${fmtN(I["13wza_details_staff"])}.</div>
      <div class="warn" style="margin-top:6px">Изменятся отчёты за эти месяцы: ${esc(REPORTS[repl.kind])}.</div>${typeWarn}
      <div style="margin-top:6px">${esc(ruleNote)}</div>
      <div style="margin-top:6px">«${esc(name(repl.kind, repl.id))}» останется в справочнике. Замену можно откатить в «Журнале замен».</div>`
      + (["types", "subs", "fails"].includes(repl.kind) ? `<div class="uses" style="margin-top:6px">Чтобы «${esc(toN)}» можно было выбрать в форме ввода, строки шаблонов моделей ${esc(st === "*" ? "всех рудников" : "этого рудника")} со старым значением будут скопированы с новым (модель общая для рудников — новое значение увидят и на других рудниках с этой моделью).</div>` : "")
      + (["types", "reasons", "damages"].includes(repl.kind) ? `<div class="uses" style="margin-top:4px">Правила причин (тип / инициатор / причина) старого значения будут скопированы для нового.</div>` : "");
  }
  $("#replPreview").innerHTML = html;
  $("#replOk").disabled = !ok || !$("#replAgree").checked;
}
async function applyRepl() {
  const kind = repl.kind, from = repl.id, st = $("#replSite").value;
  $("#replOk").disabled = true;
  const status = (t, k) => { const el = $("#replStatus"); el.textContent = t; el.className = "dict-status login-message " + (k || "success"); el.hidden = false; };
  try {
    let to = Number($("#replTo").value);
    if (replIsNew()) { status("Добавляю новое значение…"); to = await rpc("dict_add", { p_kind: kind, p_name: $("#replNew").value.trim() }); }
    status("Заменяю…");
    const r = await rpc("dict_replace", { p_kind: kind, p_from: from, p_to: to, p_site: st, p_d1: $("#replD1").value || null, p_d2: $("#replD2").value || null, p_rules: $("#replRules").checked });
    // Замена сохранена — дальше только пересчёт сводок; его сбой не значит «не заменено».
    const warn = await refreshSummaries((t) => status(`Заменено ${fmtN(r.work)} работ. ${t}`));
    closeRepl();
    dictStatus(`Готово: заменено ${fmtN(r.work)} работ, нарядов формы ${fmtN(r.wo_day)}, деталей ${fmtN(r["13wza_details"])}, персонала ${fmtN(r.staff)}${r.rules_sites ? `, правил площадок ${r.rules_sites}` : ""}.${warn || " Сводки пересчитаны (персонал — в течение минуты)."} Откатить можно в «Журнале замен».`, warn ? "error" : "success");
    await loadReplLog();
    await reloadAfterDict();
  } catch (err) {
    status("Не заменено: " + err.message + (replIsNew() ? " (новое значение, если успело добавиться, осталось в справочнике)" : ""), "error");
    $("#replOk").disabled = false;
  }
}
function renderReplLog() {
  $("#tblRepl tbody").innerHTML = REPL_LOG.length
    ? REPL_LOG.map((r) => {
      const c = r.counts || {};
      const per = r.d1 || r.d2 ? `${r.d1 ? ruDate(r.d1) : "…"} — ${r.d2 ? ruDate(r.d2) : "…"}` : "всё время";
      return `<tr data-rid="${r.id}"${r.undone_at ? ' style="opacity:.55"' : ""}><td>${esc(new Date(r.at).toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" }))}</td>
        <td>${esc(KIND[r.kind])}: «${esc(r.from)}» → «${esc(r.to)}»</td><td>${esc(r.site === "*" ? "все" : r.site)}</td><td>${esc(per)}</td>
        <td>${fmtN(c["работы"])} работ</td>
        <td>${r.undone_at ? `откачено ${esc(new Date(r.undone_at).toLocaleDateString("ru-RU"))}` : '<button class="btn-secondary btn-small" data-undo>Откатить</button>'}</td></tr>`;
    }).join("")
    : '<tr><td colspan="6" class="uses">Замен ещё не было.</td></tr>';
}
async function undoRepl(id) {
  const r = REPL_LOG.find((x) => x.id === id);
  if (!confirm(`Откатить замену «${r.from}» → «${r.to}»?\n\nВернутся ровно те ${fmtN(r.counts?.["работы"])} работ, что были изменены (если их с тех пор не меняли). После этого будут пересчитаны сводки.`)) return;
  try {
    dictStatus("Откатываю…");
    const u = await rpc("dict_replace_undo", { p_log: id });
    const warn = await refreshSummaries();
    dictStatus(`Откачено: работ ${fmtN(u.work)} из ${fmtN(u.work_expected)}, нарядов формы ${fmtN(u.wo_day)}, деталей ${fmtN(u["13wza_details"])}, персонала ${fmtN(u.staff)}.`
      + (u.work < u.work_expected ? " Часть работ с тех пор меняли — их не трогали." : "") + (u.rules_skipped ? ` Правила ${u.rules_skipped} площадок с тех пор меняли — их не возвращали.` : "") + (warn || " Сводки пересчитаны (персонал — в течение минуты)."), warn ? "error" : "success");
    await loadReplLog();
    await reloadAfterDict();
  } catch (err) { dictStatus("Ошибка: " + err.message, "error"); }
}
$("#replClose").addEventListener("click", closeRepl);
$("#replCancel").addEventListener("click", closeRepl);
$("#replModal").addEventListener("change", (e) => (e.target.id === "replAgree" ? renderReplPreview() : replPreview()));
$("#replModal").addEventListener("input", (e) => { if (e.target.id === "replNew") renderReplPreview(); });
$("#replOk").addEventListener("click", applyRepl);
$("#tblRepl").addEventListener("click", (e) => { const b = e.target.closest("[data-undo]"); if (b) undoRepl(Number(b.closest("tr").dataset.rid)); });

// ---------- 2. Отказы подсистем (общее для всех площадок) ----------
// Список отказов подсистемы = отказы в шаблонах моделей, где эта подсистема есть (аварийные и плановые работы).
// Сохранение приводит шаблоны всех таких моделей к отмеченному списку (dict_sub_fails_save), откат — по журналу.
let SF = { subs: {}, log: [], types: [] };
let sfSub = null, sfSel = null; // выбранная подсистема и отмеченные отказы (ещё не сохранённые)
// Матрица «отказ × тип машины»: столбцы — типы, строки — отмеченные отказы, ячейка — отказ доступен моделям этого типа.
let sfCols = [], sfMx = new Map(), sfMxDirty = false;
const sfOf = (sub) => SF.subs?.[sub] || { models: 0, fails: {}, tmodels: {}, tfails: {}, rules: {} };
const sfSaved = () => new Set(Object.keys(sfOf(sfSub).fails).map(Number));
const mtName = (id) => (SF.types || []).find((t) => t.id === Number(id))?.name || `#${id}`;
function sfStatus(text, kind) {
  const el = $("#sfStatus");
  el.textContent = text || "";
  el.className = "dict-status login-message " + (kind || "success");
  el.hidden = !text;
}
// Начальная отметка строки: сохранённое правило по типам; без правила — типы, у моделей которых отказ уже есть;
// новый (ещё не сохранённый) отказ — все показанные типы.
function sfInitRow(f) {
  const info = sfOf(sfSub), rule = info.rules?.[f];
  if (rule) return new Set(rule.map(Number));
  if (!sfSaved().has(f)) return new Set(sfCols);
  return new Set(sfCols.filter((t) => (info.tfails?.[f]?.[t] || 0) > 0));
}
function sfInitMatrix() {
  const info = sfOf(sfSub);
  const ids = new Set(Object.keys(info.tmodels || {}).map(Number).filter((t) => t));
  for (const r of Object.values(info.rules || {})) for (const t of r) ids.add(Number(t));
  const order = (SF.types || []).map((t) => t.id);
  sfCols = [...ids].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  sfMx = new Map([...sfSel].map((f) => [f, sfInitRow(f)]));
  sfMxDirty = false;
}
// Для сохранения: {отказ: [типы]}; отказ, отмеченный во всех столбцах, не передаётся («для всех типов»).
function sfTypesPayload() {
  const out = {};
  if (!sfCols.length) return out;
  for (const f of sfSel) {
    const set = sfMx.get(f) || new Set();
    const on = sfCols.filter((t) => set.has(t));
    if (on.length < sfCols.length) out[f] = on;
  }
  return out;
}
function renderSfMatrix() {
  const info = sfOf(sfSub), tm = info.tmodels || {};
  const fails = [...sfSel].sort((a, b) => name("fails", a).localeCompare(name("fails", b), "ru"));
  $("#sfMxWrap").hidden = sfSub == null || !fails.length || !(SF.types || []).length;
  const free = (SF.types || []).filter((t) => !sfCols.includes(t.id));
  $("#sfAddType").innerHTML = '<option value="">+ тип</option>' + free.map((t) => `<option value="${t.id}">${esc(t.name)} — моделей ${fmtN(t.models)}</option>`).join("");
  $("#sfAddType").hidden = !free.length;
  // Заголовок столбца: флажок «все по столбцу» — отмечен, если тип стоит у всех отказов, снят — ни у одного, иначе «частично».
  const colState = (t) => { const n = fails.filter((f) => sfMx.get(f)?.has(t)).length; return n === 0 ? "none" : n === fails.length ? "all" : "some"; };
  const head = `<tr><th>Отказ</th>${sfCols.map((t) => `<th${tm[t] ? "" : ' class="sf-added"'}>${esc(mtName(t))}<small>${tm[t] ? `моделей ${fmtN(tm[t])}` : "подсистемы нет"}</small><input type="checkbox" class="sf-col-all" data-mxcol="${t}" data-st="${colState(t)}"${colState(t) === "all" ? " checked" : ""} title="Отметить или снять этот тип у всех отказов" /></th>`).join("")}</tr>`;
  const body = fails.map((f) => {
    const set = sfMx.get(f) || new Set();
    return `<tr><td>${esc(name("fails", f))}${sfCols.length ? `<span class="sf-row-all" data-mxall="${f}" title="Отметить или снять все типы">все</span>` : ""}</td>${sfCols.map((t) =>
      `<td${tm[t] ? "" : ' class="sf-added"'}><input type="checkbox" data-mxf="${f}" data-mxt="${t}"${set.has(t) ? " checked" : ""} /></td>`).join("")}</tr>`;
  }).join("");
  $("#sfMx").innerHTML = `<thead>${head}</thead><tbody>${body}</tbody>`;
  for (const cb of $("#sfMx").querySelectorAll('input[data-st="some"]')) cb.indeterminate = true;
  const noType = tm[0] || 0;
  $("#sfMxNote").textContent = (sfCols.length ? "" : "У моделей этой подсистемы типы машин не назначены. ")
    + `Модели без типа (${fmtN(noType)}) получают все отмеченные отказы. Тип машине назначается в форме «Оборудование». `
    + "Модели отмеченного типа получат эту подсистему, даже если её у них не было, — лишнего не отмечайте.";
}
function renderSf() {
  if (!DICT) return;
  const subs = DICT.subs.filter((s) => sfOf(s.id).models);
  if (!subs.some((s) => s.id === sfSub)) { sfSub = subs[0]?.id ?? null; sfSel = null; }
  if (sfSel == null) { sfSel = sfSaved(); sfInitMatrix(); }
  for (const f of sfSel) if (!sfMx.has(f)) sfMx.set(f, sfInitRow(f));
  for (const f of [...sfMx.keys()]) if (!sfSel.has(f)) sfMx.delete(f);
  const info = sfOf(sfSub), saved = sfSaved();
  $("#sfSub").innerHTML = subs.map((s) => `<option value="${s.id}"${s.id === sfSub ? " selected" : ""}>${esc(s.name)} — отказов: ${fmtN(Object.keys(sfOf(s.id).fails).length)}</option>`).join("");
  $("#sfInfo").textContent = sfSub == null ? "Подсистем в шаблонах моделей нет" : `есть в шаблонах ${fmtN(info.models)} моделей; отмечено ${fmtN(sfSel.size)}`;
  const q = $("#sfFilter").value.trim().toLowerCase(), only = $("#sfOnlyOn").checked;
  const rows = DICT.fails.filter((f) => (!q || f.name.toLowerCase().includes(q)) && (!only || sfSel.has(f.id)))
    .sort((a, b) => sfSel.has(b.id) - sfSel.has(a.id) || a.name.localeCompare(b.name, "ru"));
  $("#sfList").innerHTML = rows.map((f) => {
    const n = info.fails[f.id] || 0;
    const part = n && n < info.models ? ` <span class="sf-part">у ${fmtN(n)} из ${fmtN(info.models)} моделей</span>` : "";
    const mark = sfSel.has(f.id) !== saved.has(f.id) ? ` <span class="sf-part">${sfSel.has(f.id) ? "+ добавится" : "− уберётся"}</span>` : "";
    return `<label><input type="checkbox" data-sf="${f.id}"${sfSel.has(f.id) ? " checked" : ""} /> ${esc(f.name)}${part}${mark}</label>`;
  }).join("") || '<span class="uses">Ничего не найдено.</span>';
  renderSfMatrix();
  const types = sfTypesPayload();
  const changed = sfSel.size !== saved.size || [...saved].some((f) => !sfSel.has(f)) || sfMxDirty;
  // «Выровнять»: отказ без ограничения по типам есть не у всех моделей подсистемы.
  const partial = [...sfSel].some((f) => !(f in types) && (info.fails[f] || 0) < info.models);
  $("#sfSave").disabled = sfSub == null || !sfSel.size || !(changed || partial);
  $("#sfSave").textContent = changed ? "Сохранить список" : "Выровнять по всем моделям";
  const typesTxt = (t) => Object.entries(t || {}).map(([f, ts]) => `«${name("fails", f)}»: ${ts.length ? ts.map(mtName).join(", ") : "только без типа"}`).join("; ");
  $("#tblSf tbody").innerHTML = (SF.log || []).length
    ? SF.log.map((l) => `<tr data-sfl="${l.id}"${l.undone_at ? ' style="opacity:.55"' : ""}><td>${esc(new Date(l.at).toLocaleString("ru-RU", { dateStyle: "short", timeStyle: "short" }))}</td>
        <td>${esc(name("subs", l.sub))}: отказов ${fmtN(l.fails.length)}${l.types && Object.keys(l.types).length ? `<div class="uses">по типам машин — ${esc(typesTxt(l.types))}</div>` : ""}</td><td>+${fmtN(l.added)} / −${fmtN(l.removed)}</td>
        <td>${l.undone_at ? `откачено ${esc(new Date(l.undone_at).toLocaleDateString("ru-RU"))}` : '<button class="btn-secondary btn-small" data-sfundo>Откатить</button>'}</td></tr>`).join("")
    : '<tr><td colspan="4" class="uses">Списки ещё не сохраняли.</td></tr>';
}
async function sfSave() {
  const info = sfOf(sfSub), saved = sfSaved(), tm = info.tmodels || {};
  const nm = (ids) => ids.slice(0, 8).map((f) => "«" + name("fails", f) + "»").join(", ") + (ids.length > 8 ? ` и ещё ${ids.length - 8}` : "");
  const types = sfTypesPayload();
  const add = [...sfSel].filter((f) => !saved.has(f)), del = [...saved].filter((f) => !sfSel.has(f));
  const partial = [...sfSel].filter((f) => saved.has(f) && !(f in types) && (info.fails[f] || 0) < info.models);
  const restricted = Object.keys(types).map(Number);
  // Типы, у моделей которых подсистемы ещё нет, но они отмечены хотя бы у одного отказа — им подсистема добавится.
  const newTypes = sfCols.filter((t) => !tm[t] && [...sfSel].some((f) => !(f in types) || types[f].includes(t)));
  const lines = [add.length ? `Добавятся: ${nm(add)}.` : "", del.length ? `Уберутся: ${nm(del)}.` : "",
    partial.length ? `Есть только у части моделей и появятся у всех: ${nm(partial)}.` : "",
    restricted.length ? `Только для части типов машин: ${nm(restricted)}.` : "",
    newTypes.length ? `Подсистема появится у моделей типов: ${newTypes.map((t) => `${mtName(t)} (${fmtN((SF.types || []).find((x) => x.id === t)?.models || 0)})`).join(", ")}.` : ""].filter(Boolean);
  if (!confirm(`Подсистема «${name("subs", sfSub)}» — ${fmtN(info.models)} моделей (аварийные и плановые работы).\n\n${lines.join("\n")}\n\nСписок отказов в форме ввода изменится у всех машин этих моделей. Записанные работы не меняются. Сохранение можно откатить в журнале ниже.`)) return;
  $("#sfSave").disabled = true;
  try {
    const r = await rpc("dict_sub_fails_save", { p_sub: sfSub, p_fails: [...sfSel], p_types: types });
    sfSel = null;
    await reloadAfterDict();
    sfStatus(`Сохранено: моделей ${fmtN(r.models)}, добавлено строк шаблонов ${fmtN(r.added)}, убрано ${fmtN(r.removed)}.`);
  } catch (err) { sfStatus("Не сохранено: " + err.message, "error"); renderSf(); }
}
$("#sfMx").addEventListener("change", (e) => {
  const col = Number(e.target.dataset.mxcol);
  if (col) {
    // «Все по столбцу»: поставить или снять этот тип у всех отмеченных отказов.
    for (const f of sfSel) { const set = sfMx.get(f) || new Set(); if (e.target.checked) set.add(col); else set.delete(col); sfMx.set(f, set); }
    sfMxDirty = true; renderSf(); return;
  }
  const f = Number(e.target.dataset.mxf), t = Number(e.target.dataset.mxt);
  if (!f || !t) return;
  const set = sfMx.get(f) || new Set();
  if (e.target.checked) set.add(t); else set.delete(t);
  sfMx.set(f, set); sfMxDirty = true; renderSf();
});
$("#sfMx").addEventListener("click", (e) => {
  const f = Number(e.target.closest("[data-mxall]")?.dataset.mxall);
  if (!f) return;
  const set = sfMx.get(f) || new Set();
  const all = sfCols.every((t) => set.has(t));
  sfMx.set(f, all ? new Set() : new Set(sfCols)); sfMxDirty = true; renderSf();
});
// Новый столбец — тип, у моделей которого подсистемы нет: пустой, отметьте отказы, нужные этому типу.
$("#sfAddType").addEventListener("change", (e) => {
  const t = Number(e.target.value);
  if (!t || sfCols.includes(t)) return;
  const order = (SF.types || []).map((x) => x.id);
  sfCols = [...sfCols, t].sort((a, b) => order.indexOf(a) - order.indexOf(b));
  sfMxDirty = true; renderSf();
});
$("#sfSub").addEventListener("change", (e) => { sfSub = Number(e.target.value); sfSel = null; sfStatus(""); renderSf(); });
$("#sfFilter").addEventListener("input", () => renderSf());
$("#sfOnlyOn").addEventListener("change", () => renderSf());
$("#sfList").addEventListener("change", (e) => {
  const id = Number(e.target.dataset.sf);
  if (!id) return;
  if (e.target.checked) sfSel.add(id); else sfSel.delete(id);
  renderSf();
});
$("#sfReset").addEventListener("click", () => { sfSel = null; sfStatus(""); renderSf(); });
$("#sfSave").addEventListener("click", sfSave);
$("#sfAdd").addEventListener("click", async () => {
  const nv = $("#sfNew").value.trim();
  if (!nv) { $("#sfNew").focus(); return; }
  try {
    const id = await rpc("dict_add", { p_kind: "fails", p_name: nv });
    $("#sfNew").value = "";
    const keep = sfSel;
    await reloadAfterDict();
    sfSel = keep; sfSel.add(Number(id)); renderSf();
    sfStatus(`Отказ «${nv}» добавлен в справочник и отмечен — нажмите «Сохранить список».`);
  } catch (err) { sfStatus("Ошибка: " + err.message, "error"); }
});
$("#tblSf").addEventListener("click", async (e) => {
  if (!e.target.closest("[data-sfundo]")) return;
  const l = SF.log.find((x) => x.id === Number(e.target.closest("tr").dataset.sfl));
  if (!confirm(`Откатить сохранение списка «${name("subs", l.sub)}»?\n\nУберутся добавленные строки шаблонов (${fmtN(l.added)}) и вернутся убранные (${fmtN(l.removed)}).`)) return;
  try {
    const u = await rpc("dict_sub_fails_undo", { p_log: l.id });
    sfSel = null;
    await reloadAfterDict();
    sfStatus(`Откачено: убрано строк шаблонов ${fmtN(u.removed)}, возвращено ${fmtN(u.restored)}.`);
  } catch (err) { sfStatus("Ошибка: " + err.message, "error"); }
});

// ---------- проверка текста ----------
function runTest() {
  const m = $("#testSite").value, time = $("#testTime").value;
  // Несохранённые правки площадки тоже проверяются — как они будут работать после «Сохранить правила».
  const draft = edit[m] && dirtySites.has(m);
  const rules = draft ? toDB(edit[m]) : DB.sites[m] || DB.sites["*"] || EMPTY;
  const r = applyRules(rules, $("#testText").value, time);
  // Инициатора нет в таблице, но правила причин допускают ровно одного — форма поставит его сама.
  if (!r.dmg && r.type && r.reason) {
    const ds = [...new Set(DICT.rules.filter((x) => x[0] === r.type && x[2] === r.reason).map((x) => x[1]))];
    if (ds.length === 1) { r.dmg = ds[0]; r.dmgWhy = "единственный по правилам причин"; }
    else r.dmgWhy = ds.length ? "по правилам причин возможны несколько — выберет пользователь" : "сочетание тип + причина не разрешено";
  }
  const subTxt = r.subs.length ? [...new Set(r.subs.map((x) => name("subs", x.sub) + (x.fail ? " / " + name("fails", x.fail) : "")))].join("; ") : "—";
  const out = [
    ["Правила", (draft || DB.sites[m] ? `свои правила рудника ${m}` : "общие правила") + (draft ? " (с несохранёнными правками)" : ""), ""],
    ["Тип работ", r.type ? name("types", r.type) : "—", r.typeWhy || "вне периодов ЕО и слов типа нет — выберет ИИ по смыслу или пользователь"],
    ["Подсистема", subTxt, r.subs.length ? r.subs.map((x) => "«" + x.words.join("», «") + "»").join("; ") + (r.subs.length > 1 ? " — несколько вариантов, выберет ИИ по шаблону машины" : "") : "слов из словаря нет — выберет ИИ"],
    ["Причина", r.reason ? name("reasons", r.reason) : "—", r.reasonWhy || "слов нет — выберет ИИ или пользователь"],
    ["Инициатор", r.dmg ? name("damages", r.dmg) : "—", r.dmgWhy || (r.reason && r.type ? "в таблице нет — по правилам причин или выберет пользователь" : "нужны тип и причина")],
    ["Модель", r.models.length ? r.models.map((x) => x.model).join(", ") : "—", r.models.length ? r.models.map((x) => "«" + x.words.join("», «") + "»").join("; ") : "слов модели нет — модель ищется по латинскому названию"],
  ];
  $("#testRes").innerHTML = out.map(([k, v, w]) => `<div class="r"><b>${esc(k)}</b><span>${esc(v)}${w ? ` <span class="why">· ${esc(w)}</span>` : ""}</span></div>`).join("");
}

// ---------- запуск ----------
let started = false;
async function init() {
  if (started) return;
  started = true;
  try {
    const access = await rpc("my_access");
    if (access?.role !== "admin") {
      $("#loadingIndicator").style.display = "none";
      showError("Эта страница доступна только администратору.");
      return;
    }
    await loadAll();
    $("#prMain").hidden = false;
    $("#saveBar").hidden = false;
    $("#saveBtn").addEventListener("click", saveAll);
    $("#resetBtn").addEventListener("click", resetAll);
    $("#importBtn").addEventListener("click", () => openXfer("import"));
    $("#exportBtn").addEventListener("click", () => openXfer("export"));
    $("#xferClose").addEventListener("click", closeXfer);
    $("#xferCancel").addEventListener("click", closeXfer);
    $("#xferModal").addEventListener("change", xferPreview);
    $("#xferOk").addEventListener("click", applyXfer);
    $("#testBtn").addEventListener("click", runTest);
    render();
  } catch (err) {
    showError("Ошибка загрузки: " + err.message);
  } finally {
    $("#loadingIndicator").style.display = "none";
  }
}
setupAuth(supabase, "parse-rules.html", () => init());
