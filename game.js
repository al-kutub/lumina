(() => {
  "use strict";

  const { Engine, World, Bodies, Body, Events, Composite } = Matter;

  /** Schema-versioned keys (v2). Future daily/badge keys stay namespaced separately. */
  const STORAGE_BEST_V1 = "lumina_best_score_v1";
  const STORAGE_BEST_V2 = "lumina_best_score_v2";
  const SHARE_URL = "https://al-kutub.github.io/lumina/";

  function loadBestScore() {
    const rawV2 = localStorage.getItem(STORAGE_BEST_V2);
    if (rawV2 != null) {
      const n = Number(rawV2);
      return Number.isFinite(n) && n > 0 ? n : 0;
    }
    const n1 = Number(localStorage.getItem(STORAGE_BEST_V1) || 0);
    const migrated = Number.isFinite(n1) && n1 > 0 ? n1 : 0;
    if (migrated > 0) localStorage.setItem(STORAGE_BEST_V2, String(migrated));
    return migrated;
  }

  function saveBestScore(best) {
    localStorage.setItem(STORAGE_BEST_V2, String(best));
  }
  const COMBO_WINDOW_MS = 900;
  const OVERFLOW_GRACE_MS = 1000;
  const DROP_COOLDOWN_MS = 280;
  const WALL_THICKNESS = 48;
  /** Fraction of vessel height from vessel top to the danger line */
  const DANGER_RATIO = 0.08;

  /** @type {{ name: string, r: number, color: string, glow: string, points: number }[]} */
  const TIERS = [
    { name: "Spark", r: 16, color: "#7af7ff", glow: "#3cf0ff", points: 1 },
    { name: "Ember", r: 21, color: "#7dffb3", glow: "#2dff9a", points: 3 },
    { name: "Pulse", r: 27, color: "#b8ff4d", glow: "#9dff1a", points: 6 },
    { name: "Prism", r: 34, color: "#ffe566", glow: "#ffd166", points: 10 },
    { name: "Nova", r: 42, color: "#ffb347", glow: "#ff9a1f", points: 16 },
    { name: "Comet", r: 52, color: "#ff7a59", glow: "#ff5533", points: 24 },
    { name: "Quasar", r: 63, color: "#ff4da6", glow: "#ff3dc8", points: 36 },
    { name: "Nebula", r: 76, color: "#c45dff", glow: "#8b5cff", points: 54 },
    { name: "Orbit", r: 90, color: "#6a7dff", glow: "#4d63ff", points: 80 },
    { name: "Giant", r: 106, color: "#3cf0ff", glow: "#00d4ff", points: 120 },
    { name: "Lumina", r: 124, color: "#fff4c2", glow: "#ffd166", points: 200 },
  ];

  const DROP_POOL = [0, 0, 0, 1, 1, 1, 2, 2, 3, 4];

  const els = {
    canvas: document.getElementById("gameCanvas"),
    nextCanvas: document.getElementById("nextCanvas"),
    score: document.getElementById("score"),
    best: document.getElementById("best"),
    hud: document.getElementById("hud"),
    nextPreview: document.getElementById("nextPreview"),
    titleScreen: document.getElementById("titleScreen"),
    gameOverScreen: document.getElementById("gameOverScreen"),
    startBtn: document.getElementById("startBtn"),
    retryBtn: document.getElementById("retryBtn"),
    finalScore: document.getElementById("finalScore"),
    finalTier: document.getElementById("finalTier"),
    finalCombo: document.getElementById("finalCombo"),
    newBest: document.getElementById("newBest"),
    runSummaryCard: document.getElementById("runSummaryCard"),
    copySummaryBtn: document.getElementById("copySummaryBtn"),
    shareBtn: document.getElementById("shareBtn"),
    copyFeedback: document.getElementById("copyFeedback"),
    muteBtn: document.getElementById("muteBtn"),
    muteIcon: document.getElementById("muteIcon"),
    comboFlash: document.getElementById("comboFlash"),
    app: document.getElementById("app"),
    stage: document.querySelector(".stage"),
  };

  const state = {
    mode: "title", // title | play | over
    score: 0,
    best: loadBestScore(),
    startBest: 0,
    beatBest: false,
    bestTierReached: 0,
    peakCombo: 0,
    mergeCount: 0,
    muted: false,
    currentTier: 0,
    nextTier: 0,
    aimX: 0.5,
    canDrop: true,
    lastDropAt: 0,
    combo: 0,
    lastMergeAt: 0,
    overflowSince: null,
    merging: new Set(),
    particles: [],
    floatTexts: [],
    previewBody: null,
    wallBodies: [],
    engine: null,
    runnerId: null,
    width: 0,
    height: 0,
    dpr: 1,
    vessel: { left: 0, right: 0, top: 0, bottom: 0, dangerY: 0 },
  };

  /** Audio */
  let audioCtx = null;

  function ensureAudio() {
    if (!audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) return null;
      audioCtx = new Ctx();
    }
    if (audioCtx.state === "suspended") audioCtx.resume();
    return audioCtx;
  }

  function tone(freq, dur, type = "sine", gain = 0.08, when = 0) {
    if (state.muted) return;
    const ctx = ensureAudio();
    if (!ctx) return;
    const t0 = ctx.currentTime + when;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(freq, t0);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.exponentialRampToValueAtTime(gain, t0 + 0.015);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g);
    g.connect(ctx.destination);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  function sfxDrop() {
    tone(220, 0.08, "triangle", 0.06);
    tone(440, 0.1, "sine", 0.04, 0.02);
  }

  function sfxMerge(tier) {
    const base = 280 + tier * 36;
    tone(base, 0.12, "sine", 0.09);
    tone(base * 1.5, 0.16, "triangle", 0.05, 0.04);
  }

  function sfxCombo(n) {
    const base = 420 + Math.min(n, 8) * 40;
    tone(base, 0.1, "square", 0.04);
    tone(base * 1.33, 0.14, "sine", 0.06, 0.05);
    tone(base * 2, 0.18, "triangle", 0.04, 0.1);
    // Short high-combo sting (≥3) — louder but still brief
    if (n >= 3) {
      tone(base * 2.5, 0.12, "square", 0.05, 0.08);
      tone(base * 3, 0.16, "sine", 0.045, 0.14);
    }
  }

  function sfxDangerWarn() {
    tone(320, 0.09, "sawtooth", 0.035);
    tone(260, 0.12, "triangle", 0.04, 0.06);
  }

  function sfxGameOver() {
    tone(180, 0.25, "sawtooth", 0.05);
    tone(140, 0.35, "triangle", 0.06, 0.12);
    tone(90, 0.5, "sine", 0.07, 0.28);
  }

  function randomDropTier() {
    return DROP_POOL[(Math.random() * DROP_POOL.length) | 0];
  }

  function resize() {
    const stage = els.canvas.parentElement;
    const rect = stage.getBoundingClientRect();
    state.dpr = Math.min(window.devicePixelRatio || 1, 2);
    state.width = Math.max(280, Math.floor(rect.width));
    state.height = Math.max(420, Math.floor(rect.height));
    els.canvas.width = Math.floor(state.width * state.dpr);
    els.canvas.height = Math.floor(state.height * state.dpr);
    els.canvas.style.width = `${state.width}px`;
    els.canvas.style.height = `${state.height}px`;

    // Compact Suika vessel occupying the lower ~52% of the stage.
    const padX = state.width * 0.12;
    const padTop = state.height * 0.22;
    const padBottom = state.height * 0.26;
    const vesselTop = padTop;
    const vesselBottom = state.height - padBottom;
    const vesselH = vesselBottom - vesselTop;
    state.vessel = {
      left: padX,
      right: state.width - padX,
      top: vesselTop,
      bottom: vesselBottom,
      dangerY: vesselTop + vesselH * DANGER_RATIO,
    };

    if (state.engine) {
      rebuildWalls();
      syncPreview();
    }
  }

  function rebuildWalls() {
    const { left, right, top, bottom } = state.vessel;
    const midY = (top + bottom) / 2;
    const h = bottom - top + WALL_THICKNESS;
    const w = right - left;

    for (const b of state.wallBodies) World.remove(state.engine.world, b);
    state.wallBodies = [
      Bodies.rectangle(left - WALL_THICKNESS / 2, midY, WALL_THICKNESS, h, {
        isStatic: true,
        label: "wall",
        friction: 0.35,
        restitution: 0.05,
      }),
      Bodies.rectangle(right + WALL_THICKNESS / 2, midY, WALL_THICKNESS, h, {
        isStatic: true,
        label: "wall",
        friction: 0.35,
        restitution: 0.05,
      }),
      Bodies.rectangle((left + right) / 2, bottom + WALL_THICKNESS / 2, w + WALL_THICKNESS * 2, WALL_THICKNESS, {
        isStatic: true,
        label: "floor",
        friction: 0.45,
        restitution: 0.02,
      }),
    ];
    World.add(state.engine.world, state.wallBodies);
  }

  function createOrb(tier, x, y, options = {}) {
    const t = TIERS[tier];
    const body = Bodies.circle(x, y, t.r, {
      label: "orb",
      restitution: 0.12,
      friction: 0.2,
      frictionAir: 0.012,
      density: 0.0018 + tier * 0.00015,
      ...options,
    });
    body.plugin = { tier, merged: false };
    return body;
  }

  function aimWorldX() {
    const tier = TIERS[state.currentTier];
    const min = state.vessel.left + tier.r + 2;
    const max = state.vessel.right - tier.r - 2;
    const x = state.vessel.left + (state.vessel.right - state.vessel.left) * state.aimX;
    return Math.max(min, Math.min(max, x));
  }

  function syncPreview() {
    if (!state.engine || state.mode !== "play") return;
    const x = aimWorldX();
    const y = state.vessel.top - 8;
    const t = TIERS[state.currentTier];

    if (state.previewBody) {
      World.remove(state.engine.world, state.previewBody);
      state.previewBody = null;
    }
    state.previewBody = createOrb(state.currentTier, x, y, {
      isStatic: true,
      isSensor: true,
    });
    state.previewBody.plugin.preview = true;
    World.add(state.engine.world, state.previewBody);
  }

  function drawNextPreview() {
    const ctx = els.nextCanvas.getContext("2d");
    const size = els.nextCanvas.width;
    ctx.clearRect(0, 0, size, size);
    const t = TIERS[state.nextTier];
    const r = Math.min(size * 0.36, t.r);
    const cx = size / 2;
    const cy = size / 2;
    const g = ctx.createRadialGradient(cx - r * 0.3, cy - r * 0.3, r * 0.1, cx, cy, r);
    g.addColorStop(0, "#ffffff");
    g.addColorStop(0.35, t.color);
    g.addColorStop(1, t.glow);
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = g;
    ctx.shadowColor = t.glow;
    ctx.shadowBlur = 14;
    ctx.fill();
    ctx.shadowBlur = 0;
  }

  function updateHud() {
    els.score.textContent = String(state.score);
    els.best.textContent = String(state.best);
    drawNextPreview();
  }

  function spawnParticles(x, y, color, count = 14) {
    for (let i = 0; i < count; i++) {
      const a = (Math.PI * 2 * i) / count + Math.random() * 0.4;
      const sp = 1.5 + Math.random() * 3.5;
      state.particles.push({
        x,
        y,
        vx: Math.cos(a) * sp,
        vy: Math.sin(a) * sp - 1,
        life: 1,
        decay: 0.018 + Math.random() * 0.02,
        r: 2 + Math.random() * 3.5,
        color,
      });
    }
  }

  function spawnFloatText(x, y, text, color, opts = {}) {
    state.floatTexts.push({
      x,
      y,
      text,
      color,
      life: 1,
      vy: opts.vy ?? -0.7,
      size: opts.size ?? 14,
    });
  }

  function pulseCombo(n) {
    const mega = n >= 3;
    const intensity = Math.min(1, (mega ? 0.55 : 0.35) + n * 0.1);
    els.app.style.setProperty("--pulse", String(intensity));
    els.comboFlash.classList.toggle("is-mega", mega);
    els.comboFlash.classList.add("is-on");
    clearTimeout(pulseCombo._t);
    // Keep payoff brief so play stays readable mid-clutch
    pulseCombo._t = setTimeout(() => {
      els.app.style.setProperty("--pulse", "0");
      els.comboFlash.classList.remove("is-on", "is-mega");
    }, mega ? 220 : 160);
  }

  function addScore(points, x, y) {
    state.score += points;
    if (state.score > state.startBest) {
      state.beatBest = true;
    }
    if (state.score > state.best) {
      state.best = state.score;
      saveBestScore(state.best);
    }
    updateHud();
    spawnFloatText(x, y, `+${points}`, TIERS[Math.min(TIERS.length - 1, 3)].glow);
  }

  function tryMerge(a, b) {
    if (!a.plugin || !b.plugin) return;
    if (a.plugin.preview || b.plugin.preview) return;
    if (a.plugin.merged || b.plugin.merged) return;
    if (a.plugin.tier !== b.plugin.tier) return;
    if (a.plugin.tier >= TIERS.length - 1) return;

    const idA = a.id;
    const idB = b.id;
    const key = idA < idB ? `${idA}:${idB}` : `${idB}:${idA}`;
    if (state.merging.has(key)) return;
    state.merging.add(key);

    const tier = a.plugin.tier;
    const next = tier + 1;
    const x = (a.position.x + b.position.x) / 2;
    const y = (a.position.y + b.position.y) / 2;
    const vx = (a.velocity.x + b.velocity.x) / 2;
    const vy = (a.velocity.y + b.velocity.y) / 2;

    a.plugin.merged = true;
    b.plugin.merged = true;
    World.remove(state.engine.world, a);
    World.remove(state.engine.world, b);

    const now = performance.now();
    if (now - state.lastMergeAt < COMBO_WINDOW_MS) state.combo += 1;
    else state.combo = 1;
    state.lastMergeAt = now;
    state.mergeCount += 1;
    if (state.combo > state.peakCombo) state.peakCombo = state.combo;
    if (next > state.bestTierReached) state.bestTierReached = next;

    const orb = createOrb(next, x, y);
    Body.setVelocity(orb, { x: vx * 0.4, y: vy * 0.4 - 1.2 });
    World.add(state.engine.world, orb);

    const base = TIERS[next].points;
    const bonus = state.combo > 1 ? Math.floor(base * (0.25 * (state.combo - 1))) : 0;
    const gained = base + bonus;
    addScore(gained, x, y - TIERS[next].r);

    spawnParticles(x, y, TIERS[next].glow, 12 + Math.min(state.combo, 6) * 2);
    sfxMerge(next);
    if (state.combo > 1) {
      sfxCombo(state.combo);
      pulseCombo(state.combo);
      const label = state.combo >= 3 ? `MULTI x${state.combo}` : `COMBO x${state.combo}`;
      const color = state.combo >= 3 ? "#ff7ae8" : "#ffd166";
      spawnFloatText(x, y + 18, label, color, { size: state.combo >= 3 ? 18 : 14 });
      if (state.combo >= 3) {
        spawnFloatText(x, y - TIERS[next].r - 10, "CLUTCH", "#fff4c2", { size: 16, vy: -0.9 });
      }
    }

    queueMicrotask(() => state.merging.delete(key));
  }

  function onCollision(event) {
    if (state.mode !== "play") return;
    for (const pair of event.pairs) {
      const { bodyA, bodyB } = pair;
      if (bodyA.label === "orb" && bodyB.label === "orb") tryMerge(bodyA, bodyB);
    }
  }

  function dropOrb() {
    if (state.mode !== "play" || !state.canDrop) return;
    const now = performance.now();
    if (now - state.lastDropAt < DROP_COOLDOWN_MS) return;

    const x = aimWorldX();
    const y = state.vessel.top + 4;
    const dropTier = state.currentTier;
    if (dropTier > state.bestTierReached) state.bestTierReached = dropTier;
    const orb = createOrb(dropTier, x, y);
    Body.setVelocity(orb, { x: 0, y: 1.5 });
    World.add(state.engine.world, orb);
    if (state.currentTier > state.bestTierReached) {
      state.bestTierReached = state.currentTier;
    }

    if (state.previewBody) {
      World.remove(state.engine.world, state.previewBody);
      state.previewBody = null;
    }

    state.currentTier = state.nextTier;
    state.nextTier = randomDropTier();
    state.canDrop = false;
    state.lastDropAt = now;
    updateHud();
    sfxDrop();

    setTimeout(() => {
      if (state.mode === "play") {
        state.canDrop = true;
        syncPreview();
      }
    }, DROP_COOLDOWN_MS);
  }

  function anyOrbAboveDanger() {
    const bodies = Composite.allBodies(state.engine.world);
    for (const b of bodies) {
      if (b.label !== "orb" || b.plugin?.preview) continue;
      if (b.plugin?.merged) continue;
      const top = b.position.y - b.circleRadius;
      if (top < state.vessel.dangerY) {
        const speed = Math.hypot(b.velocity.x, b.velocity.y);
        // Settled, nearly settled, or already sleeping above the line.
        if (b.isSleeping || speed < 0.85) return true;
      }
    }
    return false;
  }

  function checkOverflow(now) {
    if (anyOrbAboveDanger()) {
      if (state.overflowSince == null) {
        state.overflowSince = now;
        sfxDangerWarn();
        els.stage?.classList.add("is-danger");
      } else if (now - state.overflowSince >= OVERFLOW_GRACE_MS) {
        endGame();
      }
    } else {
      if (state.overflowSince != null) els.stage?.classList.remove("is-danger");
      state.overflowSince = null;
    }
  }

  function peakTierName() {
    const i = Math.max(0, Math.min(TIERS.length - 1, state.bestTierReached));
    return TIERS[i].name;
  }

  function buildShareSummary() {
    const run = window.lastRunMetrics;
    const score = run ? run.score : state.score;
    const tierName = run ? run.bestTierName : peakTierName();
    const peakCombo = run ? run.peakCombo : state.peakCombo;
    const beatBest = run ? run.beatBest : state.beatBest;
    const lines = [
      `LUMINA — Score ${score}`,
      `Peak tier: ${tierName}`,
      `Peak combo: ×${peakCombo}`,
    ];
    if (beatBest) lines.push("New best!");
    lines.push(SHARE_URL);
    return lines.join("\n");
  }

  function showCopyFeedback() {
    if (!els.copyFeedback) return;
    els.copyFeedback.hidden = false;
    clearTimeout(showCopyFeedback._t);
    showCopyFeedback._t = setTimeout(() => {
      els.copyFeedback.hidden = true;
    }, 1600);
  }

  async function copyRunSummary() {
    const text = buildShareSummary();
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        const ta = document.createElement("textarea");
        ta.value = text;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        document.execCommand("copy");
        document.body.removeChild(ta);
      }
      showCopyFeedback();
    } catch (_) {
      // Clipboard blocked — leave UI usable; user can still Retry.
    }
  }

  async function shareRunSummary() {
    const text = buildShareSummary();
    if (!navigator.share) return;
    try {
      await navigator.share({
        title: "LUMINA",
        text,
        url: SHARE_URL,
      });
    } catch (err) {
      if (err && err.name === "AbortError") return;
    }
  }

  function endGame() {
    if (state.mode !== "play") return;
    state.mode = "over";
    state.canDrop = false;
    state.overflowSince = null;
    els.stage?.classList.remove("is-danger");
    if (state.previewBody) {
      World.remove(state.engine.world, state.previewBody);
      state.previewBody = null;
    }
    const tier = TIERS[state.bestTierReached] || TIERS[0];
    const run = {
      score: state.score,
      bestTierReached: state.bestTierReached,
      bestTierName: tier.name,
      peakCombo: state.peakCombo,
      beatBest: state.beatBest,
      mergeCount: state.mergeCount,
      best: state.best,
    };
    // Share card + rivals bind through DOM + lastRunMetrics (PR #1 contract).
    window.lastRunMetrics = run;
    const over = els.gameOverScreen;
    over.dataset.score = String(run.score);
    over.dataset.bestTierReached = String(run.bestTierReached);
    over.dataset.bestTierName = run.bestTierName;
    over.dataset.peakCombo = String(run.peakCombo);
    over.dataset.beatBest = run.beatBest ? "1" : "0";
    over.dataset.mergeCount = String(run.mergeCount);

    els.finalScore.textContent = String(run.score);
    if (els.finalTier) els.finalTier.textContent = run.bestTierName;
    if (els.finalCombo) els.finalCombo.textContent = `×${run.peakCombo}`;
    els.newBest.hidden = !run.beatBest;
    if (els.runSummaryCard) {
      els.runSummaryCard.classList.toggle("is-new-best", run.beatBest);
    }
    if (els.shareBtn) {
      els.shareBtn.hidden = typeof navigator.share !== "function";
    }
    if (els.copyFeedback) els.copyFeedback.hidden = true;
    if (run.score > 0) saveBestScore(state.best);
    over.hidden = false;
    els.hud.hidden = true;
    els.nextPreview.hidden = true;
    sfxGameOver();
  }

  function clearWorldOrbs() {
    const bodies = Composite.allBodies(state.engine.world);
    for (const b of bodies) {
      if (b.label === "orb") World.remove(state.engine.world, b);
    }
    state.previewBody = null;
    state.particles = [];
    state.floatTexts = [];
    state.merging.clear();
  }

  function startGame() {
    ensureAudio();
    state.mode = "play";
    state.score = 0;
    state.startBest = state.best;
    state.beatBest = false;
    state.bestTierReached = 0;
    state.peakCombo = 0;
    state.mergeCount = 0;
    state.combo = 0;
    state.lastMergeAt = 0;
    state.overflowSince = null;
    els.stage?.classList.remove("is-danger");
    state.canDrop = true;
    state.currentTier = randomDropTier();
    state.nextTier = randomDropTier();
    state.aimX = 0.5;
    clearWorldOrbs();
    updateHud();
    els.titleScreen.hidden = true;
    els.gameOverScreen.hidden = true;
    els.hud.hidden = false;
    els.nextPreview.hidden = false;
    syncPreview();
  }

  function pointerToAim(clientX) {
    const rect = els.canvas.getBoundingClientRect();
    const rel = (clientX - rect.left) / rect.width;
    state.aimX = Math.max(0, Math.min(1, rel));
    if (state.mode === "play" && state.canDrop) syncPreview();
  }

  function setupInput() {
    let pointerDown = false;

    const onMove = (clientX) => {
      if (state.mode !== "play") return;
      pointerToAim(clientX);
    };

    els.canvas.addEventListener("pointerdown", (e) => {
      if (state.mode !== "play") return;
      pointerDown = true;
      els.canvas.setPointerCapture?.(e.pointerId);
      pointerToAim(e.clientX);
    });

    els.canvas.addEventListener("pointermove", (e) => {
      if (!pointerDown && e.pointerType === "mouse") onMove(e.clientX);
      else if (pointerDown) onMove(e.clientX);
      else if (e.pointerType === "mouse") onMove(e.clientX);
    });

    els.canvas.addEventListener("pointerup", (e) => {
      if (state.mode !== "play") return;
      if (pointerDown) {
        pointerToAim(e.clientX);
        dropOrb();
      }
      pointerDown = false;
    });

    els.canvas.addEventListener("pointercancel", () => {
      pointerDown = false;
    });

    // Desktop: also allow move without holding
    window.addEventListener("pointermove", (e) => {
      if (state.mode === "play" && e.pointerType === "mouse") onMove(e.clientX);
    });
  }

  function drawVessel(ctx) {
    const { left, right, top, bottom, dangerY } = state.vessel;
    const w = right - left;
    const h = bottom - top;

    // Vessel glass
    const glass = ctx.createLinearGradient(left, top, right, bottom);
    glass.addColorStop(0, "rgba(40, 50, 100, 0.35)");
    glass.addColorStop(0.5, "rgba(20, 24, 60, 0.22)");
    glass.addColorStop(1, "rgba(30, 20, 70, 0.4)");
    ctx.fillStyle = glass;
    roundRect(ctx, left, top, w, h, 18);
    ctx.fill();

    ctx.strokeStyle = "rgba(140, 170, 255, 0.35)";
    ctx.lineWidth = 2;
    roundRect(ctx, left, top, w, h, 18);
    ctx.stroke();

    // Inner rim glow
    ctx.strokeStyle = "rgba(60, 240, 255, 0.15)";
    ctx.lineWidth = 6;
    roundRect(ctx, left + 3, top + 3, w - 6, h - 6, 15);
    ctx.stroke();

    // Danger line — stronger pulse / weight while overflow grace is ticking
    const inDanger = state.overflowSince != null && state.mode === "play";
    const dangerT = inDanger
      ? Math.min(1, (performance.now() - state.overflowSince) / OVERFLOW_GRACE_MS)
      : 0;
    const pulseSpeed = inDanger ? 140 : 280;
    const pulse = 0.45 + Math.sin(performance.now() / pulseSpeed) * (inDanger ? 0.4 : 0.25);

    if (inDanger) {
      // Soft band under the line (readable on ~390px; no full-screen fill)
      const bandH = Math.max(28, (bottom - top) * 0.12);
      const band = ctx.createLinearGradient(left, dangerY - bandH, left, dangerY + 4);
      band.addColorStop(0, "rgba(255, 40, 80, 0)");
      band.addColorStop(0.7, `rgba(255, 60, 100, ${0.12 + dangerT * 0.22})`);
      band.addColorStop(1, `rgba(255, 80, 120, ${0.18 + dangerT * 0.2})`);
      ctx.fillStyle = band;
      ctx.fillRect(left + 4, dangerY - bandH, w - 8, bandH + 4);
    }

    ctx.strokeStyle = `rgba(255, 77, 109, ${0.35 + pulse * (inDanger ? 0.6 : 0.45)})`;
    ctx.lineWidth = inDanger ? 3.5 : 2;
    ctx.shadowColor = inDanger ? `rgba(255, 60, 100, ${0.55 + pulse * 0.35})` : "transparent";
    ctx.shadowBlur = inDanger ? 12 + pulse * 8 : 0;
    ctx.setLineDash(inDanger ? [6, 5] : [8, 8]);
    ctx.beginPath();
    ctx.moveTo(left + 10, dangerY);
    ctx.lineTo(right - 10, dangerY);
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.shadowBlur = 0;

    // Grace countdown bar along the danger line
    if (inDanger) {
      const barW = (w - 20) * dangerT;
      ctx.fillStyle = `rgba(255, 209, 102, ${0.55 + pulse * 0.35})`;
      ctx.fillRect(left + 10, dangerY - 1.5, barW, 3);
    }

    const label = inDanger ? "OVERFLOW" : "DANGER";
    ctx.fillStyle = `rgba(255, 77, 109, ${0.4 + pulse * (inDanger ? 0.55 : 0.3)})`;
    ctx.font = `${inDanger ? "700" : "600"} ${inDanger ? "12" : "11"}px "Exo 2", sans-serif`;
    ctx.letterSpacing = "0.15em";
    ctx.fillText(label, left + 14, dangerY - 8);
  }

  function roundRect(ctx, x, y, w, h, r) {
    const rr = Math.min(r, w / 2, h / 2);
    ctx.beginPath();
    ctx.moveTo(x + rr, y);
    ctx.arcTo(x + w, y, x + w, y + h, rr);
    ctx.arcTo(x + w, y + h, x, y + h, rr);
    ctx.arcTo(x, y + h, x, y, rr);
    ctx.arcTo(x, y, x + w, y, rr);
    ctx.closePath();
  }

  function drawOrb(ctx, body, alpha = 1) {
    const tier = body.plugin?.tier ?? 0;
    const t = TIERS[tier];
    const { x, y } = body.position;
    const r = body.circleRadius;
    const preview = body.plugin?.preview;

    ctx.save();
    ctx.globalAlpha = alpha * (preview ? 0.72 : 1);

    // Soft outer glow
    ctx.beginPath();
    ctx.arc(x, y, r * 1.35, 0, Math.PI * 2);
    const glow = ctx.createRadialGradient(x, y, r * 0.2, x, y, r * 1.35);
    glow.addColorStop(0, hexAlpha(t.glow, 0.35));
    glow.addColorStop(1, hexAlpha(t.glow, 0));
    ctx.fillStyle = glow;
    ctx.fill();

    // Core
    const core = ctx.createRadialGradient(x - r * 0.35, y - r * 0.4, r * 0.08, x, y, r);
    core.addColorStop(0, "#ffffff");
    core.addColorStop(0.28, t.color);
    core.addColorStop(1, shade(t.glow, -35));
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = core;
    ctx.shadowColor = t.glow;
    ctx.shadowBlur = preview ? 12 : 18;
    ctx.fill();
    ctx.shadowBlur = 0;

    // Specular
    ctx.beginPath();
    ctx.ellipse(x - r * 0.28, y - r * 0.32, r * 0.28, r * 0.16, -0.5, 0, Math.PI * 2);
    ctx.fillStyle = "rgba(255,255,255,0.45)";
    ctx.fill();

    // Drop guide for preview
    if (preview) {
      ctx.strokeStyle = hexAlpha(t.glow, 0.35);
      ctx.lineWidth = 1.5;
      ctx.setLineDash([4, 6]);
      ctx.beginPath();
      ctx.moveTo(x, y + r + 4);
      ctx.lineTo(x, state.vessel.bottom - 8);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    ctx.restore();
  }

  function hexAlpha(hex, a) {
    const n = hex.replace("#", "");
    const r = parseInt(n.slice(0, 2), 16);
    const g = parseInt(n.slice(2, 4), 16);
    const b = parseInt(n.slice(4, 6), 16);
    return `rgba(${r},${g},${b},${a})`;
  }

  function shade(hex, amt) {
    const n = hex.replace("#", "");
    const clamp = (v) => Math.max(0, Math.min(255, v + amt));
    const r = clamp(parseInt(n.slice(0, 2), 16));
    const g = clamp(parseInt(n.slice(2, 4), 16));
    const b = clamp(parseInt(n.slice(4, 6), 16));
    return `rgb(${r},${g},${b})`;
  }

  function drawParticles(ctx) {
    for (let i = state.particles.length - 1; i >= 0; i--) {
      const p = state.particles[i];
      p.x += p.vx;
      p.y += p.vy;
      p.vy += 0.05;
      p.life -= p.decay;
      if (p.life <= 0) {
        state.particles.splice(i, 1);
        continue;
      }
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r * p.life, 0, Math.PI * 2);
      ctx.fillStyle = hexAlpha(p.color, Math.max(0, p.life));
      ctx.fill();
    }
  }

  function drawFloatTexts(ctx) {
    for (let i = state.floatTexts.length - 1; i >= 0; i--) {
      const f = state.floatTexts[i];
      f.y += f.vy;
      f.life -= 0.02;
      if (f.life <= 0) {
        state.floatTexts.splice(i, 1);
        continue;
      }
      ctx.save();
      ctx.globalAlpha = Math.max(0, f.life);
      ctx.fillStyle = f.color;
      ctx.font = `700 ${f.size || 14}px "Orbitron", sans-serif`;
      ctx.textAlign = "center";
      ctx.fillText(f.text, f.x, f.y);
      ctx.restore();
    }
  }

  function render() {
    const ctx = els.canvas.getContext("2d");
    const { width: w, height: h, dpr } = state;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    // Soft vignette inside canvas
    const bg = ctx.createRadialGradient(w * 0.5, h * 0.35, 40, w * 0.5, h * 0.5, h * 0.75);
    bg.addColorStop(0, "rgba(24, 16, 58, 0.35)");
    bg.addColorStop(1, "rgba(6, 5, 18, 0.15)");
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    drawVessel(ctx);

    if (state.engine) {
      const bodies = Composite.allBodies(state.engine.world);
      for (const b of bodies) {
        if (b.label === "orb") drawOrb(ctx, b);
      }
    }

    drawParticles(ctx);
    drawFloatTexts(ctx);

    // Vessel-local overflow edge flash (progressing with grace) — not a sustained full-screen veil
    if (state.overflowSince != null && state.mode === "play") {
      const t = Math.min(1, (performance.now() - state.overflowSince) / OVERFLOW_GRACE_MS);
      const { left, right, top, bottom } = state.vessel;
      const edge = 3 + t * 3;
      ctx.strokeStyle = `rgba(255, 60, 100, ${0.35 + t * 0.45})`;
      ctx.lineWidth = edge;
      roundRect(ctx, left, top, right - left, bottom - top, 18);
      ctx.stroke();
    }
  }

  function loop() {
    if (state.engine && state.mode === "play") {
      Engine.update(state.engine, 1000 / 60);
      checkOverflow(performance.now());
    } else if (state.engine && state.mode === "over") {
      Engine.update(state.engine, 1000 / 60);
    }
    render();
    state.runnerId = requestAnimationFrame(loop);
  }

  function initPhysics() {
    state.engine = Engine.create({
      gravity: { x: 0, y: 1.15 },
      enableSleeping: true,
    });
    state.engine.timing.timeScale = 1;
    rebuildWalls();
    Events.on(state.engine, "collisionStart", onCollision);
  }

  function initUI() {
    els.best.textContent = String(state.best);
    els.startBtn.addEventListener("click", () => startGame());
    els.retryBtn.addEventListener("click", () => startGame());
    if (els.copySummaryBtn) {
      els.copySummaryBtn.addEventListener("click", () => {
        copyRunSummary();
      });
    }
    if (els.shareBtn) {
      els.shareBtn.hidden = typeof navigator.share !== "function";
      els.shareBtn.addEventListener("click", () => {
        shareRunSummary();
      });
    }
    els.muteBtn.addEventListener("click", () => {
      state.muted = !state.muted;
      els.muteBtn.classList.toggle("is-muted", state.muted);
      els.muteIcon.textContent = state.muted ? "✕" : "♪";
      els.muteBtn.setAttribute("aria-label", state.muted ? "Unmute" : "Mute");
      if (!state.muted) ensureAudio();
    });
  }

  function boot() {
    resize();
    initPhysics();
    initUI();
    setupInput();
    window.addEventListener("resize", () => {
      resize();
      render();
    });
    updateHud();
    els.hud.hidden = true;
    els.nextPreview.hidden = true;
    loop();
  }

  boot();
})();
