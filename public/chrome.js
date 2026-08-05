/**
 * Toasts.
 *
 * This used to also build the nav, footer and atmosphere via mountChrome(). Those are now
 * server-rendered by BaseLayout (src/components/Nav.astro, Footer.astro) so they exist in
 * the first frame instead of popping in after this module loads; the auth-dependent part
 * moved to account.js. What is left is genuinely runtime-only UI.
 */
/* ------------------------------------------------------------------ toasts */

let toastHost = null;

/**
 * Transient confirmation that an action happened.
 *
 * Use for outcomes ("Saved", "Deleted"); keep inline .msg for validation detail that needs
 * to sit next to the field it's about.
 *
 * @param {string} title
 * @param {object} [opts]
 * @param {'ok'|'error'|'info'} [opts.kind='ok']
 * @param {string} [opts.note] second line with detail
 * @param {number} [opts.duration] ms before auto-dismiss; errors default to longer
 */
export function toast(title, opts = {}) {
  const { kind = "ok", note = null } = opts;
  const duration = opts.duration ?? (kind === "error" ? 6500 : 3600);

  if (!toastHost) {
    toastHost = document.createElement("div");
    toastHost.className = "toasts";
    toastHost.setAttribute("role", "status");
    toastHost.setAttribute("aria-live", "polite");
    document.body.appendChild(toastHost);
  }

  const el = document.createElement("div");
  el.className = `toast toast-${kind}`;

  const icon = document.createElement("span");
  icon.className = "toast-icon";
  icon.textContent = kind === "ok" ? "✓" : kind === "error" ? "!" : "i";

  const body = document.createElement("div");
  body.className = "toast-body";
  const titleEl = document.createElement("div");
  titleEl.className = "toast-title";
  titleEl.textContent = title;
  body.appendChild(titleEl);
  if (note) {
    const noteEl = document.createElement("div");
    noteEl.className = "toast-note";
    noteEl.textContent = note;
    body.appendChild(noteEl);
  }

  const close = document.createElement("button");
  close.className = "toast-close";
  close.setAttribute("aria-label", "Dismiss");
  close.textContent = "×";

  el.append(icon, body, close);
  toastHost.appendChild(el);

  let timer;
  const dismiss = () => {
    clearTimeout(timer);
    el.classList.add("out");
    el.addEventListener("animationend", () => el.remove(), { once: true });
  };
  close.addEventListener("click", dismiss);
  timer = setTimeout(dismiss, duration);

  return dismiss;
}
