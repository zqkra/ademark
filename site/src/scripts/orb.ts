// The brand orb (brand/orb.svg) drawn live: a halftone sphere lit from the top left, turning slowly.
// Screen axes: x right, y down, z toward the viewer. The dot grid never moves; dots only change size and color.
// The grid is invisible outside the orb: dots appear only under the cursor and where a pink ping passes.

const SIGNAL = "#ff0d50";
const LIGHT = normalize(-0.62, -0.62, 0.48);
const TILT = 0.38;
const SPIN = 0.07; // radians per second at rest
// Light ground: small dots are pale, big dots dark. Dark ground (system setting): the ramp turns over.
const SCHEMES = {
  light: { lens: "#b5b5b5", small: 201, big: 34, halo: "10,10,10", haloAlpha: 0.06 },
  dark: { lens: "#4a4a4a", small: 70, big: 226, halo: "255,255,255", haloAlpha: 0.05 },
};
const darkQuery = window.matchMedia("(prefers-color-scheme: dark)");
const scheme = () => (darkQuery.matches ? SCHEMES.dark : SCHEMES.light);
const BUCKETS = 24;
const PING_SPEED = 0.62; // px per ms
const AUTO_PING_MS = 4200;

type Vec = [number, number, number];

interface Spot {
  center: Vec;
  radius: number;
}

interface Ping {
  x: number;
  y: number;
  start: number;
  from: number;
}

export interface OrbOptions {
  /** Drag on the orb to spin it. Off where the page must scroll on touch. */
  drag?: boolean;
  /** A ping leaves the orb every few seconds. */
  autoPing?: boolean;
}

const PINK_SPOTS: Spot[] = [
  { center: fromLatLon(0.42, 0.2), radius: 0.2 },
  { center: fromLatLon(-0.18, 3.5), radius: 0.13 },
];
const DARK_SPOT: Spot = { center: fromLatLon(-0.3, 1.9), radius: 0.42 };

function normalize(x: number, y: number, z: number): Vec {
  const n = Math.hypot(x, y, z);
  return [x / n, y / n, z / n];
}

function fromLatLon(lat: number, lon: number): Vec {
  return [Math.cos(lat) * Math.sin(lon), Math.sin(lat), Math.cos(lat) * Math.cos(lon)];
}

function falloff(distance: number, radius: number): number {
  if (distance >= radius) return 0;
  const t = 1 - distance / radius;
  return t * t * (3 - 2 * t);
}

function easeOut(t: number): number {
  const c = Math.min(1, Math.max(0, t));
  return 1 - (1 - c) ** 3;
}

function addDot(path: Path2D, x: number, y: number, r: number): void {
  path.moveTo(x + r, y);
  path.arc(x, y, r, 0, Math.PI * 2);
}

