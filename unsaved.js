// Несохранённые изменения на страницах «Настроек»: при уходе по ссылке (меню, крошки) — окно
// «Сохранить / Не сохранять / Отмена» в стиле приложения; при закрытии или перезагрузке вкладки —
// стандартное предупреждение браузера (свой текст браузер там не показывает).
//   isDirty()  — есть ли изменения относительно последнего загруженного или сохранённого состояния;
//   save()     — сохранить (async); после него isDirty() должен вернуть false, иначе окно покажется снова;
//   describe() — необязательно: список «что не сохранено» для окна.
export function guardUnsaved({ isDirty, save, describe }) {
  // После «Не сохранять» / «Сохранить» уход не должен снова спрашивать в beforeunload.
  let leaving = false;
  const dirty = () => !leaving && isDirty();
  window.addEventListener("beforeunload", (e) => {
    if (!dirty()) return;
    e.preventDefault();
    e.returnValue = "";
  });
  document.addEventListener("click", (e) => {
    if (e.defaultPrevented || e.button !== 0 || e.ctrlKey || e.metaKey || e.shiftKey || e.altKey) return;
    const a = e.target.closest("a[href]");
    if (!a || a.target === "_blank" || a.hasAttribute("download")) return;
    const href = a.getAttribute("href");
    if (!href || href.startsWith("#") || href.startsWith("javascript:")) return;
    const url = new URL(a.href, location.href);
    if (url.origin !== location.origin || (url.pathname === location.pathname && url.search === location.search)) return;
    if (!dirty()) return;
    e.preventDefault();
    ask(url.href);
  }, true);

  let box = null;
  function ask(href) {
    if (!box) {
      box = document.createElement("div");
      box.className = "modal-overlay";
      box.innerHTML = `<div class="modal-card modal-narrow" role="dialog" aria-modal="true">
        <div class="modal-header"><h2>Есть несохранённые изменения</h2></div>
        <div class="modal-body" style="padding:16px">
          <div data-u="text"></div>
          <div class="modal-form-actions" style="margin-top:14px;display:flex;justify-content:flex-end;gap:8px;flex-wrap:wrap">
            <button type="button" class="btn-secondary" data-u="cancel">Отмена</button>
            <button type="button" class="btn-secondary" data-u="discard">Не сохранять</button>
            <button type="button" class="btn-primary" data-u="save">Сохранить</button>
          </div>
        </div></div>`;
      document.body.appendChild(box);
    }
    const list = (describe && describe()) || [];
    box.querySelector('[data-u="text"]').innerHTML = "<p>Сохранить изменения перед уходом со страницы?</p>"
      + (list.length ? `<ul>${list.map((t) => `<li>${String(t).replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c])}</li>`).join("")}</ul>` : "");
    box.hidden = false;
    const btn = (k) => box.querySelector(`[data-u="${k}"]`);
    const close = () => { box.hidden = true; };
    const go = () => { close(); leaving = true; location.href = href; };
    btn("cancel").onclick = close;
    btn("discard").onclick = go;
    btn("save").onclick = async () => {
      btn("save").disabled = true;
      try { await save(); } catch (_) { /* ошибку показывает страница */ }
      btn("save").disabled = false;
      if (!dirty()) go();
      else { close(); ask(href); } // что-то не сохранилось — показать, что осталось
    };
  }
}

// Снимок полей формы или строки — для сравнения «изменилось ли» с загруженным состоянием.
export function snapshot(root) {
  return JSON.stringify([...root.querySelectorAll("input, select, textarea")].map((el) =>
    el.type === "checkbox" || el.type === "radio" ? el.checked : el.multiple ? [...el.selectedOptions].map((o) => o.value) : el.value));
}
