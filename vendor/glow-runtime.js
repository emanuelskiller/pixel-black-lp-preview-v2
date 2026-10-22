/*!
 * glow-core — gerador de gradientes de luz abstratos a partir de um hex.
 * Lógica: uma forma (o "vetor") gera um campo de distância; o campo vira energia
 * por camadas de blur empilhadas (núcleo, bloom, halo, névoa); a energia é
 * mapeada numa rampa de cor gerada do hex (OKLCH, com desvio de matiz).
 * Sem dependências. Roda no browser (window.GlowGradient) e no node (require).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.GlowGradient = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var VERSION = '0.7.0';
  var LUT_SIZE = 1024;

  // ------------------------------------------------------------------ utils
  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }
  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function mix(a, b, t) { return a + (b - a) * t; }
  function smooth(a, b, x) { var t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); }

  function mulberry32(seed) {
    var a = seed >>> 0;
    return function () {
      a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function hash3(x, y, s) {
    var h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(s | 0, 2246822519);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h ^= h >>> 16;
    return (h >>> 0) / 4294967296;
  }

  function vnoise(x, y, s) {
    var ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;
    var a = hash3(ix, iy, s), b = hash3(ix + 1, iy, s), c = hash3(ix, iy + 1, s), d = hash3(ix + 1, iy + 1, s);
    var ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);
    return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;
  }

  function fbm(x, y, s) {
    return (vnoise(x, y, s) * 0.5 + vnoise(x * 2.03, y * 2.03, s + 17) * 0.25 + vnoise(x * 4.11, y * 4.11, s + 34) * 0.125) / 0.875;
  }

  // ------------------------------------------------------------------ color
  function hexToRgb(hex) {
    var n = parseInt(hex.slice(1), 16);
    return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];
  }
  function rgbToHex(c) {
    return '#' + c.map(function (v) {
      var x = Math.round(clamp01(v) * 255);
      return (x < 16 ? '0' : '') + x.toString(16);
    }).join('').toUpperCase();
  }
  function toLin(c) { return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }
  function toSrgb(c) { c = clamp01(c); return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055; }

  function linToOklab(r, g, b) {
    var l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);
    var m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);
    var s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);
    return [
      0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,
      1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,
      0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s
    ];
  }
  function oklabToLin(L, a, b) {
    var l = L + 0.3963377774 * a + 0.2158037573 * b;
    var m = L - 0.1055613458 * a - 0.0638541728 * b;
    var s = L - 0.0894841775 * a - 1.2914855480 * b;
    l = l * l * l; m = m * m * m; s = s * s * s;
    return [
      4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,
      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,
      -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s
    ];
  }
  function inGamut(c) {
    return c[0] >= -1e-4 && c[0] <= 1.0001 && c[1] >= -1e-4 && c[1] <= 1.0001 && c[2] >= -1e-4 && c[2] <= 1.0001;
  }
  function hexToOklch(hex) {
    var c = hexToRgb(hex);
    var lab = linToOklab(toLin(c[0]), toLin(c[1]), toLin(c[2]));
    var h = Math.atan2(lab[2], lab[1]) * 180 / Math.PI;
    return [lab[0], Math.hypot(lab[1], lab[2]), h < 0 ? h + 360 : h];
  }
  // OKLCH → sRGB (0..1). Fora do gamut, reduz croma mantendo L e matiz.
  function oklchToSrgb(L, C, h) {
    var hr = h * Math.PI / 180, ca = Math.cos(hr), sa = Math.sin(hr);
    var rgb = oklabToLin(L, C * ca, C * sa);
    if (!inGamut(rgb)) {
      var lo = 0, hi = C;
      for (var i = 0; i < 18; i++) {
        var mid = (lo + hi) / 2;
        if (inGamut(oklabToLin(L, mid * ca, mid * sa))) lo = mid; else hi = mid;
      }
      rgb = oklabToLin(L, lo * ca, lo * sa);
    }
    return [toSrgb(rgb[0]), toSrgb(rgb[1]), toSrgb(rgb[2])];
  }
  function srgbLuma(c) { return 0.2126 * toLin(c[0]) + 0.7152 * toLin(c[1]) + 0.0722 * toLin(c[2]); }

  // Distância de matiz assinada (caminho mais curto) de h até alvo.
  function hueDelta(h, target) { return ((target - h + 540) % 360) - 180; }

  var HUE_WARM = 105; // amarelo em OKLCH: a luz "esquenta" rumo a ele, a sombra foge dele
  var PALETTE_DRIFT = { mono: 0.12, analog: 0.38, thermal: 1, duo: 0.3, object: 0.12 };
  var GRAD_ROWS = 32; // rampas pré-misturadas ao longo do gradiente do objeto
  var MAX_GSTOPS = 16;

  /**
   * Rampa fundo → luz gerada de um hex.
   * mode 'dark': fundo escuro → base → núcleo quase branco (luz emitida).
   * mode 'light': fundo claro → tint → base → sombra profunda (tinta sobre papel).
   * drift 0 = monocromático; 1 = térmico (atravessa matizes).
   * bg: hex do fundo ('' = automático, derivado do hex principal). O stop 0 é sempre o fundo exato.
   */
  function bgAuto(hex, mode, depth, drift) {
    var base = hexToOklch(hex), C0 = base[1], h0 = base[2];
    if (mode === 'light') return [0.975, Math.min(C0 * 0.05, 0.01), h0];
    var dWarm = hueDelta(h0, HUE_WARM); if (Math.abs(dWarm) < 1) dWarm = -1;
    var loShift = -Math.sign(dWarm) * 26 * Math.min(1, drift * 1.6);
    return [depth, Math.min(Math.max(C0, 0.02) * 0.35, 0.05), h0 + loShift];
  }

  function lchToLab(s) { var r = s[2] * Math.PI / 180; return [s[0], s[1] * Math.cos(r), s[1] * Math.sin(r)]; }
  function labToSrgb(L, a, b) {
    var h = Math.atan2(b, a) * 180 / Math.PI;
    return oklchToSrgb(L, Math.hypot(a, b), h < 0 ? h + 360 : h);
  }

  function buildRamp(hex, drift, opt) {
    if (typeof opt === 'number') opt = { depth: opt };
    opt = opt || {};
    var mode = opt.mode === 'light' ? 'light' : 'dark', depth = opt.depth !== undefined ? opt.depth : 0.12;
    var base = hexToOklch(hex), L0 = base[0], C0 = base[1], h0 = base[2];
    var dWarm = hueDelta(h0, HUE_WARM);
    if (Math.abs(dWarm) < 1) dWarm = -1; // base já amarela: sombra vai pro laranja/vermelho
    var hot = clamp01((drift - 0.4) / 0.6);
    var hiShift = dWarm * drift * (hot > 0 ? 1 : 0.55);
    var loShift = -Math.sign(dWarm) * 26 * Math.min(1, drift * 1.6);
    var Cv = Math.max(C0, 0.02);
    var bgL, bgLab, bgRgb;
    if (opt.bg && HEX.test(opt.bg)) {
      var bo = hexToOklch(opt.bg); bgL = bo[0]; bgLab = lchToLab(bo); bgRgb = hexToRgb(opt.bg);
    } else {
      var ba = bgAuto(hex, mode, depth, drift); bgL = ba[0]; bgLab = lchToLab(ba); bgRgb = oklchToSrgb(ba[0], ba[1], ba[2]);
    }
    var stops;
    if (mode === 'light') {
      var Lm = clamp(L0, 0.45, 0.7);
      var lo = loShift * Math.max(drift, 0.3) * 1.4;
      // pastel na maior parte da rampa; o tom cheio e a sombra só no pico
      stops = [
        [0.00, bgL, 0, 0],
        [0.30, mix(bgL, Lm, 0.22), Cv * 0.32, h0 + hiShift * 0.6],
        [0.58, mix(bgL, Lm, 0.55), Cv * 0.72, h0 + hiShift * 0.3],
        [0.80, Lm + 0.04, Cv * 0.98, h0],
        [0.93, Lm - 0.08, Cv, h0 + lo * 0.5],
        [1.00, Math.max(0.22, Lm - 0.2), Cv * 0.85, h0 + lo]
      ];
    } else {
      var Lb = clamp(L0, 0.46, 0.72);
      stops = [
        [0.00, bgL, 0, 0],
        [0.24, mix(bgL, Lb, 0.42), Cv * 0.88, h0 + loShift * 0.7],
        [0.48, Lb, Cv, h0],
        [0.70, mix(Lb, 0.9, 0.5), Cv * mix(0.72, 1.05, hot), h0 + hiShift * 0.5],
        [0.86, 0.92, Cv * mix(0.36, 0.95, hot), h0 + hiShift],
        [1.00, 0.985, mix(0.012, 0.04, hot), h0 + hiShift]
      ];
    }
    var custom = !!(opt.bg && HEX.test(opt.bg));
    var lut = new Float32Array(LUT_SIZE * 3);
    var j = 0;
    for (var i = 0; i < LUT_SIZE; i++) {
      var t = i / (LUT_SIZE - 1);
      while (j < stops.length - 2 && t > stops[j + 1][0]) j++;
      var a = stops[j], b = stops[j + 1];
      var lin = (t - a[0]) / (b[0] - a[0]);
      var u = smooth(0, 1, lin) * 0.35 + lin * 0.65;
      var c;
      if (custom && j <= 1) {
        // fundo escolhido: vai direto do fundo ao tom base em OKLab, sem o tom de sombra no meio (evita franja)
        var tb = (t - stops[0][0]) / (stops[2][0] - stops[0][0]);
        var ub = smooth(0, 1, tb) * 0.35 + tb * 0.65;
        var lb2 = lchToLab([stops[2][1], stops[2][2], stops[2][3]]);
        c = labToSrgb(mix(bgLab[0], lb2[0], ub), mix(bgLab[1], lb2[1], ub), mix(bgLab[2], lb2[2], ub));
      } else if (j === 0) {
        // fundo → primeiro tom em OKLab (fundo pode ter matiz indefinido / ser de outra cor)
        var lb = lchToLab([b[1], b[2], b[3]]);
        c = labToSrgb(mix(bgLab[0], lb[0], u), mix(bgLab[1], lb[1], u), mix(bgLab[2], lb[2], u));
      } else {
        c = oklchToSrgb(mix(a[1], b[1], u), mix(a[2], b[2], u), mix(a[3], b[3], u));
      }
      lut[i * 3] = c[0]; lut[i * 3 + 1] = c[1]; lut[i * 3 + 2] = c[2];
    }
    lut[0] = bgRgb[0]; lut[1] = bgRgb[1]; lut[2] = bgRgb[2];
    var hexStops = stops.map(function (s, k) { return k === 0 ? rgbToHex(bgRgb) : rgbToHex(oklchToSrgb(s[1], s[2], s[3])); });
    return { lut: lut, bg: bgRgb, stops: hexStops };
  }

  function rampColor(ramp, t) {
    var i = Math.round(clamp01(t) * (LUT_SIZE - 1)) * 3;
    return [ramp.lut[i], ramp.lut[i + 1], ramp.lut[i + 2]];
  }

  // ------------------------------------------------------------------ params
  var SHAPES = ['eclipse', 'horizon', 'aurora', 'plasma', 'bloom', 'silk', 'veil', 'flow', 'fold', 'curtain', 'vector', 'draw'];
  var VMODES = ['outline', 'fill', 'rim'];
  var STROKE_SHAPES = { draw: 1 };
  var MODES = ['dark', 'light'];
  var MAX_PATHS = 8, MAX_PATH_PTS = 400;
  var PALETTES = ['mono', 'analog', 'thermal', 'duo', 'object'];
  var FORMATS = {
    '9:16': [1080, 1920],
    '4:5': [1080, 1350],
    '1:1': [1600, 1600],
    '16:9': [1920, 1080],
    custom: null       // usa cw × ch (ex.: tamanho do frame no Figma)
  };

  var DEFAULTS = {
    shape: 'eclipse',
    color: '#7A2BF0',
    color2: '#FF4D2E',
    palette: 'analog',
    intensity: 0.6,   // até onde a rampa chega: glow de cor → núcleo estourado no branco
    spread: 0.55,     // tamanho das camadas de blur
    angle: 35,        // direção da luz, graus (0 = direita, 90 = cima)
    curvature: 0.5,
    turbulence: 0,
    occluder: false,  // esfera escura
    grain: 0.3,
    depth: 0.12,      // luminância do fundo
    elements: 4,
    sharpness: 0.6,   // nitidez do núcleo
    contrast: 1,
    drift: -1,        // -1 = automático pelo modo de paleta
    flare: 0.5,
    soften: 0,        // desfoque da forma inteira (blur no vetor): tira a aresta dura
    seed: 1,
    format: '9:16',
    scale: 1,
    mode: 'dark',     // dark = luz emitida sobre escuro; light = tinta sobre claro
    bg: '',           // hex do fundo; '' = automático
    transparent: false,
    fadeT: 0, fadeR: 0, fadeB: 0, fadeL: 0,  // fade nas bordas (0..1 = até metade do quadro)
    motion: { flow: 0.35, speed: 0.3, breathe: 0.15 }, // só pro runtime animado; não muda o PNG
    cw: 1080, ch: 1920, // formato custom
    vector: null,     // shape vetorial: { c: [[x,y,...]], z: [1|0], eo: 0|1 } em unidades do quadro
    vmode: 'fill',    // outline | fill | rim
    gfill: null,      // gradiente puxado do objeto: { t: 'l'|'r', m: [6] quadro→espaço do gradiente, s: [[pos, hex]...] }
    objColor: true,   // puxa a cor (sólida ou gradiente) do SVG/shape selecionado
    paths: []         // forma desenhada: [[x,y,x,y...], ...] em unidades do menor lado, origem no centro
  };

  var SHAPE_PRESETS = {
    eclipse: { label: 'Eclipse', angle: 35, intensity: 0.66, spread: 0.55, curvature: 0.55, turbulence: 0, sharpness: 0.75, flare: 0.45, occluder: false, elements: 1 },
    horizon: { label: 'Horizonte', angle: 90, intensity: 0.72, spread: 0.62, curvature: 0.22, turbulence: 0, sharpness: 0.85, flare: 0.9, occluder: false, elements: 1 },
    aurora: { label: 'Aurora', angle: 22, intensity: 0.6, spread: 0.7, curvature: 0.4, turbulence: 0.12, sharpness: 0.1, flare: 0.55, occluder: true, elements: 5 },
    plasma: { label: 'Plasma', angle: 62, intensity: 0.76, spread: 0.42, curvature: 0.5, turbulence: 0.62, sharpness: 0.3, flare: 0.3, occluder: false, elements: 4 },
    bloom: { label: 'Bloom', angle: 40, intensity: 0.5, spread: 0.75, curvature: 0.45, turbulence: 0.35, sharpness: 0, flare: 0.25, occluder: false, elements: 3 },
    silk: { label: 'Seda', angle: 100, intensity: 0.55, spread: 0.6, curvature: 0.6, turbulence: 0.3, sharpness: 0.55, flare: 0.3, occluder: false, elements: 4 },
    veil: { label: 'Véu', angle: 0, intensity: 0.5, spread: 0.6, curvature: 0.6, turbulence: 0.15, sharpness: 0.6, flare: 0.25, occluder: false, elements: 2 },
    flow: { label: 'Fluxo', angle: 125, intensity: 0.52, spread: 0.5, curvature: 0.45, turbulence: 0.12, sharpness: 0.65, flare: 0.3, occluder: false, elements: 4 },
    fold: { label: 'Dobra', angle: 215, intensity: 0.6, spread: 0.6, curvature: 0.5, turbulence: 0.05, sharpness: 0.7, flare: 0.4, occluder: false, elements: 1 },
    curtain: { label: 'Cortina', angle: 90, intensity: 0.6, spread: 0.55, curvature: 0.5, turbulence: 0.04, sharpness: 0.5, flare: 0.35, occluder: false, elements: 3 },
    vector: { label: 'Vetor', angle: 60, intensity: 0.6, spread: 0.45, curvature: 0.5, turbulence: 0, sharpness: 0.6, flare: 0.35, occluder: false, elements: 1 },
    draw: { label: 'Desenho', angle: 35, intensity: 0.54, spread: 0.5, curvature: 0.5, turbulence: 0.08, sharpness: 0.6, flare: 0.45, occluder: false, elements: 3 }
  };
  var SHAPE_KEYS = ['angle', 'intensity', 'spread', 'curvature', 'turbulence', 'sharpness', 'flare', 'occluder', 'elements'];

  var RANGES = {
    intensity: [0, 1], spread: [0, 1], angle: [-3600, 3600], curvature: [0, 1], turbulence: [0, 1],
    grain: [0, 1], depth: [0, 0.3], elements: [1, 8], sharpness: [0, 1], contrast: [0.5, 2],
    drift: [-1, 1], flare: [0, 1], soften: [0, 1], seed: [0, 999999],
    fadeT: [0, 1], fadeR: [0, 1], fadeB: [0, 1], fadeL: [0, 1]
  };
  var HEX = /^#[0-9A-F]{6}$/;

  function normalize(p) {
    var o = {}, k;
    p = p || {};
    for (k in DEFAULTS) o[k] = DEFAULTS[k];
    for (k in RANGES) {
      var v = Number(p[k]);
      if (p[k] !== undefined && isFinite(v)) o[k] = clamp(v, RANGES[k][0], RANGES[k][1]);
    }
    o.angle = ((o.angle % 360) + 360) % 360;
    o.elements = Math.round(o.elements);
    o.seed = Math.round(o.seed);
    ['color', 'color2'].forEach(function (c) {
      var v = typeof p[c] === 'string' ? p[c].trim().toUpperCase() : '';
      if (v && v[0] !== '#') v = '#' + v;
      if (HEX.test(v)) o[c] = v;
    });
    if (SHAPES.indexOf(p.shape) >= 0) o.shape = p.shape;
    if (PALETTES.indexOf(p.palette) >= 0) o.palette = p.palette;
    if (p.format in FORMATS) o.format = p.format;
    ['cw', 'ch'].forEach(function (k2) { var v2 = Math.round(Number(p[k2])); if (isFinite(v2) && v2 >= 16) o[k2] = Math.min(8192, v2); });
    if (VMODES.indexOf(p.vmode) >= 0) o.vmode = p.vmode;
    o.vector = normVector(p.vector);
    o.gfill = normGfill(p.gfill);
    if (typeof p.objColor === 'boolean') o.objColor = p.objColor;
    if (o.palette === 'object' && !o.gfill) o.palette = 'analog';
    if (o.palette !== 'object') o.gfill = null; // gradiente só vale na palette do objeto
    if (p.scale === 2 || p.scale === '2') o.scale = 2;
    if (typeof p.occluder === 'boolean') o.occluder = p.occluder;
    if (MODES.indexOf(p.mode) >= 0) o.mode = p.mode;
    if (typeof p.transparent === 'boolean') o.transparent = p.transparent;
    if (typeof p.bg === 'string') {
      var bv = p.bg.trim().toUpperCase();
      if (bv && bv[0] !== '#') bv = '#' + bv;
      o.bg = HEX.test(bv) ? bv : '';
    }
    var mo = p.motion && typeof p.motion === 'object' ? p.motion : {};
    o.motion = {
      flow: isFinite(Number(mo.flow)) && mo.flow !== undefined ? clamp(Number(mo.flow), 0, 1) : DEFAULTS.motion.flow,
      speed: isFinite(Number(mo.speed)) && mo.speed !== undefined ? clamp(Number(mo.speed), 0, 1) : DEFAULTS.motion.speed,
      breathe: isFinite(Number(mo.breathe)) && mo.breathe !== undefined ? clamp(Number(mo.breathe), 0, 1) : DEFAULTS.motion.breathe
    };
    o.paths = [];
    if (Array.isArray(p.paths)) {
      for (var pi = 0; pi < p.paths.length && o.paths.length < MAX_PATHS; pi++) {
        var src = p.paths[pi];
        if (!Array.isArray(src) || src.length < 4) continue;
        var clean = [];
        for (var q = 0; q + 1 < src.length && clean.length < MAX_PATH_PTS * 2; q += 2) {
          var x = Number(src[q]), y = Number(src[q + 1]);
          if (!isFinite(x) || !isFinite(y)) { clean = null; break; }
          clean.push(Math.round(clamp(x, -3, 3) * 1e4) / 1e4, Math.round(clamp(y, -3, 3) * 1e4) / 1e4);
        }
        if (clean && clean.length >= 4) o.paths.push(clean);
      }
    }
    return o;
  }

  function preset(shape, base) {
    var o = normalize(base || {});
    var sp = SHAPE_PRESETS[shape] || SHAPE_PRESETS.eclipse;
    o.shape = SHAPE_PRESETS[shape] ? shape : 'eclipse';
    SHAPE_KEYS.forEach(function (k) { o[k] = sp[k]; });
    return normalize(o);
  }

  function outputSize(p) {
    var f = p.format === 'custom' ? [p.cw, p.ch] : FORMATS[p.format] || FORMATS['9:16'];
    var sc = p.scale;
    // teto de 8192 px no maior lado
    if (Math.max(f[0], f[1]) * sc > 8192) sc = 8192 / Math.max(f[0], f[1]);
    return [Math.round(f[0] * sc), Math.round(f[1] * sc)];
  }

  function normVector(v) {
    if (!v || !Array.isArray(v.c)) return null;
    var c = [], z = [], total = 0;
    for (var i = 0; i < v.c.length && c.length < MAX_VEC_CONTOURS; i++) {
      var src = v.c[i];
      if (!Array.isArray(src) || src.length < 4) continue;
      var room = MAX_VEC_PTS - total, cl = [];
      if (room < 2) break;
      for (var q = 0; q + 1 < src.length && cl.length < room * 2; q += 2) {
        var x = Number(src[q]), y = Number(src[q + 1]);
        if (!isFinite(x) || !isFinite(y)) { cl = null; break; }
        cl.push(Math.round(clamp(x, -4, 4) * 1e4) / 1e4, Math.round(clamp(y, -4, 4) * 1e4) / 1e4);
      }
      if (!cl || cl.length < 4) continue;
      c.push(cl); z.push(Array.isArray(v.z) && v.z[i] ? 1 : 0); total += cl.length / 2;
    }
    return c.length ? { c: c, z: z, eo: v.eo ? 1 : 0 } : null;
  }

  function normGfill(g) {
    if (!g || !Array.isArray(g.s) || !Array.isArray(g.m) || g.m.length !== 6) return null;
    var m = [];
    for (var i = 0; i < 6; i++) { var v = Number(g.m[i]); if (!isFinite(v)) return null; m.push(Math.round(clamp(v, -1e4, 1e4) * 1e4) / 1e4); }
    var s = [];
    for (var j = 0; j < g.s.length && s.length < MAX_GSTOPS; j++) {
      var st = g.s[j]; if (!Array.isArray(st)) continue;
      var pos = Number(st[0]), hx = typeof st[1] === 'string' ? st[1].trim().toUpperCase() : '';
      if (hx && hx[0] !== '#') hx = '#' + hx;
      if (!isFinite(pos) || !HEX.test(hx)) continue;
      var al = st[2] === undefined ? 1 : Number(st[2]);
      s.push([Math.round(clamp(pos, 0, 1) * 1e4) / 1e4, hx, isFinite(al) ? Math.round(clamp01(al) * 1000) / 1000 : 1]);
    }
    s.sort(function (a, b) { return a[0] - b[0]; });
    if (s.length < 2) return null;
    return { t: g.t === 'r' ? 'r' : 'l', m: m, s: s };
  }

  function driftOf(p) { return p.drift >= 0 ? p.drift : PALETTE_DRIFT[p.palette]; }

  // palette que precisa de mapa de mistura por pixel (duo: ruído; object: posição no gradiente)
  function needsMix(p) { return p.palette === 'duo' || (p.palette === 'object' && !!p.gfill); }

  // posição 0..1 do pixel (unidades do quadro) dentro do gradiente do objeto (spread = pad, como no SVG)
  function gradPos(g, x, y) {
    var m = g.m, u = m[0] * x + m[2] * y + m[4];
    if (g.t === 'r') { var v = m[1] * x + m[3] * y + m[5]; u = Math.sqrt(u * u + v * v); }
    return u < 0 ? 0 : u > 1 ? 1 : u;
  }

  function ramps(p) {
    var d = driftOf(p);
    var o = { mode: p.mode, depth: p.depth, bg: p.bg };
    if (p.palette === 'object' && p.gfill) {
      // uma rampa por stop, todas sobre o MESMO fundo (o do 1º stop) pra não aparecer emenda de fundo
      var a0 = buildRamp(p.gfill.s[0][1], d, o);
      var og = { mode: p.mode, depth: p.depth, bg: p.bg || rgbToHex(a0.bg) };
      var list = p.gfill.s.map(function (st) { return buildRamp(st[1], d, og); });
      var pos = p.gfill.s.map(function (st) { return st[0]; });
      var R = GRAD_ROWS, N = LUT_SIZE * 3, rows = new Float32Array(R * N);
      for (var r = 0; r < R; r++) {
        var tg = r / (R - 1), j = 0;
        while (j < pos.length - 2 && tg > pos[j + 1]) j++;
        var span = pos[j + 1] - pos[j], f = span > 1e-6 ? clamp01((tg - pos[j]) / span) : (tg >= pos[j + 1] ? 1 : 0);
        var A = list[j].lut, B = list[j + 1].lut, off = r * N;
        for (var q = 0; q < N; q++) rows[off + q] = A[q] + (B[q] - A[q]) * f;
      }
      var alpha = null;
      if (p.gfill.s.some(function (st) { return st[2] < 1; })) {
        alpha = new Float32Array(256);
        for (var ai = 0; ai < 256; ai++) {
          var ta = ai / 255, k2 = 0;
          while (k2 < pos.length - 2 && ta > pos[k2 + 1]) k2++;
          var sp2 = pos[k2 + 1] - pos[k2], fa = sp2 > 1e-6 ? clamp01((ta - pos[k2]) / sp2) : (ta >= pos[k2 + 1] ? 1 : 0);
          alpha[ai] = mix(p.gfill.s[k2][2], p.gfill.s[k2 + 1][2], fa);
        }
      }
      return { a: list[0], b: null, g: { rows: rows, n: R, t: p.gfill.t, m: p.gfill.m, alpha: alpha, stops: list.map(function (l) { return l.stops; }) } };
    }
    var a = buildRamp(p.color, d, o);
    return { a: a, b: p.palette === 'duo' ? buildRamp(p.color2, d, o) : null };
  }

  // ------------------------------------------------------------------ strokes
  // Formas por traço: qualquer polilinha vira luz (distância até o vetor → camadas de blur).
  function chaikin(pts, closed, iters) {
    for (var it = 0; it < iters; it++) {
      var n = pts.length / 2, out = [];
      if (n < 3) return pts;
      if (!closed) out.push(pts[0], pts[1]);
      var last = closed ? n : n - 1;
      for (var i = 0; i < last; i++) {
        var j = (i + 1) % n;
        var x0 = pts[i * 2], y0 = pts[i * 2 + 1], x1 = pts[j * 2], y1 = pts[j * 2 + 1];
        out.push(0.75 * x0 + 0.25 * x1, 0.75 * y0 + 0.25 * y1, 0.25 * x0 + 0.75 * x1, 0.25 * y0 + 0.75 * y1);
      }
      if (!closed) out.push(pts[pts.length - 2], pts[pts.length - 1]);
      pts = out;
    }
    return pts;
  }

  function resample(pts, closed, spacing, cap) {
    var n = pts.length / 2, total = 0, i;
    if (n < 2) return pts.slice();
    var segs = closed ? n : n - 1;
    for (i = 0; i < segs; i++) {
      var j = (i + 1) % n;
      total += Math.hypot(pts[j * 2] - pts[i * 2], pts[j * 2 + 1] - pts[i * 2 + 1]);
    }
    if (total < 1e-6) return [pts[0], pts[1], pts[0] + 1e-4, pts[1]];
    var count = Math.max(2, Math.min(cap, Math.ceil(total / spacing)));
    var step = total / (closed ? count : count - 1);
    var out = [pts[0], pts[1]], acc = 0, target = step;
    for (i = 0; i < segs && out.length / 2 < count; i++) {
      var k = (i + 1) % n;
      var ax_ = pts[i * 2], ay_ = pts[i * 2 + 1], bx = pts[k * 2], by = pts[k * 2 + 1];
      var L = Math.hypot(bx - ax_, by - ay_);
      while (L > 0 && acc + L >= target && out.length / 2 < count) {
        var t = (target - acc) / L;
        out.push(ax_ + (bx - ax_) * t, ay_ + (by - ay_) * t);
        target += step;
      }
      acc += L;
    }
    if (!closed) { out[out.length - 2] = pts[pts.length - 2]; out[out.length - 1] = pts[pts.length - 1]; }
    return out;
  }

  var CHUNK = 12;
  // Prepara um traço: segmentos + comprimento acumulado + caixas por bloco (aceleração).
  function prepStroke(st, smoothIters) {
    var pts = chaikin(st.pts, st.closed, smoothIters || 0);
    pts = resample(pts, st.closed, 0.014, 360);
    if (st.closed) pts = pts.concat([pts[0], pts[1]]);
    var n = pts.length / 2 - 1;
    var seg = new Float64Array(n * 6); // ax, ay, ex, ey, len2, cum
    var cum = 0;
    for (var i = 0; i < n; i++) {
      var ax_ = pts[i * 2], ay_ = pts[i * 2 + 1], ex = pts[i * 2 + 2] - ax_, ey = pts[i * 2 + 3] - ay_;
      var l2 = ex * ex + ey * ey;
      seg[i * 6] = ax_; seg[i * 6 + 1] = ay_; seg[i * 6 + 2] = ex; seg[i * 6 + 3] = ey; seg[i * 6 + 4] = l2 || 1e-12; seg[i * 6 + 5] = cum;
      cum += Math.sqrt(l2);
    }
    var nc = Math.ceil(n / CHUNK), box = new Float64Array(nc * 4);
    for (var c = 0; c < nc; c++) {
      var x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
      for (var s = c * CHUNK; s < Math.min(n, (c + 1) * CHUNK); s++) {
        var px = seg[s * 6], py = seg[s * 6 + 1], qx = px + seg[s * 6 + 2], qy = py + seg[s * 6 + 3];
        x0 = Math.min(x0, px, qx); y0 = Math.min(y0, py, qy); x1 = Math.max(x1, px, qx); y1 = Math.max(y1, py, qy);
      }
      box[c * 4] = x0; box[c * 4 + 1] = y0; box[c * 4 + 2] = x1; box[c * 4 + 3] = y1;
    }
    return {
      seg: seg, n: n, box: box, nc: nc, total: cum || 1e-6, pts: pts,
      closed: st.closed, amp: st.amp, thick: st.thick || 1,
      ns: st.ns || 0,
      ex0: pts[0], ey0: pts[1], ex1: pts[pts.length - 2], ey1: pts[pts.length - 1],
      r0: Math.max(0.03, (st.taper ? st.taper[0] : 0.05) * cum), r1: Math.max(0.03, (st.taper ? st.taper[1] : 0.05) * cum)
    };
  }

  // distância mínima ao traço + posição ao longo dele (0..1)
  var _hit = [0, 0];
  function strokeDist(st, x, y) {
    var best = 1e18, bi = 0, bt = 0, seg = st.seg, box = st.box;
    for (var c = 0; c < st.nc; c++) {
      var bx = x < box[c * 4] ? box[c * 4] - x : x > box[c * 4 + 2] ? x - box[c * 4 + 2] : 0;
      var by = y < box[c * 4 + 1] ? box[c * 4 + 1] - y : y > box[c * 4 + 3] ? y - box[c * 4 + 3] : 0;
      if (bx * bx + by * by >= best) continue;
      var end = Math.min(st.n, (c + 1) * CHUNK);
      for (var i = c * CHUNK; i < end; i++) {
        var o = i * 6, dx = x - seg[o], dy = y - seg[o + 1];
        var t = (dx * seg[o + 2] + dy * seg[o + 3]) / seg[o + 4];
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        var qx = dx - t * seg[o + 2], qy = dy - t * seg[o + 3], d2 = qx * qx + qy * qy;
        if (d2 < best) { best = d2; bi = i; bt = t; }
      }
    }
    _hit[0] = Math.sqrt(best);
    _hit[1] = (seg[bi * 6 + 5] + bt * Math.sqrt(seg[bi * 6 + 4])) / st.total;
    return _hit;
  }

  function cubic(p0, p1, p2, p3, n) {
    var out = [];
    for (var i = 0; i <= n; i++) {
      var t = i / n, u = 1 - t, a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;
      out.push(a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]);
    }
    return out;
  }

  // Gera os traços de cada forma procedural. Unidades: menor lado = 1, origem no centro.
  function genStrokes(p, rng, F) {
    var Dx = F.Dx, Dy = F.Dy, Nx = F.Nx, Ny = F.Ny, ax = F.ax, ay = F.ay, ext = F.ext;
    var cv = p.curvature, n = p.elements, out = [], i, k, t;
    function rot(x, y, a) { var c = Math.cos(a), s = Math.sin(a); return [x * c - y * s, x * s + y * c]; }
    if (p.shape === 'draw') {
      var base2 = [];
      if (p.paths && p.paths.length) {
        p.paths.forEach(function (pp2) { base2.push({ pts: pp2.slice(), closed: false }); });
      } else {
        // gesto procedural enquanto não há desenho
        var g0 = [-Dx * ext * 0.9 + Nx * 0.3 * (rng() - 0.5), -Dy * ext * 0.9 + Ny * 0.3 * (rng() - 0.5)];
        var g3 = [Dx * ext * 0.9 + Nx * 0.4 * (rng() - 0.5), Dy * ext * 0.9 + Ny * 0.4 * (rng() - 0.5)];
        var g1 = [mix(g0[0], g3[0], 0.33) + Nx * mix(-0.7, 0.7, rng()), mix(g0[1], g3[1], 0.33) + Ny * mix(-0.7, 0.7, rng())];
        var g2 = [mix(g0[0], g3[0], 0.66) + Nx * mix(-0.7, 0.7, rng()), mix(g0[1], g3[1], 0.66) + Ny * mix(-0.7, 0.7, rng())];
        base2.push({ pts: cubic(g0, g1, g2, g3, 80), closed: false });
      }
      // elementos = ecos paralelos do traço
      var spacing = mix(0.035, 0.09, rng());
      base2.forEach(function (b, bi) {
        var bp2 = resample(chaikin(b.pts, false, 2), false, 0.01, 400), m2 = bp2.length / 2, nrm = [];
        for (i = 0; i < m2; i++) {
          var i0 = Math.max(0, i - 3), i1 = Math.min(m2 - 1, i + 3);
          var tx2 = bp2[i1 * 2] - bp2[i0 * 2], ty2 = bp2[i1 * 2 + 1] - bp2[i0 * 2 + 1], tl = Math.hypot(tx2, ty2) || 1;
          nrm.push(-ty2 / tl, tx2 / tl);
        }
        for (k = 0; k < n; k++) {
          var o2 = k === 0 ? 0 : Math.ceil(k / 2) * (k % 2 ? 1 : -1) * spacing;
          var ep = [];
          for (i = 0; i < m2; i++) ep.push(bp2[i * 2] + nrm[i * 2] * o2, bp2[i * 2 + 1] + nrm[i * 2 + 1] * o2);
          out.push({ pts: ep, closed: false, amp: Math.pow(0.72, k), thick: 1, taper: [0.06, 0.12], ns: bi * 9.1 + k * 2.3, smooth: 1 + Math.round(cv * 3) });
        }
      });
    }
    return out;
  }

  // ------------------------------------------------------------------ geometria vetorial
  var MAX_VEC_PTS = 1600, MAX_VEC_CONTOURS = 96;
  // shape de exemplo (marca abstrata) até o usuário colar/selecionar um vetor
  var SAMPLE_VECTOR = (function () {
    var c = [], z = [];
    function ring(cx, cy, r, k, rot, sq) {
      var o = [];
      for (var i = 0; i < k; i++) {
        var a = rot + i / k * 6.2832, cs = Math.cos(a), sn = Math.sin(a);
        var m = sq ? 1 / Math.pow(Math.pow(Math.abs(cs), 4) + Math.pow(Math.abs(sn), 4), 0.25) : 1;
        o.push(Math.round((cx + cs * r * m) * 1e4) / 1e4, Math.round((cy + sn * r * m) * 1e4) / 1e4);
      }
      return o;
    }
    c.push(ring(-0.06, -0.04, 0.2, 72, 0.3, true)); z.push(1);
    c.push(ring(-0.06, -0.04, 0.11, 56, 0.3, true).reverse()); z.push(1);
    c.push(ring(0.14, 0.15, 0.075, 40, 0, false)); z.push(1);
    return { c: c, z: z, eo: 0 };
  })();

  function boxBlur3(src, W, H, r) {
    var a = new Float32Array(src), b = new Float32Array(W * H), pass, x, y, s, i;
    var inv = 1 / (2 * r + 1);
    for (pass = 0; pass < 3; pass++) {
      for (y = 0; y < H; y++) {
        var row = y * W; s = 0;
        for (i = -r; i <= r; i++) s += a[row + clamp(i, 0, W - 1)];
        for (x = 0; x < W; x++) {
          b[row + x] = s * inv;
          s += a[row + Math.min(W - 1, x + r + 1)] - a[row + Math.max(0, x - r)];
        }
      }
      for (x = 0; x < W; x++) {
        s = 0;
        for (i = -r; i <= r; i++) s += b[clamp(i, 0, H - 1) * W + x];
        for (y = 0; y < H; y++) {
          a[y * W + x] = s * inv;
          s += b[Math.min(H - 1, y + r + 1) * W + x] - b[Math.max(0, y - r) * W + x];
        }
      }
    }
    return a;
  }

  // segmentos + caixas por bloco + normais externas + faixas pro teste dentro/fora
  function vectorGeom(V) {
    var segs = [], i, k;
    var closedAny = false;
    V.c.forEach(function (pts, ci) {
      var closed = !!V.z[ci], n = pts.length / 2;
      if (closed) closedAny = true;
      var last = closed ? n : n - 1;
      for (i = 0; i < last; i++) {
        var j = (i + 1) % n;
        segs.push(pts[i * 2], pts[i * 2 + 1], pts[j * 2], pts[j * 2 + 1], closed ? 1 : 0);
      }
    });
    var n = segs.length / 5;
    var seg = new Float64Array(n * 6), on = new Float32Array(n * 2), cl = new Uint8Array(n);
    for (i = 0; i < n; i++) {
      var ax_ = segs[i * 5], ay_ = segs[i * 5 + 1], ex = segs[i * 5 + 2] - ax_, ey = segs[i * 5 + 3] - ay_, l2 = ex * ex + ey * ey;
      seg[i * 6] = ax_; seg[i * 6 + 1] = ay_; seg[i * 6 + 2] = ex; seg[i * 6 + 3] = ey; seg[i * 6 + 4] = l2 || 1e-12;
      cl[i] = segs[i * 5 + 4];
    }
    // ordena segmentos por posição (Morton grosseiro) pra caixas de bloco apertadas
    var nc = Math.ceil(n / CHUNK), box = new Float64Array(nc * 4);
    for (var c = 0; c < nc; c++) {
      var x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
      for (k = c * CHUNK; k < Math.min(n, (c + 1) * CHUNK); k++) {
        var px = seg[k * 6], py = seg[k * 6 + 1], qx = px + seg[k * 6 + 2], qy = py + seg[k * 6 + 3];
        x0 = Math.min(x0, px, qx); y0 = Math.min(y0, py, qy); x1 = Math.max(x1, px, qx); y1 = Math.max(y1, py, qy);
      }
      box[c * 4] = x0; box[c * 4 + 1] = y0; box[c * 4 + 2] = x1; box[c * 4 + 3] = y1;
    }
    // faixas horizontais: cruzamentos (x, direção) de arestas fechadas no centro de cada faixa
    var by0 = 1e9, by1 = -1e9;
    for (i = 0; i < n; i++) if (cl[i]) { by0 = Math.min(by0, seg[i * 6 + 1], seg[i * 6 + 1] + seg[i * 6 + 3]); by1 = Math.max(by1, seg[i * 6 + 1], seg[i * 6 + 1] + seg[i * 6 + 3]); }
    var NB = closedAny ? 2048 : 0, bandH = closedAny ? (by1 - by0) / NB || 1 : 1, bands = [];
    for (var bi = 0; bi < NB; bi++) {
      var yc = by0 + (bi + 0.5) * bandH, xs = [];
      for (i = 0; i < n; i++) {
        if (!cl[i]) continue;
        var ya = seg[i * 6 + 1], yb = ya + seg[i * 6 + 3];
        if ((ya <= yc && yb > yc) || (yb <= yc && ya > yc)) {
          var t = (yc - ya) / (yb - ya);
          xs.push(seg[i * 6] + t * seg[i * 6 + 2], yb > ya ? 1 : -1);
        }
      }
      // ordena pares por x
      var idx = []; for (k = 0; k < xs.length; k += 2) idx.push(k);
      idx.sort(function (a, b) { return xs[a] - xs[b]; });
      var sx = new Float64Array(idx.length), sd = new Int8Array(idx.length);
      idx.forEach(function (o, m) { sx[m] = xs[o]; sd[m] = xs[o + 1]; });
      bands.push([sx, sd]);
    }
    var eo = !!V.eo;
    function inside(x, y) {
      if (!NB || y < by0 || y >= by1) return false;
      var b = bands[Math.min(NB - 1, ((y - by0) / bandH) | 0)], sx = b[0], sd = b[1], w = 0;
      for (var m = 0; m < sx.length && sx[m] < x; m++) w += sd[m];
      return eo ? (sx.length && countLess(sx, x) % 2 === 1) : w !== 0;
    }
    function countLess(arr, x) { var c2 = 0; while (c2 < arr.length && arr[c2] < x) c2++; return c2; }
    var G = { seg: seg, n: n, box: box, nc: nc, on: on, inside: inside, closedAny: closedAny };
    // normal externa por segmento (teste no ponto médio deslocado)
    for (i = 0; i < n; i++) {
      var L = Math.sqrt(seg[i * 6 + 4]), nx = -seg[i * 6 + 3] / L, ny = seg[i * 6 + 2] / L;
      var mx = seg[i * 6] + seg[i * 6 + 2] / 2, my = seg[i * 6 + 1] + seg[i * 6 + 3] / 2, eps = 0.0015;
      if (cl[i] && inside(mx + nx * eps, my + ny * eps) && !inside(mx - nx * eps, my - ny * eps)) { nx = -nx; ny = -ny; }
      on[i * 2] = nx; on[i * 2 + 1] = ny;
    }
    return G;
  }

  var _vhit = [0, 0];
  function vecDist(G, x, y) {
    var best = 1e18, bi = 0, seg = G.seg, box = G.box;
    for (var c = 0; c < G.nc; c++) {
      var bx = x < box[c * 4] ? box[c * 4] - x : x > box[c * 4 + 2] ? x - box[c * 4 + 2] : 0;
      var by = y < box[c * 4 + 1] ? box[c * 4 + 1] - y : y > box[c * 4 + 3] ? y - box[c * 4 + 3] : 0;
      if (bx * bx + by * by >= best) continue;
      var end = Math.min(G.n, (c + 1) * CHUNK);
      for (var i = c * CHUNK; i < end; i++) {
        var o = i * 6, dx = x - seg[o], dy = y - seg[o + 1];
        var t = (dx * seg[o + 2] + dy * seg[o + 3]) / seg[o + 4];
        t = t < 0 ? 0 : t > 1 ? 1 : t;
        var qx = dx - t * seg[o + 2], qy = dy - t * seg[o + 3], d2 = qx * qx + qy * qy;
        if (d2 < best) { best = d2; bi = i; }
      }
    }
    _vhit[0] = Math.sqrt(best); _vhit[1] = bi;
    return _vhit[0];
  }

  // ------------------------------------------------------------------ SVG → contornos
  // Parser mínimo e sem DOM (roda no worker/node): path d (todos os comandos), rect, circle,
  // ellipse, line, polyline, polygon, transform (matrix/translate/scale/rotate/skew) aninhado em <g>.
  // Curvas são achatadas em polilinhas. Saída em coordenadas do SVG.
  function mmul(a, b) {
    return [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],
      a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];
  }
  function parseTransform(str) {
    var m = [1, 0, 0, 1, 0, 0], re = /(matrix|translate|scale|rotate|skewX|skewY)\s*\(([^)]*)\)/g, r;
    while ((r = re.exec(str || ''))) {
      var a = r[2].trim().split(/[\s,]+/).map(Number), t;
      if (r[1] === 'matrix' && a.length === 6) t = a;
      else if (r[1] === 'translate') t = [1, 0, 0, 1, a[0] || 0, a[1] || 0];
      else if (r[1] === 'scale') t = [a[0], 0, 0, a.length > 1 ? a[1] : a[0], 0, 0];
      else if (r[1] === 'rotate') {
        var an = (a[0] || 0) * Math.PI / 180, c = Math.cos(an), s = Math.sin(an);
        t = [c, s, -s, c, 0, 0];
        if (a.length === 3) t = mmul(mmul([1, 0, 0, 1, a[1], a[2]], t), [1, 0, 0, 1, -a[1], -a[2]]);
      } else if (r[1] === 'skewX') t = [1, 0, Math.tan((a[0] || 0) * Math.PI / 180), 1, 0, 0];
      else if (r[1] === 'skewY') t = [1, Math.tan((a[0] || 0) * Math.PI / 180), 0, 1, 0, 0];
      if (t && t.every(isFinite)) m = mmul(m, t);
    }
    return m;
  }
  function attr(s, name) {
    var r = new RegExp('(?:^|\\s)' + name + '\\s*=\\s*("([^"]*)"|\'([^\']*)\')').exec(s);
    return r ? (r[2] !== undefined ? r[2] : r[3]) : null;
  }
  function num(s, name, d) { var v = parseFloat(attr(s, name)); return isFinite(v) ? v : d; }
  function minv(m) {
    var det = m[0] * m[3] - m[1] * m[2];
    if (!det || !isFinite(det)) return null;
    var id = 1 / det;
    return [m[3] * id, -m[1] * id, -m[2] * id, m[0] * id, (m[2] * m[5] - m[3] * m[4]) * id, (m[1] * m[4] - m[0] * m[5]) * id];
  }

  // ---- cor do SVG (pra puxar a cor do objeto) ----
  var NAMED = { black: '#000000', white: '#FFFFFF', red: '#FF0000', orange: '#FFA500', yellow: '#FFFF00', green: '#008000', lime: '#00FF00', blue: '#0000FF', purple: '#800080', magenta: '#FF00FF', fuchsia: '#FF00FF', cyan: '#00FFFF', aqua: '#00FFFF', pink: '#FFC0CB', gray: '#808080', grey: '#808080' };
  // "#abc" | "#aabbcc" | "#aabbccdd" | rgb()/rgba() | nome → { hex, a } ou null
  function parseColor(v) {
    v = String(v || '').trim().toLowerCase();
    if (!v || v === 'none' || v === 'transparent' || v === 'currentcolor' || v === 'inherit') return null;
    if (NAMED[v]) return { hex: NAMED[v], a: 1 };
    var m = /^#([0-9a-f]{3,8})$/.exec(v);
    if (m) {
      var h = m[1];
      if (h.length === 3 || h.length === 4) h = h.split('').map(function (c) { return c + c; }).join('');
      if (h.length !== 6 && h.length !== 8) return null;
      return { hex: '#' + h.slice(0, 6).toUpperCase(), a: h.length === 8 ? parseInt(h.slice(6), 16) / 255 : 1 };
    }
    m = /^rgba?\(([^)]*)\)$/.exec(v);
    if (m) {
      var p = m[1].split(/[\s,\/]+/).filter(Boolean);
      if (p.length < 3) return null;
      var ch = p.slice(0, 3).map(function (x) { return /%$/.test(x) ? parseFloat(x) * 2.55 : parseFloat(x); });
      if (!ch.every(isFinite)) return null;
      var al = p[3] === undefined ? 1 : /%$/.test(p[3]) ? parseFloat(p[3]) / 100 : parseFloat(p[3]);
      return { hex: rgbToHex(ch.map(function (x) { return clamp(x, 0, 255) / 255; })), a: isFinite(al) ? clamp01(al) : 1 };
    }
    return null;
  }
  function styleProp(styl, name) {
    var r = new RegExp('(?:^|;)\\s*' + name + '\\s*:\\s*([^;]+)').exec(styl || '');
    return r ? r[1].trim() : null;
  }
  function lengthOf(v, d, ref) { // número, ou % do ref
    if (v === null || v === undefined || v === '') return d;
    var n = parseFloat(v);
    if (!isFinite(n)) return d;
    return /%\s*$/.test(v) ? n / 100 * ref : n;
  }
  // <style> com regras de classe (exports do Canva/Illustrator): .cls-1{fill:#abc}
  function cssClasses(svg) {
    var out = {}, re = /<style[^>]*>([\s\S]*?)<\/style>/gi, b;
    while ((b = re.exec(svg))) {
      var body = b[1].replace(/<!\[CDATA\[|\]\]>/g, ''), rr = /([^{}]+)\{([^}]*)\}/g, r;
      while ((r = rr.exec(body))) {
        r[1].split(',').forEach(function (sel) {
          var m = /^\s*\.([\w-]+)\s*$/.exec(sel);
          if (m) out[m[1]] = (out[m[1]] ? out[m[1]] + ';' : '') + r[2];
        });
      }
    }
    return out;
  }
  // <linearGradient>/<radialGradient> por id, com herança de stops/atributos via href
  function svgGradients(svg, css) {
    var raw = {}, re = /<(linearGradient|radialGradient)\b((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/gi, t;
    while ((t = re.exec(svg))) {
      var a = t[2], id = attr(a, 'id');
      if (!id) continue;
      var stops = [];
      if (!t[3]) {
        var end = svg.toLowerCase().indexOf('</' + t[1].toLowerCase(), re.lastIndex);
        var body = svg.slice(re.lastIndex, end < 0 ? svg.length : end), sr = /<stop\b((?:[^>"']|"[^"]*"|'[^']*')*?)\/?>/gi, sm;
        while ((sm = sr.exec(body))) {
          var sa = sm[1], st = attr(sa, 'style') || '';
          var cls = attr(sa, 'class'); if (cls && css[cls]) st = css[cls] + ';' + st;
          var col = parseColor(styleProp(st, 'stop-color') || attr(sa, 'stop-color') || '#000');
          var op = parseFloat(styleProp(st, 'stop-opacity') || attr(sa, 'stop-opacity'));
          var off = attr(sa, 'offset') || '0', ov = parseFloat(off);
          if (/%/.test(off)) ov /= 100;
          if (col) stops.push([clamp01(isFinite(ov) ? ov : 0), col.hex, clamp01((isFinite(op) ? op : 1) * col.a)]);
        }
      }
      raw[id] = { type: t[1].toLowerCase() === 'radialgradient' ? 'r' : 'l', a: a, stops: stops, href: (attr(a, 'xlink:href') || attr(a, 'href') || '').replace(/^#/, '') };
    }
    function resolve(id, depth) {
      var g = raw[id];
      if (!g || depth > 6) return null;
      var base = g.href ? resolve(g.href, depth + 1) : null;
      var get = function (k) { var v = attr(g.a, k); return v !== null ? v : base ? base.get(k) : null; };
      return { type: g.type, stops: g.stops.length ? g.stops : base ? base.stops : [], get: get };
    }
    var out = {};
    for (var id in raw) out[id] = resolve(id, 0);
    return out;
  }
  // gradiente (já com a matriz do elemento e bbox local) → { t, s, m } com m: coordenadas do SVG → espaço do gradiente
  function gradientPaint(g, ctm, bb) {
    var stops = g.stops.slice().sort(function (x, y) { return x[0] - y[0]; });
    for (var i = 1; i < stops.length; i++) if (stops[i][0] < stops[i - 1][0]) stops[i][0] = stops[i - 1][0];
    if (stops.length === 1) stops = [[0, stops[0][1], stops[0][2]], [1, stops[0][1], stops[0][2]]];
    if (stops.length < 2) return null;
    var obb = g.get('gradientUnits') !== 'userSpaceOnUse';
    var gt = parseTransform(g.get('gradientTransform'));
    var toUser = minv(ctm); if (!toUser) return null;
    var M = toUser;
    if (obb) {
      var bw = bb[2] - bb[0], bh = bb[3] - bb[1];
      if (bw < 1e-9 || bh < 1e-9) return null;
      M = mmul([1 / bw, 0, 0, 1 / bh, -bb[0] / bw, -bb[1] / bh], M);
    }
    var gi = minv(gt); if (!gi) return null;
    M = mmul(gi, M); // svg → espaço do gradiente
    var W = obb ? 1 : (bb[2] - bb[0]) || 1, H = obb ? 1 : (bb[3] - bb[1]) || 1, row;
    if (g.type === 'l') {
      var x1 = lengthOf(g.get('x1'), 0, W), y1 = lengthOf(g.get('y1'), 0, H), x2 = lengthOf(g.get('x2'), obb ? 1 : W, W), y2 = lengthOf(g.get('y2'), 0, H);
      var dx = x2 - x1, dy = y2 - y1, L2 = dx * dx + dy * dy;
      if (L2 < 1e-12) return null;
      row = [(dx * M[0] + dy * M[1]) / L2, 0, (dx * M[2] + dy * M[3]) / L2, 0, (dx * (M[4] - x1) + dy * (M[5] - y1)) / L2, 0];
    } else {
      var cx = lengthOf(g.get('cx'), obb ? 0.5 : W / 2, W), cy = lengthOf(g.get('cy'), obb ? 0.5 : H / 2, H), r = lengthOf(g.get('r'), obb ? 0.5 : Math.min(W, H) / 2, Math.min(W, H));
      if (!(r > 1e-9)) return null;
      row = [M[0] / r, M[1] / r, M[2] / r, M[3] / r, (M[4] - cx) / r, (M[5] - cy) / r];
    }
    if (!row.every(isFinite)) return null;
    return { t: g.type, s: stops, m: row };
  }

  // achata um path "d" em subcaminhos [{pts, closed}]
  function flattenPath(d, tol) {
    var toks = String(d).match(/[a-zA-Z]|[-+]?(?:\d*\.\d+|\d+\.?)(?:[eE][-+]?\d+)?/g) || [];
    var out = [], cur = null, i = 0, cmd = '', x = 0, y = 0, sx = 0, sy = 0, cx = 0, cy = 0, qx = 0, qy = 0, prev = '';
    tol = tol || 0.5;
    function n() { return parseFloat(toks[i++]); }
    function isNum() { return i < toks.length && !/[a-zA-Z]/.test(toks[i]); }
    function start(px, py) { cur = { pts: [px, py], closed: false }; out.push(cur); }
    function line(px, py) { if (!cur) start(x, y); cur.pts.push(px, py); }
    function steps(len) { return Math.max(2, Math.min(64, Math.ceil(Math.sqrt(len / tol) * 1.2))); }
    function cubicTo(x1, y1, x2, y2, ex, ey) {
      var len = Math.hypot(x1 - x, y1 - y) + Math.hypot(x2 - x1, y2 - y1) + Math.hypot(ex - x2, ey - y2), k = steps(len);
      for (var j = 1; j <= k; j++) {
        var t = j / k, u = 1 - t;
        line(u * u * u * x + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * ex, u * u * u * y + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * ey);
      }
    }
    function quadTo(x1, y1, ex, ey) {
      var len = Math.hypot(x1 - x, y1 - y) + Math.hypot(ex - x1, ey - y1), k = steps(len);
      for (var j = 1; j <= k; j++) { var t = j / k, u = 1 - t; line(u * u * x + 2 * u * t * x1 + t * t * ex, u * u * y + 2 * u * t * y1 + t * t * ey); }
    }
    function arcTo(rx, ry, rot, large, sweep, ex, ey) {
      if (!rx || !ry) { line(ex, ey); return; }
      rx = Math.abs(rx); ry = Math.abs(ry);
      var ph = rot * Math.PI / 180, cp = Math.cos(ph), sp = Math.sin(ph);
      var dx = (x - ex) / 2, dy = (y - ey) / 2, x1 = cp * dx + sp * dy, y1 = -sp * dx + cp * dy;
      var lam = x1 * x1 / (rx * rx) + y1 * y1 / (ry * ry);
      if (lam > 1) { rx *= Math.sqrt(lam); ry *= Math.sqrt(lam); }
      var sgn = large === sweep ? -1 : 1;
      var co = sgn * Math.sqrt(Math.max(0, (rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1) / (rx * rx * y1 * y1 + ry * ry * x1 * x1)));
      var cxp = co * rx * y1 / ry, cyp = -co * ry * x1 / rx;
      var ccx = cp * cxp - sp * cyp + (x + ex) / 2, ccy = sp * cxp + cp * cyp + (y + ey) / 2;
      var a1 = Math.atan2((y1 - cyp) / ry, (x1 - cxp) / rx), a2 = Math.atan2((-y1 - cyp) / ry, (-x1 - cxp) / rx), da = a2 - a1;
      if (sweep && da < 0) da += 2 * Math.PI; else if (!sweep && da > 0) da -= 2 * Math.PI;
      var k = steps(Math.abs(da) * Math.max(rx, ry));
      for (var j = 1; j <= k; j++) {
        var a = a1 + da * j / k, px = rx * Math.cos(a), py = ry * Math.sin(a);
        line(cp * px - sp * py + ccx, sp * px + cp * py + ccy);
      }
    }
    while (i < toks.length) {
      if (/[a-zA-Z]/.test(toks[i])) cmd = toks[i++];
      else if (!cmd) { i++; continue; }
      var rel = cmd === cmd.toLowerCase(), C = cmd.toUpperCase(), ox = rel ? x : 0, oy = rel ? y : 0;
      if (C === 'Z') { if (cur) { cur.closed = true; } x = sx; y = sy; cur = null; prev = 'Z'; continue; }
      if (!isNum()) { cmd = ''; continue; }
      if (C === 'M') { x = ox + n(); y = oy + n(); sx = x; sy = y; start(x, y); cmd = rel ? 'l' : 'L'; prev = 'M'; continue; }
      if (C === 'L') { x = ox + n(); y = oy + n(); line(x, y); }
      else if (C === 'H') { x = ox + n(); line(x, y); }
      else if (C === 'V') { y = oy + n(); line(x, y); }
      else if (C === 'C') { var c1x = ox + n(), c1y = oy + n(); cx = ox + n(); cy = oy + n(); var ex = ox + n(), ey = oy + n(); cubicTo(c1x, c1y, cx, cy, ex, ey); x = ex; y = ey; }
      else if (C === 'S') { var r1x = /[CS]/.test(prev) ? 2 * x - cx : x, r1y = /[CS]/.test(prev) ? 2 * y - cy : y; cx = ox + n(); cy = oy + n(); var e2x = ox + n(), e2y = oy + n(); cubicTo(r1x, r1y, cx, cy, e2x, e2y); x = e2x; y = e2y; }
      else if (C === 'Q') { qx = ox + n(); qy = oy + n(); var e3x = ox + n(), e3y = oy + n(); quadTo(qx, qy, e3x, e3y); x = e3x; y = e3y; }
      else if (C === 'T') { qx = /[QT]/.test(prev) ? 2 * x - qx : x; qy = /[QT]/.test(prev) ? 2 * y - qy : y; var e4x = ox + n(), e4y = oy + n(); quadTo(qx, qy, e4x, e4y); x = e4x; y = e4y; }
      else if (C === 'A') { var arx = n(), ary = n(), rot = n(), la = n(), sw = n(), e5x = ox + n(), e5y = oy + n(); arcTo(arx, ary, rot, !!la, !!sw, e5x, e5y); x = e5x; y = e5y; }
      else { i++; }
      prev = C;
    }
    return out.filter(function (s) { return s.pts.length >= 4 && s.pts.every(isFinite); });
  }

  function ellipsePts(cx, cy, rx, ry) {
    var k = Math.max(24, Math.min(96, Math.ceil(Math.max(rx, ry) / 2))), pts = [];
    for (var i = 0; i < k; i++) { var a = i / k * 2 * Math.PI; pts.push(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry); }
    return pts;
  }

  /**
   * SVG (string) → { contours: [{pts, closed}], box: [x0,y0,x1,y1], evenOdd }
   * Ignora <defs>, <clipPath>, <mask>, <pattern> e elementos com fill e stroke "none".
   */
  function parseSVG(svg) {
    svg = String(svg || '');
    var stack = [[1, 0, 0, 1, 0, 0]], skip = 0, contours = [], evenOdd = false;
    var css = cssClasses(svg), grads = null, paints = [];
    var pstack = [{ fill: null, stroke: null }]; // fill/stroke herdados de <g>
    var re = /<(\/?)([a-zA-Z][\w:-]*)((?:[^>"']|"[^"]*"|'[^']*')*?)(\/?)>/g, t;
    var vb = null;
    while ((t = re.exec(svg))) {
      var close = !!t[1], tag = t[2].toLowerCase(), a = t[3] || '', self = !!t[4];
      var container = /^(svg|g|a|switch|symbol)$/.test(tag), skipTag = /^(defs|clippath|mask|pattern|lineargradient|radialgradient|filter|style|title|desc|metadata)$/.test(tag);
      if (close) {
        if (skipTag) skip = Math.max(0, skip - 1);
        else if (container && stack.length > 1) { stack.pop(); pstack.pop(); }
        continue;
      }
      if (skipTag) { if (!self) skip++; continue; }
      if (skip) continue;
      var m = mmul(stack[stack.length - 1], parseTransform(attr(a, 'transform')));
      if (tag === 'svg' && !vb) {
        var v = (attr(a, 'viewBox') || '').trim().split(/[\s,]+/).map(Number);
        if (v.length === 4 && v.every(isFinite)) vb = v;
        else { var w = num(a, 'width', 0), h = num(a, 'height', 0); if (w && h) vb = [0, 0, w, h]; }
      }
      var cls = attr(a, 'class'), clsStyle = '';
      if (cls) cls.split(/\s+/).forEach(function (c) { if (css[c]) clsStyle += ';' + css[c]; });
      var styl0 = clsStyle + ';' + (attr(a, 'style') || '');
      var pin = pstack[pstack.length - 1];
      var fillP = styleProp(styl0, 'fill') || attr(a, 'fill'), strokeP = styleProp(styl0, 'stroke') || attr(a, 'stroke');
      var curPaint = { fill: fillP !== null ? fillP : pin.fill, stroke: strokeP !== null ? strokeP : pin.stroke };
      if (container) { if (!self) { stack.push(m); pstack.push(curPaint); } continue; }
      // geometria: só atributos do próprio elemento (comportamento da v0.6, inalterado)
      var fill = attr(a, 'fill'), stroke = attr(a, 'stroke'), styl = attr(a, 'style') || '';
      var sf = /fill\s*:\s*none/.test(styl), ss = /stroke\s*:\s*none/.test(styl);
      if ((fill === 'none' || sf) && (!stroke || stroke === 'none' || ss)) continue;
      if (/evenodd/.test((attr(a, 'fill-rule') || '') + styl)) evenOdd = true;
      var subs = [];
      if (tag === 'path') subs = flattenPath(attr(a, 'd') || '', 0.35 / Math.max(1e-6, Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]))));
      else if (tag === 'rect') {
        var rx = num(a, 'x', 0), ry = num(a, 'y', 0), rw = num(a, 'width', 0), rh = num(a, 'height', 0), rr = Math.min(num(a, 'rx', num(a, 'ry', 0)), rw / 2, rh / 2);
        if (rw > 0 && rh > 0) {
          if (rr > 0) {
            var p = 'M' + (rx + rr) + ' ' + ry + 'H' + (rx + rw - rr) + 'A' + rr + ' ' + rr + ' 0 0 1 ' + (rx + rw) + ' ' + (ry + rr) + 'V' + (ry + rh - rr) +
              'A' + rr + ' ' + rr + ' 0 0 1 ' + (rx + rw - rr) + ' ' + (ry + rh) + 'H' + (rx + rr) + 'A' + rr + ' ' + rr + ' 0 0 1 ' + rx + ' ' + (ry + rh - rr) +
              'V' + (ry + rr) + 'A' + rr + ' ' + rr + ' 0 0 1 ' + (rx + rr) + ' ' + ry + 'Z';
            subs = flattenPath(p);
          } else subs = [{ pts: [rx, ry, rx + rw, ry, rx + rw, ry + rh, rx, ry + rh], closed: true }];
        }
      } else if (tag === 'circle') { var r = num(a, 'r', 0); if (r > 0) subs = [{ pts: ellipsePts(num(a, 'cx', 0), num(a, 'cy', 0), r, r), closed: true }]; }
      else if (tag === 'ellipse') { var ex = num(a, 'rx', 0), ey = num(a, 'ry', 0); if (ex > 0 && ey > 0) subs = [{ pts: ellipsePts(num(a, 'cx', 0), num(a, 'cy', 0), ex, ey), closed: true }]; }
      else if (tag === 'line') subs = [{ pts: [num(a, 'x1', 0), num(a, 'y1', 0), num(a, 'x2', 0), num(a, 'y2', 0)], closed: false }];
      else if (tag === 'polyline' || tag === 'polygon') {
        var ps = (attr(a, 'points') || '').trim().split(/[\s,]+/).map(Number).filter(isFinite);
        if (ps.length >= 4) subs = [{ pts: ps.slice(0, ps.length - ps.length % 2), closed: tag === 'polygon' }];
      }
      var open = fill === 'none' || sf;
      // pinta do elemento (herança de <g>/<svg> + classes CSS): fill, ou stroke se o fill é none
      var pFill = curPaint.fill, pOpen = pFill === 'none' || /fill\s*:\s*none/.test(styl0);
      var paintSrc = !pOpen ? (pFill === null ? '#000000' : pFill) : curPaint.stroke;
      if (subs.length && paintSrc && paintSrc !== 'none') {
        var lx0 = 1e18, ly0 = 1e18, lx1 = -1e18, ly1 = -1e18;
        subs.forEach(function (sp) { for (var q = 0; q < sp.pts.length; q += 2) { lx0 = Math.min(lx0, sp.pts[q]); lx1 = Math.max(lx1, sp.pts[q]); ly0 = Math.min(ly0, sp.pts[q + 1]); ly1 = Math.max(ly1, sp.pts[q + 1]); } });
        var det = Math.abs(m[0] * m[3] - m[1] * m[2]), area = Math.max(lx1 - lx0, 1e-6) * Math.max(ly1 - ly0, 1e-6) * det;
        if (pOpen) area *= 0.25; // traço pesa menos que preenchimento
        var urlm = /url\(\s*['"]?#([^'")\s]+)['"]?\s*\)/.exec(paintSrc), pnt = null;
        if (urlm) {
          if (!grads) grads = svgGradients(svg, css);
          var gd = grads[urlm[1]];
          if (gd && gd.stops.length) pnt = gradientPaint(gd, m, [lx0, ly0, lx1, ly1]);
          if (!pnt && gd && gd.stops.length) pnt = { solid: gd.stops[0][1] };
        } else {
          var pc = parseColor(paintSrc);
          if (pc) pnt = { solid: pc.hex, implicit: pFill === null && !pOpen };
        }
        if (pnt) { pnt.area = area; paints.push(pnt); }
      }
      subs.forEach(function (sp) {
        var pts = [];
        for (var i = 0; i < sp.pts.length; i += 2) {
          var X = sp.pts[i], Y = sp.pts[i + 1];
          pts.push(m[0] * X + m[2] * Y + m[4], m[1] * X + m[3] * Y + m[5]);
        }
        // forma preenchida sem Z também é fechada (regra do SVG)
        contours.push({ pts: pts, closed: sp.closed || (!open && tag !== 'line' && tag !== 'polyline') });
      });
    }
    var x0 = 1e18, y0 = 1e18, x1 = -1e18, y1 = -1e18;
    contours.forEach(function (c) { for (var i = 0; i < c.pts.length; i += 2) { x0 = Math.min(x0, c.pts[i]); x1 = Math.max(x1, c.pts[i]); y0 = Math.min(y0, c.pts[i + 1]); y1 = Math.max(y1, c.pts[i + 1]); } });
    return { contours: contours, box: contours.length ? [x0, y0, x1, y1] : null, viewBox: vb, evenOdd: evenOdd, paint: dominantPaint(paints) };
  }

  // pinta que domina o objeto: soma a área por cor/gradiente e fica com a maior
  function dominantPaint(paints) {
    if (!paints.length) return null;
    var groups = {}, best = null;
    paints.forEach(function (p) {
      var k = p.solid ? 's' + p.solid : 'g' + JSON.stringify(p.s) + p.t;
      var g = groups[k] || (groups[k] = { p: p, area: 0 });
      g.area += p.area;
      if (!best || g.area >= best.area * 0.999) best = g; // empate: a de cima (desenhada por último) vence
    });
    var p = best.p;
    if (p.solid) return { type: 'solid', hex: p.solid, implicit: !!p.implicit };
    return { type: 'gradient', t: p.t, s: p.s, m: p.m };
  }

  // Douglas–Peucker por contorno, aumentando a tolerância até caber no orçamento de pontos.
  function dp(pts, tol) {
    var n = pts.length / 2;
    if (n <= 2) return pts.slice();
    var keep = new Uint8Array(n); keep[0] = keep[n - 1] = 1;
    var st = [[0, n - 1]];
    while (st.length) {
      var s = st.pop(), a = s[0], b = s[1], ax = pts[a * 2], ay = pts[a * 2 + 1], bx = pts[b * 2], by = pts[b * 2 + 1];
      var dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy) || 1e-12, best = -1, bi = -1;
      for (var i = a + 1; i < b; i++) {
        var d = Math.abs((pts[i * 2] - ax) * dy - (pts[i * 2 + 1] - ay) * dx) / L;
        if (L < 1e-9) d = Math.hypot(pts[i * 2] - ax, pts[i * 2 + 1] - ay);
        if (d > best) { best = d; bi = i; }
      }
      if (best > tol) { keep[bi] = 1; st.push([a, bi], [bi, b]); }
    }
    var out = [];
    for (var k = 0; k < n; k++) if (keep[k]) out.push(pts[k * 2], pts[k * 2 + 1]);
    return out;
  }

  /**
   * Converte contornos (coordenadas quaisquer) para o formato do parâmetro `vector`,
   * já posicionados no quadro (unidade = menor lado, origem no centro).
   * place: { box: [x0,y0,x1,y1] destino em unidades } ou { fit: 0.6 } (centra e ocupa 60% do menor lado).
   */
  // mapa SVG → unidades do quadro (o mesmo usado pelo vetor): x' = x·k + ox, y' = y·ky + oy
  function placeMap(parsed, place) {
    var src = parsed.box;
    if (!src) return null;
    var sw = src[2] - src[0] || 1, sh2 = src[3] - src[1] || 1, k, ox, oy, ky;
    if (place && place.box && place.from) {
      var fr = place.from, bb = place.box;
      k = (bb[2] - bb[0]) / ((fr[2] - fr[0]) || 1); ky = (bb[3] - bb[1]) / ((fr[3] - fr[1]) || 1);
      ox = bb[0] - fr[0] * k; oy = bb[1] - fr[1] * ky;
    } else if (place && place.box) {
      var b = place.box;
      k = Math.min((b[2] - b[0]) / sw, (b[3] - b[1]) / sh2);
      ox = (b[0] + b[2]) / 2 - (src[0] + src[2]) / 2 * k; oy = (b[1] + b[3]) / 2 - (src[1] + src[3]) / 2 * k;
    } else {
      var fit = place && place.fit ? place.fit : 0.6;
      k = fit / Math.max(sw, sh2);
      ox = -(src[0] + src[2]) / 2 * k; oy = -(src[1] + src[3]) / 2 * k;
    }
    return { k: k, ky: ky || k, ox: ox, oy: oy };
  }

  /**
   * Cor do objeto no quadro: { color } pra cor sólida ou { gfill } pro gradiente, já posicionado
   * no mesmo lugar do vetor (mesmo `place` do toVector). null se o SVG não tem cor utilizável.
   */
  function toFill(parsed, place) {
    var pt = parsed && parsed.paint;
    if (!pt) return null;
    if (pt.type === 'solid') return { color: pt.hex, implicit: pt.implicit };
    var mp = placeMap(parsed, place);
    if (!mp || !mp.k || !mp.ky) return null;
    // unidades → svg, depois svg → gradiente
    var m = pt.m, T = [1 / mp.k, 0, 0, 1 / mp.ky, -mp.ox / mp.k, -mp.oy / mp.ky];
    var r = mmul(m, T);
    if (pt.t === 'l') r = [r[0], 0, r[2], 0, r[4], 0];
    return { gfill: normGfill({ t: pt.t, m: r, s: pt.s }) };
  }

  function toVector(parsed, place, budget) {
    budget = budget || MAX_VEC_PTS;
    var src = parsed.box;
    if (!src) return null;
    var sw = src[2] - src[0] || 1, sh2 = src[3] - src[1] || 1, k, ox, oy, ky;
    if (place && place.box && place.from) {
      // mapeamento exato de um retângulo de origem (ex.: viewBox do SVG = bounds do node) pro destino
      var fr = place.from, bb = place.box;
      k = (bb[2] - bb[0]) / ((fr[2] - fr[0]) || 1); ky = (bb[3] - bb[1]) / ((fr[3] - fr[1]) || 1);
      ox = bb[0] - fr[0] * k; oy = bb[1] - fr[1] * ky;
    } else if (place && place.box) {
      var b = place.box;
      k = Math.min((b[2] - b[0]) / sw, (b[3] - b[1]) / sh2);
      ox = (b[0] + b[2]) / 2 - (src[0] + src[2]) / 2 * k; oy = (b[1] + b[3]) / 2 - (src[1] + src[3]) / 2 * k;
    } else {
      var fit = place && place.fit ? place.fit : 0.6;
      k = fit / Math.max(sw, sh2);
      ox = -(src[0] + src[2]) / 2 * k; oy = -(src[1] + src[3]) / 2 * k;
    }
    var cs = parsed.contours.map(function (c) {
      var pts = [];
      for (var i = 0; i < c.pts.length; i += 2) pts.push(c.pts[i] * k + ox, c.pts[i + 1] * (ky || k) + oy);
      return { pts: pts, closed: c.closed };
    }).filter(function (c) {
      var x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;
      for (var i = 0; i < c.pts.length; i += 2) { x0 = Math.min(x0, c.pts[i]); x1 = Math.max(x1, c.pts[i]); y0 = Math.min(y0, c.pts[i + 1]); y1 = Math.max(y1, c.pts[i + 1]); }
      return x1 - x0 > 1e-4 || y1 - y0 > 1e-4;
    });
    var tol = 0.0004, simp, total;
    for (var it = 0; it < 14; it++) {
      simp = cs.map(function (c) { var p = dp(c.closed ? c.pts.concat([c.pts[0], c.pts[1]]) : c.pts, tol); if (c.closed && p.length > 4) p.length -= 2; return { pts: p, closed: c.closed }; })
        .filter(function (c) { return c.pts.length >= (c.closed ? 6 : 4); });
      total = 0; simp.forEach(function (c) { total += c.pts.length / 2; });
      if (total <= budget) break;
      tol *= 1.6;
    }
    return {
      c: simp.slice(0, MAX_VEC_CONTOURS).map(function (c) { return c.pts.map(function (v) { return Math.round(v * 1e4) / 1e4; }); }),
      z: simp.slice(0, MAX_VEC_CONTOURS).map(function (c) { return c.closed ? 1 : 0; }),
      eo: parsed.evenOdd ? 1 : 0
    };
  }

  // ------------------------------------------------------------------ scene
  // Coordenadas: origem no centro, unidade = menor lado do quadro, y pra baixo.
  function buildScene(p, W, H) {
    var S = Math.min(W, H), ax = W / 2 / S, ay = H / 2 / S;
    var rng = mulberry32(p.seed * 9973 + SHAPES.indexOf(p.shape) * 131 + 7);
    var th = p.angle * Math.PI / 180;
    var Dx = Math.cos(th), Dy = -Math.sin(th), Nx = -Dy, Ny = Dx;
    var g = 0.35 + p.spread * 1.55;
    var sh = p.sharpness;
    var seedN = p.seed * 31 + 11;

    // camadas de blur sobre a distância até o vetor
    var r0 = 0.0015 + 0.003 * (1 - sh), r1 = 0.010 * g, r2 = 0.038 * g, r3 = 0.12 * g, r4 = 0.34 * g;
    var w0 = 0.2 + 1.2 * sh;
    var i0 = 1 / (r0 * r0), i1 = 1 / (r1 * r1), i2 = 1 / (r2 * r2), i3 = 1 / r3, i4 = 1 / r4;
    function glow(d, core) {
      var d2 = d * d;
      return core * w0 * Math.exp(-d2 * i0) + 0.55 * Math.exp(-d2 * i1) + 0.34 * Math.exp(-d2 * i2) +
        0.15 * Math.exp(-d * i3) + 0.06 * Math.exp(-d * i4);
    }
    function soft(d) { // sem núcleo: só bloom/halo/névoa
      var d2 = d * d;
      return 0.5 * Math.exp(-d2 * i1 * 0.25) + 0.38 * Math.exp(-d2 * i2) + 0.18 * Math.exp(-d * i3) + 0.07 * Math.exp(-d * i4);
    }
    function rot(x, y, a) { var c = Math.cos(a), s = Math.sin(a); return [x * c - y * s, x * s + y * c]; }
    var extent = Math.abs(Dx) * ax + Math.abs(Dy) * ay; // meia-extensão do quadro na direção da luz

    var field; // (x, y) → energia
    var occ = null;

    if (p.shape === 'eclipse' || p.shape === 'horizon') {
      var horizon = p.shape === 'horizon';
      // eclipse: planeta grande saindo do canto, rim que nasce apagado e esquenta até o ponto quente.
      // horizonte: arco raso, ponto quente central com flare anamórfico.
      var R, L, cx, cy, hx, hy;
      if (horizon) {
        R = mix(4.5, 1.2, p.curvature);
        L = [Dx, Dy];
        var kh = mix(0.05, 0.16, rng());
        hx = Dx * kh; hy = Dy * kh; cx = hx - Dx * R; cy = hy - Dy * R;
      } else {
        // planeta enorme saindo do canto oposto à luz; o rim cruza o quadro na diagonal
        R = mix(1.7, 0.55, p.curvature);
        var push = mix(0.05, 0.25, rng());
        cx = -Dx * (R - push); cy = -Dy * (R - push);
        // ponto quente: sempre num trecho do rim visível dentro do quadro
        var vis = [];
        for (var ai = 0; ai < 240; ai++) {
          var an = ai / 240 * 6.2832, qx = cx + Math.cos(an) * R, qy = cy + Math.sin(an) * R;
          if (Math.abs(qx) < ax * 0.86 && Math.abs(qy) < ay * 0.86) vis.push(an);
        }
        var phi;
        if (vis.length) {
          var pick = vis[Math.floor(mix(0.55, 0.92, rng()) * vis.length) % vis.length];
          phi = rng() < 0.5 ? pick : vis[Math.floor(mix(0.08, 0.45, rng()) * vis.length) % vis.length];
        } else phi = Math.atan2(Dy, Dx);
        L = [Math.cos(phi), Math.sin(phi)];
        hx = cx + L[0] * R; hy = cy + L[1] * R;
      }
      var focus = horizon ? 7 : 4.5;
      var tx = -L[1], ty = L[0];
      var fl = p.flare;
      field = function (x, y) {
        var dx = x - cx, dy = y - cy, r = Math.sqrt(dx * dx + dy * dy), s = r - R;
        var cphi = (dx * L[0] + dy * L[1]) / (r || 1);
        var I = Math.pow(0.5 + 0.5 * cphi, focus);
        var e = I * glow(Math.abs(s), 1);
        if (s < 0) {
          e = e * Math.exp(s / 0.008) + I * 0.05 * Math.exp(s / (0.06 * g));
        } else {
          e += Math.pow(I, 0.8) * 0.22 * Math.exp(-s / (0.11 * g)) + Math.pow(I, 0.55) * 0.05 * Math.exp(-s / (0.38 * g));
        }
        if (fl > 0) {
          var fx = x - hx, fy = y - hy;
          var ft = fx * tx + fy * ty, fn = fx * L[0] + fy * L[1];
          var aniso = horizon ? 0.3 : 0.12;
          var r2 = fx * fx + fy * fy;
          var f = Math.exp(-(ft * ft) / (aniso * aniso * g) - (fn * fn) / (0.0006 * g)) * 1.1 +
            Math.exp(-r2 / (0.0025 * g)) * 0.8 + Math.exp(-r2 / (0.04 * g)) * (horizon ? 0.18 : 0.45) + Math.exp(-Math.sqrt(r2) / (0.3 * g)) * (horizon ? 0.05 : 0.12);
          if (s < 0) f *= Math.exp(s / 0.005);
          e += fl * f;
        }
        return e;
      };
    } else if (p.shape === 'aurora') {
      // feixes em leque saindo de fora do quadro + coluna de luz descendo + esfera escura (opcional)
      var nb = p.elements;
      var ox = -Dx * extent * 1.02, oy = -Dy * extent * 1.02 + (rng() - 0.5) * 0.1;
      var fan = mix(0.25, 0.6, rng());
      var beams = [];
      for (var b = 0; b < nb; b++) {
        var a = (nb > 1 ? b / (nb - 1) - 0.5 : 0) * fan + (rng() - 0.5) * 0.1;
        var u = rot(Dx, Dy, a);
        beams.push({
          ux: u[0], uy: u[1], nx: -u[1], ny: u[0],
          bend: (rng() < 0.5 ? -1 : 1) * p.curvature * mix(0.15, 0.6, rng()),
          len: mix(0.45, 1.1, rng()),
          amp: mix(0.5, 1, rng()),
          wid: mix(0.015, 0.045, rng())
        });
      }
      var hk = mix(0.3, 0.45, rng());
      var hsx = ox + Dx * hk, hsy = oy + Dy * hk;
      var colDir = Ny >= 0 ? 1 : -1;               // coluna sempre "desce" na tela
      var cNx = Nx * colDir, cNy = Ny * colDir;
      var fla = p.flare;
      field = function (x, y) {
        var e = 0, px = x - ox, py = y - oy;
        for (var i = 0; i < beams.length; i++) {
          var bm = beams[i];
          var lx = px * bm.ux + py * bm.uy, ly = px * bm.nx + py * bm.ny;
          if (lx < -0.2) continue;
          var yc = bm.bend * lx * lx, slope = 2 * bm.bend * lx;
          var d = Math.abs(ly - yc) / Math.sqrt(1 + slope * slope);
          var w = bm.wid + Math.max(lx, 0) * 0.06;
          var env = smooth(-0.1, 0.25, lx) * Math.exp(-Math.max(lx, 0) / bm.len);
          var q = d / w;
          e += bm.amp * env * (Math.exp(-q * q) * (0.45 + sh * 0.6) + 0.16 * Math.exp(-q * q * 0.1) + 0.05 * Math.exp(-q * 0.2));
        }
        var dx = x - hsx, dy = y - hsy, d2 = dx * dx + dy * dy;
        e += 0.3 * Math.exp(-d2 / (0.02 * g * g)) + 0.1 * Math.exp(-Math.sqrt(d2) / (0.3 * g));
        e += fla * 0.9 * Math.exp(-d2 / (0.0015 * g));
        // coluna: massa saturada descendo do ponto quente
        var cu = dx * cNx + dy * cNy, cv = dx * cNy * -1 + dy * cNx;
        if (cu > -0.1) {
          var cw = 0.06 * g + Math.max(cu, 0) * 0.12;
          e += 0.32 * smooth(-0.1, 0.12, cu) * Math.exp(-(cv * cv) / (cw * cw)) * Math.exp(-Math.max(cu, 0) / 0.9);
        }
        return e;
      };
      var orr = mix(0.4, 0.52, rng());
      occ = { x: hsx + Dx * (orr + 0.12) + cNx * (orr + 0.06), y: hsy + Dy * (orr + 0.12) + cNy * (orr + 0.06), r: orr };
    } else if (p.shape === 'plasma') {
      // fitas grossas de luz, empilhadas e dobradas; turbulência transforma em líquido
      var nbn = p.elements;
      var span = (Math.abs(Nx) * ax + Math.abs(Ny) * ay) * 1.7;
      var bands = [];
      for (var i2b = 0; i2b < nbn; i2b++) {
        bands.push({
          o: (nbn > 1 ? i2b / (nbn - 1) - 0.5 : 0) * span * 0.8 + (rng() - 0.5) * 0.1,
          A: mix(0.03, 0.14, rng()) * (0.3 + p.curvature),
          k: mix(1.6, 4, rng()),
          ph: rng() * 6.283,
          bend: (rng() - 0.5) * p.curvature * 1.2,
          s: i2b * 13.7 + rng() * 50,
          amp: mix(0.55, 1, rng()),
          w: mix(0.04, 0.09, rng()) * (0.6 + p.spread * 0.9)
        });
      }
      var pkx = Dx * 0.4, pky = Dy * 0.4;
      field = function (x, y) {
        var u = x * Dx + y * Dy, v = x * Nx + y * Ny, e = 0;
        for (var i = 0; i < bands.length; i++) {
          var bd = bands[i];
          var arg = bd.k * u + bd.ph;
          var vc = bd.o + bd.A * Math.sin(arg) + bd.bend * u * u;
          var slope = bd.A * bd.k * Math.cos(arg) + 2 * bd.bend * u;
          var d = Math.abs(v - vc) / Math.sqrt(1 + slope * slope);
          var env = 0.2 + 0.8 * Math.pow(vnoise(u * 1.1 + bd.s, bd.s, seedN), 1.4);
          var q = d / bd.w;
          e += bd.amp * env * (Math.exp(-q * q) * 0.75 + sh * 0.6 * Math.exp(-q * q * 6) + 0.28 * Math.exp(-q * q * 0.12) + 0.07 * Math.exp(-q * 0.15));
        }
        var hx2 = x - pkx, hy2 = y - pky;
        return e * (0.25 + 1.2 * Math.exp(-(hx2 * hx2 + hy2 * hy2) / 0.32));
      };
    } else if (p.shape === 'silk' || p.shape === 'veil' || p.shape === 'flow') {
      // fitas de tecido: cada fita é uma curva v = f(u) com perfil assimétrico
      // (lado largo = luz difusa, lado curto = vinco). A nitidez controla o vinco.
      var kind = p.shape, rib = [];
      var cnt = kind === 'flow' ? 3 + p.elements * 2 : p.elements;
      var spanN = (Math.abs(Nx) * ax + Math.abs(Ny) * ay);
      for (var ri = 0; ri < cnt; ri++) {
        var spread_ = cnt > 1 ? ri / (cnt - 1) - 0.5 : (rng() - 0.5) * 0.4;
        var cvR = p.curvature;
        rib.push(kind === 'veil' ? {
          o: spread_ * spanN * 1.1 + (rng() - 0.5) * 0.15,
          A1: mix(0.12, 0.42, cvR) * mix(0.7, 1.1, rng()), k1: mix(1.4, 2.6, rng()), p1: rng() * 6.283,
          A2: mix(0.02, 0.08, rng()) * cvR, k2: mix(3, 5, rng()), p2: rng() * 6.283,
          bend: (rng() - 0.5) * cvR * 0.5,
          wA: mix(0.26, 0.42, rng()) * g, wB: mix(0.2, 0.01, sh) * mix(0.8, 1.3, rng()), side: rng() < 0.5 ? -1 : 1,
          amp: mix(0.8, 1, rng()) * (ri === 0 ? 1.25 : 0.7), envK: mix(0.5, 1.1, rng()), s: ri * 17.3 + rng() * 40, envMin: 0.12
        } : kind === 'silk' ? {
          o: spread_ * spanN * 1.5 + (rng() - 0.5) * 0.18,
          A1: mix(0.05, 0.3, cvR) * mix(0.6, 1.2, rng()), k1: mix(1.2, 3, rng()), p1: rng() * 6.283,
          A2: mix(0.01, 0.07, rng()) * cvR, k2: mix(3.5, 6, rng()), p2: rng() * 6.283,
          bend: (rng() - 0.5) * cvR * 1.1,
          wA: mix(0.12, 0.28, rng()) * g, wB: mix(0.12, 0.008, sh) * mix(0.7, 1.4, rng()), side: rng() < 0.5 ? -1 : 1,
          amp: mix(0.6, 1, rng()), envK: mix(0.7, 1.6, rng()), s: ri * 17.3 + rng() * 40, envMin: 0.25
        } : {
          o: spread_ * spanN * 2.1 + (rng() - 0.5) * 0.06,
          A1: mix(0.02, 0.12, cvR) * mix(0.6, 1.2, rng()), k1: mix(0.8, 1.8, rng()), p1: rng() * 6.283,
          A2: mix(0.005, 0.03, rng()) * cvR, k2: mix(3, 5, rng()), p2: rng() * 6.283,
          bend: (rng() - 0.5) * cvR * 0.5,
          wA: mix(0.015, 0.16, Math.pow(rng(), 2)) * g, wB: mix(0.05, 0.004, sh) * mix(0.6, 1.4, rng()), side: rng() < 0.75 ? 1 : -1,
          amp: mix(0.35, 1, rng()), envK: mix(0.8, 1.8, rng()), s: ri * 17.3 + rng() * 40, envMin: 0.15
        });
      }
      // flow: as fitas compartilham a mesma ondulação (paralelas, não cruzadas)
      if (kind === 'flow') for (var fi2 = 1; fi2 < rib.length; fi2++) {
        rib[fi2].k1 = rib[0].k1 * mix(0.9, 1.1, rng()); rib[fi2].p1 = rib[0].p1 + (rng() - 0.5) * 0.6;
        rib[fi2].bend = rib[0].bend * mix(0.8, 1.2, rng());
      }
      var spX = Dx * extent * 0.3 + Nx * (rng() - 0.5) * 0.4, spY = Dy * extent * 0.3 + Ny * (rng() - 0.5) * 0.4;
      var flR = p.flare, base0 = kind === 'flow' ? 0.18 : 0;
      field = function (x, y) {
        var u = x * Nx + y * Ny, v = x * Dx + y * Dy, e = 0;
        for (var i = 0; i < rib.length; i++) {
          var R_ = rib[i];
          var a1 = R_.k1 * u + R_.p1, a2 = R_.k2 * u + R_.p2;
          var vc = R_.o + R_.A1 * Math.sin(a1) + R_.A2 * Math.sin(a2) + R_.bend * u * u;
          var sl = R_.A1 * R_.k1 * Math.cos(a1) + R_.A2 * R_.k2 * Math.cos(a2) + 2 * R_.bend * u;
          var s = (v - vc) / Math.sqrt(1 + sl * sl) * R_.side;
          var pr;
          if (s >= 0) { var qa = s / R_.wA; pr = 0.78 * Math.exp(-qa * qa) + 0.22 * Math.exp(-s / (R_.wA * 2.2)); }
          else { var qb = s / R_.wB; pr = Math.exp(-qb * qb); }
          // rim no vinco: leve realce colado à aresta
          pr += sh * 0.35 * Math.exp(-(s * s) / (0.0004 + R_.wB * R_.wB * 0.3));
          var env = R_.envMin + (1 - R_.envMin) * Math.pow(vnoise(u * R_.envK + R_.s, R_.s, seedN), 1.3);
          e += R_.amp * env * pr;
        }
        var hx4 = x - spX, hy4 = y - spY;
        var spot = Math.exp(-(hx4 * hx4 + hy4 * hy4) / 0.3);
        var gain = kind === 'flow' ? 0.8 : kind === 'veil' ? 1.45 : 1.3;
        return (e * gain + base0 * spot) * (0.55 + 0.45 * spot + flR * 0.9 * spot);
      };
    } else if (p.shape === 'fold') {
      // dobra: luz de preenchimento vinda de um canto + corpo escuro com um vinco fino de luz na aresta
      var Lcx = Dx * extent * 1.05, Lcy = Dy * extent * 1.05;
      var disks = [];
      for (var di = 0; di < Math.min(3, p.elements); di++) {
        var Rd = mix(0.9, 1.6, rng()) * (di ? 0.75 : 1);
        var reach = mix(0.25, 0.55, rng());
        var offN = (rng() < 0.5 ? -1 : 1) * mix(0.15, 0.45, rng());
        var dcx = -Dx * (Rd - reach) + Nx * offN + (di ? -Dx * 0.5 : 0), dcy = -Dy * (Rd - reach) + Ny * offN + (di ? -Dy * 0.5 : 0);
        if (di) { dcx += Nx * -offN * 2.2; dcy += Ny * -offN * 2.2; }
        var hdx = Lcx - dcx, hdy = Lcy - dcy, hl = Math.hypot(hdx, hdy) || 1;
        disks.push({ x: dcx, y: dcy, r: Rd, lx: hdx / hl, ly: hdy / hl, amp: di ? 0.6 : 1 });
      }
      var flF = p.flare;
      field = function (x, y) {
        var ldx = x - Lcx, ldy = y - Lcy, ld = Math.sqrt(ldx * ldx + ldy * ldy);
        var fill = 0.62 * Math.exp(-ld / (0.5 * g)) + 0.16 * Math.exp(-ld / (1.6 * g)) + 0.05;
        var e = fill, crease = 0;
        for (var i = 0; i < disks.length; i++) {
          var D_ = disks[i], dx = x - D_.x, dy = y - D_.y, r = Math.sqrt(dx * dx + dy * dy), s = r - D_.r;
          var shade = mix(0.06, 1, smooth(-0.3 * g, 0.015 + 0.06 * (1 - sh), s));
          e *= mix(1, shade, D_.amp);
          var cphi = (dx * D_.lx + dy * D_.ly) / (r || 1);
          var I = Math.pow(0.5 + 0.5 * cphi, 9) * D_.amp;
          var w1 = mix(0.012, 0.0025, sh);
          crease += I * (0.9 * Math.exp(-(s * s) / (w1 * w1)) + 0.35 * Math.exp(-(s * s) / (0.0009 * g)) + 0.12 * Math.exp(-Math.abs(s) / (0.08 * g)));
        }
        return e + crease * (0.6 + flF * 0.8);
      };
    } else if (p.shape === 'curtain') {
      // cortina: estrias de luz subindo de uma base clara, com um pico central
      var extD = extent;
      var v0 = (rng() - 0.5) * 0.25, sh0 = mix(0.28, 0.45, rng()), shAmp = mix(0.3, 0.6, rng());
      var lines = [];
      for (var li2 = 0; li2 < p.elements * 2 + 1; li2++) {
        lines.push({ v: li2 === 0 ? v0 : v0 + (rng() - 0.5) * 0.9, a: li2 === 0 ? 0.9 : mix(0.15, 0.5, rng()), w: mix(0.002, 0.008, rng()), reach: mix(0.5, 1.4, rng()) });
      }
      var flC = p.flare, cvC = p.curvature;
      field = function (x, y) {
        var u = x * Dx + y * Dy, v = x * Nx + y * Ny;
        var hgt = clamp01((u + extD) / (2 * extD));
        var dv = v - v0;
        var wC = mix(0.5, 0.015, Math.pow(hgt, mix(0.4, 1.2, cvC))) * g;
        var core = Math.exp(-Math.abs(dv) / wC) * Math.exp(-hgt * 1.5);
        var sd = Math.abs(dv) - sh0;
        var shoulder = shAmp * Math.exp(-(sd * sd) / (0.012 * g)) * Math.exp(-hgt / 0.22);
        var base = 0.45 * Math.exp(-hgt / (0.12 * g)) + 0.08 * Math.exp(-hgt / 0.6);
        var st = 0.65 * vnoise(v * 60 + 3, hgt * 1.2, seedN) + 0.35 * vnoise(v * 150 + 9, hgt * 2.5, seedN + 3);
        st = Math.pow(st, 1.4) * 1.6;
        var e = (core + shoulder + base) * mix(1, st, mix(0.25, 0.7, hgt));
        for (var i = 0; i < lines.length; i++) {
          var L_ = lines[i], q = (v - L_.v) / L_.w;
          e += L_.a * Math.exp(-q * q) * Math.exp(-hgt / L_.reach) * (0.4 + sh);
        }
        var bx2 = dv, by2 = hgt - 0.12;
        return e + flC * 0.6 * Math.exp(-(bx2 * bx2) / 0.004 - (by2 * by2) / 0.02);
      };
    } else if (p.shape === 'vector') {
      // shape vetorial (SVG colado / seleção do Figma). Distância exata ao contorno + teste dentro/fora
      // por faixas + grids suavizados (corpo borrado, intensidade de rim) pra não ter costura no halo.
      var V = p.vector && p.vector.c && p.vector.c.length ? p.vector : SAMPLE_VECTOR;
      var VG = vectorGeom(V);
      var vm = p.vmode, echoes = p.elements, sp = mix(0.018, 0.05, p.curvature);
      var ins = VG.inside;
      // grid de apoio cobrindo o quadro + margem
      var mg = 0.25, gx0 = -ax - mg, gy0 = -ay - mg, cellU = 1 / 300;
      var GW = Math.ceil((2 * ax + 2 * mg) / cellU), GH = Math.ceil((2 * ay + 2 * mg) / cellU);
      function grid() { return new Float32Array(GW * GH); }
      function sample(gr, x, y) {
        var fx = (x - gx0) / cellU - 0.5, fy = (y - gy0) / cellU - 0.5;
        if (fx < 0) fx = 0; else if (fx > GW - 1.001) fx = GW - 1.001;
        if (fy < 0) fy = 0; else if (fy > GH - 1.001) fy = GH - 1.001;
        var ix = fx | 0, iy = fy | 0, tx = fx - ix, ty = fy - iy, o = iy * GW + ix;
        return (gr[o] * (1 - tx) + gr[o + 1] * tx) * (1 - ty) + (gr[o + GW] * (1 - tx) + gr[o + GW + 1] * tx) * ty;
      }
      var hotX = Dx * extent * 0.3, hotY = Dy * extent * 0.3;
      var flV = p.flare, field0;
      var mask = null;
      if (vm !== 'outline') {
        mask = grid();
        for (var gy = 0; gy < GH; gy++) for (var gx = 0; gx < GW; gx++) mask[gy * GW + gx] = ins(gx0 + (gx + 0.5) * cellU, gy0 + (gy + 0.5) * cellU) ? 1 : 0;
      }
      var cellsOf = function (u) { return Math.max(1, Math.round(u / cellU)); };
      if (vm === 'fill') {
        // espessura média do shape (2·área/perímetro): o corpo borra proporcional a ela,
        // então texto fino continua legível e shape grosso ganha miolo largo
        var area = 0, per = 0;
        for (var q0 = 0; q0 < mask.length; q0++) area += mask[q0];
        area *= cellU * cellU;
        for (var q1 = 0; q1 < VG.n; q1++) per += Math.sqrt(VG.seg[q1 * 6 + 4]);
        var thick = clamp(per > 0 ? 2 * area / per : 0.05, 0.006, 0.2);
        var B1 = boxBlur3(mask, GW, GH, cellsOf(Math.min(0.012 * g, thick * 0.35)));
        var B2 = boxBlur3(mask, GW, GH, cellsOf(Math.min(0.05 * g, thick * 1.1 * g)));
        var B3 = boxBlur3(mask, GW, GH, cellsOf(0.16 * g));
        var wcore = 0.0015 + 0.004 * (1 - sh);
        // normaliza pelo pico de cada camada: shape fino (texto) acende tanto quanto shape grosso
        var pk = function (gr) { var m = 1e-6; for (var q = 0; q < gr.length; q += 3) if (gr[q] > m) m = gr[q]; return 1 / m; };
        // o halo largo só é parcialmente normalizado: num shape fino ele não pode virar uma mancha que engole a forma
        var n1 = pk(B1), n2 = Math.min(pk(B2), 2.2), n3 = Math.min(pk(B3), 1.5);
        field0 = function (x, y) {
          var d = vecDist(VG, x, y), inside = ins(x, y);
          var b1 = Math.min(1, sample(B1, x, y) * n1), b2 = Math.min(1, sample(B2, x, y) * n2), b3 = Math.min(1, sample(B3, x, y) * n3);
          // corpo: o miolo (onde o blur largo é alto) acende mais que as partes finas → camadas de shade
          var e = 0.42 * b1 + 0.36 * b2 * b2 + 0.4 * b3 * b3 * b3 + 0.1 * b3;
          // aresta nítida opcional (nitidez) — a forma continua legível
          e += sh * 0.22 * Math.exp(-(d * d) / (wcore * wcore)) * (inside ? 1 : 0.6);
          return e;
        };
      } else if (vm === 'rim') {
        // rim sem costura: derivada direcional da máscara borrada (lado do shape virado pra luz)
        var Rn = boxBlur3(mask, GW, GH, cellsOf(0.014)), Rf = boxBlur3(mask, GW, GH, cellsOf(0.09 * g));
        var dl = 0.012, dlf = 0.06 * g;
        var dirI = function (gr, x, y, dd) { return sample(gr, x - Dx * dd, y - Dy * dd) - sample(gr, x + Dx * dd, y + Dy * dd); };
        // normaliza pelo máximo
        var mxN = 1e-6, mxF = 1e-6, bfx = 0, bfy = 0;
        for (var sy = 0; sy < GH; sy += 2) for (var sx2 = 0; sx2 < GW; sx2 += 2) {
          var qx = gx0 + (sx2 + 0.5) * cellU, qy = gy0 + (sy + 0.5) * cellU;
          var vn = dirI(Rn, qx, qy, dl), vf = dirI(Rf, qx, qy, dlf);
          if (vn > mxN) { mxN = vn; bfx = qx; bfy = qy; }
          if (vf > mxF) mxF = vf;
        }
        var focusV = 2.2;
        field0 = function (x, y) {
          var d = vecDist(VG, x, y), inside = ins(x, y);
          var In = Math.pow(clamp01(dirI(Rn, x, y, dl) / mxN), focusV), If = clamp01(dirI(Rf, x, y, dlf) / mxF);
          var e = In * glow(d, 1);
          if (inside) e = e * Math.exp(-d / 0.005) + If * 0.05 * Math.exp(-d / (0.05 * g));
          else e += If * 0.3 * Math.exp(-d / (0.1 * g)) + Math.pow(If, 0.6) * 0.07 * Math.exp(-d / (0.35 * g));
          if (flV > 0) {
            var fx3 = x - bfx, fy3 = y - bfy, r2v = fx3 * fx3 + fy3 * fy3;
            var f = 0.8 * Math.exp(-r2v / (0.0014 * g)) + 0.28 * Math.exp(-r2v / (0.03 * g));
            if (inside) f *= Math.exp(-d / 0.004);
            e += flV * f;
          }
          return e;
        };
      } else {
        // contorno: o fio de luz é a borda; elementos = ecos concêntricos pra fora
        field0 = function (x, y) {
          var d = vecDist(VG, x, y), e = glow(d, 1);
          if (echoes > 1) {
            var s = VG.closedAny && ins(x, y) ? -d : d;
            for (var k2 = 1; k2 < echoes; k2++) { var dk = Math.abs(s - k2 * sp); e += Math.pow(0.68, k2) * glow(dk, 0.7); }
          }
          return e * (0.55 + 0.45 * fbm(x * 2.2 + 3.7, y * 2.2 + 1.3, seedN));
        };
      }
      field = function (x, y) {
        var e = field0(x, y);
        if (vm !== 'rim') {
          var hx5 = x - hotX, hy5 = y - hotY;
          e *= 0.55 + 0.75 * Math.exp(-(hx5 * hx5 + hy5 * hy5) / 0.5);
          if (flV > 0 && vm === 'outline') e += flV * 0.5 * Math.exp(-(hx5 * hx5 + hy5 * hy5) / (0.012 * g)) * Math.exp(-vecDist(VG, x, y) / 0.02);
        }
        return e;
      };
    } else if (STROKE_SHAPES[p.shape]) {
      var raw = genStrokes(p, rng, { Dx: Dx, Dy: Dy, Nx: Nx, Ny: Ny, ax: ax, ay: ay, ext: extent });
      var strokes = raw.map(function (st) { return prepStroke(st, st.smooth !== undefined ? st.smooth : 2); });
      var cut = 2.4 * g + 0.3;
      var hotx = Dx * extent * 0.32, hoty = Dy * extent * 0.32;
      // flare no ponto do traço principal mais perto do ponto quente
      var fpx = 0, fpy = 0, fbest = 1e9, m0 = strokes[0];
      for (var fi = 0; m0 && fi < m0.pts.length; fi += 2) {
        var fd = Math.hypot(m0.pts[fi] - hotx, m0.pts[fi + 1] - hoty);
        if (fd < fbest) { fbest = fd; fpx = m0.pts[fi]; fpy = m0.pts[fi + 1]; }
      }
      var flS = p.flare, spot = p.shape === 'draw' && p.paths.length ? 0.5 : 1.1;
      field = function (x, y) {
        var e = 0;
        for (var i = 0; i < strokes.length; i++) {
          var st = strokes[i];
          var h = strokeDist(st, x, y), d = h[0] / st.thick;
          if (d > cut) continue;
          var pos = h[1], env = 0.35 + 0.65 * vnoise(pos * st.total * 2.2 + st.ns, st.ns, seedN);
          // longe do traço o "ponto mais próximo" pula entre trechos (eixo medial) → costura.
          // o halo distante usa envelope médio, só o núcleo segue a variação local.
          env = mix(env, 0.68, smooth(0.01, 0.09, d));
          if (!st.closed) {
            // pontas: atenuação pela distância até a ponta no espaço (campo contínuo → sem costura nem gancho)
            var e0 = Math.hypot(x - st.ex0, y - st.ey0), e1 = Math.hypot(x - st.ex1, y - st.ey1);
            var tp = smooth(0, st.r0, e0) * smooth(0, st.r1, e1);
            env *= 0.08 + 0.92 * tp;
          }
          e += st.amp * env * glow(d, 1);
        }
        var hx3 = x - hotx, hy3 = y - hoty;
        e *= (1 - spot * 0.6) + spot * 0.6 * 1.6 * Math.exp(-(hx3 * hx3 + hy3 * hy3) / 0.45) + (1 - spot) * 0.4;
        if (flS > 0) {
          var fx2 = x - fpx, fy2 = y - fpy, r2f = fx2 * fx2 + fy2 * fy2;
          e += flS * (0.9 * Math.exp(-r2f / (0.0016 * g)) + 0.3 * Math.exp(-r2f / (0.03 * g)));
        }
        return e;
      };
    } else { // bloom
      // manchas desfocadas com vazio escuro entre elas
      var nbl = p.elements;
      var blobs = [];
      for (var bi = 0; bi < nbl; bi++) {
        var ang = rng() * 6.283;
        var el = 1 + p.curvature * mix(0.5, 2.2, rng());
        var bx = 0, by = 0, tries = 0, ok = false;
        while (!ok && tries++ < 40) {
          bx = (rng() - 0.5) * ax * 1.7; by = (rng() - 0.5) * ay * 1.7; ok = true;
          for (var bj = 0; bj < blobs.length; bj++) {
            if (Math.hypot(bx - blobs[bj].x, by - blobs[bj].y) < 0.42) { ok = false; break; }
          }
          if (Math.hypot(bx - Dx * extent * 0.45, by - Dy * extent * 0.45) < 0.45) ok = false;
        }
        blobs.push({
          x: bx, y: by,
          c: Math.cos(ang), s: Math.sin(ang), el: el,
          r: mix(0.07, 0.14, rng()) * g, amp: mix(0.2, 0.5, rng())
        });
      }
      blobs[0].x = Dx * extent * 0.45; blobs[0].y = Dy * extent * 0.45; blobs[0].amp = 0.9; blobs[0].r *= 1.5;
      var flb = p.flare;
      field = function (x, y) {
        var e = 0;
        for (var i = 0; i < blobs.length; i++) {
          var bl = blobs[i], dx = x - bl.x, dy = y - bl.y;
          var a1 = (dx * bl.c + dy * bl.s) / bl.el, a2 = (-dx * bl.s + dy * bl.c);
          var dd = Math.sqrt(a1 * a1 + a2 * a2);
          e += bl.amp * (Math.exp(-(dd * dd) / (bl.r * bl.r)) + 0.18 * Math.exp(-dd / (bl.r * 1.8)));
          if (i === 0 && flb > 0) e += flb * 0.9 * Math.exp(-(dd * dd) / (bl.r * bl.r * 0.06));
        }
        return e;
      };
    }

    if (p.occluder && p.shape !== 'eclipse' && p.shape !== 'horizon') {
      if (!occ) occ = { x: -Dx * 0.05 + Nx * 0.32, y: -Dy * 0.05 + Ny * 0.32, r: mix(0.36, 0.55, rng()) };
    } else occ = null;

    var turb = p.turbulence;
    var ws = seedN + 101;
    var mixSeed = seedN + 303;
    var energy0 = function (x, y) {
        if (turb > 0) {
          var wx = fbm(x * 1.2 + 3.1, y * 1.2 + 7.7, ws) - 0.5, wy = fbm(x * 1.2 + 11.3, y * 1.2 + 1.9, ws) - 0.5;
          var qx = x + turb * 0.75 * wx, qy = y + turb * 0.75 * wy;
          var vx = fbm(qx * 3.6, qy * 3.6, ws + 5) - 0.5, vy = fbm(qx * 3.6 + 9, qy * 3.6 + 4, ws + 5) - 0.5;
          x = qx + turb * 0.07 * vx; y = qy + turb * 0.07 * vy;
        }
        var e = field(x, y);
        if (occ) {
          var dx = x - occ.x, dy = y - occ.y, s = Math.sqrt(dx * dx + dy * dy) - occ.r;
          var m = smooth(-0.035 * g, 0.045 * g, s);
          e = e * (0.04 + 0.96 * m) + e * 0.35 * Math.exp(-(s * s) / (0.0004 * g)) * smooth(-0.05, 0, s);
        }
        return e;
    };
    var energy = energy0;
    // Desfoque: o campo inteiro (forma + glow + turbulência + esfera) é amostrado num grid e borrado,
    // literalmente "blur no vetor". A aresta dura some; o pico é parcialmente compensado pra forma não apagar.
    if (p.soften > 0) {
      var rU = 0.003 + 0.075 * Math.pow(p.soften, 1.7);
      var cell = Math.max(1 / 320, 1.25 / S, rU / 24);
      var pad = rU * 2.2 + cell * 2, bx0 = -ax - pad, by0 = -ay - pad;
      var BW = Math.ceil((2 * ax + 2 * pad) / cell) + 1, BH = Math.ceil((2 * ay + 2 * pad) / cell) + 1;
      var raw = new Float32Array(BW * BH), mr = 1e-9;
      for (var gy = 0; gy < BH; gy++) for (var gx = 0; gx < BW; gx++) {
        var v = energy0(bx0 + gx * cell, by0 + gy * cell);
        raw[gy * BW + gx] = v; if (v > mr) mr = v;
      }
      var blurred = boxBlur3(raw, BW, BH, Math.max(1, Math.round(rU / cell)));
      var mb = 1e-9; for (var bi2 = 0; bi2 < blurred.length; bi2++) if (blurred[bi2] > mb) mb = blurred[bi2];
      // compensa só parte da perda de pico: o desfoque deixa a luz mais suave, não uma mancha chapada
      var comp = clamp(Math.pow(mr / mb, 0.45), 1, 2.6);
      var fade = smooth(0, 0.12, p.soften); // abaixo de 12% cruza com o campo exato (sem salto no início do slider)
      var at = function (x, y) {
        var fx = (x - bx0) / cell, fy = (y - by0) / cell;
        if (fx < 0) fx = 0; else if (fx > BW - 1.001) fx = BW - 1.001;
        if (fy < 0) fy = 0; else if (fy > BH - 1.001) fy = BH - 1.001;
        var ix = fx | 0, iy = fy | 0, tx = fx - ix, ty = fy - iy, o = iy * BW + ix;
        return ((blurred[o] * (1 - tx) + blurred[o + 1] * tx) * (1 - ty) + (blurred[o + BW] * (1 - tx) + blurred[o + BW + 1] * tx) * ty) * comp;
      };
      energy = fade >= 1 ? at : function (x, y) { return mix(energy0(x, y), at(x, y), fade); };
    }
    return {
      W: W, H: H, S: S, ax: ax, ay: ay, Nx: Nx, Ny: Ny,
      energy: energy,
      mixAt: function (x, y) {
        var t = (x * Nx + y * Ny) * 2.4 + (fbm(x * 1.2, y * 1.2, mixSeed) - 0.5) * 2.2;
        return 0.5 + 0.5 * Math.tanh(t * 1.4);
      }
    };
  }

  // ------------------------------------------------------------------ render
  /**
   * Renderiza linhas [y0, y1) em `out` (RGBA 8 bits, W*H*4).
   * Resolução independente: as formas vivem em unidades do menor lado.
   * Fade: mistura cada borda ao fundo. Transparente: "color to alpha" a partir do fundo,
   * então compor o PNG sobre o mesmo fundo reproduz exatamente a versão opaca.
   */
  function renderRows(out, W, H, p, y0, y1, ctx) {
    ctx = ctx || prepare(p, W, H);
    p = ctx.p;
    var sc = ctx.scene, ra = ctx.ramps.a.lut, rb = ctx.ramps.b ? ctx.ramps.b.lut : null;
    var gg = ctx.ramps.g || null, grows = gg ? gg.rows : null, gR = gg ? gg.n - 1 : 0, gN = LUT_SIZE * 3, gA = gg ? gg.alpha : null;
    var bg = ctx.ramps.a.bg, b0 = bg[0], b1 = bg[1], b2 = bg[2];
    var k = gainOf(p);
    var gam = 1 / p.contrast;
    var grainA = p.grain * 0.11;
    var cell = Math.max(1, Math.round(sc.S / 1080));
    var gs = p.seed * 7 + 3;
    var inv = 1 / sc.S, hx = W / 2, hy = H / 2;
    var top = LUT_SIZE - 1;
    var transp = p.transparent;
    var fT = p.fadeT * 0.5 * H, fB = p.fadeB * 0.5 * H, fL = p.fadeL * 0.5 * W, fR = p.fadeR * 0.5 * W;
    var anyFade = fT > 0 || fB > 0 || fL > 0 || fR > 0;
    for (var py = y0; py < y1; py++) {
      var y = (py + 0.5 - hy) * inv, gy = (py / cell) | 0;
      var my = 1;
      if (fT > 0) my *= smooth(0, fT, py + 0.5);
      if (fB > 0) my *= smooth(0, fB, H - py - 0.5);
      for (var px = 0; px < W; px++) {
        var x = (px + 0.5 - hx) * inv;
        var E = sc.energy(x, y), gu = 0;
        if (grows) { gu = gradPos(gg, x, y); if (gA) E *= gA[(gu * 255 + 0.5) | 0]; }
        var t = 1 - Math.exp(-E * k);
        if (gam !== 1) t = Math.pow(t, gam);
        var li = Math.round(t * top) * 3;
        var r, g, b;
        if (grows) {
          var tgp = gu * gR, ri = tgp | 0; if (ri > gR - 1) ri = gR - 1;
          var rf = tgp - ri, q1 = ri * gN + li, q2 = q1 + gN;
          r = grows[q1] + (grows[q2] - grows[q1]) * rf; g = grows[q1 + 1] + (grows[q2 + 1] - grows[q1 + 1]) * rf; b = grows[q1 + 2] + (grows[q2 + 2] - grows[q1 + 2]) * rf;
        } else { r = ra[li]; g = ra[li + 1]; b = ra[li + 2]; }
        if (rb) {
          var m = sc.mixAt(x, y);
          r += (rb[li] - r) * m; g += (rb[li + 1] - g) * m; b += (rb[li + 2] - b) * m;
        }
        if (anyFade) {
          var mf = my;
          if (fL > 0) mf *= smooth(0, fL, px + 0.5);
          if (fR > 0) mf *= smooth(0, fR, W - px - 0.5);
          if (mf < 1) { r = b0 + (r - b0) * mf; g = b1 + (g - b1) * mf; b = b2 + (b - b2) * mf; t *= mf; }
        }
        var gx = (px / cell) | 0;
        var n = (hash3(gx, gy, gs) + hash3(gx, gy, gs + 1) - 1) * grainA * (1 - 0.65 * t);
        var dth = (hash3(px, py, gs + 2) - 0.5) / 255;
        var o = (py * W + px) * 4;
        if (transp) {
          var a = alphaOf(r, b0) , a1 = alphaOf(g, b1), a2 = alphaOf(b, b2);
          if (a1 > a) a = a1; if (a2 > a) a = a2;
          if (a < 0.002) { out[o] = b0 * 255 + 0.5; out[o + 1] = b1 * 255 + 0.5; out[o + 2] = b2 * 255 + 0.5; out[o + 3] = 0; continue; }
          var ia = 1 / a;
          r = b0 + (r - b0) * ia; g = b1 + (g - b1) * ia; b = b2 + (b - b2) * ia;
          out[o] = clamp01(r + n) * 255 + 0.5;
          out[o + 1] = clamp01(g + n) * 255 + 0.5;
          out[o + 2] = clamp01(b + n) * 255 + 0.5;
          out[o + 3] = clamp01(a + dth) * 255 + 0.5;
        } else {
          out[o] = clamp01(r + n + dth) * 255 + 0.5;
          out[o + 1] = clamp01(g + n + dth) * 255 + 0.5;
          out[o + 2] = clamp01(b + n + dth) * 255 + 0.5;
          out[o + 3] = 255;
        }
      }
    }
    return ctx;
  }

  // alpha mínimo pra que c = fundo·(1−α) + luz·α com luz ∈ [0,1]
  // folga mínima 0.12: com fundo quase branco/preto num canal, um desvio mínimo exigiria alpha total
  // (ex.: fundo #F5F6FE e luz azul 255). Aceita um erro pequeno de cor nesse canal em troca de alpha suave.
  function alphaOf(c, bgc) {
    var d = c - bgc;
    if (d > 1e-6) return Math.min(1, d / Math.max(1 - bgc, 0.12));
    if (d < -1e-6) return Math.min(1, -d / Math.max(bgc, 0.12));
    return 0;
  }

  function prepare(p, W, H) {
    p = normalize(p);
    return { p: p, scene: buildScene(p, W, H), ramps: ramps(p) };
  }

  function renderRGBA(W, H, p) {
    p = normalize(p);
    var out = new Uint8ClampedArray(W * H * 4);
    renderRows(out, W, H, p, 0, H, prepare(p, W, H));
    return out;
  }

  // Desenha num canvas 2D (browser). Retorna o ImageData.
  function render(ctx2d, p, opts) {
    p = normalize(p);
    var W = opts.width, H = opts.height;
    var img = ctx2d.createImageData(W, H);
    renderRows(img.data, W, H, p, 0, H, prepare(p, W, H));
    ctx2d.putImageData(img, 0, 0);
    return img;
  }

  // Render em fatias (não trava a UI no export grande).
  function renderAsync(W, H, p, onDone, opts) {
    p = normalize(p);
    var out = new Uint8ClampedArray(W * H * 4), c = prepare(p, W, H), y = 0;
    var step = Math.max(8, Math.floor(160000 / W));
    var cancelled = false;
    (function tick() {
      if (cancelled) return;
      var y1 = Math.min(H, y + step);
      renderRows(out, W, H, p, y, y1, c);
      y = y1;
      if (opts && opts.onProgress) opts.onProgress(y / H);
      if (y < H) setTimeout(tick, 0); else onDone(out);
    })();
    return { cancel: function () { cancelled = true; } };
  }

  function rampStops(p) {
    p = normalize(p);
    var r = ramps(p);
    return { a: r.a.stops, b: r.b ? r.b.stops : null };
  }

  function rampCSS(p, which) {
    p = normalize(p);
    var r = ramps(p)[which || 'a'];
    if (!r) return '';
    var parts = [];
    for (var i = 0; i <= 16; i++) parts.push(rgbToHex(rampColor(r, i / 16)) + ' ' + (i / 16 * 100).toFixed(1) + '%');
    return 'linear-gradient(90deg,' + parts.join(',') + ')';
  }

  function toJSON(p) {
    p = normalize(p);
    var size = outputSize(p);
    return { kind: 'glow-gradient', version: VERSION, width: size[0], height: size[1], params: p, ramp: rampStops(p) };
  }

  function fromJSON(obj) {
    if (!obj || obj.kind !== 'glow-gradient' || !obj.params) throw new Error('JSON inválido');
    return normalize(obj.params);
  }

  // ------------------------------------------------------------------ campo de energia (runtime)
  // Energia bruta por pixel (antes de intensidade/rampa) + mapa de mistura do duo.
  // O runtime anima em cima disso sem recalcular a forma.
  function energyField(W, H, p, y0, y1, ctx) {
    p = normalize(p);
    ctx = ctx || { scene: buildScene(p, W, H) };
    var sc = ctx.scene, inv = 1 / sc.S, hx = W / 2, hy = H / 2;
    y0 = y0 || 0; y1 = y1 === undefined ? H : y1;
    var E = new Float32Array(W * (y1 - y0)), M = needsMix(p) ? new Uint8Array(W * (y1 - y0)) : null;
    var gf = p.palette === 'object' && p.gfill ? p.gfill : null, gfa = gf ? ramps(p).g.alpha : null;
    for (var py = y0; py < y1; py++) {
      var y = (py + 0.5 - hy) * inv, row = (py - y0) * W;
      for (var px = 0; px < W; px++) {
        var x = (px + 0.5 - hx) * inv;
        var e = sc.energy(x, y);
        if (gf) { var gu = gradPos(gf, x, y); if (gfa) e *= gfa[(gu * 255 + 0.5) | 0]; M[row + px] = Math.round(gu * 255); }
        else if (M) M[row + px] = Math.round(sc.mixAt(x, y) * 255);
        E[row + px] = e;
      }
    }
    return { E: E, M: M, ctx: ctx };
  }
  // ganho de intensidade usado no render (mesma fórmula do renderRows)
  function gainOf(p) { return (0.3 + 3.4 * Math.pow(p.intensity, 1.25)) * (p.mode === 'light' ? 0.8 : 1); }

  // ------------------------------------------------------------------ código compartilhável
  // "gg1." + base64url(JSON só com o que difere do padrão). Cabe em nome de layer, comentário ou chat.
  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  function b64url(str) {
    var out = '', i = 0;
    for (; i + 2 < str.length; i += 3) {
      var n = (str.charCodeAt(i) << 16) | (str.charCodeAt(i + 1) << 8) | str.charCodeAt(i + 2);
      out += B64[n >> 18 & 63] + B64[n >> 12 & 63] + B64[n >> 6 & 63] + B64[n & 63];
    }
    if (str.length - i === 1) { var a = str.charCodeAt(i) << 16; out += B64[a >> 18 & 63] + B64[a >> 12 & 63]; }
    else if (str.length - i === 2) { var b = (str.charCodeAt(i) << 16) | (str.charCodeAt(i + 1) << 8); out += B64[b >> 18 & 63] + B64[b >> 12 & 63] + B64[b >> 6 & 63]; }
    return out;
  }
  function unb64url(s) {
    var out = '', buf = 0, bits = 0;
    for (var i = 0; i < s.length; i++) {
      var v = B64.indexOf(s[i]); if (v < 0) throw new Error('código inválido');
      buf = (buf << 6) | v; bits += 6;
      if (bits >= 8) { bits -= 8; out += String.fromCharCode(buf >> bits & 255); }
    }
    return out;
  }
  function encode(p) {
    p = normalize(p);
    var d = {}, k;
    for (k in p) {
      if (k === 'scale') continue;
      if (JSON.stringify(p[k]) !== JSON.stringify(DEFAULTS[k])) d[k] = p[k];
    }
    if (d.paths) d.paths = d.paths.map(function (pp) { return pp.map(function (v) { return Math.round(v * 1000) / 1000; }); });
    if (d.vector) d.vector = { c: d.vector.c.map(function (pp) { return pp.map(function (v) { return Math.round(v * 2000) / 2000; }); }), z: d.vector.z, eo: d.vector.eo };
    var json = JSON.stringify(d).replace(/[\u007f-\uffff]/g, function (c) { return '\\u' + ('000' + c.charCodeAt(0).toString(16)).slice(-4); });
    return 'gg1.' + b64url(json);
  }
  function decode(code) {
    var m = /gg1\.([A-Za-z0-9_-]+)/.exec(String(code || ''));
    if (!m) throw new Error('código inválido');
    return normalize(JSON.parse(unb64url(m[1])));
  }

  // ------------------------------------------------------------------ receita no PNG
  // O PNG exportado leva a receita (params) num chunk tEXt "glow-gradient".
  // Qualquer um com o arquivo consegue recriar a imagem idêntica com o motor.
  var CRC_TABLE = null;
  function crc32(bytes, start, end) {
    if (!CRC_TABLE) {
      CRC_TABLE = new Int32Array(256);
      for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC_TABLE[n] = c; }
    }
    var crc = -1;
    for (var i = start; i < end; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 255] ^ (crc >>> 8);
    return (crc ^ -1) >>> 0;
  }
  var PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];
  var RECIPE_KEY = 'glow-gradient';
  function isPNG(b) { for (var i = 0; i < 8; i++) if (b[i] !== PNG_SIG[i]) return false; return true; }
  function u32(b, o) { return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0; }
  function asciiBytes(str) {
    var out = new Uint8Array(str.length);
    for (var i = 0; i < str.length; i++) { var c = str.charCodeAt(i); if (c > 126) throw new Error('receita não-ASCII'); out[i] = c; }
    return out;
  }

  function embedRecipe(png, params) {
    var b = png instanceof Uint8Array ? png : new Uint8Array(png);
    if (!isPNG(b)) throw new Error('não é PNG');
    var json = JSON.stringify(toJSON(params)).replace(/[\u007f-\uffff]/g, function (c) { return '\\u' + ('000' + c.charCodeAt(0).toString(16)).slice(-4); });
    var data = asciiBytes(RECIPE_KEY + '\u0000' + json);
    // insere logo depois do IHDR (primeiro chunk), removendo receita antiga
    var parts = [b.subarray(0, 8)], o = 8, first = true;
    while (o < b.length) {
      var len = u32(b, o), type = String.fromCharCode(b[o + 4], b[o + 5], b[o + 6], b[o + 7]), end = o + 12 + len;
      var skip = false;
      if (type === 'tEXt') {
        var key = ''; for (var i = o + 8; i < o + 8 + len && b[i] !== 0; i++) key += String.fromCharCode(b[i]);
        skip = key === RECIPE_KEY;
      }
      if (!skip) parts.push(b.subarray(o, end));
      if (first) {
        var ch = new Uint8Array(12 + data.length);
        ch[0] = data.length >>> 24; ch[1] = data.length >>> 16 & 255; ch[2] = data.length >>> 8 & 255; ch[3] = data.length & 255;
        ch[4] = 116; ch[5] = 69; ch[6] = 88; ch[7] = 116; // tEXt
        ch.set(data, 8);
        var crc = crc32(ch, 4, 8 + data.length);
        ch[8 + data.length] = crc >>> 24; ch[9 + data.length] = crc >>> 16 & 255; ch[10 + data.length] = crc >>> 8 & 255; ch[11 + data.length] = crc & 255;
        parts.push(ch); first = false;
      }
      o = end;
    }
    var total = 0; parts.forEach(function (x) { total += x.length; });
    var out = new Uint8Array(total), w = 0;
    parts.forEach(function (x) { out.set(x, w); w += x.length; });
    return out;
  }

  // Lê a receita de um PNG (Uint8Array/ArrayBuffer). Retorna params normalizados ou null.
  function readRecipe(png) {
    var b = png instanceof Uint8Array ? png : new Uint8Array(png);
    if (!isPNG(b)) return null;
    var o = 8;
    while (o + 12 <= b.length) {
      var len = u32(b, o), type = String.fromCharCode(b[o + 4], b[o + 5], b[o + 6], b[o + 7]);
      if (type === 'tEXt') {
        var str = '';
        for (var i = o + 8; i < o + 8 + len; i++) str += String.fromCharCode(b[i]);
        var z = str.indexOf('\u0000');
        if (str.slice(0, z) === RECIPE_KEY) {
          try { return fromJSON(JSON.parse(str.slice(z + 1))); } catch (e) { return null; }
        }
      }
      if (type === 'IDAT' || type === 'IEND') break;
      o += 12 + len;
    }
    return null;
  }

  return {
    VERSION: VERSION,
    SHAPES: SHAPES, PALETTES: PALETTES, MODES: MODES, FORMATS: FORMATS, DEFAULTS: DEFAULTS, SHAPE_PRESETS: SHAPE_PRESETS, RANGES: RANGES,
    normalize: normalize, preset: preset, outputSize: outputSize,
    buildRamp: buildRamp, rampStops: rampStops, rampCSS: rampCSS, hexToOklch: hexToOklch, srgbLuma: srgbLuma, rampColor: rampColor,
    renderRGBA: renderRGBA, renderRows: renderRows, render: render, renderAsync: renderAsync, prepare: prepare,
    toJSON: toJSON, fromJSON: fromJSON, embedRecipe: embedRecipe, readRecipe: readRecipe, encode: encode, decode: decode,
    energyField: energyField, gainOf: gainOf, ramps: ramps, parseSVG: parseSVG, toVector: toVector, toFill: toFill, parseColor: parseColor, gradPos: gradPos, VMODES: VMODES, SAMPLE_VECTOR: SAMPLE_VECTOR,
    _internal: { alphaOf: alphaOf, hueDelta: hueDelta, mulberry32: mulberry32, oklchToSrgb: oklchToSrgb, driftOf: driftOf }
  };
});

/*!
 * glow-runtime — anima no front um gradiente criado no Glow Gradient.
 * WebGL2. A forma (campo de energia) é calculada uma vez num worker; o shader
 * aplica rampa, intensidade, fluxo, respiração, grão, bordas e transparência a 60fps.
 *
 *   const g = GlowRuntime.mount(el, 'gg1.xxxx' | params | recipeJSON, { resolution: 0.5 });
 *   g.set({ intensity: 0.8, color: '#FF4D2E' });     // ao vivo (sem recalcular a forma)
 *   g.set({ angle: 120 });                           // recalcula a forma (~50–400ms, em worker)
 *   g.motion({ flow: 0.4, speed: 0.3, breathe: 0.2 });
 *   g.pause(); g.play(); g.renderAt(t); g.destroy();
 *   await GlowRuntime.fromPNG(fileOrUrl)  → params (receita embutida no PNG exportado)
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./glow-core.js'));
  else root.GlowRuntime = factory(root.GlowGradient);
})(typeof self !== 'undefined' ? self : this, function (G) {
  'use strict';
  if (!G) throw new Error('glow-runtime: GlowGradient (glow-core) não encontrado');

  // chaves que mudam só a cor/tom → atualização instantânea (uniforms/textura de rampa)
  var LIVE = { intensity: 1, contrast: 1, grain: 1, fadeT: 1, fadeR: 1, fadeB: 1, fadeL: 1, transparent: 1,
    color: 1, color2: 1, palette: 1, mode: 1, bg: 1, drift: 1, depth: 1, motion: 1, scale: 1, objColor: 1 };

  var VS = '#version 300 es\nin vec2 a;out vec2 v;void main(){v=a*.5+.5;v.y=1.-v.y;gl_Position=vec4(a,0.,1.);}';
  var FS = [
    '#version 300 es',
    'precision highp float;',
    'in vec2 v;out vec4 o;',
    'uniform sampler2D uE,uM,uA,uB,uG;',
    'uniform float uK,uGam,uGrain,uT,uFlow,uBreathe,uDuo,uObj,uGN,uTransp,uSeed;',
    'uniform vec2 uRes,uFieldRes;uniform vec4 uFade;uniform vec3 uBg;',
    'float h(vec2 p){p=fract(p*vec2(123.34,456.21)+uSeed);p+=dot(p,p+45.32);return fract(p.x*p.y);}',
    'float n2(vec2 p){vec2 i=floor(p),f=fract(p);f=f*f*(3.-2.*f);',
    ' return mix(mix(h(i),h(i+vec2(1,0)),f.x),mix(h(i+vec2(0,1)),h(i+vec2(1,1)),f.x),f.y);}',
    'vec2 fl(vec2 p,float t){return vec2(n2(p+vec2(t*.6,t*.3))+.5*n2(p*2.1+vec2(-t*.4,t*.7)),',
    '  n2(p+vec2(5.2-t*.3,1.3+t*.5))+.5*n2(p*2.1+vec2(9.1+t*.5,-t*.6)))/1.5-.5;}',
    'float sm(float a,float b,float x){float t=clamp((x-a)/(b-a),0.,1.);return t*t*(3.-2.*t);}',
    'float al(float c,float b){float d=c-b;return d>0.?min(1.,d/max(1.-b,.12)):min(1.,-d/max(b,.12));}',
    'void main(){',
    ' float asp=uRes.x/uRes.y;vec2 q=v*vec2(max(asp,1.),max(1./asp,1.))*2.2;',
    // fluxo: deslocamento que é exatamente zero em t=0 → primeiro frame = PNG
    ' vec2 w=(fl(q,uT)-fl(q,0.))*uFlow*.08*vec2(1.,asp);',
    ' vec2 uv=clamp(v+w,vec2(.5)/uFieldRes,1.-vec2(.5)/uFieldRes);',
    ' float E=texture(uE,uv).r;',
    ' float br=1.+uBreathe*.35*(sin(uT*1.7)*.6+sin(uT*.93+1.3)*.4)*sm(0.,.6,uT);',
    ' float t=1.-exp(-E*uK*br);t=pow(t,uGam);',
    ' vec3 c=texture(uA,vec2(t,.5)).rgb;',
    ' if(uDuo>.5){float m=texture(uM,uv).r;c=mix(c,texture(uB,vec2(t,.5)).rgb,m);}',
    // cor do objeto: linha do LUT 2D = posição no gradiente do objeto (mapa M)
    ' if(uObj>.5){c=texture(uG,vec2(t,(texture(uM,uv).r*(uGN-1.)+.5)/uGN)).rgb;}',
    ' vec2 px=v*uRes;float mf=1.;',
    ' if(uFade.x>0.)mf*=sm(0.,uFade.x*.5*uRes.y,px.y);',
    ' if(uFade.y>0.)mf*=sm(0.,uFade.y*.5*uRes.x,uRes.x-px.x);',
    ' if(uFade.z>0.)mf*=sm(0.,uFade.z*.5*uRes.y,uRes.y-px.y);',
    ' if(uFade.w>0.)mf*=sm(0.,uFade.w*.5*uRes.x,px.x);',
    ' c=uBg+(c-uBg)*mf;t*=mf;',
    ' float g=(h(floor(px)+fract(uT*7.13))+h(floor(px)+17.1+fract(uT*3.7))-1.)*uGrain*.11*(1.-.65*t);',
    ' float dth=(h(px+3.3)-.5)/255.;',
    ' if(uTransp>.5){float a=max(al(c.r,uBg.r),max(al(c.g,uBg.g),al(c.b,uBg.b)));',
    '  if(a<.002){o=vec4(0.);return;}c=clamp(uBg+(c-uBg)/a+g,0.,1.);o=vec4(c*clamp(a+dth,0.,1.),clamp(a+dth,0.,1.));return;}',
    ' o=vec4(clamp(c+g+dth,0.,1.),1.);',
    '}'
  ].join('\n');

  // worker inline com o próprio core (o build injeta o fonte em GlowRuntime.CORE_SRC)
  function makeWorker() {
    var src = api.CORE_SRC;
    if (!src || typeof Worker === 'undefined') return null;
    try {
      var code = src + '\n;self.onmessage=function(e){var d=e.data,f=GlowGradient.energyField(d.w,d.h,d.p);' +
        'self.postMessage({id:d.id,E:f.E,M:f.M},f.M?[f.E.buffer,f.M.buffer]:[f.E.buffer]);};';
      return new Worker(URL.createObjectURL(new Blob([code], { type: 'text/javascript' })));
    } catch (e) { return null; }
  }

  function toParams(input) {
    if (!input) return G.normalize({});
    if (typeof input === 'string') {
      if (input.indexOf('gg1.') >= 0) return G.decode(input);
      return toParams(JSON.parse(input));
    }
    if (input.kind === 'glow-gradient') return G.fromJSON(input);
    return G.normalize(input);
  }

  // gradiente do objeto: LUT 2D (256 tons × N posições no gradiente)
  function gradTex(gl, tex, g) {
    var n = 256, R = g.n, N = g.rows.length / R, data = new Uint8Array(n * R * 4);
    for (var r = 0; r < R; r++) for (var i = 0; i < n; i++) {
      var li = Math.round(i / (n - 1) * (N / 3 - 1)) * 3 + r * N, o = (r * n + i) * 4;
      data[o] = Math.round(g.rows[li] * 255); data[o + 1] = Math.round(g.rows[li + 1] * 255); data[o + 2] = Math.round(g.rows[li + 2] * 255); data[o + 3] = 255;
    }
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, n, R, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
  }
  function rampTex(gl, tex, ramp) {
    var n = 256, data = new Uint8Array(n * 4);
    for (var i = 0; i < n; i++) {
      var c = G.rampColor(ramp, i / (n - 1));
      data[i * 4] = Math.round(c[0] * 255); data[i * 4 + 1] = Math.round(c[1] * 255); data[i * 4 + 2] = Math.round(c[2] * 255); data[i * 4 + 3] = 255;
    }
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, n, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
  }

  function mount(target, input, opts) {
    opts = opts || {};
    var canvas = target && target.tagName === 'CANVAS' ? target : document.createElement('canvas');
    if (canvas !== target) {
      canvas.style.cssText = 'display:block;width:100%;height:100%';
      target.appendChild(canvas);
    }
    var gl = canvas.getContext('webgl2', { premultipliedAlpha: true, alpha: true, antialias: false, preserveDrawingBuffer: !!opts.preserveDrawingBuffer });
    if (!gl) throw new Error('glow-runtime: WebGL2 indisponível');
    var params = toParams(input);
    var resolution = opts.resolution || 0.5;      // fração da resolução do canvas usada pro campo de energia
    var maxField = opts.maxFieldSize || 1280;
    var dpr = Math.min(opts.maxDpr || 2, window.devicePixelRatio || 1);

    function sh(type, src) {
      var s = gl.createShader(type); gl.shaderSource(s, src); gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s));
      return s;
    }
    var prog = gl.createProgram();
    gl.attachShader(prog, sh(gl.VERTEX_SHADER, VS)); gl.attachShader(prog, sh(gl.FRAGMENT_SHADER, FS));
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
    gl.useProgram(prog);
    var buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    var loc = gl.getAttribLocation(prog, 'a');
    gl.enableVertexAttribArray(loc); gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    var U = {};
    ['uE', 'uM', 'uA', 'uB', 'uG', 'uK', 'uGam', 'uGrain', 'uT', 'uFlow', 'uBreathe', 'uDuo', 'uObj', 'uGN', 'uTransp', 'uSeed', 'uRes', 'uFieldRes', 'uFade', 'uBg']
      .forEach(function (n) { U[n] = gl.getUniformLocation(prog, n); });
    function tex(unit, filter) {
      var t = gl.createTexture(); gl.activeTexture(gl.TEXTURE0 + unit); gl.bindTexture(gl.TEXTURE_2D, t);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, filter); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, filter);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE); gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
      return t;
    }
    var tE = tex(0, gl.LINEAR), tM = tex(1, gl.LINEAR), tA = tex(2, gl.LINEAR), tB = tex(3, gl.LINEAR), tG = tex(4, gl.LINEAR);
    gl.uniform1i(U.uE, 0); gl.uniform1i(U.uM, 1); gl.uniform1i(U.uA, 2); gl.uniform1i(U.uB, 3); gl.uniform1i(U.uG, 4);
    gl.activeTexture(gl.TEXTURE1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, 1, 1, 0, gl.RED, gl.UNSIGNED_BYTE, new Uint8Array([0]));

    var worker = opts.worker === false ? null : makeWorker(), jobId = 0, fieldW = 0, fieldH = 0, ready = false;
    var playing = opts.autoplay !== false, t0 = performance.now(), tPaused = 0, raf = 0, destroyed = false;
    var listeners = { ready: [] };

    function size() {
      var r = canvas.getBoundingClientRect();
      var w = Math.max(1, Math.round((r.width || canvas.width) * dpr)), h = Math.max(1, Math.round((r.height || canvas.height) * dpr));
      if (opts.width && opts.height) { w = opts.width; h = opts.height; }
      if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; return true; }
      return false;
    }
    function uploadField(E, M, w, h) {
      gl.activeTexture(gl.TEXTURE0); gl.bindTexture(gl.TEXTURE_2D, tE);
      gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.R16F, w, h, 0, gl.RED, gl.FLOAT, E);
      if (M) { gl.activeTexture(gl.TEXTURE1); gl.bindTexture(gl.TEXTURE_2D, tM); gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, w, h, 0, gl.RED, gl.UNSIGNED_BYTE, M); }
      fieldW = w; fieldH = h; ready = true;
      listeners.ready.forEach(function (f) { f(); });
      draw();
    }
    function computeField() {
      size();
      var s = Math.min(resolution, maxField / Math.max(canvas.width, canvas.height));
      var w = Math.max(16, Math.round(canvas.width * s)), h = Math.max(16, Math.round(canvas.height * s));
      var id = ++jobId, p = JSON.parse(JSON.stringify(params));
      if (worker) {
        worker.onmessage = function (e) { if (e.data.id === jobId && !destroyed) uploadField(e.data.E, e.data.M, w, h); };
        worker.postMessage({ id: id, w: w, h: h, p: p });
      } else {
        setTimeout(function () { if (id !== jobId || destroyed) return; var f = G.energyField(w, h, p); uploadField(f.E, f.M, w, h); }, 0);
      }
    }
    function updateLive() {
      var r = G.ramps(params);
      gl.activeTexture(gl.TEXTURE2); rampTex(gl, tA, r.a);
      if (r.b) { gl.activeTexture(gl.TEXTURE3); rampTex(gl, tB, r.b); }
      if (r.g) { gl.activeTexture(gl.TEXTURE4); gradTex(gl, tG, r.g); }
      gl.uniform1f(U.uObj, r.g ? 1 : 0); gl.uniform1f(U.uGN, r.g ? r.g.n : 1);
      gl.uniform1f(U.uK, G.gainOf(params)); gl.uniform1f(U.uGam, 1 / params.contrast);
      gl.uniform1f(U.uGrain, params.grain); gl.uniform1f(U.uDuo, r.b ? 1 : 0); gl.uniform1f(U.uTransp, params.transparent ? 1 : 0);
      gl.uniform1f(U.uSeed, (params.seed % 997) / 997);
      gl.uniform4f(U.uFade, params.fadeT, params.fadeR, params.fadeB, params.fadeL);
      gl.uniform3f(U.uBg, r.a.bg[0], r.a.bg[1], r.a.bg[2]);
      gl.uniform1f(U.uFlow, params.motion.flow); gl.uniform1f(U.uBreathe, params.motion.breathe);
    }
    function now() { return playing ? (performance.now() - t0) / 1000 : tPaused; }
    function draw(t) {
      if (!ready || destroyed) return;
      if (t === undefined) t = now();
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
      gl.uniform1f(U.uT, t * (0.15 + params.motion.speed * 1.6));
      gl.uniform2f(U.uRes, canvas.width, canvas.height); gl.uniform2f(U.uFieldRes, fieldW, fieldH);
      gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    }
    function loop() {
      raf = 0;
      if (!playing || destroyed) return;
      draw(); raf = requestAnimationFrame(loop);
    }
    var ro = typeof ResizeObserver !== 'undefined' && !opts.width ? new ResizeObserver(function () {
      clearTimeout(ro._t); ro._t = setTimeout(function () { if (size()) computeField(); else draw(); }, 120);
    }) : null;
    if (ro) ro.observe(canvas);
    var reduce = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches && opts.respectReducedMotion !== false;
    if (reduce) playing = false;

    updateLive(); computeField();
    if (playing) raf = requestAnimationFrame(loop);

    var inst = {
      canvas: canvas,
      get params() { return JSON.parse(JSON.stringify(params)); },
      set: function (patch) {
        var needField = false, k;
        for (k in patch) if (!LIVE[k]) needField = true;
        // trocar a palette pode ligar/desligar o mapa de mistura (duo / cor do objeto)
        if ('palette' in patch && patch.palette !== params.palette) needField = true;
        var next = Object.assign({}, params, patch);
        if (patch.motion) next.motion = Object.assign({}, params.motion, patch.motion);
        params = G.normalize(next);
        updateLive();
        if (needField) computeField(); else draw();
        return inst;
      },
      load: function (input) { params = toParams(input); updateLive(); computeField(); return inst; },
      motion: function (m) { return inst.set({ motion: m }); },
      play: function () { if (!playing) { playing = true; t0 = performance.now() - tPaused * 1000; raf = requestAnimationFrame(loop); } return inst; },
      pause: function () { if (playing) { tPaused = now(); playing = false; } return inst; },
      renderAt: function (t) { tPaused = t; playing = false; draw(t); return inst; },
      on: function (ev, f) { (listeners[ev] = listeners[ev] || []).push(f); if (ev === 'ready' && ready) f(); return inst; },
      get ready() { return ready; },
      destroy: function () {
        destroyed = true; if (raf) cancelAnimationFrame(raf); if (worker) worker.terminate(); if (ro) ro.disconnect();
        gl.deleteProgram(prog); [tE, tM, tA, tB, tG].forEach(function (t) { gl.deleteTexture(t); }); gl.deleteBuffer(buf);
        if (canvas !== target && canvas.parentNode) canvas.parentNode.removeChild(canvas);
      }
    };
    return inst;
  }

  function fromPNG(src) {
    var get = typeof src === 'string' ? fetch(src).then(function (r) { return r.arrayBuffer(); })
      : src && src.arrayBuffer ? src.arrayBuffer() : Promise.resolve(src);
    return get.then(function (ab) {
      var p = G.readRecipe(new Uint8Array(ab));
      if (!p) throw new Error('PNG sem receita do Glow Gradient');
      return p;
    });
  }

  var api = { VERSION: G.VERSION, mount: mount, fromPNG: fromPNG, decode: G.decode, encode: G.encode, core: G, CORE_SRC: '' };
  return api;
});

;GlowRuntime.CORE_SRC = "/*!\n * glow-core \u2014 gerador de gradientes de luz abstratos a partir de um hex.\n * L\u00f3gica: uma forma (o \"vetor\") gera um campo de dist\u00e2ncia; o campo vira energia\n * por camadas de blur empilhadas (n\u00facleo, bloom, halo, n\u00e9voa); a energia \u00e9\n * mapeada numa rampa de cor gerada do hex (OKLCH, com desvio de matiz).\n * Sem depend\u00eancias. Roda no browser (window.GlowGradient) e no node (require).\n */\n(function (root, factory) {\n  if (typeof module === 'object' && module.exports) module.exports = factory();\n  else root.GlowGradient = factory();\n})(typeof self !== 'undefined' ? self : this, function () {\n  'use strict';\n\n  var VERSION = '0.7.0';\n  var LUT_SIZE = 1024;\n\n  // ------------------------------------------------------------------ utils\n  function clamp(v, a, b) { return v < a ? a : v > b ? b : v; }\n  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }\n  function mix(a, b, t) { return a + (b - a) * t; }\n  function smooth(a, b, x) { var t = clamp01((x - a) / (b - a)); return t * t * (3 - 2 * t); }\n\n  function mulberry32(seed) {\n    var a = seed >>> 0;\n    return function () {\n      a = (a + 0x6D2B79F5) | 0;\n      var t = Math.imul(a ^ (a >>> 15), 1 | a);\n      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;\n      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;\n    };\n  }\n\n  function hash3(x, y, s) {\n    var h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(s | 0, 2246822519);\n    h = Math.imul(h ^ (h >>> 13), 1274126177);\n    h ^= h >>> 16;\n    return (h >>> 0) / 4294967296;\n  }\n\n  function vnoise(x, y, s) {\n    var ix = Math.floor(x), iy = Math.floor(y), fx = x - ix, fy = y - iy;\n    var a = hash3(ix, iy, s), b = hash3(ix + 1, iy, s), c = hash3(ix, iy + 1, s), d = hash3(ix + 1, iy + 1, s);\n    var ux = fx * fx * (3 - 2 * fx), uy = fy * fy * (3 - 2 * fy);\n    return a + (b - a) * ux + (c - a) * uy + (a - b - c + d) * ux * uy;\n  }\n\n  function fbm(x, y, s) {\n    return (vnoise(x, y, s) * 0.5 + vnoise(x * 2.03, y * 2.03, s + 17) * 0.25 + vnoise(x * 4.11, y * 4.11, s + 34) * 0.125) / 0.875;\n  }\n\n  // ------------------------------------------------------------------ color\n  function hexToRgb(hex) {\n    var n = parseInt(hex.slice(1), 16);\n    return [(n >> 16 & 255) / 255, (n >> 8 & 255) / 255, (n & 255) / 255];\n  }\n  function rgbToHex(c) {\n    return '#' + c.map(function (v) {\n      var x = Math.round(clamp01(v) * 255);\n      return (x < 16 ? '0' : '') + x.toString(16);\n    }).join('').toUpperCase();\n  }\n  function toLin(c) { return c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4); }\n  function toSrgb(c) { c = clamp01(c); return c <= 0.0031308 ? 12.92 * c : 1.055 * Math.pow(c, 1 / 2.4) - 0.055; }\n\n  function linToOklab(r, g, b) {\n    var l = Math.cbrt(0.4122214708 * r + 0.5363325363 * g + 0.0514459929 * b);\n    var m = Math.cbrt(0.2119034982 * r + 0.6806995451 * g + 0.1073969566 * b);\n    var s = Math.cbrt(0.0883024619 * r + 0.2817188376 * g + 0.6299787005 * b);\n    return [\n      0.2104542553 * l + 0.7936177850 * m - 0.0040720468 * s,\n      1.9779984951 * l - 2.4285922050 * m + 0.4505937099 * s,\n      0.0259040371 * l + 0.7827717662 * m - 0.8086757660 * s\n    ];\n  }\n  function oklabToLin(L, a, b) {\n    var l = L + 0.3963377774 * a + 0.2158037573 * b;\n    var m = L - 0.1055613458 * a - 0.0638541728 * b;\n    var s = L - 0.0894841775 * a - 1.2914855480 * b;\n    l = l * l * l; m = m * m * m; s = s * s * s;\n    return [\n      4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s,\n      -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s,\n      -0.0041960863 * l - 0.7034186147 * m + 1.7076147010 * s\n    ];\n  }\n  function inGamut(c) {\n    return c[0] >= -1e-4 && c[0] <= 1.0001 && c[1] >= -1e-4 && c[1] <= 1.0001 && c[2] >= -1e-4 && c[2] <= 1.0001;\n  }\n  function hexToOklch(hex) {\n    var c = hexToRgb(hex);\n    var lab = linToOklab(toLin(c[0]), toLin(c[1]), toLin(c[2]));\n    var h = Math.atan2(lab[2], lab[1]) * 180 / Math.PI;\n    return [lab[0], Math.hypot(lab[1], lab[2]), h < 0 ? h + 360 : h];\n  }\n  // OKLCH \u2192 sRGB (0..1). Fora do gamut, reduz croma mantendo L e matiz.\n  function oklchToSrgb(L, C, h) {\n    var hr = h * Math.PI / 180, ca = Math.cos(hr), sa = Math.sin(hr);\n    var rgb = oklabToLin(L, C * ca, C * sa);\n    if (!inGamut(rgb)) {\n      var lo = 0, hi = C;\n      for (var i = 0; i < 18; i++) {\n        var mid = (lo + hi) / 2;\n        if (inGamut(oklabToLin(L, mid * ca, mid * sa))) lo = mid; else hi = mid;\n      }\n      rgb = oklabToLin(L, lo * ca, lo * sa);\n    }\n    return [toSrgb(rgb[0]), toSrgb(rgb[1]), toSrgb(rgb[2])];\n  }\n  function srgbLuma(c) { return 0.2126 * toLin(c[0]) + 0.7152 * toLin(c[1]) + 0.0722 * toLin(c[2]); }\n\n  // Dist\u00e2ncia de matiz assinada (caminho mais curto) de h at\u00e9 alvo.\n  function hueDelta(h, target) { return ((target - h + 540) % 360) - 180; }\n\n  var HUE_WARM = 105; // amarelo em OKLCH: a luz \"esquenta\" rumo a ele, a sombra foge dele\n  var PALETTE_DRIFT = { mono: 0.12, analog: 0.38, thermal: 1, duo: 0.3, object: 0.12 };\n  var GRAD_ROWS = 32; // rampas pr\u00e9-misturadas ao longo do gradiente do objeto\n  var MAX_GSTOPS = 16;\n\n  /**\n   * Rampa fundo \u2192 luz gerada de um hex.\n   * mode 'dark': fundo escuro \u2192 base \u2192 n\u00facleo quase branco (luz emitida).\n   * mode 'light': fundo claro \u2192 tint \u2192 base \u2192 sombra profunda (tinta sobre papel).\n   * drift 0 = monocrom\u00e1tico; 1 = t\u00e9rmico (atravessa matizes).\n   * bg: hex do fundo ('' = autom\u00e1tico, derivado do hex principal). O stop 0 \u00e9 sempre o fundo exato.\n   */\n  function bgAuto(hex, mode, depth, drift) {\n    var base = hexToOklch(hex), C0 = base[1], h0 = base[2];\n    if (mode === 'light') return [0.975, Math.min(C0 * 0.05, 0.01), h0];\n    var dWarm = hueDelta(h0, HUE_WARM); if (Math.abs(dWarm) < 1) dWarm = -1;\n    var loShift = -Math.sign(dWarm) * 26 * Math.min(1, drift * 1.6);\n    return [depth, Math.min(Math.max(C0, 0.02) * 0.35, 0.05), h0 + loShift];\n  }\n\n  function lchToLab(s) { var r = s[2] * Math.PI / 180; return [s[0], s[1] * Math.cos(r), s[1] * Math.sin(r)]; }\n  function labToSrgb(L, a, b) {\n    var h = Math.atan2(b, a) * 180 / Math.PI;\n    return oklchToSrgb(L, Math.hypot(a, b), h < 0 ? h + 360 : h);\n  }\n\n  function buildRamp(hex, drift, opt) {\n    if (typeof opt === 'number') opt = { depth: opt };\n    opt = opt || {};\n    var mode = opt.mode === 'light' ? 'light' : 'dark', depth = opt.depth !== undefined ? opt.depth : 0.12;\n    var base = hexToOklch(hex), L0 = base[0], C0 = base[1], h0 = base[2];\n    var dWarm = hueDelta(h0, HUE_WARM);\n    if (Math.abs(dWarm) < 1) dWarm = -1; // base j\u00e1 amarela: sombra vai pro laranja/vermelho\n    var hot = clamp01((drift - 0.4) / 0.6);\n    var hiShift = dWarm * drift * (hot > 0 ? 1 : 0.55);\n    var loShift = -Math.sign(dWarm) * 26 * Math.min(1, drift * 1.6);\n    var Cv = Math.max(C0, 0.02);\n    var bgL, bgLab, bgRgb;\n    if (opt.bg && HEX.test(opt.bg)) {\n      var bo = hexToOklch(opt.bg); bgL = bo[0]; bgLab = lchToLab(bo); bgRgb = hexToRgb(opt.bg);\n    } else {\n      var ba = bgAuto(hex, mode, depth, drift); bgL = ba[0]; bgLab = lchToLab(ba); bgRgb = oklchToSrgb(ba[0], ba[1], ba[2]);\n    }\n    var stops;\n    if (mode === 'light') {\n      var Lm = clamp(L0, 0.45, 0.7);\n      var lo = loShift * Math.max(drift, 0.3) * 1.4;\n      // pastel na maior parte da rampa; o tom cheio e a sombra s\u00f3 no pico\n      stops = [\n        [0.00, bgL, 0, 0],\n        [0.30, mix(bgL, Lm, 0.22), Cv * 0.32, h0 + hiShift * 0.6],\n        [0.58, mix(bgL, Lm, 0.55), Cv * 0.72, h0 + hiShift * 0.3],\n        [0.80, Lm + 0.04, Cv * 0.98, h0],\n        [0.93, Lm - 0.08, Cv, h0 + lo * 0.5],\n        [1.00, Math.max(0.22, Lm - 0.2), Cv * 0.85, h0 + lo]\n      ];\n    } else {\n      var Lb = clamp(L0, 0.46, 0.72);\n      stops = [\n        [0.00, bgL, 0, 0],\n        [0.24, mix(bgL, Lb, 0.42), Cv * 0.88, h0 + loShift * 0.7],\n        [0.48, Lb, Cv, h0],\n        [0.70, mix(Lb, 0.9, 0.5), Cv * mix(0.72, 1.05, hot), h0 + hiShift * 0.5],\n        [0.86, 0.92, Cv * mix(0.36, 0.95, hot), h0 + hiShift],\n        [1.00, 0.985, mix(0.012, 0.04, hot), h0 + hiShift]\n      ];\n    }\n    var custom = !!(opt.bg && HEX.test(opt.bg));\n    var lut = new Float32Array(LUT_SIZE * 3);\n    var j = 0;\n    for (var i = 0; i < LUT_SIZE; i++) {\n      var t = i / (LUT_SIZE - 1);\n      while (j < stops.length - 2 && t > stops[j + 1][0]) j++;\n      var a = stops[j], b = stops[j + 1];\n      var lin = (t - a[0]) / (b[0] - a[0]);\n      var u = smooth(0, 1, lin) * 0.35 + lin * 0.65;\n      var c;\n      if (custom && j <= 1) {\n        // fundo escolhido: vai direto do fundo ao tom base em OKLab, sem o tom de sombra no meio (evita franja)\n        var tb = (t - stops[0][0]) / (stops[2][0] - stops[0][0]);\n        var ub = smooth(0, 1, tb) * 0.35 + tb * 0.65;\n        var lb2 = lchToLab([stops[2][1], stops[2][2], stops[2][3]]);\n        c = labToSrgb(mix(bgLab[0], lb2[0], ub), mix(bgLab[1], lb2[1], ub), mix(bgLab[2], lb2[2], ub));\n      } else if (j === 0) {\n        // fundo \u2192 primeiro tom em OKLab (fundo pode ter matiz indefinido / ser de outra cor)\n        var lb = lchToLab([b[1], b[2], b[3]]);\n        c = labToSrgb(mix(bgLab[0], lb[0], u), mix(bgLab[1], lb[1], u), mix(bgLab[2], lb[2], u));\n      } else {\n        c = oklchToSrgb(mix(a[1], b[1], u), mix(a[2], b[2], u), mix(a[3], b[3], u));\n      }\n      lut[i * 3] = c[0]; lut[i * 3 + 1] = c[1]; lut[i * 3 + 2] = c[2];\n    }\n    lut[0] = bgRgb[0]; lut[1] = bgRgb[1]; lut[2] = bgRgb[2];\n    var hexStops = stops.map(function (s, k) { return k === 0 ? rgbToHex(bgRgb) : rgbToHex(oklchToSrgb(s[1], s[2], s[3])); });\n    return { lut: lut, bg: bgRgb, stops: hexStops };\n  }\n\n  function rampColor(ramp, t) {\n    var i = Math.round(clamp01(t) * (LUT_SIZE - 1)) * 3;\n    return [ramp.lut[i], ramp.lut[i + 1], ramp.lut[i + 2]];\n  }\n\n  // ------------------------------------------------------------------ params\n  var SHAPES = ['eclipse', 'horizon', 'aurora', 'plasma', 'bloom', 'silk', 'veil', 'flow', 'fold', 'curtain', 'vector', 'draw'];\n  var VMODES = ['outline', 'fill', 'rim'];\n  var STROKE_SHAPES = { draw: 1 };\n  var MODES = ['dark', 'light'];\n  var MAX_PATHS = 8, MAX_PATH_PTS = 400;\n  var PALETTES = ['mono', 'analog', 'thermal', 'duo', 'object'];\n  var FORMATS = {\n    '9:16': [1080, 1920],\n    '4:5': [1080, 1350],\n    '1:1': [1600, 1600],\n    '16:9': [1920, 1080],\n    custom: null       // usa cw \u00d7 ch (ex.: tamanho do frame no Figma)\n  };\n\n  var DEFAULTS = {\n    shape: 'eclipse',\n    color: '#7A2BF0',\n    color2: '#FF4D2E',\n    palette: 'analog',\n    intensity: 0.6,   // at\u00e9 onde a rampa chega: glow de cor \u2192 n\u00facleo estourado no branco\n    spread: 0.55,     // tamanho das camadas de blur\n    angle: 35,        // dire\u00e7\u00e3o da luz, graus (0 = direita, 90 = cima)\n    curvature: 0.5,\n    turbulence: 0,\n    occluder: false,  // esfera escura\n    grain: 0.3,\n    depth: 0.12,      // lumin\u00e2ncia do fundo\n    elements: 4,\n    sharpness: 0.6,   // nitidez do n\u00facleo\n    contrast: 1,\n    drift: -1,        // -1 = autom\u00e1tico pelo modo de paleta\n    flare: 0.5,\n    soften: 0,        // desfoque da forma inteira (blur no vetor): tira a aresta dura\n    seed: 1,\n    format: '9:16',\n    scale: 1,\n    mode: 'dark',     // dark = luz emitida sobre escuro; light = tinta sobre claro\n    bg: '',           // hex do fundo; '' = autom\u00e1tico\n    transparent: false,\n    fadeT: 0, fadeR: 0, fadeB: 0, fadeL: 0,  // fade nas bordas (0..1 = at\u00e9 metade do quadro)\n    motion: { flow: 0.35, speed: 0.3, breathe: 0.15 }, // s\u00f3 pro runtime animado; n\u00e3o muda o PNG\n    cw: 1080, ch: 1920, // formato custom\n    vector: null,     // shape vetorial: { c: [[x,y,...]], z: [1|0], eo: 0|1 } em unidades do quadro\n    vmode: 'fill',    // outline | fill | rim\n    gfill: null,      // gradiente puxado do objeto: { t: 'l'|'r', m: [6] quadro\u2192espa\u00e7o do gradiente, s: [[pos, hex]...] }\n    objColor: true,   // puxa a cor (s\u00f3lida ou gradiente) do SVG/shape selecionado\n    paths: []         // forma desenhada: [[x,y,x,y...], ...] em unidades do menor lado, origem no centro\n  };\n\n  var SHAPE_PRESETS = {\n    eclipse: { label: 'Eclipse', angle: 35, intensity: 0.66, spread: 0.55, curvature: 0.55, turbulence: 0, sharpness: 0.75, flare: 0.45, occluder: false, elements: 1 },\n    horizon: { label: 'Horizonte', angle: 90, intensity: 0.72, spread: 0.62, curvature: 0.22, turbulence: 0, sharpness: 0.85, flare: 0.9, occluder: false, elements: 1 },\n    aurora: { label: 'Aurora', angle: 22, intensity: 0.6, spread: 0.7, curvature: 0.4, turbulence: 0.12, sharpness: 0.1, flare: 0.55, occluder: true, elements: 5 },\n    plasma: { label: 'Plasma', angle: 62, intensity: 0.76, spread: 0.42, curvature: 0.5, turbulence: 0.62, sharpness: 0.3, flare: 0.3, occluder: false, elements: 4 },\n    bloom: { label: 'Bloom', angle: 40, intensity: 0.5, spread: 0.75, curvature: 0.45, turbulence: 0.35, sharpness: 0, flare: 0.25, occluder: false, elements: 3 },\n    silk: { label: 'Seda', angle: 100, intensity: 0.55, spread: 0.6, curvature: 0.6, turbulence: 0.3, sharpness: 0.55, flare: 0.3, occluder: false, elements: 4 },\n    veil: { label: 'V\u00e9u', angle: 0, intensity: 0.5, spread: 0.6, curvature: 0.6, turbulence: 0.15, sharpness: 0.6, flare: 0.25, occluder: false, elements: 2 },\n    flow: { label: 'Fluxo', angle: 125, intensity: 0.52, spread: 0.5, curvature: 0.45, turbulence: 0.12, sharpness: 0.65, flare: 0.3, occluder: false, elements: 4 },\n    fold: { label: 'Dobra', angle: 215, intensity: 0.6, spread: 0.6, curvature: 0.5, turbulence: 0.05, sharpness: 0.7, flare: 0.4, occluder: false, elements: 1 },\n    curtain: { label: 'Cortina', angle: 90, intensity: 0.6, spread: 0.55, curvature: 0.5, turbulence: 0.04, sharpness: 0.5, flare: 0.35, occluder: false, elements: 3 },\n    vector: { label: 'Vetor', angle: 60, intensity: 0.6, spread: 0.45, curvature: 0.5, turbulence: 0, sharpness: 0.6, flare: 0.35, occluder: false, elements: 1 },\n    draw: { label: 'Desenho', angle: 35, intensity: 0.54, spread: 0.5, curvature: 0.5, turbulence: 0.08, sharpness: 0.6, flare: 0.45, occluder: false, elements: 3 }\n  };\n  var SHAPE_KEYS = ['angle', 'intensity', 'spread', 'curvature', 'turbulence', 'sharpness', 'flare', 'occluder', 'elements'];\n\n  var RANGES = {\n    intensity: [0, 1], spread: [0, 1], angle: [-3600, 3600], curvature: [0, 1], turbulence: [0, 1],\n    grain: [0, 1], depth: [0, 0.3], elements: [1, 8], sharpness: [0, 1], contrast: [0.5, 2],\n    drift: [-1, 1], flare: [0, 1], soften: [0, 1], seed: [0, 999999],\n    fadeT: [0, 1], fadeR: [0, 1], fadeB: [0, 1], fadeL: [0, 1]\n  };\n  var HEX = /^#[0-9A-F]{6}$/;\n\n  function normalize(p) {\n    var o = {}, k;\n    p = p || {};\n    for (k in DEFAULTS) o[k] = DEFAULTS[k];\n    for (k in RANGES) {\n      var v = Number(p[k]);\n      if (p[k] !== undefined && isFinite(v)) o[k] = clamp(v, RANGES[k][0], RANGES[k][1]);\n    }\n    o.angle = ((o.angle % 360) + 360) % 360;\n    o.elements = Math.round(o.elements);\n    o.seed = Math.round(o.seed);\n    ['color', 'color2'].forEach(function (c) {\n      var v = typeof p[c] === 'string' ? p[c].trim().toUpperCase() : '';\n      if (v && v[0] !== '#') v = '#' + v;\n      if (HEX.test(v)) o[c] = v;\n    });\n    if (SHAPES.indexOf(p.shape) >= 0) o.shape = p.shape;\n    if (PALETTES.indexOf(p.palette) >= 0) o.palette = p.palette;\n    if (p.format in FORMATS) o.format = p.format;\n    ['cw', 'ch'].forEach(function (k2) { var v2 = Math.round(Number(p[k2])); if (isFinite(v2) && v2 >= 16) o[k2] = Math.min(8192, v2); });\n    if (VMODES.indexOf(p.vmode) >= 0) o.vmode = p.vmode;\n    o.vector = normVector(p.vector);\n    o.gfill = normGfill(p.gfill);\n    if (typeof p.objColor === 'boolean') o.objColor = p.objColor;\n    if (o.palette === 'object' && !o.gfill) o.palette = 'analog';\n    if (o.palette !== 'object') o.gfill = null; // gradiente s\u00f3 vale na palette do objeto\n    if (p.scale === 2 || p.scale === '2') o.scale = 2;\n    if (typeof p.occluder === 'boolean') o.occluder = p.occluder;\n    if (MODES.indexOf(p.mode) >= 0) o.mode = p.mode;\n    if (typeof p.transparent === 'boolean') o.transparent = p.transparent;\n    if (typeof p.bg === 'string') {\n      var bv = p.bg.trim().toUpperCase();\n      if (bv && bv[0] !== '#') bv = '#' + bv;\n      o.bg = HEX.test(bv) ? bv : '';\n    }\n    var mo = p.motion && typeof p.motion === 'object' ? p.motion : {};\n    o.motion = {\n      flow: isFinite(Number(mo.flow)) && mo.flow !== undefined ? clamp(Number(mo.flow), 0, 1) : DEFAULTS.motion.flow,\n      speed: isFinite(Number(mo.speed)) && mo.speed !== undefined ? clamp(Number(mo.speed), 0, 1) : DEFAULTS.motion.speed,\n      breathe: isFinite(Number(mo.breathe)) && mo.breathe !== undefined ? clamp(Number(mo.breathe), 0, 1) : DEFAULTS.motion.breathe\n    };\n    o.paths = [];\n    if (Array.isArray(p.paths)) {\n      for (var pi = 0; pi < p.paths.length && o.paths.length < MAX_PATHS; pi++) {\n        var src = p.paths[pi];\n        if (!Array.isArray(src) || src.length < 4) continue;\n        var clean = [];\n        for (var q = 0; q + 1 < src.length && clean.length < MAX_PATH_PTS * 2; q += 2) {\n          var x = Number(src[q]), y = Number(src[q + 1]);\n          if (!isFinite(x) || !isFinite(y)) { clean = null; break; }\n          clean.push(Math.round(clamp(x, -3, 3) * 1e4) / 1e4, Math.round(clamp(y, -3, 3) * 1e4) / 1e4);\n        }\n        if (clean && clean.length >= 4) o.paths.push(clean);\n      }\n    }\n    return o;\n  }\n\n  function preset(shape, base) {\n    var o = normalize(base || {});\n    var sp = SHAPE_PRESETS[shape] || SHAPE_PRESETS.eclipse;\n    o.shape = SHAPE_PRESETS[shape] ? shape : 'eclipse';\n    SHAPE_KEYS.forEach(function (k) { o[k] = sp[k]; });\n    return normalize(o);\n  }\n\n  function outputSize(p) {\n    var f = p.format === 'custom' ? [p.cw, p.ch] : FORMATS[p.format] || FORMATS['9:16'];\n    var sc = p.scale;\n    // teto de 8192 px no maior lado\n    if (Math.max(f[0], f[1]) * sc > 8192) sc = 8192 / Math.max(f[0], f[1]);\n    return [Math.round(f[0] * sc), Math.round(f[1] * sc)];\n  }\n\n  function normVector(v) {\n    if (!v || !Array.isArray(v.c)) return null;\n    var c = [], z = [], total = 0;\n    for (var i = 0; i < v.c.length && c.length < MAX_VEC_CONTOURS; i++) {\n      var src = v.c[i];\n      if (!Array.isArray(src) || src.length < 4) continue;\n      var room = MAX_VEC_PTS - total, cl = [];\n      if (room < 2) break;\n      for (var q = 0; q + 1 < src.length && cl.length < room * 2; q += 2) {\n        var x = Number(src[q]), y = Number(src[q + 1]);\n        if (!isFinite(x) || !isFinite(y)) { cl = null; break; }\n        cl.push(Math.round(clamp(x, -4, 4) * 1e4) / 1e4, Math.round(clamp(y, -4, 4) * 1e4) / 1e4);\n      }\n      if (!cl || cl.length < 4) continue;\n      c.push(cl); z.push(Array.isArray(v.z) && v.z[i] ? 1 : 0); total += cl.length / 2;\n    }\n    return c.length ? { c: c, z: z, eo: v.eo ? 1 : 0 } : null;\n  }\n\n  function normGfill(g) {\n    if (!g || !Array.isArray(g.s) || !Array.isArray(g.m) || g.m.length !== 6) return null;\n    var m = [];\n    for (var i = 0; i < 6; i++) { var v = Number(g.m[i]); if (!isFinite(v)) return null; m.push(Math.round(clamp(v, -1e4, 1e4) * 1e4) / 1e4); }\n    var s = [];\n    for (var j = 0; j < g.s.length && s.length < MAX_GSTOPS; j++) {\n      var st = g.s[j]; if (!Array.isArray(st)) continue;\n      var pos = Number(st[0]), hx = typeof st[1] === 'string' ? st[1].trim().toUpperCase() : '';\n      if (hx && hx[0] !== '#') hx = '#' + hx;\n      if (!isFinite(pos) || !HEX.test(hx)) continue;\n      var al = st[2] === undefined ? 1 : Number(st[2]);\n      s.push([Math.round(clamp(pos, 0, 1) * 1e4) / 1e4, hx, isFinite(al) ? Math.round(clamp01(al) * 1000) / 1000 : 1]);\n    }\n    s.sort(function (a, b) { return a[0] - b[0]; });\n    if (s.length < 2) return null;\n    return { t: g.t === 'r' ? 'r' : 'l', m: m, s: s };\n  }\n\n  function driftOf(p) { return p.drift >= 0 ? p.drift : PALETTE_DRIFT[p.palette]; }\n\n  // palette que precisa de mapa de mistura por pixel (duo: ru\u00eddo; object: posi\u00e7\u00e3o no gradiente)\n  function needsMix(p) { return p.palette === 'duo' || (p.palette === 'object' && !!p.gfill); }\n\n  // posi\u00e7\u00e3o 0..1 do pixel (unidades do quadro) dentro do gradiente do objeto (spread = pad, como no SVG)\n  function gradPos(g, x, y) {\n    var m = g.m, u = m[0] * x + m[2] * y + m[4];\n    if (g.t === 'r') { var v = m[1] * x + m[3] * y + m[5]; u = Math.sqrt(u * u + v * v); }\n    return u < 0 ? 0 : u > 1 ? 1 : u;\n  }\n\n  function ramps(p) {\n    var d = driftOf(p);\n    var o = { mode: p.mode, depth: p.depth, bg: p.bg };\n    if (p.palette === 'object' && p.gfill) {\n      // uma rampa por stop, todas sobre o MESMO fundo (o do 1\u00ba stop) pra n\u00e3o aparecer emenda de fundo\n      var a0 = buildRamp(p.gfill.s[0][1], d, o);\n      var og = { mode: p.mode, depth: p.depth, bg: p.bg || rgbToHex(a0.bg) };\n      var list = p.gfill.s.map(function (st) { return buildRamp(st[1], d, og); });\n      var pos = p.gfill.s.map(function (st) { return st[0]; });\n      var R = GRAD_ROWS, N = LUT_SIZE * 3, rows = new Float32Array(R * N);\n      for (var r = 0; r < R; r++) {\n        var tg = r / (R - 1), j = 0;\n        while (j < pos.length - 2 && tg > pos[j + 1]) j++;\n        var span = pos[j + 1] - pos[j], f = span > 1e-6 ? clamp01((tg - pos[j]) / span) : (tg >= pos[j + 1] ? 1 : 0);\n        var A = list[j].lut, B = list[j + 1].lut, off = r * N;\n        for (var q = 0; q < N; q++) rows[off + q] = A[q] + (B[q] - A[q]) * f;\n      }\n      var alpha = null;\n      if (p.gfill.s.some(function (st) { return st[2] < 1; })) {\n        alpha = new Float32Array(256);\n        for (var ai = 0; ai < 256; ai++) {\n          var ta = ai / 255, k2 = 0;\n          while (k2 < pos.length - 2 && ta > pos[k2 + 1]) k2++;\n          var sp2 = pos[k2 + 1] - pos[k2], fa = sp2 > 1e-6 ? clamp01((ta - pos[k2]) / sp2) : (ta >= pos[k2 + 1] ? 1 : 0);\n          alpha[ai] = mix(p.gfill.s[k2][2], p.gfill.s[k2 + 1][2], fa);\n        }\n      }\n      return { a: list[0], b: null, g: { rows: rows, n: R, t: p.gfill.t, m: p.gfill.m, alpha: alpha, stops: list.map(function (l) { return l.stops; }) } };\n    }\n    var a = buildRamp(p.color, d, o);\n    return { a: a, b: p.palette === 'duo' ? buildRamp(p.color2, d, o) : null };\n  }\n\n  // ------------------------------------------------------------------ strokes\n  // Formas por tra\u00e7o: qualquer polilinha vira luz (dist\u00e2ncia at\u00e9 o vetor \u2192 camadas de blur).\n  function chaikin(pts, closed, iters) {\n    for (var it = 0; it < iters; it++) {\n      var n = pts.length / 2, out = [];\n      if (n < 3) return pts;\n      if (!closed) out.push(pts[0], pts[1]);\n      var last = closed ? n : n - 1;\n      for (var i = 0; i < last; i++) {\n        var j = (i + 1) % n;\n        var x0 = pts[i * 2], y0 = pts[i * 2 + 1], x1 = pts[j * 2], y1 = pts[j * 2 + 1];\n        out.push(0.75 * x0 + 0.25 * x1, 0.75 * y0 + 0.25 * y1, 0.25 * x0 + 0.75 * x1, 0.25 * y0 + 0.75 * y1);\n      }\n      if (!closed) out.push(pts[pts.length - 2], pts[pts.length - 1]);\n      pts = out;\n    }\n    return pts;\n  }\n\n  function resample(pts, closed, spacing, cap) {\n    var n = pts.length / 2, total = 0, i;\n    if (n < 2) return pts.slice();\n    var segs = closed ? n : n - 1;\n    for (i = 0; i < segs; i++) {\n      var j = (i + 1) % n;\n      total += Math.hypot(pts[j * 2] - pts[i * 2], pts[j * 2 + 1] - pts[i * 2 + 1]);\n    }\n    if (total < 1e-6) return [pts[0], pts[1], pts[0] + 1e-4, pts[1]];\n    var count = Math.max(2, Math.min(cap, Math.ceil(total / spacing)));\n    var step = total / (closed ? count : count - 1);\n    var out = [pts[0], pts[1]], acc = 0, target = step;\n    for (i = 0; i < segs && out.length / 2 < count; i++) {\n      var k = (i + 1) % n;\n      var ax_ = pts[i * 2], ay_ = pts[i * 2 + 1], bx = pts[k * 2], by = pts[k * 2 + 1];\n      var L = Math.hypot(bx - ax_, by - ay_);\n      while (L > 0 && acc + L >= target && out.length / 2 < count) {\n        var t = (target - acc) / L;\n        out.push(ax_ + (bx - ax_) * t, ay_ + (by - ay_) * t);\n        target += step;\n      }\n      acc += L;\n    }\n    if (!closed) { out[out.length - 2] = pts[pts.length - 2]; out[out.length - 1] = pts[pts.length - 1]; }\n    return out;\n  }\n\n  var CHUNK = 12;\n  // Prepara um tra\u00e7o: segmentos + comprimento acumulado + caixas por bloco (acelera\u00e7\u00e3o).\n  function prepStroke(st, smoothIters) {\n    var pts = chaikin(st.pts, st.closed, smoothIters || 0);\n    pts = resample(pts, st.closed, 0.014, 360);\n    if (st.closed) pts = pts.concat([pts[0], pts[1]]);\n    var n = pts.length / 2 - 1;\n    var seg = new Float64Array(n * 6); // ax, ay, ex, ey, len2, cum\n    var cum = 0;\n    for (var i = 0; i < n; i++) {\n      var ax_ = pts[i * 2], ay_ = pts[i * 2 + 1], ex = pts[i * 2 + 2] - ax_, ey = pts[i * 2 + 3] - ay_;\n      var l2 = ex * ex + ey * ey;\n      seg[i * 6] = ax_; seg[i * 6 + 1] = ay_; seg[i * 6 + 2] = ex; seg[i * 6 + 3] = ey; seg[i * 6 + 4] = l2 || 1e-12; seg[i * 6 + 5] = cum;\n      cum += Math.sqrt(l2);\n    }\n    var nc = Math.ceil(n / CHUNK), box = new Float64Array(nc * 4);\n    for (var c = 0; c < nc; c++) {\n      var x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;\n      for (var s = c * CHUNK; s < Math.min(n, (c + 1) * CHUNK); s++) {\n        var px = seg[s * 6], py = seg[s * 6 + 1], qx = px + seg[s * 6 + 2], qy = py + seg[s * 6 + 3];\n        x0 = Math.min(x0, px, qx); y0 = Math.min(y0, py, qy); x1 = Math.max(x1, px, qx); y1 = Math.max(y1, py, qy);\n      }\n      box[c * 4] = x0; box[c * 4 + 1] = y0; box[c * 4 + 2] = x1; box[c * 4 + 3] = y1;\n    }\n    return {\n      seg: seg, n: n, box: box, nc: nc, total: cum || 1e-6, pts: pts,\n      closed: st.closed, amp: st.amp, thick: st.thick || 1,\n      ns: st.ns || 0,\n      ex0: pts[0], ey0: pts[1], ex1: pts[pts.length - 2], ey1: pts[pts.length - 1],\n      r0: Math.max(0.03, (st.taper ? st.taper[0] : 0.05) * cum), r1: Math.max(0.03, (st.taper ? st.taper[1] : 0.05) * cum)\n    };\n  }\n\n  // dist\u00e2ncia m\u00ednima ao tra\u00e7o + posi\u00e7\u00e3o ao longo dele (0..1)\n  var _hit = [0, 0];\n  function strokeDist(st, x, y) {\n    var best = 1e18, bi = 0, bt = 0, seg = st.seg, box = st.box;\n    for (var c = 0; c < st.nc; c++) {\n      var bx = x < box[c * 4] ? box[c * 4] - x : x > box[c * 4 + 2] ? x - box[c * 4 + 2] : 0;\n      var by = y < box[c * 4 + 1] ? box[c * 4 + 1] - y : y > box[c * 4 + 3] ? y - box[c * 4 + 3] : 0;\n      if (bx * bx + by * by >= best) continue;\n      var end = Math.min(st.n, (c + 1) * CHUNK);\n      for (var i = c * CHUNK; i < end; i++) {\n        var o = i * 6, dx = x - seg[o], dy = y - seg[o + 1];\n        var t = (dx * seg[o + 2] + dy * seg[o + 3]) / seg[o + 4];\n        t = t < 0 ? 0 : t > 1 ? 1 : t;\n        var qx = dx - t * seg[o + 2], qy = dy - t * seg[o + 3], d2 = qx * qx + qy * qy;\n        if (d2 < best) { best = d2; bi = i; bt = t; }\n      }\n    }\n    _hit[0] = Math.sqrt(best);\n    _hit[1] = (seg[bi * 6 + 5] + bt * Math.sqrt(seg[bi * 6 + 4])) / st.total;\n    return _hit;\n  }\n\n  function cubic(p0, p1, p2, p3, n) {\n    var out = [];\n    for (var i = 0; i <= n; i++) {\n      var t = i / n, u = 1 - t, a = u * u * u, b = 3 * u * u * t, c = 3 * u * t * t, d = t * t * t;\n      out.push(a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0], a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1]);\n    }\n    return out;\n  }\n\n  // Gera os tra\u00e7os de cada forma procedural. Unidades: menor lado = 1, origem no centro.\n  function genStrokes(p, rng, F) {\n    var Dx = F.Dx, Dy = F.Dy, Nx = F.Nx, Ny = F.Ny, ax = F.ax, ay = F.ay, ext = F.ext;\n    var cv = p.curvature, n = p.elements, out = [], i, k, t;\n    function rot(x, y, a) { var c = Math.cos(a), s = Math.sin(a); return [x * c - y * s, x * s + y * c]; }\n    if (p.shape === 'draw') {\n      var base2 = [];\n      if (p.paths && p.paths.length) {\n        p.paths.forEach(function (pp2) { base2.push({ pts: pp2.slice(), closed: false }); });\n      } else {\n        // gesto procedural enquanto n\u00e3o h\u00e1 desenho\n        var g0 = [-Dx * ext * 0.9 + Nx * 0.3 * (rng() - 0.5), -Dy * ext * 0.9 + Ny * 0.3 * (rng() - 0.5)];\n        var g3 = [Dx * ext * 0.9 + Nx * 0.4 * (rng() - 0.5), Dy * ext * 0.9 + Ny * 0.4 * (rng() - 0.5)];\n        var g1 = [mix(g0[0], g3[0], 0.33) + Nx * mix(-0.7, 0.7, rng()), mix(g0[1], g3[1], 0.33) + Ny * mix(-0.7, 0.7, rng())];\n        var g2 = [mix(g0[0], g3[0], 0.66) + Nx * mix(-0.7, 0.7, rng()), mix(g0[1], g3[1], 0.66) + Ny * mix(-0.7, 0.7, rng())];\n        base2.push({ pts: cubic(g0, g1, g2, g3, 80), closed: false });\n      }\n      // elementos = ecos paralelos do tra\u00e7o\n      var spacing = mix(0.035, 0.09, rng());\n      base2.forEach(function (b, bi) {\n        var bp2 = resample(chaikin(b.pts, false, 2), false, 0.01, 400), m2 = bp2.length / 2, nrm = [];\n        for (i = 0; i < m2; i++) {\n          var i0 = Math.max(0, i - 3), i1 = Math.min(m2 - 1, i + 3);\n          var tx2 = bp2[i1 * 2] - bp2[i0 * 2], ty2 = bp2[i1 * 2 + 1] - bp2[i0 * 2 + 1], tl = Math.hypot(tx2, ty2) || 1;\n          nrm.push(-ty2 / tl, tx2 / tl);\n        }\n        for (k = 0; k < n; k++) {\n          var o2 = k === 0 ? 0 : Math.ceil(k / 2) * (k % 2 ? 1 : -1) * spacing;\n          var ep = [];\n          for (i = 0; i < m2; i++) ep.push(bp2[i * 2] + nrm[i * 2] * o2, bp2[i * 2 + 1] + nrm[i * 2 + 1] * o2);\n          out.push({ pts: ep, closed: false, amp: Math.pow(0.72, k), thick: 1, taper: [0.06, 0.12], ns: bi * 9.1 + k * 2.3, smooth: 1 + Math.round(cv * 3) });\n        }\n      });\n    }\n    return out;\n  }\n\n  // ------------------------------------------------------------------ geometria vetorial\n  var MAX_VEC_PTS = 1600, MAX_VEC_CONTOURS = 96;\n  // shape de exemplo (marca abstrata) at\u00e9 o usu\u00e1rio colar/selecionar um vetor\n  var SAMPLE_VECTOR = (function () {\n    var c = [], z = [];\n    function ring(cx, cy, r, k, rot, sq) {\n      var o = [];\n      for (var i = 0; i < k; i++) {\n        var a = rot + i / k * 6.2832, cs = Math.cos(a), sn = Math.sin(a);\n        var m = sq ? 1 / Math.pow(Math.pow(Math.abs(cs), 4) + Math.pow(Math.abs(sn), 4), 0.25) : 1;\n        o.push(Math.round((cx + cs * r * m) * 1e4) / 1e4, Math.round((cy + sn * r * m) * 1e4) / 1e4);\n      }\n      return o;\n    }\n    c.push(ring(-0.06, -0.04, 0.2, 72, 0.3, true)); z.push(1);\n    c.push(ring(-0.06, -0.04, 0.11, 56, 0.3, true).reverse()); z.push(1);\n    c.push(ring(0.14, 0.15, 0.075, 40, 0, false)); z.push(1);\n    return { c: c, z: z, eo: 0 };\n  })();\n\n  function boxBlur3(src, W, H, r) {\n    var a = new Float32Array(src), b = new Float32Array(W * H), pass, x, y, s, i;\n    var inv = 1 / (2 * r + 1);\n    for (pass = 0; pass < 3; pass++) {\n      for (y = 0; y < H; y++) {\n        var row = y * W; s = 0;\n        for (i = -r; i <= r; i++) s += a[row + clamp(i, 0, W - 1)];\n        for (x = 0; x < W; x++) {\n          b[row + x] = s * inv;\n          s += a[row + Math.min(W - 1, x + r + 1)] - a[row + Math.max(0, x - r)];\n        }\n      }\n      for (x = 0; x < W; x++) {\n        s = 0;\n        for (i = -r; i <= r; i++) s += b[clamp(i, 0, H - 1) * W + x];\n        for (y = 0; y < H; y++) {\n          a[y * W + x] = s * inv;\n          s += b[Math.min(H - 1, y + r + 1) * W + x] - b[Math.max(0, y - r) * W + x];\n        }\n      }\n    }\n    return a;\n  }\n\n  // segmentos + caixas por bloco + normais externas + faixas pro teste dentro/fora\n  function vectorGeom(V) {\n    var segs = [], i, k;\n    var closedAny = false;\n    V.c.forEach(function (pts, ci) {\n      var closed = !!V.z[ci], n = pts.length / 2;\n      if (closed) closedAny = true;\n      var last = closed ? n : n - 1;\n      for (i = 0; i < last; i++) {\n        var j = (i + 1) % n;\n        segs.push(pts[i * 2], pts[i * 2 + 1], pts[j * 2], pts[j * 2 + 1], closed ? 1 : 0);\n      }\n    });\n    var n = segs.length / 5;\n    var seg = new Float64Array(n * 6), on = new Float32Array(n * 2), cl = new Uint8Array(n);\n    for (i = 0; i < n; i++) {\n      var ax_ = segs[i * 5], ay_ = segs[i * 5 + 1], ex = segs[i * 5 + 2] - ax_, ey = segs[i * 5 + 3] - ay_, l2 = ex * ex + ey * ey;\n      seg[i * 6] = ax_; seg[i * 6 + 1] = ay_; seg[i * 6 + 2] = ex; seg[i * 6 + 3] = ey; seg[i * 6 + 4] = l2 || 1e-12;\n      cl[i] = segs[i * 5 + 4];\n    }\n    // ordena segmentos por posi\u00e7\u00e3o (Morton grosseiro) pra caixas de bloco apertadas\n    var nc = Math.ceil(n / CHUNK), box = new Float64Array(nc * 4);\n    for (var c = 0; c < nc; c++) {\n      var x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;\n      for (k = c * CHUNK; k < Math.min(n, (c + 1) * CHUNK); k++) {\n        var px = seg[k * 6], py = seg[k * 6 + 1], qx = px + seg[k * 6 + 2], qy = py + seg[k * 6 + 3];\n        x0 = Math.min(x0, px, qx); y0 = Math.min(y0, py, qy); x1 = Math.max(x1, px, qx); y1 = Math.max(y1, py, qy);\n      }\n      box[c * 4] = x0; box[c * 4 + 1] = y0; box[c * 4 + 2] = x1; box[c * 4 + 3] = y1;\n    }\n    // faixas horizontais: cruzamentos (x, dire\u00e7\u00e3o) de arestas fechadas no centro de cada faixa\n    var by0 = 1e9, by1 = -1e9;\n    for (i = 0; i < n; i++) if (cl[i]) { by0 = Math.min(by0, seg[i * 6 + 1], seg[i * 6 + 1] + seg[i * 6 + 3]); by1 = Math.max(by1, seg[i * 6 + 1], seg[i * 6 + 1] + seg[i * 6 + 3]); }\n    var NB = closedAny ? 2048 : 0, bandH = closedAny ? (by1 - by0) / NB || 1 : 1, bands = [];\n    for (var bi = 0; bi < NB; bi++) {\n      var yc = by0 + (bi + 0.5) * bandH, xs = [];\n      for (i = 0; i < n; i++) {\n        if (!cl[i]) continue;\n        var ya = seg[i * 6 + 1], yb = ya + seg[i * 6 + 3];\n        if ((ya <= yc && yb > yc) || (yb <= yc && ya > yc)) {\n          var t = (yc - ya) / (yb - ya);\n          xs.push(seg[i * 6] + t * seg[i * 6 + 2], yb > ya ? 1 : -1);\n        }\n      }\n      // ordena pares por x\n      var idx = []; for (k = 0; k < xs.length; k += 2) idx.push(k);\n      idx.sort(function (a, b) { return xs[a] - xs[b]; });\n      var sx = new Float64Array(idx.length), sd = new Int8Array(idx.length);\n      idx.forEach(function (o, m) { sx[m] = xs[o]; sd[m] = xs[o + 1]; });\n      bands.push([sx, sd]);\n    }\n    var eo = !!V.eo;\n    function inside(x, y) {\n      if (!NB || y < by0 || y >= by1) return false;\n      var b = bands[Math.min(NB - 1, ((y - by0) / bandH) | 0)], sx = b[0], sd = b[1], w = 0;\n      for (var m = 0; m < sx.length && sx[m] < x; m++) w += sd[m];\n      return eo ? (sx.length && countLess(sx, x) % 2 === 1) : w !== 0;\n    }\n    function countLess(arr, x) { var c2 = 0; while (c2 < arr.length && arr[c2] < x) c2++; return c2; }\n    var G = { seg: seg, n: n, box: box, nc: nc, on: on, inside: inside, closedAny: closedAny };\n    // normal externa por segmento (teste no ponto m\u00e9dio deslocado)\n    for (i = 0; i < n; i++) {\n      var L = Math.sqrt(seg[i * 6 + 4]), nx = -seg[i * 6 + 3] / L, ny = seg[i * 6 + 2] / L;\n      var mx = seg[i * 6] + seg[i * 6 + 2] / 2, my = seg[i * 6 + 1] + seg[i * 6 + 3] / 2, eps = 0.0015;\n      if (cl[i] && inside(mx + nx * eps, my + ny * eps) && !inside(mx - nx * eps, my - ny * eps)) { nx = -nx; ny = -ny; }\n      on[i * 2] = nx; on[i * 2 + 1] = ny;\n    }\n    return G;\n  }\n\n  var _vhit = [0, 0];\n  function vecDist(G, x, y) {\n    var best = 1e18, bi = 0, seg = G.seg, box = G.box;\n    for (var c = 0; c < G.nc; c++) {\n      var bx = x < box[c * 4] ? box[c * 4] - x : x > box[c * 4 + 2] ? x - box[c * 4 + 2] : 0;\n      var by = y < box[c * 4 + 1] ? box[c * 4 + 1] - y : y > box[c * 4 + 3] ? y - box[c * 4 + 3] : 0;\n      if (bx * bx + by * by >= best) continue;\n      var end = Math.min(G.n, (c + 1) * CHUNK);\n      for (var i = c * CHUNK; i < end; i++) {\n        var o = i * 6, dx = x - seg[o], dy = y - seg[o + 1];\n        var t = (dx * seg[o + 2] + dy * seg[o + 3]) / seg[o + 4];\n        t = t < 0 ? 0 : t > 1 ? 1 : t;\n        var qx = dx - t * seg[o + 2], qy = dy - t * seg[o + 3], d2 = qx * qx + qy * qy;\n        if (d2 < best) { best = d2; bi = i; }\n      }\n    }\n    _vhit[0] = Math.sqrt(best); _vhit[1] = bi;\n    return _vhit[0];\n  }\n\n  // ------------------------------------------------------------------ SVG \u2192 contornos\n  // Parser m\u00ednimo e sem DOM (roda no worker/node): path d (todos os comandos), rect, circle,\n  // ellipse, line, polyline, polygon, transform (matrix/translate/scale/rotate/skew) aninhado em <g>.\n  // Curvas s\u00e3o achatadas em polilinhas. Sa\u00edda em coordenadas do SVG.\n  function mmul(a, b) {\n    return [a[0] * b[0] + a[2] * b[1], a[1] * b[0] + a[3] * b[1], a[0] * b[2] + a[2] * b[3], a[1] * b[2] + a[3] * b[3],\n      a[0] * b[4] + a[2] * b[5] + a[4], a[1] * b[4] + a[3] * b[5] + a[5]];\n  }\n  function parseTransform(str) {\n    var m = [1, 0, 0, 1, 0, 0], re = /(matrix|translate|scale|rotate|skewX|skewY)\\s*\\(([^)]*)\\)/g, r;\n    while ((r = re.exec(str || ''))) {\n      var a = r[2].trim().split(/[\\s,]+/).map(Number), t;\n      if (r[1] === 'matrix' && a.length === 6) t = a;\n      else if (r[1] === 'translate') t = [1, 0, 0, 1, a[0] || 0, a[1] || 0];\n      else if (r[1] === 'scale') t = [a[0], 0, 0, a.length > 1 ? a[1] : a[0], 0, 0];\n      else if (r[1] === 'rotate') {\n        var an = (a[0] || 0) * Math.PI / 180, c = Math.cos(an), s = Math.sin(an);\n        t = [c, s, -s, c, 0, 0];\n        if (a.length === 3) t = mmul(mmul([1, 0, 0, 1, a[1], a[2]], t), [1, 0, 0, 1, -a[1], -a[2]]);\n      } else if (r[1] === 'skewX') t = [1, 0, Math.tan((a[0] || 0) * Math.PI / 180), 1, 0, 0];\n      else if (r[1] === 'skewY') t = [1, Math.tan((a[0] || 0) * Math.PI / 180), 0, 1, 0, 0];\n      if (t && t.every(isFinite)) m = mmul(m, t);\n    }\n    return m;\n  }\n  function attr(s, name) {\n    var r = new RegExp('(?:^|\\\\s)' + name + '\\\\s*=\\\\s*(\"([^\"]*)\"|\\'([^\\']*)\\')').exec(s);\n    return r ? (r[2] !== undefined ? r[2] : r[3]) : null;\n  }\n  function num(s, name, d) { var v = parseFloat(attr(s, name)); return isFinite(v) ? v : d; }\n  function minv(m) {\n    var det = m[0] * m[3] - m[1] * m[2];\n    if (!det || !isFinite(det)) return null;\n    var id = 1 / det;\n    return [m[3] * id, -m[1] * id, -m[2] * id, m[0] * id, (m[2] * m[5] - m[3] * m[4]) * id, (m[1] * m[4] - m[0] * m[5]) * id];\n  }\n\n  // ---- cor do SVG (pra puxar a cor do objeto) ----\n  var NAMED = { black: '#000000', white: '#FFFFFF', red: '#FF0000', orange: '#FFA500', yellow: '#FFFF00', green: '#008000', lime: '#00FF00', blue: '#0000FF', purple: '#800080', magenta: '#FF00FF', fuchsia: '#FF00FF', cyan: '#00FFFF', aqua: '#00FFFF', pink: '#FFC0CB', gray: '#808080', grey: '#808080' };\n  // \"#abc\" | \"#aabbcc\" | \"#aabbccdd\" | rgb()/rgba() | nome \u2192 { hex, a } ou null\n  function parseColor(v) {\n    v = String(v || '').trim().toLowerCase();\n    if (!v || v === 'none' || v === 'transparent' || v === 'currentcolor' || v === 'inherit') return null;\n    if (NAMED[v]) return { hex: NAMED[v], a: 1 };\n    var m = /^#([0-9a-f]{3,8})$/.exec(v);\n    if (m) {\n      var h = m[1];\n      if (h.length === 3 || h.length === 4) h = h.split('').map(function (c) { return c + c; }).join('');\n      if (h.length !== 6 && h.length !== 8) return null;\n      return { hex: '#' + h.slice(0, 6).toUpperCase(), a: h.length === 8 ? parseInt(h.slice(6), 16) / 255 : 1 };\n    }\n    m = /^rgba?\\(([^)]*)\\)$/.exec(v);\n    if (m) {\n      var p = m[1].split(/[\\s,\\/]+/).filter(Boolean);\n      if (p.length < 3) return null;\n      var ch = p.slice(0, 3).map(function (x) { return /%$/.test(x) ? parseFloat(x) * 2.55 : parseFloat(x); });\n      if (!ch.every(isFinite)) return null;\n      var al = p[3] === undefined ? 1 : /%$/.test(p[3]) ? parseFloat(p[3]) / 100 : parseFloat(p[3]);\n      return { hex: rgbToHex(ch.map(function (x) { return clamp(x, 0, 255) / 255; })), a: isFinite(al) ? clamp01(al) : 1 };\n    }\n    return null;\n  }\n  function styleProp(styl, name) {\n    var r = new RegExp('(?:^|;)\\\\s*' + name + '\\\\s*:\\\\s*([^;]+)').exec(styl || '');\n    return r ? r[1].trim() : null;\n  }\n  function lengthOf(v, d, ref) { // n\u00famero, ou % do ref\n    if (v === null || v === undefined || v === '') return d;\n    var n = parseFloat(v);\n    if (!isFinite(n)) return d;\n    return /%\\s*$/.test(v) ? n / 100 * ref : n;\n  }\n  // <style> com regras de classe (exports do Canva/Illustrator): .cls-1{fill:#abc}\n  function cssClasses(svg) {\n    var out = {}, re = /<style[^>]*>([\\s\\S]*?)<\\/style>/gi, b;\n    while ((b = re.exec(svg))) {\n      var body = b[1].replace(/<!\\[CDATA\\[|\\]\\]>/g, ''), rr = /([^{}]+)\\{([^}]*)\\}/g, r;\n      while ((r = rr.exec(body))) {\n        r[1].split(',').forEach(function (sel) {\n          var m = /^\\s*\\.([\\w-]+)\\s*$/.exec(sel);\n          if (m) out[m[1]] = (out[m[1]] ? out[m[1]] + ';' : '') + r[2];\n        });\n      }\n    }\n    return out;\n  }\n  // <linearGradient>/<radialGradient> por id, com heran\u00e7a de stops/atributos via href\n  function svgGradients(svg, css) {\n    var raw = {}, re = /<(linearGradient|radialGradient)\\b((?:[^>\"']|\"[^\"]*\"|'[^']*')*?)(\\/?)>/gi, t;\n    while ((t = re.exec(svg))) {\n      var a = t[2], id = attr(a, 'id');\n      if (!id) continue;\n      var stops = [];\n      if (!t[3]) {\n        var end = svg.toLowerCase().indexOf('</' + t[1].toLowerCase(), re.lastIndex);\n        var body = svg.slice(re.lastIndex, end < 0 ? svg.length : end), sr = /<stop\\b((?:[^>\"']|\"[^\"]*\"|'[^']*')*?)\\/?>/gi, sm;\n        while ((sm = sr.exec(body))) {\n          var sa = sm[1], st = attr(sa, 'style') || '';\n          var cls = attr(sa, 'class'); if (cls && css[cls]) st = css[cls] + ';' + st;\n          var col = parseColor(styleProp(st, 'stop-color') || attr(sa, 'stop-color') || '#000');\n          var op = parseFloat(styleProp(st, 'stop-opacity') || attr(sa, 'stop-opacity'));\n          var off = attr(sa, 'offset') || '0', ov = parseFloat(off);\n          if (/%/.test(off)) ov /= 100;\n          if (col) stops.push([clamp01(isFinite(ov) ? ov : 0), col.hex, clamp01((isFinite(op) ? op : 1) * col.a)]);\n        }\n      }\n      raw[id] = { type: t[1].toLowerCase() === 'radialgradient' ? 'r' : 'l', a: a, stops: stops, href: (attr(a, 'xlink:href') || attr(a, 'href') || '').replace(/^#/, '') };\n    }\n    function resolve(id, depth) {\n      var g = raw[id];\n      if (!g || depth > 6) return null;\n      var base = g.href ? resolve(g.href, depth + 1) : null;\n      var get = function (k) { var v = attr(g.a, k); return v !== null ? v : base ? base.get(k) : null; };\n      return { type: g.type, stops: g.stops.length ? g.stops : base ? base.stops : [], get: get };\n    }\n    var out = {};\n    for (var id in raw) out[id] = resolve(id, 0);\n    return out;\n  }\n  // gradiente (j\u00e1 com a matriz do elemento e bbox local) \u2192 { t, s, m } com m: coordenadas do SVG \u2192 espa\u00e7o do gradiente\n  function gradientPaint(g, ctm, bb) {\n    var stops = g.stops.slice().sort(function (x, y) { return x[0] - y[0]; });\n    for (var i = 1; i < stops.length; i++) if (stops[i][0] < stops[i - 1][0]) stops[i][0] = stops[i - 1][0];\n    if (stops.length === 1) stops = [[0, stops[0][1], stops[0][2]], [1, stops[0][1], stops[0][2]]];\n    if (stops.length < 2) return null;\n    var obb = g.get('gradientUnits') !== 'userSpaceOnUse';\n    var gt = parseTransform(g.get('gradientTransform'));\n    var toUser = minv(ctm); if (!toUser) return null;\n    var M = toUser;\n    if (obb) {\n      var bw = bb[2] - bb[0], bh = bb[3] - bb[1];\n      if (bw < 1e-9 || bh < 1e-9) return null;\n      M = mmul([1 / bw, 0, 0, 1 / bh, -bb[0] / bw, -bb[1] / bh], M);\n    }\n    var gi = minv(gt); if (!gi) return null;\n    M = mmul(gi, M); // svg \u2192 espa\u00e7o do gradiente\n    var W = obb ? 1 : (bb[2] - bb[0]) || 1, H = obb ? 1 : (bb[3] - bb[1]) || 1, row;\n    if (g.type === 'l') {\n      var x1 = lengthOf(g.get('x1'), 0, W), y1 = lengthOf(g.get('y1'), 0, H), x2 = lengthOf(g.get('x2'), obb ? 1 : W, W), y2 = lengthOf(g.get('y2'), 0, H);\n      var dx = x2 - x1, dy = y2 - y1, L2 = dx * dx + dy * dy;\n      if (L2 < 1e-12) return null;\n      row = [(dx * M[0] + dy * M[1]) / L2, 0, (dx * M[2] + dy * M[3]) / L2, 0, (dx * (M[4] - x1) + dy * (M[5] - y1)) / L2, 0];\n    } else {\n      var cx = lengthOf(g.get('cx'), obb ? 0.5 : W / 2, W), cy = lengthOf(g.get('cy'), obb ? 0.5 : H / 2, H), r = lengthOf(g.get('r'), obb ? 0.5 : Math.min(W, H) / 2, Math.min(W, H));\n      if (!(r > 1e-9)) return null;\n      row = [M[0] / r, M[1] / r, M[2] / r, M[3] / r, (M[4] - cx) / r, (M[5] - cy) / r];\n    }\n    if (!row.every(isFinite)) return null;\n    return { t: g.type, s: stops, m: row };\n  }\n\n  // achata um path \"d\" em subcaminhos [{pts, closed}]\n  function flattenPath(d, tol) {\n    var toks = String(d).match(/[a-zA-Z]|[-+]?(?:\\d*\\.\\d+|\\d+\\.?)(?:[eE][-+]?\\d+)?/g) || [];\n    var out = [], cur = null, i = 0, cmd = '', x = 0, y = 0, sx = 0, sy = 0, cx = 0, cy = 0, qx = 0, qy = 0, prev = '';\n    tol = tol || 0.5;\n    function n() { return parseFloat(toks[i++]); }\n    function isNum() { return i < toks.length && !/[a-zA-Z]/.test(toks[i]); }\n    function start(px, py) { cur = { pts: [px, py], closed: false }; out.push(cur); }\n    function line(px, py) { if (!cur) start(x, y); cur.pts.push(px, py); }\n    function steps(len) { return Math.max(2, Math.min(64, Math.ceil(Math.sqrt(len / tol) * 1.2))); }\n    function cubicTo(x1, y1, x2, y2, ex, ey) {\n      var len = Math.hypot(x1 - x, y1 - y) + Math.hypot(x2 - x1, y2 - y1) + Math.hypot(ex - x2, ey - y2), k = steps(len);\n      for (var j = 1; j <= k; j++) {\n        var t = j / k, u = 1 - t;\n        line(u * u * u * x + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * ex, u * u * u * y + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * ey);\n      }\n    }\n    function quadTo(x1, y1, ex, ey) {\n      var len = Math.hypot(x1 - x, y1 - y) + Math.hypot(ex - x1, ey - y1), k = steps(len);\n      for (var j = 1; j <= k; j++) { var t = j / k, u = 1 - t; line(u * u * x + 2 * u * t * x1 + t * t * ex, u * u * y + 2 * u * t * y1 + t * t * ey); }\n    }\n    function arcTo(rx, ry, rot, large, sweep, ex, ey) {\n      if (!rx || !ry) { line(ex, ey); return; }\n      rx = Math.abs(rx); ry = Math.abs(ry);\n      var ph = rot * Math.PI / 180, cp = Math.cos(ph), sp = Math.sin(ph);\n      var dx = (x - ex) / 2, dy = (y - ey) / 2, x1 = cp * dx + sp * dy, y1 = -sp * dx + cp * dy;\n      var lam = x1 * x1 / (rx * rx) + y1 * y1 / (ry * ry);\n      if (lam > 1) { rx *= Math.sqrt(lam); ry *= Math.sqrt(lam); }\n      var sgn = large === sweep ? -1 : 1;\n      var co = sgn * Math.sqrt(Math.max(0, (rx * rx * ry * ry - rx * rx * y1 * y1 - ry * ry * x1 * x1) / (rx * rx * y1 * y1 + ry * ry * x1 * x1)));\n      var cxp = co * rx * y1 / ry, cyp = -co * ry * x1 / rx;\n      var ccx = cp * cxp - sp * cyp + (x + ex) / 2, ccy = sp * cxp + cp * cyp + (y + ey) / 2;\n      var a1 = Math.atan2((y1 - cyp) / ry, (x1 - cxp) / rx), a2 = Math.atan2((-y1 - cyp) / ry, (-x1 - cxp) / rx), da = a2 - a1;\n      if (sweep && da < 0) da += 2 * Math.PI; else if (!sweep && da > 0) da -= 2 * Math.PI;\n      var k = steps(Math.abs(da) * Math.max(rx, ry));\n      for (var j = 1; j <= k; j++) {\n        var a = a1 + da * j / k, px = rx * Math.cos(a), py = ry * Math.sin(a);\n        line(cp * px - sp * py + ccx, sp * px + cp * py + ccy);\n      }\n    }\n    while (i < toks.length) {\n      if (/[a-zA-Z]/.test(toks[i])) cmd = toks[i++];\n      else if (!cmd) { i++; continue; }\n      var rel = cmd === cmd.toLowerCase(), C = cmd.toUpperCase(), ox = rel ? x : 0, oy = rel ? y : 0;\n      if (C === 'Z') { if (cur) { cur.closed = true; } x = sx; y = sy; cur = null; prev = 'Z'; continue; }\n      if (!isNum()) { cmd = ''; continue; }\n      if (C === 'M') { x = ox + n(); y = oy + n(); sx = x; sy = y; start(x, y); cmd = rel ? 'l' : 'L'; prev = 'M'; continue; }\n      if (C === 'L') { x = ox + n(); y = oy + n(); line(x, y); }\n      else if (C === 'H') { x = ox + n(); line(x, y); }\n      else if (C === 'V') { y = oy + n(); line(x, y); }\n      else if (C === 'C') { var c1x = ox + n(), c1y = oy + n(); cx = ox + n(); cy = oy + n(); var ex = ox + n(), ey = oy + n(); cubicTo(c1x, c1y, cx, cy, ex, ey); x = ex; y = ey; }\n      else if (C === 'S') { var r1x = /[CS]/.test(prev) ? 2 * x - cx : x, r1y = /[CS]/.test(prev) ? 2 * y - cy : y; cx = ox + n(); cy = oy + n(); var e2x = ox + n(), e2y = oy + n(); cubicTo(r1x, r1y, cx, cy, e2x, e2y); x = e2x; y = e2y; }\n      else if (C === 'Q') { qx = ox + n(); qy = oy + n(); var e3x = ox + n(), e3y = oy + n(); quadTo(qx, qy, e3x, e3y); x = e3x; y = e3y; }\n      else if (C === 'T') { qx = /[QT]/.test(prev) ? 2 * x - qx : x; qy = /[QT]/.test(prev) ? 2 * y - qy : y; var e4x = ox + n(), e4y = oy + n(); quadTo(qx, qy, e4x, e4y); x = e4x; y = e4y; }\n      else if (C === 'A') { var arx = n(), ary = n(), rot = n(), la = n(), sw = n(), e5x = ox + n(), e5y = oy + n(); arcTo(arx, ary, rot, !!la, !!sw, e5x, e5y); x = e5x; y = e5y; }\n      else { i++; }\n      prev = C;\n    }\n    return out.filter(function (s) { return s.pts.length >= 4 && s.pts.every(isFinite); });\n  }\n\n  function ellipsePts(cx, cy, rx, ry) {\n    var k = Math.max(24, Math.min(96, Math.ceil(Math.max(rx, ry) / 2))), pts = [];\n    for (var i = 0; i < k; i++) { var a = i / k * 2 * Math.PI; pts.push(cx + Math.cos(a) * rx, cy + Math.sin(a) * ry); }\n    return pts;\n  }\n\n  /**\n   * SVG (string) \u2192 { contours: [{pts, closed}], box: [x0,y0,x1,y1], evenOdd }\n   * Ignora <defs>, <clipPath>, <mask>, <pattern> e elementos com fill e stroke \"none\".\n   */\n  function parseSVG(svg) {\n    svg = String(svg || '');\n    var stack = [[1, 0, 0, 1, 0, 0]], skip = 0, contours = [], evenOdd = false;\n    var css = cssClasses(svg), grads = null, paints = [];\n    var pstack = [{ fill: null, stroke: null }]; // fill/stroke herdados de <g>\n    var re = /<(\\/?)([a-zA-Z][\\w:-]*)((?:[^>\"']|\"[^\"]*\"|'[^']*')*?)(\\/?)>/g, t;\n    var vb = null;\n    while ((t = re.exec(svg))) {\n      var close = !!t[1], tag = t[2].toLowerCase(), a = t[3] || '', self = !!t[4];\n      var container = /^(svg|g|a|switch|symbol)$/.test(tag), skipTag = /^(defs|clippath|mask|pattern|lineargradient|radialgradient|filter|style|title|desc|metadata)$/.test(tag);\n      if (close) {\n        if (skipTag) skip = Math.max(0, skip - 1);\n        else if (container && stack.length > 1) { stack.pop(); pstack.pop(); }\n        continue;\n      }\n      if (skipTag) { if (!self) skip++; continue; }\n      if (skip) continue;\n      var m = mmul(stack[stack.length - 1], parseTransform(attr(a, 'transform')));\n      if (tag === 'svg' && !vb) {\n        var v = (attr(a, 'viewBox') || '').trim().split(/[\\s,]+/).map(Number);\n        if (v.length === 4 && v.every(isFinite)) vb = v;\n        else { var w = num(a, 'width', 0), h = num(a, 'height', 0); if (w && h) vb = [0, 0, w, h]; }\n      }\n      var cls = attr(a, 'class'), clsStyle = '';\n      if (cls) cls.split(/\\s+/).forEach(function (c) { if (css[c]) clsStyle += ';' + css[c]; });\n      var styl0 = clsStyle + ';' + (attr(a, 'style') || '');\n      var pin = pstack[pstack.length - 1];\n      var fillP = styleProp(styl0, 'fill') || attr(a, 'fill'), strokeP = styleProp(styl0, 'stroke') || attr(a, 'stroke');\n      var curPaint = { fill: fillP !== null ? fillP : pin.fill, stroke: strokeP !== null ? strokeP : pin.stroke };\n      if (container) { if (!self) { stack.push(m); pstack.push(curPaint); } continue; }\n      // geometria: s\u00f3 atributos do pr\u00f3prio elemento (comportamento da v0.6, inalterado)\n      var fill = attr(a, 'fill'), stroke = attr(a, 'stroke'), styl = attr(a, 'style') || '';\n      var sf = /fill\\s*:\\s*none/.test(styl), ss = /stroke\\s*:\\s*none/.test(styl);\n      if ((fill === 'none' || sf) && (!stroke || stroke === 'none' || ss)) continue;\n      if (/evenodd/.test((attr(a, 'fill-rule') || '') + styl)) evenOdd = true;\n      var subs = [];\n      if (tag === 'path') subs = flattenPath(attr(a, 'd') || '', 0.35 / Math.max(1e-6, Math.sqrt(Math.abs(m[0] * m[3] - m[1] * m[2]))));\n      else if (tag === 'rect') {\n        var rx = num(a, 'x', 0), ry = num(a, 'y', 0), rw = num(a, 'width', 0), rh = num(a, 'height', 0), rr = Math.min(num(a, 'rx', num(a, 'ry', 0)), rw / 2, rh / 2);\n        if (rw > 0 && rh > 0) {\n          if (rr > 0) {\n            var p = 'M' + (rx + rr) + ' ' + ry + 'H' + (rx + rw - rr) + 'A' + rr + ' ' + rr + ' 0 0 1 ' + (rx + rw) + ' ' + (ry + rr) + 'V' + (ry + rh - rr) +\n              'A' + rr + ' ' + rr + ' 0 0 1 ' + (rx + rw - rr) + ' ' + (ry + rh) + 'H' + (rx + rr) + 'A' + rr + ' ' + rr + ' 0 0 1 ' + rx + ' ' + (ry + rh - rr) +\n              'V' + (ry + rr) + 'A' + rr + ' ' + rr + ' 0 0 1 ' + (rx + rr) + ' ' + ry + 'Z';\n            subs = flattenPath(p);\n          } else subs = [{ pts: [rx, ry, rx + rw, ry, rx + rw, ry + rh, rx, ry + rh], closed: true }];\n        }\n      } else if (tag === 'circle') { var r = num(a, 'r', 0); if (r > 0) subs = [{ pts: ellipsePts(num(a, 'cx', 0), num(a, 'cy', 0), r, r), closed: true }]; }\n      else if (tag === 'ellipse') { var ex = num(a, 'rx', 0), ey = num(a, 'ry', 0); if (ex > 0 && ey > 0) subs = [{ pts: ellipsePts(num(a, 'cx', 0), num(a, 'cy', 0), ex, ey), closed: true }]; }\n      else if (tag === 'line') subs = [{ pts: [num(a, 'x1', 0), num(a, 'y1', 0), num(a, 'x2', 0), num(a, 'y2', 0)], closed: false }];\n      else if (tag === 'polyline' || tag === 'polygon') {\n        var ps = (attr(a, 'points') || '').trim().split(/[\\s,]+/).map(Number).filter(isFinite);\n        if (ps.length >= 4) subs = [{ pts: ps.slice(0, ps.length - ps.length % 2), closed: tag === 'polygon' }];\n      }\n      var open = fill === 'none' || sf;\n      // pinta do elemento (heran\u00e7a de <g>/<svg> + classes CSS): fill, ou stroke se o fill \u00e9 none\n      var pFill = curPaint.fill, pOpen = pFill === 'none' || /fill\\s*:\\s*none/.test(styl0);\n      var paintSrc = !pOpen ? (pFill === null ? '#000000' : pFill) : curPaint.stroke;\n      if (subs.length && paintSrc && paintSrc !== 'none') {\n        var lx0 = 1e18, ly0 = 1e18, lx1 = -1e18, ly1 = -1e18;\n        subs.forEach(function (sp) { for (var q = 0; q < sp.pts.length; q += 2) { lx0 = Math.min(lx0, sp.pts[q]); lx1 = Math.max(lx1, sp.pts[q]); ly0 = Math.min(ly0, sp.pts[q + 1]); ly1 = Math.max(ly1, sp.pts[q + 1]); } });\n        var det = Math.abs(m[0] * m[3] - m[1] * m[2]), area = Math.max(lx1 - lx0, 1e-6) * Math.max(ly1 - ly0, 1e-6) * det;\n        if (pOpen) area *= 0.25; // tra\u00e7o pesa menos que preenchimento\n        var urlm = /url\\(\\s*['\"]?#([^'\")\\s]+)['\"]?\\s*\\)/.exec(paintSrc), pnt = null;\n        if (urlm) {\n          if (!grads) grads = svgGradients(svg, css);\n          var gd = grads[urlm[1]];\n          if (gd && gd.stops.length) pnt = gradientPaint(gd, m, [lx0, ly0, lx1, ly1]);\n          if (!pnt && gd && gd.stops.length) pnt = { solid: gd.stops[0][1] };\n        } else {\n          var pc = parseColor(paintSrc);\n          if (pc) pnt = { solid: pc.hex, implicit: pFill === null && !pOpen };\n        }\n        if (pnt) { pnt.area = area; paints.push(pnt); }\n      }\n      subs.forEach(function (sp) {\n        var pts = [];\n        for (var i = 0; i < sp.pts.length; i += 2) {\n          var X = sp.pts[i], Y = sp.pts[i + 1];\n          pts.push(m[0] * X + m[2] * Y + m[4], m[1] * X + m[3] * Y + m[5]);\n        }\n        // forma preenchida sem Z tamb\u00e9m \u00e9 fechada (regra do SVG)\n        contours.push({ pts: pts, closed: sp.closed || (!open && tag !== 'line' && tag !== 'polyline') });\n      });\n    }\n    var x0 = 1e18, y0 = 1e18, x1 = -1e18, y1 = -1e18;\n    contours.forEach(function (c) { for (var i = 0; i < c.pts.length; i += 2) { x0 = Math.min(x0, c.pts[i]); x1 = Math.max(x1, c.pts[i]); y0 = Math.min(y0, c.pts[i + 1]); y1 = Math.max(y1, c.pts[i + 1]); } });\n    return { contours: contours, box: contours.length ? [x0, y0, x1, y1] : null, viewBox: vb, evenOdd: evenOdd, paint: dominantPaint(paints) };\n  }\n\n  // pinta que domina o objeto: soma a \u00e1rea por cor/gradiente e fica com a maior\n  function dominantPaint(paints) {\n    if (!paints.length) return null;\n    var groups = {}, best = null;\n    paints.forEach(function (p) {\n      var k = p.solid ? 's' + p.solid : 'g' + JSON.stringify(p.s) + p.t;\n      var g = groups[k] || (groups[k] = { p: p, area: 0 });\n      g.area += p.area;\n      if (!best || g.area >= best.area * 0.999) best = g; // empate: a de cima (desenhada por \u00faltimo) vence\n    });\n    var p = best.p;\n    if (p.solid) return { type: 'solid', hex: p.solid, implicit: !!p.implicit };\n    return { type: 'gradient', t: p.t, s: p.s, m: p.m };\n  }\n\n  // Douglas\u2013Peucker por contorno, aumentando a toler\u00e2ncia at\u00e9 caber no or\u00e7amento de pontos.\n  function dp(pts, tol) {\n    var n = pts.length / 2;\n    if (n <= 2) return pts.slice();\n    var keep = new Uint8Array(n); keep[0] = keep[n - 1] = 1;\n    var st = [[0, n - 1]];\n    while (st.length) {\n      var s = st.pop(), a = s[0], b = s[1], ax = pts[a * 2], ay = pts[a * 2 + 1], bx = pts[b * 2], by = pts[b * 2 + 1];\n      var dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy) || 1e-12, best = -1, bi = -1;\n      for (var i = a + 1; i < b; i++) {\n        var d = Math.abs((pts[i * 2] - ax) * dy - (pts[i * 2 + 1] - ay) * dx) / L;\n        if (L < 1e-9) d = Math.hypot(pts[i * 2] - ax, pts[i * 2 + 1] - ay);\n        if (d > best) { best = d; bi = i; }\n      }\n      if (best > tol) { keep[bi] = 1; st.push([a, bi], [bi, b]); }\n    }\n    var out = [];\n    for (var k = 0; k < n; k++) if (keep[k]) out.push(pts[k * 2], pts[k * 2 + 1]);\n    return out;\n  }\n\n  /**\n   * Converte contornos (coordenadas quaisquer) para o formato do par\u00e2metro `vector`,\n   * j\u00e1 posicionados no quadro (unidade = menor lado, origem no centro).\n   * place: { box: [x0,y0,x1,y1] destino em unidades } ou { fit: 0.6 } (centra e ocupa 60% do menor lado).\n   */\n  // mapa SVG \u2192 unidades do quadro (o mesmo usado pelo vetor): x' = x\u00b7k + ox, y' = y\u00b7ky + oy\n  function placeMap(parsed, place) {\n    var src = parsed.box;\n    if (!src) return null;\n    var sw = src[2] - src[0] || 1, sh2 = src[3] - src[1] || 1, k, ox, oy, ky;\n    if (place && place.box && place.from) {\n      var fr = place.from, bb = place.box;\n      k = (bb[2] - bb[0]) / ((fr[2] - fr[0]) || 1); ky = (bb[3] - bb[1]) / ((fr[3] - fr[1]) || 1);\n      ox = bb[0] - fr[0] * k; oy = bb[1] - fr[1] * ky;\n    } else if (place && place.box) {\n      var b = place.box;\n      k = Math.min((b[2] - b[0]) / sw, (b[3] - b[1]) / sh2);\n      ox = (b[0] + b[2]) / 2 - (src[0] + src[2]) / 2 * k; oy = (b[1] + b[3]) / 2 - (src[1] + src[3]) / 2 * k;\n    } else {\n      var fit = place && place.fit ? place.fit : 0.6;\n      k = fit / Math.max(sw, sh2);\n      ox = -(src[0] + src[2]) / 2 * k; oy = -(src[1] + src[3]) / 2 * k;\n    }\n    return { k: k, ky: ky || k, ox: ox, oy: oy };\n  }\n\n  /**\n   * Cor do objeto no quadro: { color } pra cor s\u00f3lida ou { gfill } pro gradiente, j\u00e1 posicionado\n   * no mesmo lugar do vetor (mesmo `place` do toVector). null se o SVG n\u00e3o tem cor utiliz\u00e1vel.\n   */\n  function toFill(parsed, place) {\n    var pt = parsed && parsed.paint;\n    if (!pt) return null;\n    if (pt.type === 'solid') return { color: pt.hex, implicit: pt.implicit };\n    var mp = placeMap(parsed, place);\n    if (!mp || !mp.k || !mp.ky) return null;\n    // unidades \u2192 svg, depois svg \u2192 gradiente\n    var m = pt.m, T = [1 / mp.k, 0, 0, 1 / mp.ky, -mp.ox / mp.k, -mp.oy / mp.ky];\n    var r = mmul(m, T);\n    if (pt.t === 'l') r = [r[0], 0, r[2], 0, r[4], 0];\n    return { gfill: normGfill({ t: pt.t, m: r, s: pt.s }) };\n  }\n\n  function toVector(parsed, place, budget) {\n    budget = budget || MAX_VEC_PTS;\n    var src = parsed.box;\n    if (!src) return null;\n    var sw = src[2] - src[0] || 1, sh2 = src[3] - src[1] || 1, k, ox, oy, ky;\n    if (place && place.box && place.from) {\n      // mapeamento exato de um ret\u00e2ngulo de origem (ex.: viewBox do SVG = bounds do node) pro destino\n      var fr = place.from, bb = place.box;\n      k = (bb[2] - bb[0]) / ((fr[2] - fr[0]) || 1); ky = (bb[3] - bb[1]) / ((fr[3] - fr[1]) || 1);\n      ox = bb[0] - fr[0] * k; oy = bb[1] - fr[1] * ky;\n    } else if (place && place.box) {\n      var b = place.box;\n      k = Math.min((b[2] - b[0]) / sw, (b[3] - b[1]) / sh2);\n      ox = (b[0] + b[2]) / 2 - (src[0] + src[2]) / 2 * k; oy = (b[1] + b[3]) / 2 - (src[1] + src[3]) / 2 * k;\n    } else {\n      var fit = place && place.fit ? place.fit : 0.6;\n      k = fit / Math.max(sw, sh2);\n      ox = -(src[0] + src[2]) / 2 * k; oy = -(src[1] + src[3]) / 2 * k;\n    }\n    var cs = parsed.contours.map(function (c) {\n      var pts = [];\n      for (var i = 0; i < c.pts.length; i += 2) pts.push(c.pts[i] * k + ox, c.pts[i + 1] * (ky || k) + oy);\n      return { pts: pts, closed: c.closed };\n    }).filter(function (c) {\n      var x0 = 1e9, x1 = -1e9, y0 = 1e9, y1 = -1e9;\n      for (var i = 0; i < c.pts.length; i += 2) { x0 = Math.min(x0, c.pts[i]); x1 = Math.max(x1, c.pts[i]); y0 = Math.min(y0, c.pts[i + 1]); y1 = Math.max(y1, c.pts[i + 1]); }\n      return x1 - x0 > 1e-4 || y1 - y0 > 1e-4;\n    });\n    var tol = 0.0004, simp, total;\n    for (var it = 0; it < 14; it++) {\n      simp = cs.map(function (c) { var p = dp(c.closed ? c.pts.concat([c.pts[0], c.pts[1]]) : c.pts, tol); if (c.closed && p.length > 4) p.length -= 2; return { pts: p, closed: c.closed }; })\n        .filter(function (c) { return c.pts.length >= (c.closed ? 6 : 4); });\n      total = 0; simp.forEach(function (c) { total += c.pts.length / 2; });\n      if (total <= budget) break;\n      tol *= 1.6;\n    }\n    return {\n      c: simp.slice(0, MAX_VEC_CONTOURS).map(function (c) { return c.pts.map(function (v) { return Math.round(v * 1e4) / 1e4; }); }),\n      z: simp.slice(0, MAX_VEC_CONTOURS).map(function (c) { return c.closed ? 1 : 0; }),\n      eo: parsed.evenOdd ? 1 : 0\n    };\n  }\n\n  // ------------------------------------------------------------------ scene\n  // Coordenadas: origem no centro, unidade = menor lado do quadro, y pra baixo.\n  function buildScene(p, W, H) {\n    var S = Math.min(W, H), ax = W / 2 / S, ay = H / 2 / S;\n    var rng = mulberry32(p.seed * 9973 + SHAPES.indexOf(p.shape) * 131 + 7);\n    var th = p.angle * Math.PI / 180;\n    var Dx = Math.cos(th), Dy = -Math.sin(th), Nx = -Dy, Ny = Dx;\n    var g = 0.35 + p.spread * 1.55;\n    var sh = p.sharpness;\n    var seedN = p.seed * 31 + 11;\n\n    // camadas de blur sobre a dist\u00e2ncia at\u00e9 o vetor\n    var r0 = 0.0015 + 0.003 * (1 - sh), r1 = 0.010 * g, r2 = 0.038 * g, r3 = 0.12 * g, r4 = 0.34 * g;\n    var w0 = 0.2 + 1.2 * sh;\n    var i0 = 1 / (r0 * r0), i1 = 1 / (r1 * r1), i2 = 1 / (r2 * r2), i3 = 1 / r3, i4 = 1 / r4;\n    function glow(d, core) {\n      var d2 = d * d;\n      return core * w0 * Math.exp(-d2 * i0) + 0.55 * Math.exp(-d2 * i1) + 0.34 * Math.exp(-d2 * i2) +\n        0.15 * Math.exp(-d * i3) + 0.06 * Math.exp(-d * i4);\n    }\n    function soft(d) { // sem n\u00facleo: s\u00f3 bloom/halo/n\u00e9voa\n      var d2 = d * d;\n      return 0.5 * Math.exp(-d2 * i1 * 0.25) + 0.38 * Math.exp(-d2 * i2) + 0.18 * Math.exp(-d * i3) + 0.07 * Math.exp(-d * i4);\n    }\n    function rot(x, y, a) { var c = Math.cos(a), s = Math.sin(a); return [x * c - y * s, x * s + y * c]; }\n    var extent = Math.abs(Dx) * ax + Math.abs(Dy) * ay; // meia-extens\u00e3o do quadro na dire\u00e7\u00e3o da luz\n\n    var field; // (x, y) \u2192 energia\n    var occ = null;\n\n    if (p.shape === 'eclipse' || p.shape === 'horizon') {\n      var horizon = p.shape === 'horizon';\n      // eclipse: planeta grande saindo do canto, rim que nasce apagado e esquenta at\u00e9 o ponto quente.\n      // horizonte: arco raso, ponto quente central com flare anam\u00f3rfico.\n      var R, L, cx, cy, hx, hy;\n      if (horizon) {\n        R = mix(4.5, 1.2, p.curvature);\n        L = [Dx, Dy];\n        var kh = mix(0.05, 0.16, rng());\n        hx = Dx * kh; hy = Dy * kh; cx = hx - Dx * R; cy = hy - Dy * R;\n      } else {\n        // planeta enorme saindo do canto oposto \u00e0 luz; o rim cruza o quadro na diagonal\n        R = mix(1.7, 0.55, p.curvature);\n        var push = mix(0.05, 0.25, rng());\n        cx = -Dx * (R - push); cy = -Dy * (R - push);\n        // ponto quente: sempre num trecho do rim vis\u00edvel dentro do quadro\n        var vis = [];\n        for (var ai = 0; ai < 240; ai++) {\n          var an = ai / 240 * 6.2832, qx = cx + Math.cos(an) * R, qy = cy + Math.sin(an) * R;\n          if (Math.abs(qx) < ax * 0.86 && Math.abs(qy) < ay * 0.86) vis.push(an);\n        }\n        var phi;\n        if (vis.length) {\n          var pick = vis[Math.floor(mix(0.55, 0.92, rng()) * vis.length) % vis.length];\n          phi = rng() < 0.5 ? pick : vis[Math.floor(mix(0.08, 0.45, rng()) * vis.length) % vis.length];\n        } else phi = Math.atan2(Dy, Dx);\n        L = [Math.cos(phi), Math.sin(phi)];\n        hx = cx + L[0] * R; hy = cy + L[1] * R;\n      }\n      var focus = horizon ? 7 : 4.5;\n      var tx = -L[1], ty = L[0];\n      var fl = p.flare;\n      field = function (x, y) {\n        var dx = x - cx, dy = y - cy, r = Math.sqrt(dx * dx + dy * dy), s = r - R;\n        var cphi = (dx * L[0] + dy * L[1]) / (r || 1);\n        var I = Math.pow(0.5 + 0.5 * cphi, focus);\n        var e = I * glow(Math.abs(s), 1);\n        if (s < 0) {\n          e = e * Math.exp(s / 0.008) + I * 0.05 * Math.exp(s / (0.06 * g));\n        } else {\n          e += Math.pow(I, 0.8) * 0.22 * Math.exp(-s / (0.11 * g)) + Math.pow(I, 0.55) * 0.05 * Math.exp(-s / (0.38 * g));\n        }\n        if (fl > 0) {\n          var fx = x - hx, fy = y - hy;\n          var ft = fx * tx + fy * ty, fn = fx * L[0] + fy * L[1];\n          var aniso = horizon ? 0.3 : 0.12;\n          var r2 = fx * fx + fy * fy;\n          var f = Math.exp(-(ft * ft) / (aniso * aniso * g) - (fn * fn) / (0.0006 * g)) * 1.1 +\n            Math.exp(-r2 / (0.0025 * g)) * 0.8 + Math.exp(-r2 / (0.04 * g)) * (horizon ? 0.18 : 0.45) + Math.exp(-Math.sqrt(r2) / (0.3 * g)) * (horizon ? 0.05 : 0.12);\n          if (s < 0) f *= Math.exp(s / 0.005);\n          e += fl * f;\n        }\n        return e;\n      };\n    } else if (p.shape === 'aurora') {\n      // feixes em leque saindo de fora do quadro + coluna de luz descendo + esfera escura (opcional)\n      var nb = p.elements;\n      var ox = -Dx * extent * 1.02, oy = -Dy * extent * 1.02 + (rng() - 0.5) * 0.1;\n      var fan = mix(0.25, 0.6, rng());\n      var beams = [];\n      for (var b = 0; b < nb; b++) {\n        var a = (nb > 1 ? b / (nb - 1) - 0.5 : 0) * fan + (rng() - 0.5) * 0.1;\n        var u = rot(Dx, Dy, a);\n        beams.push({\n          ux: u[0], uy: u[1], nx: -u[1], ny: u[0],\n          bend: (rng() < 0.5 ? -1 : 1) * p.curvature * mix(0.15, 0.6, rng()),\n          len: mix(0.45, 1.1, rng()),\n          amp: mix(0.5, 1, rng()),\n          wid: mix(0.015, 0.045, rng())\n        });\n      }\n      var hk = mix(0.3, 0.45, rng());\n      var hsx = ox + Dx * hk, hsy = oy + Dy * hk;\n      var colDir = Ny >= 0 ? 1 : -1;               // coluna sempre \"desce\" na tela\n      var cNx = Nx * colDir, cNy = Ny * colDir;\n      var fla = p.flare;\n      field = function (x, y) {\n        var e = 0, px = x - ox, py = y - oy;\n        for (var i = 0; i < beams.length; i++) {\n          var bm = beams[i];\n          var lx = px * bm.ux + py * bm.uy, ly = px * bm.nx + py * bm.ny;\n          if (lx < -0.2) continue;\n          var yc = bm.bend * lx * lx, slope = 2 * bm.bend * lx;\n          var d = Math.abs(ly - yc) / Math.sqrt(1 + slope * slope);\n          var w = bm.wid + Math.max(lx, 0) * 0.06;\n          var env = smooth(-0.1, 0.25, lx) * Math.exp(-Math.max(lx, 0) / bm.len);\n          var q = d / w;\n          e += bm.amp * env * (Math.exp(-q * q) * (0.45 + sh * 0.6) + 0.16 * Math.exp(-q * q * 0.1) + 0.05 * Math.exp(-q * 0.2));\n        }\n        var dx = x - hsx, dy = y - hsy, d2 = dx * dx + dy * dy;\n        e += 0.3 * Math.exp(-d2 / (0.02 * g * g)) + 0.1 * Math.exp(-Math.sqrt(d2) / (0.3 * g));\n        e += fla * 0.9 * Math.exp(-d2 / (0.0015 * g));\n        // coluna: massa saturada descendo do ponto quente\n        var cu = dx * cNx + dy * cNy, cv = dx * cNy * -1 + dy * cNx;\n        if (cu > -0.1) {\n          var cw = 0.06 * g + Math.max(cu, 0) * 0.12;\n          e += 0.32 * smooth(-0.1, 0.12, cu) * Math.exp(-(cv * cv) / (cw * cw)) * Math.exp(-Math.max(cu, 0) / 0.9);\n        }\n        return e;\n      };\n      var orr = mix(0.4, 0.52, rng());\n      occ = { x: hsx + Dx * (orr + 0.12) + cNx * (orr + 0.06), y: hsy + Dy * (orr + 0.12) + cNy * (orr + 0.06), r: orr };\n    } else if (p.shape === 'plasma') {\n      // fitas grossas de luz, empilhadas e dobradas; turbul\u00eancia transforma em l\u00edquido\n      var nbn = p.elements;\n      var span = (Math.abs(Nx) * ax + Math.abs(Ny) * ay) * 1.7;\n      var bands = [];\n      for (var i2b = 0; i2b < nbn; i2b++) {\n        bands.push({\n          o: (nbn > 1 ? i2b / (nbn - 1) - 0.5 : 0) * span * 0.8 + (rng() - 0.5) * 0.1,\n          A: mix(0.03, 0.14, rng()) * (0.3 + p.curvature),\n          k: mix(1.6, 4, rng()),\n          ph: rng() * 6.283,\n          bend: (rng() - 0.5) * p.curvature * 1.2,\n          s: i2b * 13.7 + rng() * 50,\n          amp: mix(0.55, 1, rng()),\n          w: mix(0.04, 0.09, rng()) * (0.6 + p.spread * 0.9)\n        });\n      }\n      var pkx = Dx * 0.4, pky = Dy * 0.4;\n      field = function (x, y) {\n        var u = x * Dx + y * Dy, v = x * Nx + y * Ny, e = 0;\n        for (var i = 0; i < bands.length; i++) {\n          var bd = bands[i];\n          var arg = bd.k * u + bd.ph;\n          var vc = bd.o + bd.A * Math.sin(arg) + bd.bend * u * u;\n          var slope = bd.A * bd.k * Math.cos(arg) + 2 * bd.bend * u;\n          var d = Math.abs(v - vc) / Math.sqrt(1 + slope * slope);\n          var env = 0.2 + 0.8 * Math.pow(vnoise(u * 1.1 + bd.s, bd.s, seedN), 1.4);\n          var q = d / bd.w;\n          e += bd.amp * env * (Math.exp(-q * q) * 0.75 + sh * 0.6 * Math.exp(-q * q * 6) + 0.28 * Math.exp(-q * q * 0.12) + 0.07 * Math.exp(-q * 0.15));\n        }\n        var hx2 = x - pkx, hy2 = y - pky;\n        return e * (0.25 + 1.2 * Math.exp(-(hx2 * hx2 + hy2 * hy2) / 0.32));\n      };\n    } else if (p.shape === 'silk' || p.shape === 'veil' || p.shape === 'flow') {\n      // fitas de tecido: cada fita \u00e9 uma curva v = f(u) com perfil assim\u00e9trico\n      // (lado largo = luz difusa, lado curto = vinco). A nitidez controla o vinco.\n      var kind = p.shape, rib = [];\n      var cnt = kind === 'flow' ? 3 + p.elements * 2 : p.elements;\n      var spanN = (Math.abs(Nx) * ax + Math.abs(Ny) * ay);\n      for (var ri = 0; ri < cnt; ri++) {\n        var spread_ = cnt > 1 ? ri / (cnt - 1) - 0.5 : (rng() - 0.5) * 0.4;\n        var cvR = p.curvature;\n        rib.push(kind === 'veil' ? {\n          o: spread_ * spanN * 1.1 + (rng() - 0.5) * 0.15,\n          A1: mix(0.12, 0.42, cvR) * mix(0.7, 1.1, rng()), k1: mix(1.4, 2.6, rng()), p1: rng() * 6.283,\n          A2: mix(0.02, 0.08, rng()) * cvR, k2: mix(3, 5, rng()), p2: rng() * 6.283,\n          bend: (rng() - 0.5) * cvR * 0.5,\n          wA: mix(0.26, 0.42, rng()) * g, wB: mix(0.2, 0.01, sh) * mix(0.8, 1.3, rng()), side: rng() < 0.5 ? -1 : 1,\n          amp: mix(0.8, 1, rng()) * (ri === 0 ? 1.25 : 0.7), envK: mix(0.5, 1.1, rng()), s: ri * 17.3 + rng() * 40, envMin: 0.12\n        } : kind === 'silk' ? {\n          o: spread_ * spanN * 1.5 + (rng() - 0.5) * 0.18,\n          A1: mix(0.05, 0.3, cvR) * mix(0.6, 1.2, rng()), k1: mix(1.2, 3, rng()), p1: rng() * 6.283,\n          A2: mix(0.01, 0.07, rng()) * cvR, k2: mix(3.5, 6, rng()), p2: rng() * 6.283,\n          bend: (rng() - 0.5) * cvR * 1.1,\n          wA: mix(0.12, 0.28, rng()) * g, wB: mix(0.12, 0.008, sh) * mix(0.7, 1.4, rng()), side: rng() < 0.5 ? -1 : 1,\n          amp: mix(0.6, 1, rng()), envK: mix(0.7, 1.6, rng()), s: ri * 17.3 + rng() * 40, envMin: 0.25\n        } : {\n          o: spread_ * spanN * 2.1 + (rng() - 0.5) * 0.06,\n          A1: mix(0.02, 0.12, cvR) * mix(0.6, 1.2, rng()), k1: mix(0.8, 1.8, rng()), p1: rng() * 6.283,\n          A2: mix(0.005, 0.03, rng()) * cvR, k2: mix(3, 5, rng()), p2: rng() * 6.283,\n          bend: (rng() - 0.5) * cvR * 0.5,\n          wA: mix(0.015, 0.16, Math.pow(rng(), 2)) * g, wB: mix(0.05, 0.004, sh) * mix(0.6, 1.4, rng()), side: rng() < 0.75 ? 1 : -1,\n          amp: mix(0.35, 1, rng()), envK: mix(0.8, 1.8, rng()), s: ri * 17.3 + rng() * 40, envMin: 0.15\n        });\n      }\n      // flow: as fitas compartilham a mesma ondula\u00e7\u00e3o (paralelas, n\u00e3o cruzadas)\n      if (kind === 'flow') for (var fi2 = 1; fi2 < rib.length; fi2++) {\n        rib[fi2].k1 = rib[0].k1 * mix(0.9, 1.1, rng()); rib[fi2].p1 = rib[0].p1 + (rng() - 0.5) * 0.6;\n        rib[fi2].bend = rib[0].bend * mix(0.8, 1.2, rng());\n      }\n      var spX = Dx * extent * 0.3 + Nx * (rng() - 0.5) * 0.4, spY = Dy * extent * 0.3 + Ny * (rng() - 0.5) * 0.4;\n      var flR = p.flare, base0 = kind === 'flow' ? 0.18 : 0;\n      field = function (x, y) {\n        var u = x * Nx + y * Ny, v = x * Dx + y * Dy, e = 0;\n        for (var i = 0; i < rib.length; i++) {\n          var R_ = rib[i];\n          var a1 = R_.k1 * u + R_.p1, a2 = R_.k2 * u + R_.p2;\n          var vc = R_.o + R_.A1 * Math.sin(a1) + R_.A2 * Math.sin(a2) + R_.bend * u * u;\n          var sl = R_.A1 * R_.k1 * Math.cos(a1) + R_.A2 * R_.k2 * Math.cos(a2) + 2 * R_.bend * u;\n          var s = (v - vc) / Math.sqrt(1 + sl * sl) * R_.side;\n          var pr;\n          if (s >= 0) { var qa = s / R_.wA; pr = 0.78 * Math.exp(-qa * qa) + 0.22 * Math.exp(-s / (R_.wA * 2.2)); }\n          else { var qb = s / R_.wB; pr = Math.exp(-qb * qb); }\n          // rim no vinco: leve realce colado \u00e0 aresta\n          pr += sh * 0.35 * Math.exp(-(s * s) / (0.0004 + R_.wB * R_.wB * 0.3));\n          var env = R_.envMin + (1 - R_.envMin) * Math.pow(vnoise(u * R_.envK + R_.s, R_.s, seedN), 1.3);\n          e += R_.amp * env * pr;\n        }\n        var hx4 = x - spX, hy4 = y - spY;\n        var spot = Math.exp(-(hx4 * hx4 + hy4 * hy4) / 0.3);\n        var gain = kind === 'flow' ? 0.8 : kind === 'veil' ? 1.45 : 1.3;\n        return (e * gain + base0 * spot) * (0.55 + 0.45 * spot + flR * 0.9 * spot);\n      };\n    } else if (p.shape === 'fold') {\n      // dobra: luz de preenchimento vinda de um canto + corpo escuro com um vinco fino de luz na aresta\n      var Lcx = Dx * extent * 1.05, Lcy = Dy * extent * 1.05;\n      var disks = [];\n      for (var di = 0; di < Math.min(3, p.elements); di++) {\n        var Rd = mix(0.9, 1.6, rng()) * (di ? 0.75 : 1);\n        var reach = mix(0.25, 0.55, rng());\n        var offN = (rng() < 0.5 ? -1 : 1) * mix(0.15, 0.45, rng());\n        var dcx = -Dx * (Rd - reach) + Nx * offN + (di ? -Dx * 0.5 : 0), dcy = -Dy * (Rd - reach) + Ny * offN + (di ? -Dy * 0.5 : 0);\n        if (di) { dcx += Nx * -offN * 2.2; dcy += Ny * -offN * 2.2; }\n        var hdx = Lcx - dcx, hdy = Lcy - dcy, hl = Math.hypot(hdx, hdy) || 1;\n        disks.push({ x: dcx, y: dcy, r: Rd, lx: hdx / hl, ly: hdy / hl, amp: di ? 0.6 : 1 });\n      }\n      var flF = p.flare;\n      field = function (x, y) {\n        var ldx = x - Lcx, ldy = y - Lcy, ld = Math.sqrt(ldx * ldx + ldy * ldy);\n        var fill = 0.62 * Math.exp(-ld / (0.5 * g)) + 0.16 * Math.exp(-ld / (1.6 * g)) + 0.05;\n        var e = fill, crease = 0;\n        for (var i = 0; i < disks.length; i++) {\n          var D_ = disks[i], dx = x - D_.x, dy = y - D_.y, r = Math.sqrt(dx * dx + dy * dy), s = r - D_.r;\n          var shade = mix(0.06, 1, smooth(-0.3 * g, 0.015 + 0.06 * (1 - sh), s));\n          e *= mix(1, shade, D_.amp);\n          var cphi = (dx * D_.lx + dy * D_.ly) / (r || 1);\n          var I = Math.pow(0.5 + 0.5 * cphi, 9) * D_.amp;\n          var w1 = mix(0.012, 0.0025, sh);\n          crease += I * (0.9 * Math.exp(-(s * s) / (w1 * w1)) + 0.35 * Math.exp(-(s * s) / (0.0009 * g)) + 0.12 * Math.exp(-Math.abs(s) / (0.08 * g)));\n        }\n        return e + crease * (0.6 + flF * 0.8);\n      };\n    } else if (p.shape === 'curtain') {\n      // cortina: estrias de luz subindo de uma base clara, com um pico central\n      var extD = extent;\n      var v0 = (rng() - 0.5) * 0.25, sh0 = mix(0.28, 0.45, rng()), shAmp = mix(0.3, 0.6, rng());\n      var lines = [];\n      for (var li2 = 0; li2 < p.elements * 2 + 1; li2++) {\n        lines.push({ v: li2 === 0 ? v0 : v0 + (rng() - 0.5) * 0.9, a: li2 === 0 ? 0.9 : mix(0.15, 0.5, rng()), w: mix(0.002, 0.008, rng()), reach: mix(0.5, 1.4, rng()) });\n      }\n      var flC = p.flare, cvC = p.curvature;\n      field = function (x, y) {\n        var u = x * Dx + y * Dy, v = x * Nx + y * Ny;\n        var hgt = clamp01((u + extD) / (2 * extD));\n        var dv = v - v0;\n        var wC = mix(0.5, 0.015, Math.pow(hgt, mix(0.4, 1.2, cvC))) * g;\n        var core = Math.exp(-Math.abs(dv) / wC) * Math.exp(-hgt * 1.5);\n        var sd = Math.abs(dv) - sh0;\n        var shoulder = shAmp * Math.exp(-(sd * sd) / (0.012 * g)) * Math.exp(-hgt / 0.22);\n        var base = 0.45 * Math.exp(-hgt / (0.12 * g)) + 0.08 * Math.exp(-hgt / 0.6);\n        var st = 0.65 * vnoise(v * 60 + 3, hgt * 1.2, seedN) + 0.35 * vnoise(v * 150 + 9, hgt * 2.5, seedN + 3);\n        st = Math.pow(st, 1.4) * 1.6;\n        var e = (core + shoulder + base) * mix(1, st, mix(0.25, 0.7, hgt));\n        for (var i = 0; i < lines.length; i++) {\n          var L_ = lines[i], q = (v - L_.v) / L_.w;\n          e += L_.a * Math.exp(-q * q) * Math.exp(-hgt / L_.reach) * (0.4 + sh);\n        }\n        var bx2 = dv, by2 = hgt - 0.12;\n        return e + flC * 0.6 * Math.exp(-(bx2 * bx2) / 0.004 - (by2 * by2) / 0.02);\n      };\n    } else if (p.shape === 'vector') {\n      // shape vetorial (SVG colado / sele\u00e7\u00e3o do Figma). Dist\u00e2ncia exata ao contorno + teste dentro/fora\n      // por faixas + grids suavizados (corpo borrado, intensidade de rim) pra n\u00e3o ter costura no halo.\n      var V = p.vector && p.vector.c && p.vector.c.length ? p.vector : SAMPLE_VECTOR;\n      var VG = vectorGeom(V);\n      var vm = p.vmode, echoes = p.elements, sp = mix(0.018, 0.05, p.curvature);\n      var ins = VG.inside;\n      // grid de apoio cobrindo o quadro + margem\n      var mg = 0.25, gx0 = -ax - mg, gy0 = -ay - mg, cellU = 1 / 300;\n      var GW = Math.ceil((2 * ax + 2 * mg) / cellU), GH = Math.ceil((2 * ay + 2 * mg) / cellU);\n      function grid() { return new Float32Array(GW * GH); }\n      function sample(gr, x, y) {\n        var fx = (x - gx0) / cellU - 0.5, fy = (y - gy0) / cellU - 0.5;\n        if (fx < 0) fx = 0; else if (fx > GW - 1.001) fx = GW - 1.001;\n        if (fy < 0) fy = 0; else if (fy > GH - 1.001) fy = GH - 1.001;\n        var ix = fx | 0, iy = fy | 0, tx = fx - ix, ty = fy - iy, o = iy * GW + ix;\n        return (gr[o] * (1 - tx) + gr[o + 1] * tx) * (1 - ty) + (gr[o + GW] * (1 - tx) + gr[o + GW + 1] * tx) * ty;\n      }\n      var hotX = Dx * extent * 0.3, hotY = Dy * extent * 0.3;\n      var flV = p.flare, field0;\n      var mask = null;\n      if (vm !== 'outline') {\n        mask = grid();\n        for (var gy = 0; gy < GH; gy++) for (var gx = 0; gx < GW; gx++) mask[gy * GW + gx] = ins(gx0 + (gx + 0.5) * cellU, gy0 + (gy + 0.5) * cellU) ? 1 : 0;\n      }\n      var cellsOf = function (u) { return Math.max(1, Math.round(u / cellU)); };\n      if (vm === 'fill') {\n        // espessura m\u00e9dia do shape (2\u00b7\u00e1rea/per\u00edmetro): o corpo borra proporcional a ela,\n        // ent\u00e3o texto fino continua leg\u00edvel e shape grosso ganha miolo largo\n        var area = 0, per = 0;\n        for (var q0 = 0; q0 < mask.length; q0++) area += mask[q0];\n        area *= cellU * cellU;\n        for (var q1 = 0; q1 < VG.n; q1++) per += Math.sqrt(VG.seg[q1 * 6 + 4]);\n        var thick = clamp(per > 0 ? 2 * area / per : 0.05, 0.006, 0.2);\n        var B1 = boxBlur3(mask, GW, GH, cellsOf(Math.min(0.012 * g, thick * 0.35)));\n        var B2 = boxBlur3(mask, GW, GH, cellsOf(Math.min(0.05 * g, thick * 1.1 * g)));\n        var B3 = boxBlur3(mask, GW, GH, cellsOf(0.16 * g));\n        var wcore = 0.0015 + 0.004 * (1 - sh);\n        // normaliza pelo pico de cada camada: shape fino (texto) acende tanto quanto shape grosso\n        var pk = function (gr) { var m = 1e-6; for (var q = 0; q < gr.length; q += 3) if (gr[q] > m) m = gr[q]; return 1 / m; };\n        // o halo largo s\u00f3 \u00e9 parcialmente normalizado: num shape fino ele n\u00e3o pode virar uma mancha que engole a forma\n        var n1 = pk(B1), n2 = Math.min(pk(B2), 2.2), n3 = Math.min(pk(B3), 1.5);\n        field0 = function (x, y) {\n          var d = vecDist(VG, x, y), inside = ins(x, y);\n          var b1 = Math.min(1, sample(B1, x, y) * n1), b2 = Math.min(1, sample(B2, x, y) * n2), b3 = Math.min(1, sample(B3, x, y) * n3);\n          // corpo: o miolo (onde o blur largo \u00e9 alto) acende mais que as partes finas \u2192 camadas de shade\n          var e = 0.42 * b1 + 0.36 * b2 * b2 + 0.4 * b3 * b3 * b3 + 0.1 * b3;\n          // aresta n\u00edtida opcional (nitidez) \u2014 a forma continua leg\u00edvel\n          e += sh * 0.22 * Math.exp(-(d * d) / (wcore * wcore)) * (inside ? 1 : 0.6);\n          return e;\n        };\n      } else if (vm === 'rim') {\n        // rim sem costura: derivada direcional da m\u00e1scara borrada (lado do shape virado pra luz)\n        var Rn = boxBlur3(mask, GW, GH, cellsOf(0.014)), Rf = boxBlur3(mask, GW, GH, cellsOf(0.09 * g));\n        var dl = 0.012, dlf = 0.06 * g;\n        var dirI = function (gr, x, y, dd) { return sample(gr, x - Dx * dd, y - Dy * dd) - sample(gr, x + Dx * dd, y + Dy * dd); };\n        // normaliza pelo m\u00e1ximo\n        var mxN = 1e-6, mxF = 1e-6, bfx = 0, bfy = 0;\n        for (var sy = 0; sy < GH; sy += 2) for (var sx2 = 0; sx2 < GW; sx2 += 2) {\n          var qx = gx0 + (sx2 + 0.5) * cellU, qy = gy0 + (sy + 0.5) * cellU;\n          var vn = dirI(Rn, qx, qy, dl), vf = dirI(Rf, qx, qy, dlf);\n          if (vn > mxN) { mxN = vn; bfx = qx; bfy = qy; }\n          if (vf > mxF) mxF = vf;\n        }\n        var focusV = 2.2;\n        field0 = function (x, y) {\n          var d = vecDist(VG, x, y), inside = ins(x, y);\n          var In = Math.pow(clamp01(dirI(Rn, x, y, dl) / mxN), focusV), If = clamp01(dirI(Rf, x, y, dlf) / mxF);\n          var e = In * glow(d, 1);\n          if (inside) e = e * Math.exp(-d / 0.005) + If * 0.05 * Math.exp(-d / (0.05 * g));\n          else e += If * 0.3 * Math.exp(-d / (0.1 * g)) + Math.pow(If, 0.6) * 0.07 * Math.exp(-d / (0.35 * g));\n          if (flV > 0) {\n            var fx3 = x - bfx, fy3 = y - bfy, r2v = fx3 * fx3 + fy3 * fy3;\n            var f = 0.8 * Math.exp(-r2v / (0.0014 * g)) + 0.28 * Math.exp(-r2v / (0.03 * g));\n            if (inside) f *= Math.exp(-d / 0.004);\n            e += flV * f;\n          }\n          return e;\n        };\n      } else {\n        // contorno: o fio de luz \u00e9 a borda; elementos = ecos conc\u00eantricos pra fora\n        field0 = function (x, y) {\n          var d = vecDist(VG, x, y), e = glow(d, 1);\n          if (echoes > 1) {\n            var s = VG.closedAny && ins(x, y) ? -d : d;\n            for (var k2 = 1; k2 < echoes; k2++) { var dk = Math.abs(s - k2 * sp); e += Math.pow(0.68, k2) * glow(dk, 0.7); }\n          }\n          return e * (0.55 + 0.45 * fbm(x * 2.2 + 3.7, y * 2.2 + 1.3, seedN));\n        };\n      }\n      field = function (x, y) {\n        var e = field0(x, y);\n        if (vm !== 'rim') {\n          var hx5 = x - hotX, hy5 = y - hotY;\n          e *= 0.55 + 0.75 * Math.exp(-(hx5 * hx5 + hy5 * hy5) / 0.5);\n          if (flV > 0 && vm === 'outline') e += flV * 0.5 * Math.exp(-(hx5 * hx5 + hy5 * hy5) / (0.012 * g)) * Math.exp(-vecDist(VG, x, y) / 0.02);\n        }\n        return e;\n      };\n    } else if (STROKE_SHAPES[p.shape]) {\n      var raw = genStrokes(p, rng, { Dx: Dx, Dy: Dy, Nx: Nx, Ny: Ny, ax: ax, ay: ay, ext: extent });\n      var strokes = raw.map(function (st) { return prepStroke(st, st.smooth !== undefined ? st.smooth : 2); });\n      var cut = 2.4 * g + 0.3;\n      var hotx = Dx * extent * 0.32, hoty = Dy * extent * 0.32;\n      // flare no ponto do tra\u00e7o principal mais perto do ponto quente\n      var fpx = 0, fpy = 0, fbest = 1e9, m0 = strokes[0];\n      for (var fi = 0; m0 && fi < m0.pts.length; fi += 2) {\n        var fd = Math.hypot(m0.pts[fi] - hotx, m0.pts[fi + 1] - hoty);\n        if (fd < fbest) { fbest = fd; fpx = m0.pts[fi]; fpy = m0.pts[fi + 1]; }\n      }\n      var flS = p.flare, spot = p.shape === 'draw' && p.paths.length ? 0.5 : 1.1;\n      field = function (x, y) {\n        var e = 0;\n        for (var i = 0; i < strokes.length; i++) {\n          var st = strokes[i];\n          var h = strokeDist(st, x, y), d = h[0] / st.thick;\n          if (d > cut) continue;\n          var pos = h[1], env = 0.35 + 0.65 * vnoise(pos * st.total * 2.2 + st.ns, st.ns, seedN);\n          // longe do tra\u00e7o o \"ponto mais pr\u00f3ximo\" pula entre trechos (eixo medial) \u2192 costura.\n          // o halo distante usa envelope m\u00e9dio, s\u00f3 o n\u00facleo segue a varia\u00e7\u00e3o local.\n          env = mix(env, 0.68, smooth(0.01, 0.09, d));\n          if (!st.closed) {\n            // pontas: atenua\u00e7\u00e3o pela dist\u00e2ncia at\u00e9 a ponta no espa\u00e7o (campo cont\u00ednuo \u2192 sem costura nem gancho)\n            var e0 = Math.hypot(x - st.ex0, y - st.ey0), e1 = Math.hypot(x - st.ex1, y - st.ey1);\n            var tp = smooth(0, st.r0, e0) * smooth(0, st.r1, e1);\n            env *= 0.08 + 0.92 * tp;\n          }\n          e += st.amp * env * glow(d, 1);\n        }\n        var hx3 = x - hotx, hy3 = y - hoty;\n        e *= (1 - spot * 0.6) + spot * 0.6 * 1.6 * Math.exp(-(hx3 * hx3 + hy3 * hy3) / 0.45) + (1 - spot) * 0.4;\n        if (flS > 0) {\n          var fx2 = x - fpx, fy2 = y - fpy, r2f = fx2 * fx2 + fy2 * fy2;\n          e += flS * (0.9 * Math.exp(-r2f / (0.0016 * g)) + 0.3 * Math.exp(-r2f / (0.03 * g)));\n        }\n        return e;\n      };\n    } else { // bloom\n      // manchas desfocadas com vazio escuro entre elas\n      var nbl = p.elements;\n      var blobs = [];\n      for (var bi = 0; bi < nbl; bi++) {\n        var ang = rng() * 6.283;\n        var el = 1 + p.curvature * mix(0.5, 2.2, rng());\n        var bx = 0, by = 0, tries = 0, ok = false;\n        while (!ok && tries++ < 40) {\n          bx = (rng() - 0.5) * ax * 1.7; by = (rng() - 0.5) * ay * 1.7; ok = true;\n          for (var bj = 0; bj < blobs.length; bj++) {\n            if (Math.hypot(bx - blobs[bj].x, by - blobs[bj].y) < 0.42) { ok = false; break; }\n          }\n          if (Math.hypot(bx - Dx * extent * 0.45, by - Dy * extent * 0.45) < 0.45) ok = false;\n        }\n        blobs.push({\n          x: bx, y: by,\n          c: Math.cos(ang), s: Math.sin(ang), el: el,\n          r: mix(0.07, 0.14, rng()) * g, amp: mix(0.2, 0.5, rng())\n        });\n      }\n      blobs[0].x = Dx * extent * 0.45; blobs[0].y = Dy * extent * 0.45; blobs[0].amp = 0.9; blobs[0].r *= 1.5;\n      var flb = p.flare;\n      field = function (x, y) {\n        var e = 0;\n        for (var i = 0; i < blobs.length; i++) {\n          var bl = blobs[i], dx = x - bl.x, dy = y - bl.y;\n          var a1 = (dx * bl.c + dy * bl.s) / bl.el, a2 = (-dx * bl.s + dy * bl.c);\n          var dd = Math.sqrt(a1 * a1 + a2 * a2);\n          e += bl.amp * (Math.exp(-(dd * dd) / (bl.r * bl.r)) + 0.18 * Math.exp(-dd / (bl.r * 1.8)));\n          if (i === 0 && flb > 0) e += flb * 0.9 * Math.exp(-(dd * dd) / (bl.r * bl.r * 0.06));\n        }\n        return e;\n      };\n    }\n\n    if (p.occluder && p.shape !== 'eclipse' && p.shape !== 'horizon') {\n      if (!occ) occ = { x: -Dx * 0.05 + Nx * 0.32, y: -Dy * 0.05 + Ny * 0.32, r: mix(0.36, 0.55, rng()) };\n    } else occ = null;\n\n    var turb = p.turbulence;\n    var ws = seedN + 101;\n    var mixSeed = seedN + 303;\n    var energy0 = function (x, y) {\n        if (turb > 0) {\n          var wx = fbm(x * 1.2 + 3.1, y * 1.2 + 7.7, ws) - 0.5, wy = fbm(x * 1.2 + 11.3, y * 1.2 + 1.9, ws) - 0.5;\n          var qx = x + turb * 0.75 * wx, qy = y + turb * 0.75 * wy;\n          var vx = fbm(qx * 3.6, qy * 3.6, ws + 5) - 0.5, vy = fbm(qx * 3.6 + 9, qy * 3.6 + 4, ws + 5) - 0.5;\n          x = qx + turb * 0.07 * vx; y = qy + turb * 0.07 * vy;\n        }\n        var e = field(x, y);\n        if (occ) {\n          var dx = x - occ.x, dy = y - occ.y, s = Math.sqrt(dx * dx + dy * dy) - occ.r;\n          var m = smooth(-0.035 * g, 0.045 * g, s);\n          e = e * (0.04 + 0.96 * m) + e * 0.35 * Math.exp(-(s * s) / (0.0004 * g)) * smooth(-0.05, 0, s);\n        }\n        return e;\n    };\n    var energy = energy0;\n    // Desfoque: o campo inteiro (forma + glow + turbul\u00eancia + esfera) \u00e9 amostrado num grid e borrado,\n    // literalmente \"blur no vetor\". A aresta dura some; o pico \u00e9 parcialmente compensado pra forma n\u00e3o apagar.\n    if (p.soften > 0) {\n      var rU = 0.003 + 0.075 * Math.pow(p.soften, 1.7);\n      var cell = Math.max(1 / 320, 1.25 / S, rU / 24);\n      var pad = rU * 2.2 + cell * 2, bx0 = -ax - pad, by0 = -ay - pad;\n      var BW = Math.ceil((2 * ax + 2 * pad) / cell) + 1, BH = Math.ceil((2 * ay + 2 * pad) / cell) + 1;\n      var raw = new Float32Array(BW * BH), mr = 1e-9;\n      for (var gy = 0; gy < BH; gy++) for (var gx = 0; gx < BW; gx++) {\n        var v = energy0(bx0 + gx * cell, by0 + gy * cell);\n        raw[gy * BW + gx] = v; if (v > mr) mr = v;\n      }\n      var blurred = boxBlur3(raw, BW, BH, Math.max(1, Math.round(rU / cell)));\n      var mb = 1e-9; for (var bi2 = 0; bi2 < blurred.length; bi2++) if (blurred[bi2] > mb) mb = blurred[bi2];\n      // compensa s\u00f3 parte da perda de pico: o desfoque deixa a luz mais suave, n\u00e3o uma mancha chapada\n      var comp = clamp(Math.pow(mr / mb, 0.45), 1, 2.6);\n      var fade = smooth(0, 0.12, p.soften); // abaixo de 12% cruza com o campo exato (sem salto no in\u00edcio do slider)\n      var at = function (x, y) {\n        var fx = (x - bx0) / cell, fy = (y - by0) / cell;\n        if (fx < 0) fx = 0; else if (fx > BW - 1.001) fx = BW - 1.001;\n        if (fy < 0) fy = 0; else if (fy > BH - 1.001) fy = BH - 1.001;\n        var ix = fx | 0, iy = fy | 0, tx = fx - ix, ty = fy - iy, o = iy * BW + ix;\n        return ((blurred[o] * (1 - tx) + blurred[o + 1] * tx) * (1 - ty) + (blurred[o + BW] * (1 - tx) + blurred[o + BW + 1] * tx) * ty) * comp;\n      };\n      energy = fade >= 1 ? at : function (x, y) { return mix(energy0(x, y), at(x, y), fade); };\n    }\n    return {\n      W: W, H: H, S: S, ax: ax, ay: ay, Nx: Nx, Ny: Ny,\n      energy: energy,\n      mixAt: function (x, y) {\n        var t = (x * Nx + y * Ny) * 2.4 + (fbm(x * 1.2, y * 1.2, mixSeed) - 0.5) * 2.2;\n        return 0.5 + 0.5 * Math.tanh(t * 1.4);\n      }\n    };\n  }\n\n  // ------------------------------------------------------------------ render\n  /**\n   * Renderiza linhas [y0, y1) em `out` (RGBA 8 bits, W*H*4).\n   * Resolu\u00e7\u00e3o independente: as formas vivem em unidades do menor lado.\n   * Fade: mistura cada borda ao fundo. Transparente: \"color to alpha\" a partir do fundo,\n   * ent\u00e3o compor o PNG sobre o mesmo fundo reproduz exatamente a vers\u00e3o opaca.\n   */\n  function renderRows(out, W, H, p, y0, y1, ctx) {\n    ctx = ctx || prepare(p, W, H);\n    p = ctx.p;\n    var sc = ctx.scene, ra = ctx.ramps.a.lut, rb = ctx.ramps.b ? ctx.ramps.b.lut : null;\n    var gg = ctx.ramps.g || null, grows = gg ? gg.rows : null, gR = gg ? gg.n - 1 : 0, gN = LUT_SIZE * 3, gA = gg ? gg.alpha : null;\n    var bg = ctx.ramps.a.bg, b0 = bg[0], b1 = bg[1], b2 = bg[2];\n    var k = gainOf(p);\n    var gam = 1 / p.contrast;\n    var grainA = p.grain * 0.11;\n    var cell = Math.max(1, Math.round(sc.S / 1080));\n    var gs = p.seed * 7 + 3;\n    var inv = 1 / sc.S, hx = W / 2, hy = H / 2;\n    var top = LUT_SIZE - 1;\n    var transp = p.transparent;\n    var fT = p.fadeT * 0.5 * H, fB = p.fadeB * 0.5 * H, fL = p.fadeL * 0.5 * W, fR = p.fadeR * 0.5 * W;\n    var anyFade = fT > 0 || fB > 0 || fL > 0 || fR > 0;\n    for (var py = y0; py < y1; py++) {\n      var y = (py + 0.5 - hy) * inv, gy = (py / cell) | 0;\n      var my = 1;\n      if (fT > 0) my *= smooth(0, fT, py + 0.5);\n      if (fB > 0) my *= smooth(0, fB, H - py - 0.5);\n      for (var px = 0; px < W; px++) {\n        var x = (px + 0.5 - hx) * inv;\n        var E = sc.energy(x, y), gu = 0;\n        if (grows) { gu = gradPos(gg, x, y); if (gA) E *= gA[(gu * 255 + 0.5) | 0]; }\n        var t = 1 - Math.exp(-E * k);\n        if (gam !== 1) t = Math.pow(t, gam);\n        var li = Math.round(t * top) * 3;\n        var r, g, b;\n        if (grows) {\n          var tgp = gu * gR, ri = tgp | 0; if (ri > gR - 1) ri = gR - 1;\n          var rf = tgp - ri, q1 = ri * gN + li, q2 = q1 + gN;\n          r = grows[q1] + (grows[q2] - grows[q1]) * rf; g = grows[q1 + 1] + (grows[q2 + 1] - grows[q1 + 1]) * rf; b = grows[q1 + 2] + (grows[q2 + 2] - grows[q1 + 2]) * rf;\n        } else { r = ra[li]; g = ra[li + 1]; b = ra[li + 2]; }\n        if (rb) {\n          var m = sc.mixAt(x, y);\n          r += (rb[li] - r) * m; g += (rb[li + 1] - g) * m; b += (rb[li + 2] - b) * m;\n        }\n        if (anyFade) {\n          var mf = my;\n          if (fL > 0) mf *= smooth(0, fL, px + 0.5);\n          if (fR > 0) mf *= smooth(0, fR, W - px - 0.5);\n          if (mf < 1) { r = b0 + (r - b0) * mf; g = b1 + (g - b1) * mf; b = b2 + (b - b2) * mf; t *= mf; }\n        }\n        var gx = (px / cell) | 0;\n        var n = (hash3(gx, gy, gs) + hash3(gx, gy, gs + 1) - 1) * grainA * (1 - 0.65 * t);\n        var dth = (hash3(px, py, gs + 2) - 0.5) / 255;\n        var o = (py * W + px) * 4;\n        if (transp) {\n          var a = alphaOf(r, b0) , a1 = alphaOf(g, b1), a2 = alphaOf(b, b2);\n          if (a1 > a) a = a1; if (a2 > a) a = a2;\n          if (a < 0.002) { out[o] = b0 * 255 + 0.5; out[o + 1] = b1 * 255 + 0.5; out[o + 2] = b2 * 255 + 0.5; out[o + 3] = 0; continue; }\n          var ia = 1 / a;\n          r = b0 + (r - b0) * ia; g = b1 + (g - b1) * ia; b = b2 + (b - b2) * ia;\n          out[o] = clamp01(r + n) * 255 + 0.5;\n          out[o + 1] = clamp01(g + n) * 255 + 0.5;\n          out[o + 2] = clamp01(b + n) * 255 + 0.5;\n          out[o + 3] = clamp01(a + dth) * 255 + 0.5;\n        } else {\n          out[o] = clamp01(r + n + dth) * 255 + 0.5;\n          out[o + 1] = clamp01(g + n + dth) * 255 + 0.5;\n          out[o + 2] = clamp01(b + n + dth) * 255 + 0.5;\n          out[o + 3] = 255;\n        }\n      }\n    }\n    return ctx;\n  }\n\n  // alpha m\u00ednimo pra que c = fundo\u00b7(1\u2212\u03b1) + luz\u00b7\u03b1 com luz \u2208 [0,1]\n  // folga m\u00ednima 0.12: com fundo quase branco/preto num canal, um desvio m\u00ednimo exigiria alpha total\n  // (ex.: fundo #F5F6FE e luz azul 255). Aceita um erro pequeno de cor nesse canal em troca de alpha suave.\n  function alphaOf(c, bgc) {\n    var d = c - bgc;\n    if (d > 1e-6) return Math.min(1, d / Math.max(1 - bgc, 0.12));\n    if (d < -1e-6) return Math.min(1, -d / Math.max(bgc, 0.12));\n    return 0;\n  }\n\n  function prepare(p, W, H) {\n    p = normalize(p);\n    return { p: p, scene: buildScene(p, W, H), ramps: ramps(p) };\n  }\n\n  function renderRGBA(W, H, p) {\n    p = normalize(p);\n    var out = new Uint8ClampedArray(W * H * 4);\n    renderRows(out, W, H, p, 0, H, prepare(p, W, H));\n    return out;\n  }\n\n  // Desenha num canvas 2D (browser). Retorna o ImageData.\n  function render(ctx2d, p, opts) {\n    p = normalize(p);\n    var W = opts.width, H = opts.height;\n    var img = ctx2d.createImageData(W, H);\n    renderRows(img.data, W, H, p, 0, H, prepare(p, W, H));\n    ctx2d.putImageData(img, 0, 0);\n    return img;\n  }\n\n  // Render em fatias (n\u00e3o trava a UI no export grande).\n  function renderAsync(W, H, p, onDone, opts) {\n    p = normalize(p);\n    var out = new Uint8ClampedArray(W * H * 4), c = prepare(p, W, H), y = 0;\n    var step = Math.max(8, Math.floor(160000 / W));\n    var cancelled = false;\n    (function tick() {\n      if (cancelled) return;\n      var y1 = Math.min(H, y + step);\n      renderRows(out, W, H, p, y, y1, c);\n      y = y1;\n      if (opts && opts.onProgress) opts.onProgress(y / H);\n      if (y < H) setTimeout(tick, 0); else onDone(out);\n    })();\n    return { cancel: function () { cancelled = true; } };\n  }\n\n  function rampStops(p) {\n    p = normalize(p);\n    var r = ramps(p);\n    return { a: r.a.stops, b: r.b ? r.b.stops : null };\n  }\n\n  function rampCSS(p, which) {\n    p = normalize(p);\n    var r = ramps(p)[which || 'a'];\n    if (!r) return '';\n    var parts = [];\n    for (var i = 0; i <= 16; i++) parts.push(rgbToHex(rampColor(r, i / 16)) + ' ' + (i / 16 * 100).toFixed(1) + '%');\n    return 'linear-gradient(90deg,' + parts.join(',') + ')';\n  }\n\n  function toJSON(p) {\n    p = normalize(p);\n    var size = outputSize(p);\n    return { kind: 'glow-gradient', version: VERSION, width: size[0], height: size[1], params: p, ramp: rampStops(p) };\n  }\n\n  function fromJSON(obj) {\n    if (!obj || obj.kind !== 'glow-gradient' || !obj.params) throw new Error('JSON inv\u00e1lido');\n    return normalize(obj.params);\n  }\n\n  // ------------------------------------------------------------------ campo de energia (runtime)\n  // Energia bruta por pixel (antes de intensidade/rampa) + mapa de mistura do duo.\n  // O runtime anima em cima disso sem recalcular a forma.\n  function energyField(W, H, p, y0, y1, ctx) {\n    p = normalize(p);\n    ctx = ctx || { scene: buildScene(p, W, H) };\n    var sc = ctx.scene, inv = 1 / sc.S, hx = W / 2, hy = H / 2;\n    y0 = y0 || 0; y1 = y1 === undefined ? H : y1;\n    var E = new Float32Array(W * (y1 - y0)), M = needsMix(p) ? new Uint8Array(W * (y1 - y0)) : null;\n    var gf = p.palette === 'object' && p.gfill ? p.gfill : null, gfa = gf ? ramps(p).g.alpha : null;\n    for (var py = y0; py < y1; py++) {\n      var y = (py + 0.5 - hy) * inv, row = (py - y0) * W;\n      for (var px = 0; px < W; px++) {\n        var x = (px + 0.5 - hx) * inv;\n        var e = sc.energy(x, y);\n        if (gf) { var gu = gradPos(gf, x, y); if (gfa) e *= gfa[(gu * 255 + 0.5) | 0]; M[row + px] = Math.round(gu * 255); }\n        else if (M) M[row + px] = Math.round(sc.mixAt(x, y) * 255);\n        E[row + px] = e;\n      }\n    }\n    return { E: E, M: M, ctx: ctx };\n  }\n  // ganho de intensidade usado no render (mesma f\u00f3rmula do renderRows)\n  function gainOf(p) { return (0.3 + 3.4 * Math.pow(p.intensity, 1.25)) * (p.mode === 'light' ? 0.8 : 1); }\n\n  // ------------------------------------------------------------------ c\u00f3digo compartilh\u00e1vel\n  // \"gg1.\" + base64url(JSON s\u00f3 com o que difere do padr\u00e3o). Cabe em nome de layer, coment\u00e1rio ou chat.\n  var B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';\n  function b64url(str) {\n    var out = '', i = 0;\n    for (; i + 2 < str.length; i += 3) {\n      var n = (str.charCodeAt(i) << 16) | (str.charCodeAt(i + 1) << 8) | str.charCodeAt(i + 2);\n      out += B64[n >> 18 & 63] + B64[n >> 12 & 63] + B64[n >> 6 & 63] + B64[n & 63];\n    }\n    if (str.length - i === 1) { var a = str.charCodeAt(i) << 16; out += B64[a >> 18 & 63] + B64[a >> 12 & 63]; }\n    else if (str.length - i === 2) { var b = (str.charCodeAt(i) << 16) | (str.charCodeAt(i + 1) << 8); out += B64[b >> 18 & 63] + B64[b >> 12 & 63] + B64[b >> 6 & 63]; }\n    return out;\n  }\n  function unb64url(s) {\n    var out = '', buf = 0, bits = 0;\n    for (var i = 0; i < s.length; i++) {\n      var v = B64.indexOf(s[i]); if (v < 0) throw new Error('c\u00f3digo inv\u00e1lido');\n      buf = (buf << 6) | v; bits += 6;\n      if (bits >= 8) { bits -= 8; out += String.fromCharCode(buf >> bits & 255); }\n    }\n    return out;\n  }\n  function encode(p) {\n    p = normalize(p);\n    var d = {}, k;\n    for (k in p) {\n      if (k === 'scale') continue;\n      if (JSON.stringify(p[k]) !== JSON.stringify(DEFAULTS[k])) d[k] = p[k];\n    }\n    if (d.paths) d.paths = d.paths.map(function (pp) { return pp.map(function (v) { return Math.round(v * 1000) / 1000; }); });\n    if (d.vector) d.vector = { c: d.vector.c.map(function (pp) { return pp.map(function (v) { return Math.round(v * 2000) / 2000; }); }), z: d.vector.z, eo: d.vector.eo };\n    var json = JSON.stringify(d).replace(/[\\u007f-\\uffff]/g, function (c) { return '\\\\u' + ('000' + c.charCodeAt(0).toString(16)).slice(-4); });\n    return 'gg1.' + b64url(json);\n  }\n  function decode(code) {\n    var m = /gg1\\.([A-Za-z0-9_-]+)/.exec(String(code || ''));\n    if (!m) throw new Error('c\u00f3digo inv\u00e1lido');\n    return normalize(JSON.parse(unb64url(m[1])));\n  }\n\n  // ------------------------------------------------------------------ receita no PNG\n  // O PNG exportado leva a receita (params) num chunk tEXt \"glow-gradient\".\n  // Qualquer um com o arquivo consegue recriar a imagem id\u00eantica com o motor.\n  var CRC_TABLE = null;\n  function crc32(bytes, start, end) {\n    if (!CRC_TABLE) {\n      CRC_TABLE = new Int32Array(256);\n      for (var n = 0; n < 256; n++) { var c = n; for (var k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; CRC_TABLE[n] = c; }\n    }\n    var crc = -1;\n    for (var i = start; i < end; i++) crc = CRC_TABLE[(crc ^ bytes[i]) & 255] ^ (crc >>> 8);\n    return (crc ^ -1) >>> 0;\n  }\n  var PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];\n  var RECIPE_KEY = 'glow-gradient';\n  function isPNG(b) { for (var i = 0; i < 8; i++) if (b[i] !== PNG_SIG[i]) return false; return true; }\n  function u32(b, o) { return ((b[o] << 24) | (b[o + 1] << 16) | (b[o + 2] << 8) | b[o + 3]) >>> 0; }\n  function asciiBytes(str) {\n    var out = new Uint8Array(str.length);\n    for (var i = 0; i < str.length; i++) { var c = str.charCodeAt(i); if (c > 126) throw new Error('receita n\u00e3o-ASCII'); out[i] = c; }\n    return out;\n  }\n\n  function embedRecipe(png, params) {\n    var b = png instanceof Uint8Array ? png : new Uint8Array(png);\n    if (!isPNG(b)) throw new Error('n\u00e3o \u00e9 PNG');\n    var json = JSON.stringify(toJSON(params)).replace(/[\\u007f-\\uffff]/g, function (c) { return '\\\\u' + ('000' + c.charCodeAt(0).toString(16)).slice(-4); });\n    var data = asciiBytes(RECIPE_KEY + '\\u0000' + json);\n    // insere logo depois do IHDR (primeiro chunk), removendo receita antiga\n    var parts = [b.subarray(0, 8)], o = 8, first = true;\n    while (o < b.length) {\n      var len = u32(b, o), type = String.fromCharCode(b[o + 4], b[o + 5], b[o + 6], b[o + 7]), end = o + 12 + len;\n      var skip = false;\n      if (type === 'tEXt') {\n        var key = ''; for (var i = o + 8; i < o + 8 + len && b[i] !== 0; i++) key += String.fromCharCode(b[i]);\n        skip = key === RECIPE_KEY;\n      }\n      if (!skip) parts.push(b.subarray(o, end));\n      if (first) {\n        var ch = new Uint8Array(12 + data.length);\n        ch[0] = data.length >>> 24; ch[1] = data.length >>> 16 & 255; ch[2] = data.length >>> 8 & 255; ch[3] = data.length & 255;\n        ch[4] = 116; ch[5] = 69; ch[6] = 88; ch[7] = 116; // tEXt\n        ch.set(data, 8);\n        var crc = crc32(ch, 4, 8 + data.length);\n        ch[8 + data.length] = crc >>> 24; ch[9 + data.length] = crc >>> 16 & 255; ch[10 + data.length] = crc >>> 8 & 255; ch[11 + data.length] = crc & 255;\n        parts.push(ch); first = false;\n      }\n      o = end;\n    }\n    var total = 0; parts.forEach(function (x) { total += x.length; });\n    var out = new Uint8Array(total), w = 0;\n    parts.forEach(function (x) { out.set(x, w); w += x.length; });\n    return out;\n  }\n\n  // L\u00ea a receita de um PNG (Uint8Array/ArrayBuffer). Retorna params normalizados ou null.\n  function readRecipe(png) {\n    var b = png instanceof Uint8Array ? png : new Uint8Array(png);\n    if (!isPNG(b)) return null;\n    var o = 8;\n    while (o + 12 <= b.length) {\n      var len = u32(b, o), type = String.fromCharCode(b[o + 4], b[o + 5], b[o + 6], b[o + 7]);\n      if (type === 'tEXt') {\n        var str = '';\n        for (var i = o + 8; i < o + 8 + len; i++) str += String.fromCharCode(b[i]);\n        var z = str.indexOf('\\u0000');\n        if (str.slice(0, z) === RECIPE_KEY) {\n          try { return fromJSON(JSON.parse(str.slice(z + 1))); } catch (e) { return null; }\n        }\n      }\n      if (type === 'IDAT' || type === 'IEND') break;\n      o += 12 + len;\n    }\n    return null;\n  }\n\n  return {\n    VERSION: VERSION,\n    SHAPES: SHAPES, PALETTES: PALETTES, MODES: MODES, FORMATS: FORMATS, DEFAULTS: DEFAULTS, SHAPE_PRESETS: SHAPE_PRESETS, RANGES: RANGES,\n    normalize: normalize, preset: preset, outputSize: outputSize,\n    buildRamp: buildRamp, rampStops: rampStops, rampCSS: rampCSS, hexToOklch: hexToOklch, srgbLuma: srgbLuma, rampColor: rampColor,\n    renderRGBA: renderRGBA, renderRows: renderRows, render: render, renderAsync: renderAsync, prepare: prepare,\n    toJSON: toJSON, fromJSON: fromJSON, embedRecipe: embedRecipe, readRecipe: readRecipe, encode: encode, decode: decode,\n    energyField: energyField, gainOf: gainOf, ramps: ramps, parseSVG: parseSVG, toVector: toVector, toFill: toFill, parseColor: parseColor, gradPos: gradPos, VMODES: VMODES, SAMPLE_VECTOR: SAMPLE_VECTOR,\n    _internal: { alphaOf: alphaOf, hueDelta: hueDelta, mulberry32: mulberry32, oklchToSrgb: oklchToSrgb, driftOf: driftOf }\n  };\n});\n";