export function mountOrb(canvas: HTMLCanvasElement, host: HTMLElement, text: HTMLElement, options: OrbOptions = {}): void {
  const context = canvas.getContext("2d");
  if (!context) return;
  const ctx = context;
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  let width = 0;
  let height = 0;
  let cx = 0;
  let cy = 0;
  let radius = 0;
  let step = 12;
  let startedAt = performance.now();
  let lastFrame = startedAt;
  let lastPing = startedAt;
  let frame = 0;
  let visible = true;

  let angle = 0.6;
  let extraSpin = 0;
  const pings: Ping[] = [];
  const pointer = { x: -9999, y: -9999, targetX: -9999, targetY: -9999, strength: 0, target: 0 };
  const drag = { active: false, moved: 0, lastX: 0, lastTime: 0, velocity: 0 };

  function layout(): void {
    const rect = host.getBoundingClientRect();
    width = rect.width;
    height = rect.height;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    canvas.style.width = `${width}px`;
    canvas.style.height = `${height}px`;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // On wide screens the orb starts where the text ends and may bleed off the right edge by half its radius.
    if (width >= 900) {
      const range = document.createRange();
      range.selectNodeContents(text);
      const textRight = range.getBoundingClientRect().right - rect.left;
      const left = textRight + 56;
      radius = Math.max(220, Math.min(height * 0.46, (width - left) / 1.5));
      cx = Math.max(left + radius, width * 0.62);
      cy = height * 0.5;
    } else {
      radius = width * 0.56;
      cx = width * 0.8;
      cy = height * 0.35;
    }
    step = Math.min(13, Math.max(8, radius / 30));
  }

  function pingAt(x: number, y: number, from: number, now: number): void {
    pings.push({ x, y, start: now, from });
    if (pings.length > 6) pings.shift();
    lastPing = now;
  }

  function pingStrength(x: number, y: number, now: number, width_: number): number {
    let strength = 0;
    for (const ping of pings) {
      const age = now - ping.start;
      const ring = ping.from + age * PING_SPEED;
      const fade = Math.max(0, 1 - age / 2600);
      if (fade <= 0) continue;
      const d = Math.hypot(x - ping.x, y - ping.y);
      strength = Math.max(strength, falloff(Math.abs(d - ring), width_) * fade);
    }
    return strength;
  }

  function draw(now: number): void {
    const dt = Math.min(0.05, (now - lastFrame) / 1000);
    lastFrame = now;
    if (!reduceMotion && !drag.active) {
      angle += (SPIN + extraSpin) * dt;
      extraSpin *= Math.exp(-dt * 1.4);
    }
    const intro = reduceMotion ? Infinity : now - startedAt;

    if (options.autoPing && !reduceMotion && intro > 1400 && now - lastPing > AUTO_PING_MS) {
      pingAt(cx, cy, radius * 0.92, now);
    }
    while (pings.length && now - pings[0].start > 2600) pings.shift();

    const cosT = Math.cos(-TILT);
    const sinT = Math.sin(-TILT);
    const cosS = Math.cos(-angle);
    const sinS = Math.sin(-angle);
    const maxDot = step * 0.41;
    const ringWidth = step * 1.8;

    pointer.x += (pointer.targetX - pointer.x) * 0.14;
    pointer.y += (pointer.targetY - pointer.y) * 0.14;
    pointer.strength += (pointer.target - pointer.strength) * 0.08;
    const lens = 140;

    ctx.clearRect(0, 0, width, height);
    const halo = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius * 1.3);
    const colors = scheme();
    halo.addColorStop(0.35, `rgba(${colors.halo},${colors.haloAlpha})`);
    halo.addColorStop(1, `rgba(${colors.halo},0)`);
    ctx.fillStyle = halo;
    ctx.fillRect(0, 0, width, height);

    const grays: Path2D[] = Array.from({ length: BUCKETS }, () => new Path2D());
    const pink = new Path2D();
    const lensDots = new Path2D();

    const firstCol = Math.ceil(-cx / step);
    const lastCol = Math.floor((width - cx) / step);
    const firstRow = Math.ceil(-cy / step);
    const lastRow = Math.floor((height - cy) / step);

    for (let row = firstRow; row <= lastRow; row++) {
      const y = cy + row * step;
      const dy = y - cy;
      for (let col = firstCol; col <= lastCol; col++) {
        const x = cx + col * step;
        const dx = x - cx;
        const distance = Math.hypot(dx, dy);

        let near = 0;
        if (pointer.strength > 0.01) {
          const d = Math.hypot(x - pointer.x, y - pointer.y);
          if (d < lens) near = (1 - d / lens) ** 2 * pointer.strength;
        }
        const ping = pings.length ? pingStrength(x, y, now, ringWidth) : 0;

        if (distance > radius) {
          if (ping > 0.12) addDot(pink, x, y, step * 0.34 * ping);
          else if (near > 0.04) addDot(lensDots, x, y, near * step * 0.26);
          continue;
        }

        const appear = easeOut((intro - (distance / radius) * 450) / 550);
        if (appear <= 0) continue;

        const nx = dx / radius;
        const ny = dy / radius;
        const nz = Math.sqrt(Math.max(0, 1 - nx * nx - ny * ny));
        const lit = Math.max(0, nx * LIGHT[0] + ny * LIGHT[1] + nz * LIGHT[2]);

        // The pink rim arc stays where the light hits the edge, as in the brand orb.
        const rimAngle = (Math.atan2(dy, dx) * 180) / Math.PI;
        if (distance / radius > 0.955 && rimAngle > -169 && rimAngle < -103) {
          addDot(pink, x, y, maxDot * 0.95 * appear);
          continue;
        }

        // Back from the view to the turning sphere: undo the tilt, then the spin.
        const vy = -ny;
        const ty = vy * cosT - nz * sinT;
        const tz = vy * sinT + nz * cosT;
        const px = nx * cosS + tz * sinS;
        const pz = -nx * sinS + tz * cosS;
        const lat = Math.asin(Math.max(-1, Math.min(1, ty)));
        const lon = Math.atan2(px, pz);

        let pinkness = 0;
        for (const spot of PINK_SPOTS) {
          const dot = px * spot.center[0] + ty * spot.center[1] + pz * spot.center[2];
          pinkness = Math.max(pinkness, falloff(Math.acos(Math.min(1, dot)), spot.radius));
        }
        if (pinkness > 0.22 && nz > 0.12) {
          addDot(pink, x, y, maxDot * (0.5 + 0.45 * pinkness) * appear);
          continue;
        }

        const darkDot = px * DARK_SPOT.center[0] + ty * DARK_SPOT.center[1] + pz * DARK_SPOT.center[2];
        const dark = falloff(Math.acos(Math.min(1, darkDot)), DARK_SPOT.radius) * Math.min(1, nz * 2);
        const bands = 0.05 * Math.sin(lat * 9 + 2 * Math.sin(lon * 3));
        const ink = Math.min(1, Math.max(0, 0.06 + 0.9 * lit ** 1.15 + 0.42 * dark + bands + near * 0.35));
        const r = (0.095 + ink * 0.905) * maxDot * appear;

        if (ping > 0.18) {
          addDot(pink, x, y, Math.max(r, maxDot * (0.45 + 0.5 * ping) * appear));
          continue;
        }
        if (r < 0.25) continue;
        addDot(grays[Math.min(BUCKETS - 1, Math.floor(ink * BUCKETS))], x, y, r);
      }
    }

    ctx.fillStyle = colors.lens;
    ctx.fill(lensDots);
    for (let i = 0; i < BUCKETS; i++) {
      const g = Math.round(colors.small - (colors.small - colors.big) * ((i + 0.5) / BUCKETS));
      ctx.fillStyle = `rgb(${g},${g},${g})`;
      ctx.fill(grays[i]);
    }
    ctx.fillStyle = SIGNAL;
    ctx.fill(pink);
  }

  function loop(now: number): void {
    draw(now);
    frame = visible && !document.hidden ? requestAnimationFrame(loop) : 0;
  }

  function start(): void {
    if (reduceMotion) {
      draw(performance.now());
      return;
    }
    if (!frame) {
      lastFrame = performance.now();
      frame = requestAnimationFrame(loop);
    }
  }

  layout();
  startedAt = performance.now();
  lastPing = startedAt;
  start();

  new ResizeObserver(() => {
    layout();
    if (reduceMotion) draw(performance.now());
  }).observe(host);

  new IntersectionObserver(([entry]) => {
    visible = entry.isIntersecting;
    if (visible) start();
  }).observe(host);

  document.addEventListener("visibilitychange", () => {
    if (!document.hidden) start();
  });

  // A still orb (reduced motion) is redrawn when the system switches between light and dark.
  darkQuery.addEventListener("change", () => {
    if (reduceMotion) draw(performance.now());
  });

  if (reduceMotion) return;

  const local = (event: PointerEvent) => {
    const rect = host.getBoundingClientRect();
    return { x: event.clientX - rect.left, y: event.clientY - rect.top };
  };
  const onControl = (event: Event) => (event.target as Element | null)?.closest("a, button") !== null;

  host.addEventListener("pointermove", (event) => {
    const p = local(event);
    pointer.targetX = p.x;
    pointer.targetY = p.y;
    if (pointer.target === 0) {
      pointer.x = p.x;
      pointer.y = p.y;
    }
    pointer.target = event.pointerType === "mouse" ? 1 : 0;

    if (drag.active) {
      const dx = event.clientX - drag.lastX;
      const dtMs = Math.max(1, event.timeStamp - drag.lastTime);
      angle += dx / radius;
      drag.velocity = (dx / radius / dtMs) * 1000;
      drag.moved += Math.abs(dx);
      drag.lastX = event.clientX;
      drag.lastTime = event.timeStamp;
    }
  });

  host.addEventListener("pointerleave", () => {
    pointer.target = 0;
  });

  host.addEventListener("pointerdown", (event) => {
    if (onControl(event)) return;
    const p = local(event);
    const onOrb = Math.hypot(p.x - cx, p.y - cy) < radius * 1.05;
    drag.moved = 0;
    if (options.drag && onOrb) {
      drag.active = true;
      drag.lastX = event.clientX;
      drag.lastTime = event.timeStamp;
      drag.velocity = 0;
      host.setPointerCapture(event.pointerId);
    }
  });

  const release = (event: PointerEvent) => {
    if (onControl(event)) return;
    const wasDrag = drag.active && drag.moved > 6;
    if (drag.active) {
      drag.active = false;
      extraSpin = Math.max(-6, Math.min(6, drag.velocity));
    }
    if (!wasDrag) {
      const p = local(event);
      pingAt(p.x, p.y, 0, performance.now());
      navigator.vibrate?.(8);
    }
  };
  host.addEventListener("pointerup", release);
  host.addEventListener("pointercancel", () => {
    drag.active = false;
  });
}
