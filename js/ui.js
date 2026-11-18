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

  const uid = (p) => (p || "") + Date.now().toString(36).toUpperCase() + Math.random().toString(36).slice(2, 6).toUpperCase();

  Object.assign(H, { $, esc, DAY, fmtDate, fmtShort, fmtTime, daysAgo, ago, toast, store, sheet, closeSheet, shrinkImage, qrSvg, csv, uid });
})(window.HPAI);
