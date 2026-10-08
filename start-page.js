// Стартовая страница и доступ к страницам пользователя: задаёт администратор
// («Пользователи» → «Стартовая страница», «Доступ»).
// Стартовая: пусто — по роли: «Ввод ремонтов» — форма ремонтов, остальные — «Состояние оборудования».
// Используется после нового входа (код с почты, приглашение, QR) и при открытии адреса сайта,
// чтобы новое устройство открывало нужную страницу, а не ту, что была открыта где-то ещё.
// Доступ: пусто — все страницы уровня доступа; иначе только выбранные (из тех, что разрешает уровень).
// Это меню и переходы; данные по-прежнему защищает база (уровень доступа и область).
import { NAV_GROUPS } from "./nav.js?v=26";

export const DEFAULT_START = "fleet-status.html";
export const SITE_INDEX = "index.html"; // адрес сайта без имени страницы
export const ENTRY_START = "repair-entry.html";
// Личные страницы учётной записи — открыты всем, в «Доступ» не входят.
const ALWAYS_OPEN = ["devices.html"];

const NAV_ITEMS = NAV_GROUPS.flatMap((g) => g.items);

// Разрешает ли уровень доступа страницу (без учёта списка «Доступ»).
function roleAllows(role, item) {
  if (role === "repair_entry") return item.href === ENTRY_START;
  if (item.adminOnly) return role === "admin";
  if (item.entryOnly) return role === "editor" || role === "admin";
  return true;
}

// Страницы меню, доступные пользователю, в порядке меню.
// «Доступ» не действует на администратора (ему открыты все страницы)
// и на «Ввод ремонтов» (всегда только форма).
export function allowedPages(access) {
  const role = access?.role || "viewer";
  const chosen = access?.pages?.length && role !== "repair_entry" && role !== "admin" ? new Set(access.pages) : null;
  return NAV_ITEMS.filter((i) => roleAllows(role, i) && (!chosen || chosen.has(i.href))).map((i) => i.href);
}

export function pageAllowed(access, href) {
  if (ALWAYS_OPEN.includes(href) || !NAV_ITEMS.some((i) => i.href === href)) return true;
  return allowedPages(access).includes(href);
}

export function startPageFor(access) {
  if (access?.role === "repair_entry") return ENTRY_START;
  const allowed = allowedPages(access);
  if (access?.start_page && allowed.includes(access.start_page)) return access.start_page;
  if (allowed.includes(DEFAULT_START)) return DEFAULT_START;
  return allowed[0] || ALWAYS_OPEN[0];
}

export async function resolveStartPage(supabase) {
  const { data } = await supabase.rpc("my_access");
  return startPageFor(data);
}
