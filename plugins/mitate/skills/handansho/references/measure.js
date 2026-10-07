/*
 * UI 計測スニペット — ブラウザの JavaScript 実行ツールに「中身をそのまま」注入して使う。
 *
 * なぜ canvas 経由か: getComputedStyle が返す色は oklch / oklab / rgb など様々で、文字列を
 * 直接 RGB とみなすと WCAG コントラストを誤算する。canvas に一度描いて sRGB に正規化する。
 *
 * なぜアルファ合成するか: バッジ等は「文字色と同系色の半透明 tint 背景」を持つ
 * (例: text-destructive + bg-destructive/10)。透過を無視すると文字色 ≒ 背景色に化けて
 * コントラストを 1 と誤検出する。半透明レイヤーは下地(白)まで遡って合成してから計算する。
 *
 * 返り値は監査結果の JSON 文字列。window.__ui に helper を残すので個別計測はそれを使う:
 *   __ui.contrastEl($0)                 要素の文字 vs 実効背景のコントラスト
 *   __ui.contrast(fg, bg)               任意の 2 色 (CSS 文字列/[r,g,b]) のコントラスト
 *   __ui.effRGB($0)                     実効背景色(半透明を白まで合成した [r,g,b])
 */
(function () {
  const cv = document.createElement("canvas");
  cv.width = cv.height = 1;
  const ctx = cv.getContext("2d");

  // 任意の CSS 色 → [r,g,b,a]。canvas は非プリマルチプルで読めるので alpha も取れる。
  function toRGBA(css) {
    ctx.clearRect(0, 0, 1, 1);
    ctx.fillStyle = "#000";
    ctx.fillStyle = css || "transparent";
    ctx.fillRect(0, 0, 1, 1);
    const d = ctx.getImageData(0, 0, 1, 1).data;
    return [d[0], d[1], d[2], d[3] / 255];
  }
  function toRGB(css) { const c = toRGBA(css); return [c[0], c[1], c[2]]; }
  function over(top, base) {
    const a = top[3];
    return [top[0] * a + base[0] * (1 - a), top[1] * a + base[1] * (1 - a), top[2] * a + base[2] * (1 - a)];
  }
  // 実効背景: 半透明の背景レイヤーを白まで遡って合成した不透明 [r,g,b]。
  function effRGB(el) {
    const layers = [];
    let e = el;
    while (e) {
      const c = toRGBA(getComputedStyle(e).backgroundColor);
      if (c[3] > 0) { layers.push(c); if (c[3] >= 0.999) break; }
      e = e.parentElement;
    }
    let base = [255, 255, 255];
    for (let i = layers.length - 1; i >= 0; i--) base = over(layers[i], base);
    return base.map(Math.round);
  }
  function lum(rgb) {
    const a = rgb.map((v) => { v /= 255; return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); });
    return 0.2126 * a[0] + 0.7152 * a[1] + 0.0722 * a[2];
  }
  function contrast(fg, bg) {
    const f = Array.isArray(fg) ? fg : toRGB(fg);
    const b = Array.isArray(bg) ? bg : toRGB(bg);
    const L1 = lum(f), L2 = lum(b);
    const hi = Math.max(L1, L2), lo = Math.min(L1, L2);
    return +(((hi + 0.05) / (lo + 0.05)).toFixed(2));
  }
  // 要素の文字 vs 実効背景。文字色が半透明ならその背景に合成してから測る。
  function contrastEl(el) {
    const bg = effRGB(el);
    const fgc = toRGBA(getComputedStyle(el).color);
    const fg = fgc[3] >= 0.999 ? [fgc[0], fgc[1], fgc[2]] : over(fgc, bg).map(Math.round);
    return contrast(fg, bg);
  }
  window.__ui = { toRGBA, toRGB, effRGB, contrast, contrastEl, lum };

  const visible = (el) => {
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
  };
  const leaf = (el) => el.children.length === 0 && (el.textContent || "").trim().length > 0;

  const out = {};
  out.bodyBg = effRGB(document.body);

  // 本文テキストのコントラスト分布。AA 目安(本文4.5 / 大きい・太字18.66px以上や24px以上は3.0)未満を数える。
  const leaves = [...document.querySelectorAll("p,span,td,th,div,a,button,label,li,h1,h2,h3")]
    .filter((el) => leaf(el) && visible(el)).slice(0, 400);
  const contrasts = leaves.map((el) => {
    const cs = getComputedStyle(el);
    const size = parseFloat(cs.fontSize);
    const bold = +cs.fontWeight >= 700;
    const large = size >= 24 || (size >= 18.66 && bold);
    return { c: contrastEl(el), size, large, text: (el.textContent || "").trim().slice(0, 20) };
  });
  const sorted = [...contrasts].sort((a, b) => a.c - b.c);
  out.textContrast = {
    sampled: contrasts.length,
    min: sorted[0],
    belowAA: contrasts.filter((x) => (x.large ? x.c < 3 : x.c < 4.5)).length,
    worst5: sorted.slice(0, 5),
  };

  // 塗り系ボタンのコントラスト・サイズ・位置。filled が複数で位置が散れば主 CTA の競合を疑う。
  const btns = [...document.querySelectorAll("button, a[role=button], [class*=btn]")].filter(visible);
  out.buttons = btns.slice(0, 14).map((b) => {
    const cs = getComputedStyle(b);
    const r = b.getBoundingClientRect();
    const bg = effRGB(b);
    return {
      label: (b.textContent || "").trim().slice(0, 16),
      contrast: contrastEl(b),
      h: Math.round(r.height),
      pos: { x: Math.round(r.x), y: Math.round(r.y) },
      filled: bg.some((v, i) => Math.abs(v - out.bodyBg[i]) > 24),
    };
  });

  // テーブル: 行高、第1列の重複(連続ラン最大)。重複が多いと一覧のスキャン性が落ちる。
  const table = document.querySelector("table");
  if (table) {
    const rows = [...table.querySelectorAll("tbody tr")].filter(visible);
    out.table = { rowCount: rows.length };
    if (rows.length) {
      out.table.rowHeight = Math.round(rows[0].getBoundingClientRect().height);
      const first = rows.map((r) => {
        const c = r.querySelector("td");
        return c ? (c.innerText || "").split("\n")[0].trim() : "";
      });
      let maxRun = first.length ? 1 : 0, cur = 1;
      for (let i = 1; i < first.length; i++) {
        if (first[i] && first[i] === first[i - 1]) { cur++; maxRun = Math.max(maxRun, cur); }
        else cur = 1;
      }
      out.table.distinctFirstCol = new Set(first.filter(Boolean)).size;
      out.table.maxConsecutiveSameFirstCol = maxRun;
    }
  }

  // 空値表現(—/-/N/A 等)の色。本文と同等に濃いと空欄がノイズになる。
  const emptyGlyphs = new Set(["—", "-", "ー", "N/A", "n/a", "なし", "－"]);
  const emptyEl = leaves.find((el) => emptyGlyphs.has((el.textContent || "").trim()));
  if (emptyEl) out.emptyValue = { rgb: toRGB(getComputedStyle(emptyEl).color), contrast: contrastEl(emptyEl) };

  out.viewport = { w: innerWidth, h: innerHeight };
  return JSON.stringify(out, null, 2);
})();
