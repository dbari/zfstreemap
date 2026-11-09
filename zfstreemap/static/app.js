(() => {
  "use strict";

  const PAD = 3; // inset of a dataset's children from its border, px
  const HEADER_H = 18; // height of a dataset's name bar, px
  const MIN_BOX = 2; // boxes smaller than this in either dimension are not drawn, px
  const MIN_POOL_W = 96; // top-level pools are drawn at least this big, so small pools stay visible
  const MIN_POOL_H = 64;
  const MIN_POOL_AREA = MIN_POOL_W * MIN_POOL_H * 1.1; // small margin so rounding never drops a pool below the minimum

  const $ = (id) => document.getElementById(id);
  const mapEl = $("map");
  const tipEl = $("tooltip");
  const crumbEl = $("crumbs");
  const summaryEl = $("summary");
  const statusEl = $("status");
  const refreshBtn = $("refresh");
  const busyEl = $("busy");

  const state = {
    root: null, // tree returned by /api/tree
    index: new Map(), // dataset name -> node; the virtual root is ""
    zoom: "", // dataset drawn as the full map; "" shows all pools
  };

  // ---- formatting ---------------------------------------------------------

  const UNITS = ["B", "K", "M", "G", "T", "P", "E"];

  // Same style as `zfs list -h`: three significant digits, binary units.
  function fmtBytes(n) {
    if (n < 1024) return `${n}B`;
    let v = n;
    let i = 0;
    while (v >= 1024 && i < UNITS.length - 1) {
      v /= 1024;
      i++;
    }
    const text = v < 10 ? v.toFixed(2) : v < 100 ? v.toFixed(1) : v.toFixed(0);
    return text + UNITS[i];
  }

  function sizeText(n) {
    return `${fmtBytes(n)} (${n.toLocaleString()} bytes)`;
  }

  function fmtDate(epochSeconds) {
    return new Date(epochSeconds * 1000).toLocaleDateString(undefined, {
      year: "numeric",
      month: "short",
      day: "numeric",
    });
  }

  function shortName(name) {
    return name.split("/").pop();
  }

  function parentOf(name) {
    const i = name.lastIndexOf("/");
    return i < 0 ? "" : name.slice(0, i);
  }

  // Colour is chosen per pool so each pool's datasets share a hue.
  function hueOf(name) {
    const pool = name.split("/")[0];
    let h = 0;
    for (let i = 0; i < pool.length; i++) h = (h * 31 + pool.charCodeAt(i)) % 360;
    return h;
  }

  // ---- layout -------------------------------------------------------------

  // Space a box stands for: a dataset's used space, or a pool's used plus free space.
  function sizeOf(node) {
    return node.used + (node.free || 0);
  }

  // What a dataset's box is divided into: child datasets, one block for all
  // snapshots, and (for pools) one block for free space. The dataset's own data
  // gets an unlabelled "own" item so the areas stay proportional, but it is not
  // drawn; it shows as the plain background of the dataset's box.
  function itemsFor(node) {
    const items = [];
    for (const child of node.children) {
      if (sizeOf(child) > 0) items.push({ kind: "dataset", node: child, value: sizeOf(child) });
    }
    if (node.type !== "root") {
      if (node.snapshot_space > 0) items.push({ kind: "snapshots", node, value: node.snapshot_space });
      if (node.own > 0) items.push({ kind: "own", node, value: node.own });
      if (node.free > 0) items.push({ kind: "free", node, value: node.free });
    }
    return items.sort((a, b) => b.value - a.value);
  }

  // Weights used for layout. Items whose area would fall below minArea are
  // raised to the smallest weight that gives minArea, so the rest shrink a bit.
  function layoutWeights(items, rect, minArea) {
    const area = rect.w * rect.h;
    const values = items.map((it) => it.value);
    const total = values.reduce((sum, v) => sum + v, 0);
    if (!(minArea > 0) || items.length * minArea >= area) return values;

    // The floor depends on the total it will be part of, so iterate to a fixed point.
    let sum = total;
    for (let i = 0; i < 50; i++) {
      const floor = (minArea * sum) / area;
      const next = values.reduce((s, v) => s + Math.max(v, floor), 0);
      if (Math.abs(next - sum) <= 1e-9 * total) break;
      sum = next;
    }
    const floor = (minArea * sum) / area;
    return values.map((v) => Math.max(v, floor));
  }

  // Top-level pools. A pool too small for MIN_POOL_W x MIN_POOL_H is placed in a strip
  // along the bottom of the map at that minimum height; the other pools are laid out
  // proportionally above the strip.
  function layoutPools(items, rect) {
    const total = items.reduce((sum, it) => sum + it.value, 0);
    if (!(total > 0)) return [];
    const scale = (rect.w * rect.h) / total;
    const small = items.filter((it) => it.value * scale < MIN_POOL_AREA);
    const big = items.filter((it) => it.value * scale >= MIN_POOL_AREA);
    if (!small.length || rect.h < 2 * MIN_POOL_H) return squarify(items, rect, MIN_POOL_AREA);

    const stripH = MIN_POOL_H;
    const stripY = rect.y + rect.h - stripH;
    const weights = layoutWeights(small, { w: rect.w, h: stripH }, MIN_POOL_W * stripH * 1.1);
    const weightSum = weights.reduce((sum, w) => sum + w, 0);
    const out = [];
    let x = rect.x;
    small.forEach((item, i) => {
      const w = (weights[i] / weightSum) * rect.w;
      out.push({ item, x, y: stripY, w, h: stripH });
      x += w;
    });
    const bigRect = { x: rect.x, y: rect.y, w: rect.w, h: rect.h - stripH };
    return out.concat(squarify(big, bigRect));
  }

  // Squarified treemap (Bruls, Huizing, van Wijk). Returns one rectangle per item.
  // minArea (optional) is the smallest area any item may be drawn with, in px².
  function squarify(items, rect, minArea = 0) {
    const weights = layoutWeights(items, rect, minArea);
    const total = weights.reduce((sum, w) => sum + w, 0);
    const out = [];
    if (!(total > 0) || rect.w <= 0 || rect.h <= 0) return out;

    const scale = (rect.w * rect.h) / total;
    const cells = items.map((item, i) => ({ item, area: weights[i] * scale }));

    let r = { ...rect };
    let row = [];
    let i = 0;
    while (i < cells.length && r.w > 0 && r.h > 0) {
      const side = Math.min(r.w, r.h);
      const candidate = row.concat([cells[i]]);
      if (row.length === 0 || worst(candidate, side) <= worst(row, side)) {
        row = candidate;
        i++;
      } else {
        r = layoutRow(row, r, out);
        row = [];
      }
    }
    if (row.length) layoutRow(row, r, out);
    return out;
  }

  // Worst aspect ratio of a row laid along a side of length `side`.
  function worst(row, side) {
    let sum = 0;
    let max = 0;
    let min = Infinity;
    for (const c of row) {
      sum += c.area;
      max = Math.max(max, c.area);
      min = Math.min(min, c.area);
    }
    const s2 = side * side;
    return Math.max((s2 * max) / (sum * sum), (sum * sum) / (s2 * min));
  }

  // Places a finished row along the shorter side of `r` and returns what is left.
  function layoutRow(row, r, out) {
    const sum = row.reduce((s, c) => s + c.area, 0);
    if (r.w >= r.h) {
      const colW = sum / r.h;
      let y = r.y;
      for (const c of row) {
        const h = c.area / colW;
        out.push({ item: c.item, x: r.x, y, w: colW, h });
        y += h;
      }
      return { x: r.x + colW, y: r.y, w: r.w - colW, h: r.h };
    }
    const rowH = sum / r.w;
    let x = r.x;
    for (const c of row) {
      const w = c.area / rowH;
      out.push({ item: c.item, x, y: r.y, w, h: rowH });
      x += w;
    }
    return { x: r.x, y: r.y + rowH, w: r.w, h: r.h - rowH };
  }

  // ---- drawing ------------------------------------------------------------

  // All boxes are siblings inside #map, positioned in map coordinates. Nesting
  // is expressed by drawing parents before their children, so children paint on top.
  function addBox(classes, rect, name, kind) {
    const el = document.createElement("div");
    el.className = `box ${classes}`;
    el.dataset.kind = kind;
    el.dataset.name = name;
    el.style.left = `${rect.x}px`;
    el.style.top = `${rect.y}px`;
    el.style.width = `${rect.w}px`;
    el.style.height = `${rect.h}px`;
    mapEl.appendChild(el);
    return el;
  }

  function addLabel(el, text) {
    const label = document.createElement("div");
    label.className = "label";
    label.textContent = text;
    el.appendChild(label);
  }

  function drawDataset(node, rect, depth) {
    const isRoot = node.type === "root";
    const pad = isRoot ? 0 : PAD;
    const el = addBox(isRoot ? "ds root" : "ds", rect, node.name, "dataset");
    el.style.setProperty("--depth", depth);
    el.style.setProperty("--hue", hueOf(node.name));

    let top = rect.y + pad;
    if (!isRoot && rect.w >= 40 && rect.h >= HEADER_H + 2 * pad + 10) {
      addLabel(el, `${shortName(node.name)}  ${fmtBytes(sizeOf(node))}`);
      top += HEADER_H;
    }

    const inner = { x: rect.x + pad, y: top, w: rect.w - 2 * pad, h: rect.y + rect.h - pad - top };
    if (inner.w < MIN_BOX * 3 || inner.h < MIN_BOX * 3) return;

    const placements = isRoot ? layoutPools(itemsFor(node), inner) : squarify(itemsFor(node), inner);
    for (const placed of placements) {
      if (placed.w < MIN_BOX || placed.h < MIN_BOX) continue;
      switch (placed.item.kind) {
        case "dataset":
          drawDataset(placed.item.node, placed, depth + 1);
          break;
        case "own":
          break; // reserved space only; the box background shows through
        default:
          drawLeaf(placed.item, placed);
      }
    }
  }

  function drawLeaf(item, rect) {
    const node = item.node;
    const kind = item.kind;
    const el = addBox(kind === "snapshots" ? "snap" : "free", rect, node.name, kind);

    if (rect.w < 36 || rect.h < 16) return;
    if (kind === "snapshots") {
      addLabel(el, `${node.snapshot_count} snapshots · ${fmtBytes(item.value)}`);
    } else if (kind === "free") {
      addLabel(el, `free · ${fmtBytes(item.value)}`);
    }
  }

  function render() {
    hideTip();
    const node = state.index.get(state.zoom) || state.root;
    mapEl.replaceChildren();
    if (node) {
      drawDataset(node, { x: 0, y: 0, w: mapEl.clientWidth, h: mapEl.clientHeight }, 0);
    }
    renderCrumbs();
  }

  function renderCrumbs() {
    crumbEl.replaceChildren();
    const names = [""];
    if (state.zoom) {
      let acc = "";
      for (const part of state.zoom.split("/")) {
        acc = acc ? `${acc}/${part}` : part;
        names.push(acc);
      }
    }
    names.forEach((name, i) => {
      if (i > 0) {
        const sep = document.createElement("span");
        sep.className = "sep";
        sep.textContent = "›";
        crumbEl.appendChild(sep);
      }
      if (i === names.length - 1) {
        const current = document.createElement("span");
        current.className = "current";
        current.textContent = name ? shortName(name) : "All pools";
        current.title = name || "all pools";
        crumbEl.appendChild(current);
      } else {
        const button = document.createElement("button");
        button.type = "button";
        button.textContent = name ? shortName(name) : "All pools";
        button.title = name || "all pools";
        button.addEventListener("click", () => zoomTo(name));
        crumbEl.appendChild(button);
      }
    });
  }

  function renderSummary() {
    let snapSpace = 0;
    let snapCount = 0;
    let datasets = 0;
    for (const node of state.index.values()) {
      if (node.type === "root") continue;
      datasets++;
      snapSpace += node.snapshot_space;
      snapCount += node.snapshot_count;
    }
    const pools = state.root.children.length;
    summaryEl.textContent =
      `${fmtBytes(state.root.used)} used and ${fmtBytes(state.root.free)} free in ${pools} pool${pools === 1 ? "" : "s"} · ` +
      `${datasets} datasets · ${snapCount} snapshots using ${fmtBytes(snapSpace)}`;
  }

  // ---- tooltip ------------------------------------------------------------

  function describe(kind, name) {
    const node = state.index.get(name);
    if (!node) return null;

    if (kind === "snapshots") {
      const rows = [
        ["Snapshots", String(node.snapshot_count)],
        ["Space used", sizeText(node.snapshot_space)],
      ];
      if (node.snapshot_oldest !== null) {
        rows.push(["Oldest", fmtDate(node.snapshot_oldest)]);
        rows.push(["Newest", fmtDate(node.snapshot_newest)]);
      }
      return {
        title: `${name} · snapshots`,
        rows,
        note: "All snapshots of this dataset are combined into one block.",
      };
    }

    if (kind === "free") {
      return {
        title: `${name} · free space`,
        rows: [["Free", sizeText(node.free)]],
        note: "Space still available to datasets in this pool.",
      };
    }

    if (node.type === "root") {
      return {
        title: "All pools",
        rows: [
          ["Pools", String(node.children.length)],
          ["Used", sizeText(node.used)],
          ["Free", sizeText(node.free)],
        ],
        note: "Box area is proportional to space.",
      };
    }

    const rows = [
      ["Type", node.type],
      ["Space used", sizeText(node.used)],
    ];
    if (node.free !== null) {
      rows.push(["Free", sizeText(node.free)]);
      rows.push(["Total", sizeText(sizeOf(node))]);
    }
    rows.push(
      ["Own data", sizeText(node.own)],
      ["Snapshots", `${node.snapshot_count} · ${sizeText(node.snapshot_space)}`],
      ["Child datasets", String(node.children.length)],
      ["Referenced", sizeText(node.referenced)],
    );
    if (node.snapshot_oldest !== null) {
      rows.push(["Snapshot range", `${fmtDate(node.snapshot_oldest)} – ${fmtDate(node.snapshot_newest)}`]);
    }
    if (node.mountpoint && node.mountpoint !== "-") rows.push(["Mountpoint", node.mountpoint]);
    return {
      title: node.name,
      rows,
      note: "Click to zoom in. Unshaded space inside the box is the dataset's own data.",
    };
  }

  function renderTip(info) {
    const children = [];
    const title = document.createElement("div");
    title.className = "title";
    title.textContent = info.title;
    children.push(title);
    for (const [key, value] of info.rows) {
      const row = document.createElement("div");
      row.className = "row";
      const k = document.createElement("span");
      k.className = "k";
      k.textContent = key;
      const v = document.createElement("span");
      v.textContent = value;
      row.append(k, v);
      children.push(row);
    }
    if (info.note) {
      const note = document.createElement("div");
      note.className = "note";
      note.textContent = info.note;
      children.push(note);
    }
    tipEl.replaceChildren(...children);
  }

  let tipTarget = null;

  function hideTip() {
    tipEl.hidden = true;
    tipTarget = null;
  }

  function positionTip(x, y) {
    const gap = 16;
    let left = x + gap;
    let top = y + gap;
    if (left + tipEl.offsetWidth > window.innerWidth) left = x - tipEl.offsetWidth - gap;
    if (top + tipEl.offsetHeight > window.innerHeight) top = y - tipEl.offsetHeight - gap;
    tipEl.style.left = `${Math.max(0, left)}px`;
    tipEl.style.top = `${Math.max(0, top)}px`;
  }

  // ---- interaction --------------------------------------------------------

  function zoomTo(name) {
    if (name === state.zoom || !state.index.has(name)) return;
    state.zoom = name;
    render();
  }

  mapEl.addEventListener("mousemove", (e) => {
    const el = e.target.closest(".box");
    if (!el) {
      hideTip();
      return;
    }
    if (el !== tipTarget) {
      const info = describe(el.dataset.kind, el.dataset.name);
      if (!info) {
        hideTip();
        return;
      }
      tipTarget = el;
      renderTip(info);
      tipEl.hidden = false;
    }
    positionTip(e.clientX, e.clientY);
  });

  mapEl.addEventListener("mouseleave", hideTip);

  mapEl.addEventListener("click", (e) => {
    const el = e.target.closest(".box");
    if (!el || el.dataset.kind === "snapshots") return;
    zoomTo(el.dataset.name);
  });

  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape" && state.zoom) zoomTo(parentOf(state.zoom));
  });

  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (state.root) render();
    }, 120);
  });

  // ---- loading ------------------------------------------------------------

  function indexTree(root) {
    const index = new Map();
    const walk = (node) => {
      index.set(node.name, node);
      node.children.forEach(walk);
    };
    walk(root);
    return index;
  }

  function setStatus(text, isError = false) {
    statusEl.textContent = text;
    statusEl.classList.toggle("error", isError);
  }

  async function load() {
    refreshBtn.disabled = true;
    busyEl.hidden = false;
    setStatus("Querying ZFS…");
    try {
      const resp = await fetch("/api/tree", { cache: "no-store" });
      const data = await resp.json();
      if (!resp.ok) throw new Error(data.error || `HTTP ${resp.status}`);
      state.root = data.root;
      state.index = indexTree(data.root);
      if (!state.index.has(state.zoom)) state.zoom = "";
      renderSummary();
      setStatus(`Updated ${new Date(data.generated * 1000).toLocaleTimeString()}`);
      render();
    } catch (err) {
      setStatus(`Error: ${err.message}`, true);
    } finally {
      refreshBtn.disabled = false;
      busyEl.hidden = true;
    }
  }

  refreshBtn.addEventListener("click", load);
  load();
})();
