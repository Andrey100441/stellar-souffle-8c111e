import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { setupAuth } from "./auth.js?v=36";
import { NAV_GROUPS } from "./nav.js?v=26";
import { guardUnsaved, snapshot } from "./unsaved.js?v=1";

const SUPABASE_URL = "https://xdegfnbinprrfoxpcvpf.supabase.co";
const SUPABASE_KEY = "sb_publishable_8k0lb6crF1cjE0aziGtoZA_ojJh4IID";
const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

// Управление пользователями и их областями видимости (только администратор).
// Список и изменение ролей/областей — функции БД admin_list_users / admin_set_user_access;
// приглашение (письмо), повторное приглашение и удаление — Edge Function admin-users (нужен сервисный
// ключ, который не должен попадать в браузер). Все проверки прав делает база.

const ROLE_LABEL = { viewer: "Просмотр", repair_entry: "Ввод ремонтов", editor: "Редактор", admin: "Администратор" };

let dashboardStarted = false;
let myUserId = null;
let minesByObject = new Map(); // объект -> [шахты]

const $ = (sel) => document.querySelector(sel);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);

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

function mineOptions(selected) {
  const sel = new Set(selected || []);
  return [...minesByObject.entries()]
    .map(([obj, mines]) => `<optgroup label="${esc(obj)}">${mines.map((m) => `<option value="${esc(m)}"${sel.has(m) ? " selected" : ""}>${esc(m)}</option>`).join("")}</optgroup>`)
    .join("");
}
const selectedValues = (el) => [...el.selectedOptions].map((o) => o.value);

async function loadScopeOptions() {
  // Администратор видит весь парк — список объектов/шахт берём из справочника техники.
  const { data, error } = await supabase.from("v_equipment_list").select("object,mine");
  if (error) throw error;
  const map = new Map();
  for (const r of data) {
    const obj = r.object || "—";
    if (!map.has(obj)) map.set(obj, new Set());
    if (r.mine) map.get(obj).add(r.mine);
  }
  minesByObject = new Map([...map.entries()].sort((a, b) => a[0].localeCompare(b[0], "ru")).map(([o, s]) => [o, [...s].sort((a, b) => a.localeCompare(b, "ru"))]));
  $("#addMines").innerHTML = mineOptions([]);
  $("#addStart").innerHTML = startOptions("");
  $("#addPages").innerHTML = pageOptions([]);
}

