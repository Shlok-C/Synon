// --- Library (IndexedDB) — minimal inline reader/writer for the "Add to
// Library" toolbar button and locally-uploaded PDFs. Mirrors
// src/shared/library-db.ts's schema; kept as a small standalone copy since
// this file is plain JS copied verbatim by build.mjs, not bundled through
// the TS entry points.
function openLibraryDb() {
  return new Promise((resolve, reject) => {
    // Version must stay in lockstep with src/shared/library-db.ts's DB_VERSION —
    // IndexedDB versioning is global per database name, not per caller, so a
    // mismatch throws a VersionError in whichever context opens second.
    const req = indexedDB.open("synon-library", 2);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("items")) {
        const items = db.createObjectStore("items", { keyPath: "id" });
        items.createIndex("folderId", "folderId");
      }
      if (!db.objectStoreNames.contains("folders")) {
        db.createObjectStore("folders", { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains("outlineCache")) {
        db.createObjectStore("outlineCache", { keyPath: "pdfKey" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function loadLibraryItem(id) {
  try {
    const db = await openLibraryDb();
    if (!db.objectStoreNames.contains("items")) return null;
    return await new Promise((resolve, reject) => {
      const req = db.transaction("items", "readonly").objectStore("items").get(id);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return null;
  }
}

async function findLibraryItemByUrl(url) {
  try {
    const db = await openLibraryDb();
    if (!db.objectStoreNames.contains("items")) return null;
    const all = await new Promise((resolve, reject) => {
      const req = db.transaction("items", "readonly").objectStore("items").getAll();
      req.onsuccess = () => resolve(req.result || []);
      req.onerror = () => reject(req.error);
    });
    return all.find((i) => i.type === "pdf" && i.sourceKind === "public" && i.url === url) || null;
  } catch {
    return null;
  }
}

async function addLibraryItem(item) {
  try {
    const db = await openLibraryDb();
    const full = Object.assign({}, item, { id: crypto.randomUUID(), dateAdded: Date.now() });
    await new Promise((resolve, reject) => {
      const req = db.transaction("items", "readwrite").objectStore("items").add(full);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
    return true;
  } catch {
    return false;
  }
}

// --- Persistent LLM-outline cache — keyed the same way as the session-scoped
// heuristic schema cache (libraryId||pdfUrl), but lives in IndexedDB so a
// previously-opened PDF never re-triggers the LLM, even in a new session.
async function getCachedOutline(pdfKey) {
  try {
    const db = await openLibraryDb();
    if (!db.objectStoreNames.contains("outlineCache")) return undefined;
    return await new Promise((resolve, reject) => {
      const req = db.transaction("outlineCache", "readonly").objectStore("outlineCache").get(pdfKey);
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } catch {
    return undefined;
  }
}

async function setCachedOutline(pdfKey, nodes) {
  try {
    const db = await openLibraryDb();
    const record = { pdfKey, nodes, cachedAt: Date.now() };
    await new Promise((resolve, reject) => {
      const req = db.transaction("outlineCache", "readwrite").objectStore("outlineCache").put(record);
      req.onsuccess = () => resolve();
      req.onerror = () => reject(req.error);
    });
  } catch {
    // Cache failures (quota, private mode) shouldn't block showing the result.
  }
}

// Same noise filter inferOutlineFromSchema applies internally, plus a
// short-line cap (headings are short; this excludes body paragraphs) and a
// total-character budget to bound the LLM prompt's size/cost.
const OUTLINE_CANDIDATE_MAX_LINE_LEN = 120;
const OUTLINE_CANDIDATE_MAX_CHARS = 6000;

function buildOutlineCandidates(schema) {
  const candidates = [];
  let totalChars = 0;
  for (const r of schema.runs) {
    if (r.isMargin || r.isTocPage || r.isRunningHeader) continue;
    const text = r.text.trim();
    if (!text || text.length > OUTLINE_CANDIDATE_MAX_LINE_LEN) continue;
    if (totalChars + text.length > OUTLINE_CANDIDATE_MAX_CHARS) break;
    totalChars += text.length;
    candidates.push({
      text,
      pageIndex: r.pageIndex,
      isBold: !!r.isBold,
      isLarge: !!r.isLarge,
      isNumbered: !!r.isNumbered,
    });
  }
  return candidates;
}

function requestLlmOutline(candidates, timeoutMs = 20000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), timeoutMs);
    chrome.runtime.sendMessage({ type: "GENERATE_PDF_OUTLINE", candidates }, (response) => {
      clearTimeout(timer);
      if (chrome.runtime.lastError || !response) {
        resolve(null);
      } else {
        resolve(response.nodes);
      }
    });
  });
}

(async function () {
  const params = new URLSearchParams(location.search);
  let pdfUrl = params.get("file");
  const libraryId = params.get("libraryId");
  let libraryFilename = null;

  if (!pdfUrl && libraryId) {
    const item = await loadLibraryItem(libraryId);
    if (item && item.pdfBytes) {
      pdfUrl = URL.createObjectURL(item.pdfBytes);
      libraryFilename = item.title;
    }
  }

  // --- DOM references ---
  const loadingEl = document.getElementById("loading");
  const errorEl = document.getElementById("error");
  const viewerEl = document.getElementById("viewer");
  const viewerScrollEl = document.getElementById("viewer-scroll");
  const toolbarEl = document.getElementById("toolbar");
  const zoomLevelEl = document.getElementById("zoom-level");
  const pageInputEl = document.getElementById("page-input");
  const totalPagesEl = document.getElementById("total-pages");
  const filenameEl = document.getElementById("filename");
  const sidebarEl = document.getElementById("sidebar");
  const sidebarToggleEl = document.getElementById("sidebar-toggle");
  const thumbPaneEl = document.getElementById("thumb-pane");
  const outlinePaneEl = document.getElementById("outline-pane");
  const moreBtnEl = document.getElementById("more-btn");
  const moreMenuEl = document.getElementById("more-menu");
  const fitWidthBtn = document.getElementById("fit-width");
  const prevPageBtn = document.getElementById("prev-page");
  const nextPageBtn = document.getElementById("next-page");
  const zoomInBtn = document.getElementById("zoom-in");
  const zoomOutBtn = document.getElementById("zoom-out");
  const rotateBtn = document.getElementById("rotate-btn");
  const downloadBtn = document.getElementById("download-btn");
  const printBtn = document.getElementById("print-btn");
  const addLibraryBtn = document.getElementById("add-library-btn");

  if (!pdfUrl) {
    loadingEl.style.display = "none";
    errorEl.style.display = "block";
    errorEl.textContent = "No PDF URL provided.";
    return;
  }

  // Self-report on every load — not just fresh redirects — so tabs restored
  // directly to this viewer.html URL (Chrome's "Reopen closed tab", session
  // restore) are tracked for reload-recovery just like freshly-redirected ones.
  // Skipped for local library items: their pdfUrl is a blob: URL scoped to this
  // viewer instance, which would be dead by the time a restore tried to reuse it.
  if (!libraryId) {
    chrome.runtime.sendMessage({ type: "PDF_VIEWER_OPENED", url: pdfUrl });
  }

  // --- Add to Library button ---
  function setLibraryButtonSaved(saved) {
    addLibraryBtn.classList.toggle("active", saved);
    addLibraryBtn.title = saved ? "Already in Library" : "Add to Library";
    addLibraryBtn.disabled = saved;
  }

  if (libraryId) {
    setLibraryButtonSaved(true);
  } else {
    const existing = await findLibraryItemByUrl(pdfUrl);
    if (existing) {
      setLibraryButtonSaved(true);
    } else {
      addLibraryBtn.addEventListener("click", async () => {
        addLibraryBtn.disabled = true;
        const ok = await addLibraryItem({
          type: "pdf",
          sourceKind: "public",
          url: pdfUrl,
          title: document.title,
          faviconUrl: null,
          snapshotText: null,
          pdfBytes: null,
          folderId: null,
        });
        if (ok) setLibraryButtonSaved(true);
        else addLibraryBtn.disabled = false;
      });
    }
  }

  // --- PDF.js ---
  const pdfjsLib = await import("../build/pdf.mjs");
  pdfjsLib.GlobalWorkerOptions.workerSrc = "../build/pdf.worker.mjs";

  // --- State ---
  let pdf;
  let rotation = 0;
  let totalPages = 0;
  let currentPage = 1;
  let viewMode = "single"; // "single" | "two-up" | "grid"
  let sidebarOpen = true;
  let sidebarTab = "thumb"; // "thumb" | "outline"

  let scale = 1.5;
  const SCALE_STEP = 0.25;
  const SCALE_MIN = 0.5;
  const SCALE_MAX = 5.0;
  const GRID_SCALE_FACTOR = 0.4;

  const pageContainers = [];
  const renderedPages = new Set();
  const visiblePages = new Set();
  let observer = null;

  // --- Performance settings (overridable from the extension popup) ---
  let renderWindow = 6;      // pages kept rendered on each side of the current page
  let outlineScanCap = 250;  // above this page count, the outline scan runs on demand
  let streamingEnabled = true; // fetch only viewed pages first (disableAutoFetch)
  let placeholderW = "";     // current placeholder CSS width, for canvas eviction
  let placeholderH = "";     // current placeholder CSS height, for canvas eviction

  const thumbContainers = [];
  const renderedThumbs = new Set();
  let thumbObserver = null;

  let outlineEntries = []; // flat list of { row, pageIndex, childrenContainer, chevron, hasChildren }

  function effectiveScale() {
    return viewMode === "grid" ? scale * GRID_SCALE_FACTOR : scale;
  }

  // --- Settings persistence ---
  function loadSettings() {
    return new Promise((resolve) => {
      chrome.storage.sync.get(
        ["pdfViewMode", "pdfSidebarOpen", "pdfSidebarTab", "pdfStreaming", "pdfRenderWindow", "pdfOutlineScanCap"],
        (r) => {
          if (r.pdfViewMode === "two-up" || r.pdfViewMode === "grid" || r.pdfViewMode === "single") {
            viewMode = r.pdfViewMode;
          }
          if (typeof r.pdfSidebarOpen === "boolean") sidebarOpen = r.pdfSidebarOpen;
          if (r.pdfSidebarTab === "outline" || r.pdfSidebarTab === "thumb") {
            sidebarTab = r.pdfSidebarTab;
          }
          if (typeof r.pdfStreaming === "boolean") streamingEnabled = r.pdfStreaming;
          if (Number.isFinite(r.pdfRenderWindow) && r.pdfRenderWindow >= 2) {
            renderWindow = r.pdfRenderWindow;
          }
          if (Number.isFinite(r.pdfOutlineScanCap) && r.pdfOutlineScanCap >= 50) {
            outlineScanCap = r.pdfOutlineScanCap;
          }
          resolve();
        }
      );
    });
  }

  function saveSetting(key, value) {
    chrome.storage.sync.set({ [key]: value });
  }

  // --- Main load ---
  async function loadPdf() {
    loadingEl.style.display = "block";
    errorEl.style.display = "none";
    viewerEl.innerHTML = "";
    toolbarEl.style.display = "none";
    scale = 1.5; // open at 100% zoom

    try {
      const loadingTask = pdfjsLib.getDocument({
        url: pdfUrl,
        rangeChunkSize: 65536,
        disableAutoFetch: streamingEnabled,
        disableStream: false,
      });
      loadingTask.onProgress = ({ loaded, total }) => {
        loadingEl.textContent = total
          ? "Loading PDF… " + Math.round((loaded / total) * 100) + "%"
          : "Loading PDF…";
      };
      pdf = await loadingTask.promise;
    } catch (err) {
      loadingEl.style.display = "none";
      errorEl.style.display = "block";
      errorEl.innerHTML = "";
      errorEl.appendChild(document.createTextNode("Failed to load PDF: " + err.message));
      const retryBtn = document.createElement("button");
      retryBtn.textContent = "Retry";
      retryBtn.addEventListener("click", loadPdf);
      errorEl.appendChild(document.createElement("br"));
      errorEl.appendChild(retryBtn);
      return;
    }

    loadingEl.style.display = "none";

    const filename = libraryFilename || decodeURIComponent(pdfUrl.split("/").pop() || "Document");
    document.title = filename;
    filenameEl.textContent = filename;
    filenameEl.title = filename;

    toolbarEl.style.display = "flex";

    applyViewMode();
    applySidebarState();
    await initViewer();

    // Build sidebar content in parallel; they don't block viewer interaction
    buildThumbnailPane();
    initOutline();
  }

  // --- Page tracking ---
  function updatePageInfo() {
    if (document.activeElement !== pageInputEl) {
      pageInputEl.value = String(currentPage);
    }
    totalPagesEl.textContent = String(totalPages);
  }

  function onPageChange() {
    updatePageInfo();
    updateActiveThumb();
    updateActiveOutlineEntry();
    evictDistantPages();
  }

  // Restore a rendered page back to a lightweight placeholder, freeing its canvas.
  function resetToPlaceholder(index) {
    const container = pageContainers[index];
    if (!container) return;
    if (container._renderTask) {
      try { container._renderTask.cancel(); } catch {}
      container._renderTask = null;
    }
    container.innerHTML = "";
    container.className = "page-container page page-placeholder";
    if (placeholderW) container.style.width = placeholderW;
    if (placeholderH) container.style.height = placeholderH;
    container.textContent = "Page " + (index + 1);
    renderedPages.delete(index);
  }

  // Evict rendered pages farther than renderWindow from the current page.
  function evictDistantPages() {
    const cur = currentPage - 1;
    for (const idx of [...renderedPages]) {
      if (Math.abs(idx - cur) > renderWindow) resetToPlaceholder(idx);
    }
  }

  function updateCurrentPage() {
    if (visiblePages.size === 0) return;
    const scrollMid = viewerScrollEl.scrollTop + viewerScrollEl.clientHeight / 2;
    // Only the handful of currently-visible pages are inspected (not all N).
    let topmostRowY = Infinity;
    let newIdx = -1;
    let maxVisible = -1;
    for (const i of visiblePages) {
      const c = pageContainers[i];
      if (!c) continue;
      if (i > maxVisible) maxVisible = i;
      const cTop = c.offsetTop - viewerEl.offsetTop;
      const cBottom = cTop + c.offsetHeight;
      if (cBottom > scrollMid && (cTop < topmostRowY || (cTop === topmostRowY && i < newIdx))) {
        topmostRowY = cTop;
        newIdx = i;
      }
    }
    // Near the end of the document nothing sits below the midpoint — use the last visible page.
    if (newIdx === -1) newIdx = maxVisible;
    if (newIdx === -1) return;
    const newPage = newIdx + 1;
    if (newPage !== currentPage) {
      currentPage = newPage;
      onPageChange();
    }
  }

  let scrollRaf = null;
  viewerScrollEl.addEventListener("scroll", () => {
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = null;
      updateCurrentPage();
    });
  });

  function updateZoomLabel() {
    zoomLevelEl.textContent = Math.round((scale / 1.5) * 100) + "%";
  }

  // --- Page rendering ---
  async function renderPage(index) {
    if (renderedPages.has(index)) return;
    renderedPages.add(index);

    const container = pageContainers[index];
    const pageNum = index + 1;
    const page = await pdf.getPage(pageNum);
    const vpScale = effectiveScale();
    const viewport = page.getViewport({ scale: vpScale, rotation });

    container.innerHTML = "";
    container.className = "page-container page";

    const dpr = window.devicePixelRatio || 1;
    const canvas = document.createElement("canvas");
    canvas.width = Math.ceil(viewport.width * dpr);
    canvas.height = Math.ceil(viewport.height * dpr);
    const cssW = (canvas.width / dpr) + "px";
    const cssH = (canvas.height / dpr) + "px";
    container.style.width = cssW;
    container.style.height = cssH;
    canvas.style.width = cssW;
    canvas.style.height = cssH;
    container.appendChild(canvas);

    const ctx = canvas.getContext("2d");
    const renderTask = page.render({
      canvasContext: ctx,
      viewport,
      transform: [dpr, 0, 0, dpr, 0, 0],
    });
    container._renderTask = renderTask;
    try {
      await renderTask.promise;
    } catch (err) {
      if (err && err.name === "RenderingCancelledException") {
        renderedPages.delete(index);
        return;
      }
      throw err;
    } finally {
      if (container._renderTask === renderTask) container._renderTask = null;
    }

    const textContent = await page.getTextContent();
    const textLayerDiv = document.createElement("div");
    textLayerDiv.className = "textLayer";
    container.appendChild(textLayerDiv);

    const textLayer = new pdfjsLib.TextLayer({
      textContentSource: textContent,
      container: textLayerDiv,
      viewport,
    });
    await textLayer.render();

    // Free canvases for pages now far from the viewport.
    evictDistantPages();
  }

  function createObserver() {
    return new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          const idx = parseInt(entry.target.getAttribute("data-page-number"), 10) - 1;
          if (entry.isIntersecting) {
            visiblePages.add(idx);
            renderPage(idx);
          } else {
            visiblePages.delete(idx);
            // Cancel a still-pending render for a page that scrolled away mid-render
            // (_renderTask is non-null only while a render is in flight).
            const c = pageContainers[idx];
            if (c && c._renderTask) {
              try { c._renderTask.cancel(); } catch {}
            }
          }
        }
      },
      { root: viewerScrollEl, rootMargin: "200px" }
    );
  }

  // --- Free-canvas side margins ---
  const EDGE_VISIBLE = 50; // px of the page edge that stays visible at a pan extreme

  function applyCanvasPadding() {
    if (viewMode === "grid") {
      viewerEl.style.removeProperty("--side-pad");
      return;
    }
    const pad = Math.max(0, viewerScrollEl.clientWidth - EDGE_VISIBLE);
    viewerEl.style.setProperty("--side-pad", pad + "px");
  }

  function centerHorizontally() {
    viewerScrollEl.scrollLeft = (viewerScrollEl.scrollWidth - viewerScrollEl.clientWidth) / 2;
  }

  async function initViewer() {
    viewerEl.innerHTML = "";
    pageContainers.length = 0;
    renderedPages.clear();
    visiblePages.clear();
    if (observer) observer.disconnect();

    viewerEl.style.setProperty("--scale-factor", String(effectiveScale()));
    updateZoomLabel();

    const firstPage = await pdf.getPage(1);
    const defaultVp = firstPage.getViewport({ scale: effectiveScale(), rotation });

    const initDpr = window.devicePixelRatio || 1;
    const phW = (Math.ceil(defaultVp.width * initDpr) / initDpr) + "px";
    const phH = (Math.ceil(defaultVp.height * initDpr) / initDpr) + "px";
    placeholderW = phW;
    placeholderH = phH;
    for (let i = 0; i < pdf.numPages; i++) {
      const container = document.createElement("div");
      container.className = "page-container page page-placeholder";
      container.setAttribute("data-page-number", String(i + 1));
      container.style.width = phW;
      container.style.height = phH;
      container.textContent = "Page " + (i + 1);
      viewerEl.appendChild(container);
      pageContainers.push(container);
    }

    totalPages = pdf.numPages;
    currentPage = 1;
    pageInputEl.max = String(totalPages);
    updatePageInfo();

    observer = createObserver();
    for (const container of pageContainers) observer.observe(container);

    applyCanvasPadding();
    centerHorizontally();
  }

  async function rerender() {
    const scrollEl = viewerScrollEl;

    // Anchor scroll to the currently visible page + offset within it
    let anchorIndex = 0;
    let anchorFraction = 0;
    const scrollTop = scrollEl.scrollTop;
    for (let i = 0; i < pageContainers.length; i++) {
      const c = pageContainers[i];
      const cTop = c.offsetTop - viewerEl.offsetTop;
      const cBottom = cTop + c.offsetHeight;
      if (cBottom > scrollTop) {
        anchorIndex = i;
        anchorFraction = (scrollTop - cTop) / (c.offsetHeight || 1);
        break;
      }
    }

    renderedPages.clear();
    visiblePages.clear();
    if (observer) observer.disconnect();
    // Cancel any in-flight renders before tearing down their canvases.
    for (const container of pageContainers) {
      if (container._renderTask) {
        try { container._renderTask.cancel(); } catch {}
        container._renderTask = null;
      }
    }

    viewerEl.style.setProperty("--scale-factor", String(effectiveScale()));
    updateZoomLabel();

    const firstPage = await pdf.getPage(1);
    const defaultVp = firstPage.getViewport({ scale: effectiveScale(), rotation });
    const dpr = window.devicePixelRatio || 1;
    const phW = (Math.ceil(defaultVp.width * dpr) / dpr) + "px";
    const phH = (Math.ceil(defaultVp.height * dpr) / dpr) + "px";
    placeholderW = phW;
    placeholderH = phH;

    for (let i = 0; i < pageContainers.length; i++) {
      const container = pageContainers[i];
      container.innerHTML = "";
      container.className = "page-container page page-placeholder";
      container.style.width = phW;
      container.style.height = phH;
      container.textContent = "Page " + (i + 1);
    }

    requestAnimationFrame(() => {
      applyCanvasPadding();
      const left = (scrollEl.scrollWidth - scrollEl.clientWidth) / 2;
      const anchor = pageContainers[anchorIndex];
      if (anchor) {
        const newTop = anchor.offsetTop - viewerEl.offsetTop;
        scrollEl.scrollTo(left, newTop + anchorFraction * anchor.offsetHeight);
      } else {
        scrollEl.scrollLeft = left;
      }
    });

    observer = createObserver();
    for (const container of pageContainers) observer.observe(container);
  }

  // --- Zoom controls ---
  function zoomIn() {
    if (scale >= SCALE_MAX) return;
    scale = Math.min(scale + SCALE_STEP, SCALE_MAX);
    rerender();
  }

  function zoomOut() {
    if (scale <= SCALE_MIN) return;
    scale = Math.max(scale - SCALE_STEP, SCALE_MIN);
    rerender();
  }

  function fitWidth() {
    if (viewMode === "grid") return;
    const availableWidth = viewerScrollEl.clientWidth - 16;
    pdf.getPage(1).then((page) => {
      const unscaledVp = page.getViewport({ scale: 1, rotation });
      scale = Math.min(Math.max(availableWidth / unscaledVp.width, SCALE_MIN), SCALE_MAX);
      rerender();
    });
  }

  zoomInBtn.addEventListener("click", zoomIn);
  zoomOutBtn.addEventListener("click", zoomOut);
  fitWidthBtn.addEventListener("click", fitWidth);

  // --- Page navigation ---
  function goToPage(pageNum) {
    const clamped = Math.max(1, Math.min(pageNum, totalPages));
    const el = pageContainers[clamped - 1];
    if (el) el.scrollIntoView({ behavior: "smooth" });
  }

  prevPageBtn.addEventListener("click", () => {
    if (currentPage > 1) goToPage(currentPage - 1);
  });
  nextPageBtn.addEventListener("click", () => {
    if (currentPage < totalPages) goToPage(currentPage + 1);
  });

  pageInputEl.addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      e.preventDefault();
      const val = parseInt(pageInputEl.value, 10);
      if (!isNaN(val)) goToPage(val);
      pageInputEl.blur();
    } else if (e.key === "Escape") {
      pageInputEl.value = String(currentPage);
      pageInputEl.blur();
    }
  });
  pageInputEl.addEventListener("blur", () => {
    const val = parseInt(pageInputEl.value, 10);
    if (!isNaN(val) && val !== currentPage) goToPage(val);
    else pageInputEl.value = String(currentPage);
  });

  // --- Download ---
  downloadBtn.addEventListener("click", () => {
    const filename = libraryFilename || decodeURIComponent(pdfUrl.split("/").pop() || "document.pdf");
    const a = document.createElement("a");
    a.href = pdfUrl;
    a.download = filename.endsWith(".pdf") ? filename : filename + ".pdf";
    a.rel = "noopener";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  });

  // --- Print ---
  printBtn.addEventListener("click", () => window.print());

  // --- Rotate ---
  rotateBtn.addEventListener("click", () => {
    rotation = (rotation + 90) % 360;
    rerender();
    // Thumbnails need to re-render too since rotation changes their aspect ratio
    rebuildThumbnails();
  });

  // --- Keyboard / wheel zoom ---
  document.addEventListener("keydown", (e) => {
    const target = e.target;
    if (target === pageInputEl) return;
    if ((e.ctrlKey || e.metaKey) && (e.key === "=" || e.key === "+")) {
      e.preventDefault();
      zoomIn();
    } else if ((e.ctrlKey || e.metaKey) && e.key === "-") {
      e.preventDefault();
      zoomOut();
    } else if ((e.ctrlKey || e.metaKey) && e.key === "0") {
      e.preventDefault();
      scale = 1.5;
      rerender();
    }
  });

  document.addEventListener("wheel", (e) => {
    if (e.ctrlKey || e.metaKey) {
      e.preventDefault();
      if (e.deltaY < 0) zoomIn();
      else zoomOut();
    }
  }, { passive: false });

  // --- Middle-mouse grab/pan ---
  let isPanning = false;
  let panStartX = 0, panStartY = 0, panStartLeft = 0, panStartTop = 0;

  function endPan() {
    if (!isPanning) return;
    isPanning = false;
    document.body.classList.remove("panning");
  }

  viewerScrollEl.addEventListener("mousedown", (e) => {
    if (e.button !== 1) return;
    e.preventDefault(); // suppress Chrome's native middle-click autoscroll
    isPanning = true;
    panStartX = e.clientX;
    panStartY = e.clientY;
    panStartLeft = viewerScrollEl.scrollLeft;
    panStartTop = viewerScrollEl.scrollTop;
    document.body.classList.add("panning");
  });

  document.addEventListener("mousemove", (e) => {
    if (!isPanning) return;
    e.preventDefault();
    viewerScrollEl.scrollLeft = panStartLeft - (e.clientX - panStartX);
    viewerScrollEl.scrollTop = panStartTop - (e.clientY - panStartY);
  });

  document.addEventListener("mouseup", endPan);
  document.addEventListener("mouseleave", endPan);
  window.addEventListener("blur", endPan);

  window.addEventListener("resize", () => {
    applyCanvasPadding();
    centerHorizontally();
  });

  // --- Sidebar tabs + toggle ---
  function applySidebarState() {
    sidebarEl.classList.toggle("open", sidebarOpen);
    sidebarToggleEl.classList.toggle("active", sidebarOpen);
    document.querySelectorAll("#sidebar-tabs .tab").forEach((t) => {
      t.classList.toggle("active", t.dataset.tab === sidebarTab);
    });
    thumbPaneEl.hidden = sidebarTab !== "thumb";
    outlinePaneEl.hidden = sidebarTab !== "outline";
  }

  sidebarToggleEl.addEventListener("click", () => {
    sidebarOpen = !sidebarOpen;
    saveSetting("pdfSidebarOpen", sidebarOpen);
    applySidebarState();
  });

  document.querySelectorAll("#sidebar-tabs .tab").forEach((tab) => {
    tab.addEventListener("click", () => {
      sidebarTab = tab.dataset.tab;
      saveSetting("pdfSidebarTab", sidebarTab);
      applySidebarState();
      if (sidebarTab === "thumb") updateActiveThumb();
      if (sidebarTab === "outline") updateActiveOutlineEntry();
    });
  });

  // --- Thumbnails ---
  async function buildThumbnailPane() {
    thumbPaneEl.innerHTML = "";
    thumbContainers.length = 0;
    renderedThumbs.clear();
    if (thumbObserver) thumbObserver.disconnect();

    if (!pdf) return;

    const firstPage = await pdf.getPage(1);
    const baseVp = firstPage.getViewport({ scale: 1, rotation });
    const THUMB_W = 140;
    const thumbScale = THUMB_W / baseVp.width;
    const thumbH = baseVp.height * thumbScale;

    for (let i = 0; i < pdf.numPages; i++) {
      const wrap = document.createElement("div");
      wrap.className = "thumb";
      wrap.setAttribute("data-page-number", String(i + 1));

      const canvas = document.createElement("canvas");
      canvas.width = THUMB_W;
      canvas.height = Math.round(thumbH);
      canvas.style.width = THUMB_W + "px";
      canvas.style.height = Math.round(thumbH) + "px";
      wrap.appendChild(canvas);

      const label = document.createElement("div");
      label.className = "thumb-label";
      label.textContent = String(i + 1);
      wrap.appendChild(label);

      const pageIdx = i;
      wrap.addEventListener("click", () => goToPage(pageIdx + 1));

      thumbPaneEl.appendChild(wrap);
      thumbContainers.push(wrap);
    }

    thumbObserver = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (e.isIntersecting) {
            const idx = parseInt(e.target.getAttribute("data-page-number"), 10) - 1;
            renderThumbnail(idx);
          }
        }
      },
      { root: thumbPaneEl, rootMargin: "400px" }
    );
    for (const c of thumbContainers) thumbObserver.observe(c);

    updateActiveThumb();
  }

  async function renderThumbnail(index) {
    if (renderedThumbs.has(index)) return;
    renderedThumbs.add(index);
    const wrap = thumbContainers[index];
    if (!wrap) return;
    const canvas = wrap.querySelector("canvas");
    try {
      const page = await pdf.getPage(index + 1);
      const baseVp = page.getViewport({ scale: 1, rotation });
      const thumbScale = canvas.width / baseVp.width;
      const vp = page.getViewport({ scale: thumbScale, rotation });
      canvas.width = Math.round(vp.width);
      canvas.height = Math.round(vp.height);
      canvas.style.width = vp.width + "px";
      canvas.style.height = vp.height + "px";
      const ctx = canvas.getContext("2d");
      await page.render({ canvasContext: ctx, viewport: vp }).promise;
    } catch {
      renderedThumbs.delete(index);
    }
  }

  function updateActiveThumb() {
    for (const c of thumbContainers) c.classList.remove("thumb-active");
    const active = thumbContainers[currentPage - 1];
    if (!active) return;
    active.classList.add("thumb-active");
    if (sidebarOpen && sidebarTab === "thumb") {
      active.scrollIntoView({ block: "nearest" });
    }
  }

  function rebuildThumbnails() {
    // Only rebuild if pane has been populated (user opened thumbnails at least once)
    if (thumbContainers.length === 0) return;
    buildThumbnailPane();
  }

  // --- Outline ---
  async function resolveDestToPageIndex(dest) {
    if (dest == null) return null;
    try {
      let d = dest;
      if (typeof d === "string") d = await pdf.getDestination(d);
      if (d && d[0]) return await pdf.getPageIndex(d[0]);
    } catch {
      // unresolved — fine
    }
    return null;
  }

  async function resolveOutlineTree(items, level) {
    const out = [];
    for (const item of items) {
      const pageIndex = await resolveDestToPageIndex(item.dest);
      const children = item.items && item.items.length > 0
        ? await resolveOutlineTree(item.items, level + 1)
        : [];
      out.push({ title: item.title, pageIndex, level, children });
    }
    return out;
  }

  async function getOutlineEntries(pdfDoc) {
    const outline = await pdfDoc.getOutline();
    if (!outline || outline.length === 0) return null;
    return await resolveOutlineTree(outline, 0);
  }

  const BOLD_FONT_PATTERN = /bold|heavy|black|demi|semibold/i;
  const NUMBERED_PATTERNS = [
    { re: /^\s*\d+\.\d+\.\d+[\s.]/, depth: 2 },
    { re: /^\s*\d+\.\d+[\s.]/, depth: 1 },
    { re: /^\s*\d+\.\s/, depth: 0 },
    { re: /^\s*(chapter|section|part)\s+\d+/i, depth: 0 },
    { re: /^\s*[A-Z]\.\s/, depth: 0 },
    { re: /^\s*(?:I{1,3}|IV|VI{0,3}|IX|XI{0,3}|XIV|XV|XVI{0,3}|XIX|XX)\.\s/, depth: 0 },
  ];

  // Collapse adjacent text fragments on the same line into single runs.
  function mergeLineFragments(items, pageIndex) {
    const runs = [];
    let current = null;
    for (const item of items) {
      if (!item.str || !item.str.trim()) continue;
      const fontSize = Math.abs(item.transform[3]);
      const x = item.transform[4];
      const y = item.transform[5];
      const fontName = item.fontName || "";
      const width = item.width || 0;
      if (current && Math.abs(current.y - y) < 2 && x <= current.x + current.width + fontSize) {
        current.text += item.str;
        current.width = Math.max(current.width, (x + width) - current.x);
        if (fontSize > current.fontSize) { current.fontSize = fontSize; current.fontName = fontName; }
      } else {
        if (current) runs.push(current);
        current = { text: item.str, fontSize, fontName, pageIndex, y, x, width };
      }
    }
    if (current) runs.push(current);
    return runs;
  }

  // Returns the most frequent font size (modal) across all runs — the true body text size.
  function computeBodyFontSize(runs) {
    const freq = {};
    for (const r of runs) {
      const key = Math.round(r.fontSize * 2) / 2; // 0.5pt buckets
      freq[key] = (freq[key] || 0) + 1;
    }
    let modeSize = 12, maxFreq = 0;
    for (const [size, count] of Object.entries(freq)) {
      if (count > maxFreq) { maxFreq = count; modeSize = parseFloat(size); }
    }
    return modeSize;
  }

  // True if ≥30% of the page's runs look like TOC entries (text + dot-leaders + page number).
  const TOC_ENTRY_RE = /[.\s]{3,}\d+\s*$/;
  function detectTocPage(runs) {
    if (runs.length === 0) return false;
    return runs.filter((r) => TOC_ENTRY_RE.test(r.text)).length / runs.length >= 0.3;
  }

  // Mutates runs: marks any text appearing on ≥3 pages and ≥20% of all pages as a running header.
  function markRunningHeaders(allRuns, numPages) {
    const byText = {};
    for (const r of allRuns) {
      const k = r.text.trim().toLowerCase();
      (byText[k] = byText[k] || []).push(r);
    }
    for (const group of Object.values(byText)) {
      const pages = new Set(group.map((r) => r.pageIndex)).size;
      if (pages >= 3 && pages / numPages >= 0.2) {
        for (const r of group) r.isRunningHeader = true;
      }
    }
  }

  // Tag a merged run with bold, large, and numbered signals.
  function classifyRun(run, bodySize) {
    const isBold = BOLD_FONT_PATTERN.test(run.fontName);
    const isLarge = run.fontSize >= bodySize * 1.25;
    let isNumbered = false;
    let numberDepth = -1;
    for (const { re, depth } of NUMBERED_PATTERNS) {
      if (re.test(run.text)) { isNumbered = true; numberDepth = depth; break; }
    }
    return { isBold, isLarge, isNumbered, numberDepth };
  }

  // Scan every page of the PDF and return a classified schema.
  async function parseFullPdf(pdfDoc) {
    const pageRuns = [];
    for (let i = 0; i < pdfDoc.numPages; i++) {
      const page = await pdfDoc.getPage(i + 1);
      const viewport = page.getViewport({ scale: 1 });
      const pageHeight = viewport.height;
      const content = await page.getTextContent();
      const raw = mergeLineFragments(content.items, i);
      const toc = detectTocPage(raw);
      pageRuns.push(raw.map((r) => ({
        ...r,
        isMargin: r.y < pageHeight * 0.06 || r.y > pageHeight * 0.94,
        isTocPage: toc,
        isRunningHeader: false,
      })));
      // Yield to the event loop so scroll/zoom stay responsive during the scan.
      if (i % 8 === 7) await new Promise((r) => setTimeout(r));
    }

    const allRuns = pageRuns.flat();
    if (allRuns.length === 0) return { numPages: pdfDoc.numPages, bodyFontSize: 12, runs: [] };

    markRunningHeaders(allRuns, pdfDoc.numPages);

    const bodyFontSize = computeBodyFontSize(allRuns);
    const runs = allRuns.map((run) => ({ ...run, ...classifyRun(run, bodyFontSize) }));
    return { numPages: pdfDoc.numPages, bodyFontSize, runs };
  }

  // Convert a classified schema to an outline node list using confidence-ranked signals.
  function inferOutlineFromSchema(schema) {
    const { runs } = schema;
    // Strip noise before any signal-priority logic.
    const candidates = runs.filter((r) => !r.isMargin && !r.isTocPage && !r.isRunningHeader);
    function dedupe(subset) {
      const seen = new Set();
      return subset.filter((r) => {
        const key = r.text.trim().toLowerCase();
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    }
    function toNodes(subset, levelFn) {
      return subset.map((r) => ({ title: r.text.trim(), pageIndex: r.pageIndex, level: levelFn(r), children: [] }));
    }
    function sizeLevel(subset) {
      const uniq = [...new Set(subset.map((r) => r.fontSize))].sort((a, b) => b - a);
      const map = {};
      uniq.forEach((s, i) => { map[s] = Math.min(i, 3); });
      return (r) => map[r.fontSize];
    }

    // Numbered headings self-encode their hierarchy — most reliable signal.
    const numbered = dedupe(candidates.filter((r) => r.isNumbered));
    if (numbered.length >= 3) return toNodes(numbered, (r) => r.numberDepth);

    // Bold + large is the next best signal.
    const boldLarge = dedupe(candidates.filter((r) => r.isBold && r.isLarge));
    if (boldLarge.length >= 3) return toNodes(boldLarge, sizeLevel(boldLarge));

    // Large font alone as last resort.
    const large = dedupe(candidates.filter((r) => r.isLarge));
    if (large.length >= 3) return toNodes(large, sizeLevel(large));

    return [];
  }

  const outlineCacheKey = () => "synon-pdf-schema:" + (libraryId || pdfUrl);

  // Decide how the outline is produced: embedded TOC, cached scan, auto-scan, or on-demand.
  async function initOutline() {
    const tree = await getOutlineEntries(pdf);
    if (tree && tree.length > 0) { renderOutline(tree); return; }

    // Reuse a cached scan for this URL if present.
    let schema = null;
    try {
      const cached = sessionStorage.getItem(outlineCacheKey());
      if (cached) schema = JSON.parse(cached);
    } catch {}
    if (schema) { await finishOutline(schema); return; }

    // Large documents defer the scan so opening stays fast and streaming isn't defeated.
    if (pdf.numPages > outlineScanCap) {
      renderOutlineGenerateButton();
      return;
    }

    await runOutlineScan();
  }

  async function runOutlineScan() {
    outlinePaneEl.innerHTML = '<div class="toc-empty">Building outline…</div>';
    const schema = await parseFullPdf(pdf);
    try { sessionStorage.setItem(outlineCacheKey(), JSON.stringify(schema)); } catch {}
    await finishOutline(schema);
  }

  function renderOutlineGenerateButton() {
    outlinePaneEl.innerHTML = "";
    const wrap = document.createElement("div");
    wrap.className = "toc-empty";
    const msg = document.createElement("div");
    msg.textContent = "Large document (" + pdf.numPages + " pages).";
    const btn = document.createElement("button");
    btn.className = "toc-generate-btn";
    btn.textContent = "Generate outline";
    btn.addEventListener("click", () => { btn.disabled = true; runOutlineScan(); });
    wrap.appendChild(msg);
    wrap.appendChild(btn);
    outlinePaneEl.appendChild(wrap);
  }

  // --- LLM outline fallback, tried only once heuristics find nothing ---
  function pdfCacheKey() {
    return libraryId || pdfUrl;
  }

  function renderOutlineActionMessage(text, buttonText, onClick) {
    outlinePaneEl.innerHTML = "";
    const wrap = document.createElement("div");
    wrap.className = "toc-empty";
    const msg = document.createElement("div");
    msg.textContent = text;
    const btn = document.createElement("button");
    btn.className = "toc-generate-btn";
    btn.textContent = buttonText;
    btn.addEventListener("click", () => { btn.disabled = true; onClick(); });
    wrap.appendChild(msg);
    wrap.appendChild(btn);
    outlinePaneEl.appendChild(wrap);
  }

  async function finishOutline(schema) {
    const nodes = inferOutlineFromSchema(schema);
    if (nodes.length > 0) { renderOutline(nodes); return; }
    await handleNoHeuristicOutline(schema);
  }

  async function handleNoHeuristicOutline(schema) {
    // Once a PDF has been checked before (found something or genuinely
    // nothing), never call the LLM again for it automatically.
    const cached = await getCachedOutline(pdfCacheKey());
    if (cached !== undefined) {
      renderOutline(cached.nodes || []);
      return;
    }
    renderOutlineActionMessage("No outline detected.", "Generate outline with AI", () => runLlmOutlineGeneration(schema));
  }

  async function runLlmOutlineGeneration(schema) {
    outlinePaneEl.innerHTML = '<div class="toc-empty">Asking AI for an outline…</div>';
    const candidates = buildOutlineCandidates(schema);
    const nodes = await requestLlmOutline(candidates);
    if (nodes === null) {
      // Call itself failed (no key, timeout, network, bad reply) — stays
      // retryable, not cached, so a transient failure isn't permanent.
      renderOutlineActionMessage("Couldn't generate an outline right now.", "Retry", () => runLlmOutlineGeneration(schema));
      return;
    }
    await setCachedOutline(pdfCacheKey(), nodes);
    renderOutline(nodes);
  }

  function renderOutline(tree) {
    outlinePaneEl.innerHTML = "";
    outlineEntries = [];

    if (!tree || tree.length === 0) {
      const empty = document.createElement("div");
      empty.className = "toc-empty";
      empty.textContent = "No outline available.";
      outlinePaneEl.appendChild(empty);
      return;
    }

    function renderNode(node, parent, depth) {
      const displayLevel = typeof node.level === "number" ? node.level : depth;
      const row = document.createElement("div");
      row.className = "toc-entry toc-level-" + Math.min(displayLevel, 3);

      const chevron = document.createElement("span");
      chevron.className = "toc-chevron";
      const hasChildren = node.children && node.children.length > 0;
      chevron.textContent = hasChildren ? (depth === 0 ? "▾" : "▸") : "";
      row.appendChild(chevron);

      const title = document.createElement("span");
      title.className = "toc-title";
      title.textContent = node.title;
      title.title = node.title;
      row.appendChild(title);

      const childrenContainer = document.createElement("div");
      childrenContainer.className = "toc-children";
      if (depth !== 0 && hasChildren) childrenContainer.hidden = true;

      if (hasChildren) {
        chevron.style.cursor = "pointer";
        chevron.addEventListener("click", (e) => {
          e.stopPropagation();
          const isHidden = childrenContainer.hidden;
          childrenContainer.hidden = !isHidden;
          chevron.textContent = isHidden ? "▾" : "▸";
        });
      }

      row.addEventListener("click", () => {
        if (node.pageIndex != null) goToPage(node.pageIndex + 1);
      });

      parent.appendChild(row);
      outlineEntries.push({ row, pageIndex: node.pageIndex, childrenContainer, chevron, hasChildren });

      if (hasChildren) {
        for (const child of node.children) renderNode(child, childrenContainer, depth + 1);
        parent.appendChild(childrenContainer);
      }
    }

    for (const node of tree) renderNode(node, outlinePaneEl, 0);

    updateActiveOutlineEntry();
  }

  function updateActiveOutlineEntry() {
    if (outlineEntries.length === 0) return;
    const curIdx = currentPage - 1;
    let active = null;
    for (const entry of outlineEntries) {
      if (entry.pageIndex == null) continue;
      if (entry.pageIndex <= curIdx) active = entry;
      else break;
    }

    for (const e of outlineEntries) e.row.classList.remove("toc-active");
    if (!active) return;

    active.row.classList.add("toc-active");

    // Expand ancestor containers so the active row is visible
    let el = active.row.parentElement;
    while (el && el !== outlinePaneEl) {
      if (el.classList.contains("toc-children") && el.hidden) {
        el.hidden = false;
        const prevRow = el.previousElementSibling;
        if (prevRow) {
          const chev = prevRow.querySelector(".toc-chevron");
          if (chev) chev.textContent = "▾";
        }
      }
      el = el.parentElement;
    }

    if (sidebarOpen && sidebarTab === "outline") {
      active.row.scrollIntoView({ block: "nearest" });
    }
  }

  // --- More menu / view mode ---
  moreBtnEl.addEventListener("click", (e) => {
    e.stopPropagation();
    moreMenuEl.hidden = !moreMenuEl.hidden;
  });
  document.addEventListener("click", (e) => {
    if (moreMenuEl.hidden) return;
    if (!moreMenuEl.contains(e.target) && e.target !== moreBtnEl) {
      moreMenuEl.hidden = true;
    }
  });
  moreMenuEl.addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    if (btn.dataset.mode) {
      setViewMode(btn.dataset.mode);
      moreMenuEl.hidden = true;
    } else if (btn.id === "reset-zoom") {
      scale = 1.5;
      rerender();
      moreMenuEl.hidden = true;
    }
  });

  function applyViewMode() {
    viewerEl.classList.remove("two-up-mode", "grid-mode");
    if (viewMode === "two-up") viewerEl.classList.add("two-up-mode");
    else if (viewMode === "grid") viewerEl.classList.add("grid-mode");

    fitWidthBtn.disabled = viewMode === "grid";

    moreMenuEl.querySelectorAll("button[data-mode]").forEach((b) => {
      b.setAttribute("aria-checked", b.dataset.mode === viewMode ? "true" : "false");
    });
  }

  function setViewMode(mode) {
    if (mode === viewMode) return;
    viewMode = mode;
    saveSetting("pdfViewMode", mode);
    applyViewMode();
    rerender();
  }

  // Click-to-zoom in grid mode
  viewerEl.addEventListener("click", (e) => {
    if (viewMode !== "grid") return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && sel.toString().trim()) return;
    const container = e.target.closest(".page-container");
    if (!container) return;
    const pageNum = parseInt(container.getAttribute("data-page-number"), 10);
    if (!pageNum) return;
    setViewMode("single");
    setTimeout(() => goToPage(pageNum), 150);
  });

  // Toolbar is always visible (no auto-hide); it stays at data-hidden="false".

  // --- Startup ---
  await loadSettings();
  await loadPdf();
})();
