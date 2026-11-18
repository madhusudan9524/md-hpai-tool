/* Maryland HPAI map: small UI helpers shared by all modules (no map library). */
window.HPAI = window.HPAI || { modules: [] };
(function (H) {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const DAY = 864e5;
  const fmtDate = (t) => (t ? new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "");
  const fmtShort = (t) => (t ? new Date(t).toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "");
  const fmtTime = (t) => (t ? new Date(t).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : "");
  const daysAgo = (t) => Math.max(0, Math.round((Date.now() - t) / DAY));
  const ago = (t) => { const d = daysAgo(t); return d === 0 ? "today" : d === 1 ? "yesterday" : `${d} days ago`; };

  let tt;
  function toast(msg, ms) { const t = $("toast"); t.textContent = msg; t.hidden = false; clearTimeout(tt); tt = setTimeout(() => (t.hidden = true), ms || 3200); }

  // browser storage can be missing or throw (private mode); keep it optional
  const store = {
    get(k, d) { try { const v = localStorage.getItem("hpai." + k); return v == null ? d : JSON.parse(v); } catch (e) { return d; } },
    set(k, v) { try { localStorage.setItem("hpai." + k, JSON.stringify(v)); } catch (e) {} }
  };

  // one sheet (dialog) at a time
  let onClose = null;
  function sheet(title, html, closeCb) {
    $("sheetTitle").textContent = title; $("sheetBody").innerHTML = html; $("sheet").hidden = false; onClose = closeCb || null;
    const f = $("sheetBody").querySelector("input, select, textarea, button"); if (f) setTimeout(() => f.focus(), 50);
    return $("sheetBody");
  }
  function closeSheet() { $("sheet").hidden = true; $("sheetBody").innerHTML = ""; if (onClose) { const c = onClose; onClose = null; c(); } }
  document.addEventListener("DOMContentLoaded", () => {
    $("sheetClose").onclick = closeSheet;
    $("sheet").addEventListener("click", (e) => { if (e.target.id === "sheet") closeSheet(); });
    document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !$("sheet").hidden) closeSheet(); });
  });

  // shrink a photo before upload (long edge 1600 px, JPEG)
  function shrinkImage(file, max) {
    return new Promise((res, rej) => {
      const img = new Image(), url = URL.createObjectURL(file);
      img.onload = () => {
        const k = Math.min(1, (max || 1600) / Math.max(img.width, img.height)), c = document.createElement("canvas");
        c.width = Math.round(img.width * k); c.height = Math.round(img.height * k);
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height); URL.revokeObjectURL(url);
        c.toBlob((b) => (b ? res(b) : rej(new Error("Could not read photo"))), "image/jpeg", 0.85);
      };
      img.onerror = () => rej(new Error("Could not read photo")); img.src = url;
    });
  }

  function qrSvg(text) {
    if (!window.qrcode) return `<p class="hint">QR code unavailable offline. Permit: <b>${esc(text)}</b></p>`;
    const q = window.qrcode(0, "M"); q.addData(text); q.make();
    return q.createSvgTag({ cellSize: 6, margin: 2, scalable: true });
  }

  function csv(rows, name) {
    if (!rows.length) return toast("Nothing to export");
    const keys = Object.keys(rows[0]);
    const body = [keys.join(",")].concat(rows.map((r) => keys.map((k) => JSON.stringify(r[k] == null ? "" : r[k] instanceof Date ? r[k].toISOString() : r[k])).join(","))).join("\n");
    const a = document.createElement("a"); a.href = URL.createObjectURL(new Blob([body], { type: "text/csv" })); a.download = name; a.click();
  }

  // distances are stored in km (regulatory definitions) and shown in miles
  const mi = (km, d) => { const v = km * 0.621371; return v >= 10 || d === 0 ? Math.round(v).toString() : v.toFixed(d == null ? 1 : d).replace(/\.0$/, ""); };
  // plain one-color line icons used across the panel
  const ICONS = {
    live: '<path d="M7 10c0-3 2-5 5-5 1.6 0 2.8.7 3.6 1.8L19 6l-1.6 2.6c.4.8.6 1.7.6 2.4 0 4-3 7-7 7H8"/><path d="M8 18l-2 2M11 18v2.5"/><circle cx="14.5" cy="8.5" r=".6"/><path d="M7 10c-2 0-3 1.5-3 3 0 2.2 1.8 4 4 4"/>',
    eggs: '<path d="M12 3c-3.3 0-6 5-6 9a6 6 0 0 0 12 0c0-4-2.7-9-6-9z"/>',
    feed: '<path d="M12 21V8"/><path d="M12 12c-2.5 0-4-1.5-4-4 2.5 0 4 1.5 4 4zM12 12c2.5 0 4-1.5 4-4-2.5 0-4 1.5-4 4zM12 16c-2.5 0-4-1.5-4-4 2.5 0 4 1.5 4 4zM12 16c2.5 0 4-1.5 4-4-2.5 0-4 1.5-4 4zM12 8c-1.5-1-2-2.5-1.5-4 1.5.5 2 2 1.5 4z"/>',
    litter: '<path d="M3 18h18"/><path d="M5 18c1-4 3.5-7 7-7s6 3 7 7"/><path d="M9 11c.5-2 1.6-3 3-3s2.5 1 3 3"/>',
    dead: '<path d="M12 3 2.5 20h19z"/><path d="M12 10v5M12 17.6v.4"/>',
    service: '<path d="M14.5 5.5a4 4 0 0 0-5 5L4 16l4 4 5.5-5.5a4 4 0 0 0 5-5l-2.5 2.5-2.5-.5-.5-2.5z"/>',
    truck: '<path d="M2 7h11v9H2zM13 10h4l4 3v3h-8"/><circle cx="6" cy="17.5" r="1.8"/><circle cx="17" cy="17.5" r="1.8"/>',
    home: '<path d="M4 11 12 4l8 7v9h-5v-6H9v6H4z"/>',
    farm: '<path d="M3 21V11l3-4 6-4 6 4 3 4v10z"/><path d="M9 21v-5h6v5"/>',
    a: '<circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.5" fill="currentColor"/>',
    b: '<path d="M12 21s7-6.2 7-11.5A7 7 0 0 0 5 9.5C5 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>',
    date: '<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/>',
    block: '<circle cx="12" cy="12" r="9"/><path d="M5.6 5.6l12.8 12.8"/>',
    spacing: '<path d="M3 12h18M6 9l-3 3 3 3M18 9l3 3-3 3"/>',
    cone: '<path d="M9 4h6l4 16H5z"/><path d="M7.5 11h9M6.5 15h11"/>',
    wash: '<path d="M12 3s6 6.5 6 11a6 6 0 0 1-12 0c0-4.5 6-11 6-11z"/>',
    hazard: '<path d="M12 3 2.5 20h19z"/><path d="M12 10v5M12 17.6v.4"/>',
    clock: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5l3 2"/>',
    traffic: '<rect x="8" y="2.5" width="8" height="19" rx="2"/><circle cx="12" cy="7" r="1.5"/><circle cx="12" cy="12" r="1.5"/><circle cx="12" cy="17" r="1.5"/>',
    warn: '<circle cx="12" cy="12" r="9"/><path d="M12 7.5v6M12 16.5v.5"/>'
  };
  const icon = (n, cls) => `<svg class="li ${cls || ""}" viewBox="0 0 24 24" aria-hidden="true">${ICONS[n] || ""}</svg>`;
  const uid = (p) => (p || "") + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 6).toUpperCase();

  Object.assign(H, { icon, mi, $, esc, DAY, fmtDate, fmtShort, fmtTime, daysAgo, ago, toast, store, sheet, closeSheet, shrinkImage, qrSvg, csv, uid });
})(window.HPAI);