// Приглашён, но ещё не принял: письмо отправлено, почта не подтверждена.
const pending = (u) => !!u.invited_at && !u.email_confirmed_at;
const fmtTime = (t) => new Date(t).toLocaleString("ru-RU");
function statusCell(u) {
  if (pending(u)) return `<span class="muted">приглашён ${fmtTime(u.invited_at)}, ещё не принял</span>`;
  return u.last_sign_in_at ? fmtTime(u.last_sign_in_at) : '<span class="muted">не входил</span>';
}
const acceptUrl = () => new URL("accept.html", window.location.href).href.split(/[?#]/)[0];

// «Доступ»: страницы меню, которые видит пользователь (пусто = все страницы его уровня доступа).
function pageOptions(selected) {
  const sel = new Set(selected || []);
  return NAV_GROUPS.map(
    (g) => `<optgroup label="${esc(g.label)}">${g.items.map((i) => `<option value="${esc(i.href)}"${sel.has(i.href) ? " selected" : ""}>${esc(i.label)}</option>`).join("")}</optgroup>`
  ).join("");
}
// В «Стартовой странице» доступны только страницы из «Доступа» (если он задан).
function syncStartOptions(pagesSel, startSel) {
  const chosen = new Set(chosenPages(pagesSel));
  for (const o of startSel.options) o.disabled = !!o.value && chosen.size > 0 && !chosen.has(o.value);
  if (startSel.selectedOptions[0]?.disabled) startSel.value = "";
}

// Стартовая страница: пусто = по уровню доступа (см. start-page.js); список — пункты меню.
function startOptions(selected) {
  const groups = NAV_GROUPS.map(
    (g) => `<optgroup label="${esc(g.label)}">${g.items.map((i) => `<option value="${esc(i.href)}"${selected === i.href ? " selected" : ""}>${esc(i.label)}</option>`).join("")}</optgroup>`
  );
  return `<option value=""${selected ? "" : " selected"}>По уровню доступа</option>` + groups.join("");
}

async function loadUsers() {
  const { data, error } = await supabase.rpc("admin_list_users");
  if (error) throw error;
  $("#usersBody").innerHTML = data
    .map((u) => {
      const me = u.user_id === myUserId;
      return `
    <tr data-id="${u.user_id}">
      <td>${esc(u.email)}${me ? ' <span class="muted">(вы)</span>' : ""}</td>
      <td><select data-f="role">${Object.entries(ROLE_LABEL).map(([k, l]) => `<option value="${k}"${u.role === k ? " selected" : ""}>${l}</option>`).join("")}</select></td>
      <td><label><input type="checkbox" data-f="all"${u.all_equipment ? " checked" : ""} /> весь парк</label><div class="admin-scope-note" hidden>администратор видит весь парк</div></td>
      <td><select multiple data-f="mines">${mineOptions(u.mines)}</select></td>
      <td><select multiple data-f="pages">${pageOptions(u.pages)}</select><div class="admin-scope-note admin-pages-note" hidden>администратору доступны все страницы</div></td>
      <td><select data-f="start">${startOptions(u.start_page)}</select></td>
      <td>${statusCell(u)}</td>
      <td class="row-actions">
        <button type="button" class="btn-secondary btn-small" data-act="save">Сохранить</button>
        ${pending(u) ? '<button type="button" class="btn-secondary btn-small" data-act="resend">Отправить ещё раз</button>' : ""}
        ${me ? "" : `<button type="button" class="btn-secondary btn-small" data-act="delete">${pending(u) ? "Отозвать" : "Удалить"}</button>`}
      </td>
    </tr>`;
    })
    .join("");
  $("#usersBody").querySelectorAll("tr").forEach(lockRowScope);
  $("#usersBody").querySelectorAll("tr").forEach((tr) => (tr.dataset.orig = snapshot(tr))); // для «есть несохранённые изменения»
}

// Администратор всегда видит весь парк (так решает база) и все страницы, поэтому область и доступ
// у него не выбираются: поля «Весь парк», «Объекты», «Доступ» серые, рядом пояснение.
function lockScope(isAdmin, fields, note) {
  fields.forEach((el) => (el.disabled = isAdmin));
  if (note) note.hidden = !isAdmin;
}
function lockRowScope(tr) {
  const isAdmin = tr.querySelector('[data-f="role"]').value === "admin";
  lockScope(isAdmin, ["all", "mines"].map((f) => tr.querySelector(`[data-f="${f}"]`)), tr.querySelector(".admin-scope-note"));
  lockScope(isAdmin, [tr.querySelector('[data-f="pages"]')], tr.querySelector(".admin-pages-note"));
  syncStartOptions(tr.querySelector('[data-f="pages"]'), tr.querySelector('[data-f="start"]'));
}
function lockAddScope() {
  const isAdmin = $("#addRole").value === "admin";
  lockScope(isAdmin, [$("#addAll"), $("#addMines")], $("#addScopeNote"));
  lockScope(isAdmin, [$("#addPages")], $("#addPagesNote"));
  syncStartOptions($("#addPages"), $("#addStart"));
}
// Выбранные страницы «Доступа»; у администратора — пусто (все страницы).
const chosenPages = (sel) => (sel.disabled ? [] : selectedValues(sel));

async function saveRow(tr, btn) {
  clearError();
  btn.disabled = true;
  const { error } = await supabase.rpc("admin_set_user_access", {
    p_user_id: tr.dataset.id,
    p_role: tr.querySelector('[data-f="role"]').value,
    p_all_equipment: tr.querySelector('[data-f="all"]').checked,
    p_objects: [], // столбец «Объекты» (целиком) убран — область задаётся шахтами
    p_mines: selectedValues(tr.querySelector('[data-f="mines"]')),
  });
  const pagesErr = error
    ? null
    : (await supabase.rpc("admin_set_user_pages", { p_user_id: tr.dataset.id, p_pages: chosenPages(tr.querySelector('[data-f="pages"]')) })).error;
  const startErr = error || pagesErr
    ? null
    : (await supabase.rpc("admin_set_user_start_page", { p_user_id: tr.dataset.id, p_page: tr.querySelector('[data-f="start"]').value })).error;
  btn.disabled = false;
  if (error || pagesErr || startErr) {
    showError("Ошибка сохранения: " + (error || pagesErr || startErr).message);
    return;
  }
  tr.dataset.orig = snapshot(tr); // сохранено — строка больше не «изменена»
  btn.textContent = "Сохранено ✓";
  setTimeout(() => (btn.textContent = "Сохранить"), 1500);
}
// Уход со страницы с изменённым, но не сохранённым доступом пользователя — предложить сохранить.
const changedUsers = () => [...document.querySelectorAll("#usersBody tr[data-id]")].filter((tr) => tr.dataset.orig != null && snapshot(tr) !== tr.dataset.orig);
guardUnsaved({
  isDirty: () => changedUsers().length > 0,
  describe: () => changedUsers().map((tr) => `доступ: ${tr.cells[0].textContent.replace("(вы)", "").trim()}`),
  save: async () => { for (const tr of changedUsers()) await saveRow(tr, tr.querySelector('[data-act="save"]')); },
});

async function callAdminUsers(body) {
  const { data, error } = await supabase.functions.invoke("admin-users", { body });
  if (error) {
    // Текст ошибки из функции (400/403) — в теле ответа.
    let msg = error.message;
    try {
      const j = await error.context.json();
      if (j?.error) msg = j.error;
    } catch (_) {}
    throw new Error(msg);
  }
  return data;
}

async function resendInvite(tr, btn) {
  clearError();
  btn.disabled = true;
  try {
    await callAdminUsers({ action: "resend", user_id: tr.dataset.id, redirect_to: acceptUrl() });
    btn.textContent = "Отправлено ✓";
    await loadUsers();
  } catch (e) {
    showError("Ошибка отправки приглашения: " + e.message);
    btn.disabled = false;
  }
}

async function deleteRow(tr) {
  const email = tr.querySelector("td").textContent.trim();
  const isInvite = tr.querySelector('[data-act="resend"]');
  const question = isInvite
    ? `Отозвать приглашение для ${email}? Ссылка из письма перестанет работать.`
    : `Удалить пользователя ${email}? Он больше не сможет войти.`;
  if (!confirm(question)) return;
  clearError();
  try {
    await callAdminUsers({ action: "delete", user_id: tr.dataset.id });
    await loadUsers();
  } catch (e) {
    showError("Ошибка удаления: " + e.message);
  }
}

async function addUser(e) {
  e.preventDefault();
  clearError();
  const btn = $("#addBtn");
  btn.disabled = true;
  try {
    const created = await callAdminUsers({
      action: "create",
      redirect_to: acceptUrl(),
      email: $("#addEmail").value.trim(),
      role: $("#addRole").value,
      all_equipment: $("#addAll").checked,
      objects: [],
      mines: selectedValues($("#addMines")),
    });
    const addPages = chosenPages($("#addPages"));
    if (addPages.length && created?.user_id) {
      const { error } = await supabase.rpc("admin_set_user_pages", { p_user_id: created.user_id, p_pages: addPages });
      if (error) showError("Приглашение отправлено, но доступ к страницам не сохранён: " + error.message);
    }
    if ($("#addStart").value && created?.user_id) {
      const { error } = await supabase.rpc("admin_set_user_start_page", { p_user_id: created.user_id, p_page: $("#addStart").value });
      if (error) showError("Приглашение отправлено, но стартовая страница не сохранена: " + error.message);
    }
    const sentTo = $("#addEmail").value.trim();
    $("#addForm").reset();
    lockAddScope();
    await loadUsers();
    btn.textContent = "Приглашение отправлено ✓";
    btn.title = sentTo;
    setTimeout(() => (btn.textContent = "Пригласить"), 2500);
  } catch (err) {
    showError("Ошибка добавления: " + err.message);
  } finally {
    btn.disabled = false;
  }
}

async function initDashboard(session) {
  if (dashboardStarted) return;
  dashboardStarted = true;
  myUserId = session.user.id;
  setLoading(true);
  try {
    const { data: access, error } = await supabase.rpc("my_access");
    if (error) throw error;
    if (access?.role !== "admin") {
      $("main").innerHTML = '<p class="hint-text">Эта страница доступна только администратору.</p>';
      return;
    }
    // В списках объектов и доступа выбор переключается обычным кликом (без Ctrl): клик по выбранному снимает выделение.
    document.addEventListener("mousedown", (e) => {
      const opt = e.target.closest("select[multiple] option");
      if (!opt) return;
      e.preventDefault();
      const sel = opt.parentElement.closest("select");
      if (sel.disabled) return;
      const top = sel.scrollTop;
      opt.selected = !opt.selected;
      sel.focus();
      sel.scrollTop = top;
      sel.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await loadScopeOptions();
    await loadUsers();
    $("#addForm").addEventListener("submit", addUser);
    $("#addRole").addEventListener("change", lockAddScope);
    $("#usersBody").addEventListener("change", (e) => {
      if (e.target.matches('[data-f="role"]')) lockRowScope(e.target.closest("tr"));
      if (e.target.matches('[data-f="pages"]')) {
        const tr = e.target.closest("tr");
        syncStartOptions(e.target, tr.querySelector('[data-f="start"]'));
      }
    });
    $("#addPages").addEventListener("change", () => syncStartOptions($("#addPages"), $("#addStart")));
    lockAddScope();
    $("#usersBody").addEventListener("click", (e) => {
      const btn = e.target.closest("button[data-act]");
      if (!btn) return;
      const tr = btn.closest("tr");
      if (btn.dataset.act === "save") saveRow(tr, btn);
      else if (btn.dataset.act === "resend") resendInvite(tr, btn);
      else if (btn.dataset.act === "delete") deleteRow(tr);
    });
  } catch (e) {
    showError("Ошибка загрузки: " + e.message);
  } finally {
    setLoading(false);
  }
}

setupAuth(supabase, "users.html", (session) => initDashboard(session));
