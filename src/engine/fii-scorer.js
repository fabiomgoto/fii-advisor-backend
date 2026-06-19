'use strict';

// ─── Lookup ticker → segmento ────────────────────────────────────────────────

const TICKER_SEGMENTO = {
  // ── FIAGRO ───────────────────────────────────────────────────────────────────
  SNAG11: 'agro', RZAG11: 'agro', RZAK11: 'agro', JURO11: 'agro',
  HCTR11: 'agro', GCRA11: 'agro', PGPF11: 'agro',

  // ── Recebíveis / CRI ─────────────────────────────────────────────────────────
  KNCR11: 'recebiveis', KNIP11: 'recebiveis', MXRF11: 'recebiveis',
  VRTA11: 'recebiveis', MCCI11: 'recebiveis', RBRR11: 'recebiveis',
  VGIP11: 'recebiveis', IRDM11: 'recebiveis', BTCI11: 'recebiveis',
  SNCI11: 'recebiveis', CVBI11: 'recebiveis', HABT11: 'recebiveis',
  HCRI11: 'recebiveis', PLCR11: 'recebiveis', NCHB11: 'recebiveis',
  RBRY11: 'recebiveis', CPTS11: 'recebiveis', TPFT11: 'recebiveis',
  VCJR11: 'recebiveis', FEXC11: 'recebiveis', VGIA11: 'recebiveis',
  DEVA11: 'recebiveis', XPCI11: 'recebiveis', HGCR11: 'recebiveis',
  NPAR11: 'recebiveis', OUJP11: 'recebiveis', CACR11: 'recebiveis',
  RZTR11: 'recebiveis', MGCR11: 'recebiveis', VSLH11: 'recebiveis',
  BTAL11: 'recebiveis',

  // ── FOF ──────────────────────────────────────────────────────────────────────
  BCFF11: 'fof', HFOF11: 'fof', KFOF11: 'fof', RBFF11: 'fof',
  MGFF11: 'fof', TFOF11: 'fof', BPFF11: 'fof', CXOF11: 'fof',
  IBFF11: 'fof', NFOF11: 'fof',

  // ── Tijolo — logística / galpões / industrial ─────────────────────────────────
  HGLG11: 'tijolo', BTLG11: 'tijolo', BRCO11: 'tijolo', GGRC11: 'tijolo',
  TRXF11: 'tijolo', KNRI11: 'tijolo', XPLG11: 'tijolo', LVBI11: 'tijolo',
  LOG11:  'tijolo', VILG11: 'tijolo', FIIB11: 'tijolo', GLOG11: 'tijolo',
  GALG11: 'tijolo', SDIL11: 'tijolo', VGHF11: 'tijolo', CXAG11: 'tijolo',
  HSLG11: 'tijolo', TGAR11: 'tijolo', GTWR11: 'tijolo',

  // ── Lajes Corporativas ───────────────────────────────────────────────────────
  PVBI11: 'lajes', RCRB11: 'lajes', BRCR11: 'lajes', JSRE11: 'lajes',
  VINO11: 'lajes', PATC11: 'lajes', HGPO11: 'lajes', EDGA11: 'lajes',
  TBLG11: 'lajes', RFOF11: 'lajes', HGRE11: 'lajes', XPPR11: 'lajes',
  CBOP11: 'lajes', FTWR11: 'lajes', BMLC11: 'lajes', RBED11: 'lajes',

  // ── Shopping ─────────────────────────────────────────────────────────────────
  XPML11: 'shopping', VISC11: 'shopping', HSML11: 'shopping', MALL11: 'shopping',
  HGBS11: 'shopping', GSFI11: 'shopping', FVPQ11: 'shopping', ABCP11: 'shopping',
  FLRP11: 'shopping', JRDM11: 'shopping', PQDP11: 'shopping',

  // ── Desenvolvimento ──────────────────────────────────────────────────────────
  URPR11: 'desenvolvimento', PLPL11: 'desenvolvimento', HOSI11: 'desenvolvimento',
  RBVA11: 'desenvolvimento', GPCP11: 'desenvolvimento', MFAI11: 'desenvolvimento',

  // ── Agências bancárias ───────────────────────────────────────────────────────
  BBPO11: 'agencias', AGCX11: 'agencias', BBRC11: 'agencias',
  SAAG11: 'agencias', RBBV11: 'agencias',

  // ── Hotel / Hotelaria ────────────────────────────────────────────────────────
  HTMX11: 'hotel', XPHT11: 'hotel', HOTH11: 'hotel', RBTS11: 'hotel',
  HHBR11: 'hotel',
};

function detectarSegmento(fii) {
  const ticker = (fii.ticker || '').toUpperCase();
  if (TICKER_SEGMENTO[ticker]) return TICKER_SEGMENTO[ticker];

  const nome = ((fii.name || '') + (fii.segment || '')).toUpperCase();
  if (/AGRO|RURAL|CRA\b/.test(nome))                          return 'agro';
  if (/SHOPPING|MALL/.test(nome))                             return 'shopping';
  if (/HOTEL|RESORT/.test(nome))                              return 'hotel';
  if (/LAJES|CORPORAT|ESCRITORIO/.test(nome))                 return 'lajes';
  if (/FOF|FUND.OF.FUND/.test(nome))                          return 'fof';
  if (/AGENCIA|BANCO|BANCARIO/.test(nome))                    return 'agencias';
  if (/CRI|RECEB|CREDITO IMOB|PAPEL/.test(nome))              return 'recebiveis';
  if (/GALPAO|LOGISTIC|INDUSTRIAL|ARMAZEM/.test(nome))        return 'tijolo';
  return 'universal';
}

// ─── Pontuadores base (retornam fração 0-1) ──────────────────────────────────

const pont = {
  dy(v)         { if (v >= 12) return 1; if (v >= 10) return 0.85; if (v >= 8) return 0.65; if (v >= 6) return 0.40; return 0.15; },
  pvp(v)        { if (v < 0.85) return 1; if (v < 0.95) return 0.85; if (v < 1.05) return 0.65; if (v < 1.15) return 0.35; return 0.10; },
  pvpAlt(v)     { if (v < 0.70) return 1; if (v < 0.85) return 0.80; if (v < 1.00) return 0.55; if (v < 1.10) return 0.30; return 0.05; },
  growth(v)     { const pct = v * 100; if (pct > 5) return 1; if (pct > 0) return 0.75; if (pct === 0) return 0.50; return 0.15; },
  liq(v)        { if (v > 3000000) return 1; if (v > 1000000) return 0.75; if (v > 300000) return 0.50; return 0.20; },
  consistency(v){ if (v >= 10) return 1; if (v >= 8) return 0.70; if (v >= 6) return 0.40; return 0.10; },
  vacancy(v, ex = 2, good = 8)    { if (v < ex) return 1; if (v < good) return 0.65; if (v < 15) return 0.30; return 0; },
  vacancyLax(v) { return pont.vacancy(v, 5, 12); },
  vacancyCorp(v){ return pont.vacancy(v, 7, 15); },
  wault(v)      { if (v > 7) return 1; if (v > 5) return 0.75; if (v > 3) return 0.50; return 0.20; },
  leverage(v)   { if (v < 15) return 1; if (v < 25) return 0.70; if (v < 35) return 0.40; return 0.10; },
  properties(v) { if (v > 15) return 1; if (v > 8) return 0.65; if (v > 3) return 0.40; return 0.15; },
};

// ─── Modelos por segmento (campo, peso, fn pontuar) ─────────────────────────

const MODELOS = {
  agro: [
    { campo: 'dy_12m',     peso: 30, fn: pont.dy         },
    { campo: 'div_growth', peso: 20, fn: pont.growth      },
    { campo: 'pvp',        peso: 20, fn: pont.pvp         },
    { campo: 'liquidity',  peso: 10, fn: pont.liq         },
    { campo: 'consistency',peso: 20, fn: pont.consistency },
  ],
  recebiveis: [
    { campo: 'dy_12m',     peso: 25, fn: pont.dy         },
    { campo: 'pvp',        peso: 25, fn: pont.pvp        },
    { campo: 'div_growth', peso: 20, fn: pont.growth     },
    { campo: 'liquidity',  peso: 10, fn: pont.liq        },
    { campo: 'consistency',peso: 20, fn: pont.consistency},
  ],
  fof: [
    { campo: 'dy_12m',     peso: 30, fn: pont.dy         },
    { campo: 'pvp',        peso: 20, fn: pont.pvp        },
    { campo: 'div_growth', peso: 20, fn: pont.growth     },
    { campo: 'consistency',peso: 20, fn: pont.consistency},
    { campo: 'liquidity',  peso: 10, fn: pont.liq        },
  ],
  tijolo: [
    { campo: 'dy_12m',     peso: 20, fn: pont.dy         },
    { campo: 'pvp',        peso: 15, fn: pont.pvp        },
    { campo: 'vacancy',    peso: 20, fn: pont.vacancy     },
    { campo: 'div_growth', peso: 15, fn: pont.growth     },
    { campo: 'wault',      peso: 10, fn: pont.wault      },
    { campo: 'leverage',   peso:  5, fn: pont.leverage   },
    { campo: 'properties', peso:  5, fn: pont.properties },
    { campo: 'liquidity',  peso:  5, fn: pont.liq        },
    { campo: 'consistency',peso:  5, fn: pont.consistency},
  ],
  lajes: [
    { campo: 'dy_12m',     peso: 15, fn: pont.dy         },
    { campo: 'pvp',        peso: 20, fn: pont.pvp        },
    { campo: 'vacancy',    peso: 15, fn: pont.vacancyCorp},
    { campo: 'div_growth', peso: 15, fn: pont.growth     },
    { campo: 'wault',      peso: 22, fn: pont.wault      },
    { campo: 'liquidity',  peso:  8, fn: pont.liq        },
    { campo: 'consistency',peso:  5, fn: pont.consistency},
  ],
  shopping: [
    { campo: 'dy_12m',     peso: 20, fn: pont.dy         },
    { campo: 'pvp',        peso: 15, fn: pont.pvp        },
    { campo: 'vacancy',    peso: 20, fn: pont.vacancyLax },
    { campo: 'div_growth', peso: 20, fn: pont.growth     },
    { campo: 'properties', peso: 10, fn: pont.properties },
    { campo: 'liquidity',  peso: 10, fn: pont.liq        },
    { campo: 'consistency',peso:  5, fn: pont.consistency},
  ],
  desenvolvimento: [
    { campo: 'pvp',        peso: 40, fn: pont.pvpAlt     },
    { campo: 'dy_12m',     peso: 30, fn: pont.dy         },
    { campo: 'div_growth', peso: 15, fn: pont.growth     },
    { campo: 'liquidity',  peso: 15, fn: pont.liq        },
  ],
  agencias: [
    { campo: 'dy_12m',     peso: 20, fn: pont.dy         },
    { campo: 'wault',      peso: 30, fn: pont.wault      },
    { campo: 'pvp',        peso: 20, fn: pont.pvp        },
    { campo: 'consistency',peso: 20, fn: pont.consistency},
    { campo: 'liquidity',  peso: 10, fn: pont.liq        },
  ],
  hotel: [
    { campo: 'dy_12m',     peso: 35, fn: pont.dy         },
    { campo: 'pvp',        peso: 25, fn: pont.pvp        },
    { campo: 'div_growth', peso: 25, fn: pont.growth     },
    { campo: 'liquidity',  peso: 15, fn: pont.liq        },
  ],
  universal: [
    { campo: 'dy_12m',     peso: 20, fn: pont.dy         },
    { campo: 'pvp',        peso: 15, fn: pont.pvp        },
    { campo: 'vacancy',    peso: 15, fn: pont.vacancy    },
    { campo: 'div_growth', peso: 15, fn: pont.growth     },
    { campo: 'wault',      peso: 10, fn: pont.wault      },
    { campo: 'leverage',   peso: 10, fn: pont.leverage   },
    { campo: 'properties', peso: 10, fn: pont.properties },
    { campo: 'liquidity',  peso:  5, fn: pont.liq        },
  ],
};

// ─── Proteção contra DY inflado por colapso de cota ─────────────────────────

function detectarCriseDY(fii) {
  const dy  = fii.dy_12m  ?? 0;
  const pvp = fii.pvp     ?? 1;
  const alertas = [];

  // DY > 20% + P/VP < 0.50 = provável colapso de cota (ex: CACR11)
  if (dy > 20 && pvp < 0.50) {
    alertas.push(`DY inflado (${dy.toFixed(1)}%) com P/VP colapsado (${pvp.toFixed(2)})`);
  }

  // DY > 30% isoladamente é suspeito — mesmo com P/VP ok
  if (dy > 30 && pvp < 0.70) {
    alertas.push(`DY anormalmente alto (${dy.toFixed(1)}%)`);
  }

  return { emCrise: alertas.length > 0, alertas };
}

// ─── Motor principal ─────────────────────────────────────────────────────────

function calcularScore(fii) {
  const segmento = detectarSegmento(fii);
  const modelo   = MODELOS[segmento] || MODELOS.universal;
  const crise    = detectarCriseDY(fii);

  let somapontos      = 0;
  let somaDisponivel  = 0;
  const criterios         = [];
  const criterios_sem_dado = [];

  for (const { campo, peso, fn } of modelo) {
    const valor = fii[campo] ?? null;
    if (valor == null) {
      criterios_sem_dado.push({ campo, peso });
      continue;
    }

    // Em crise: zera a pontuação do DY (o campo existe, mas vale 0 pontos)
    const fracao = (crise.emCrise && campo === 'dy_12m')
      ? 0
      : Math.max(0, Math.min(1, fn(valor)));

    const pontos = parseFloat((fracao * peso).toFixed(2));
    const pct    = Math.round(fracao * 100);
    somapontos     += pontos;
    somaDisponivel += peso;
    criterios.push({ campo, peso, valor, pontos, pct });
  }

  const score = somaDisponivel > 0
    ? Math.min(Math.round((somapontos / somaDisponivel) * 100), 100)
    : 0;

  const cobertura_pct = modelo.length > 0
    ? Math.round((somaDisponivel / modelo.reduce((s, c) => s + c.peso, 0)) * 100)
    : 0;

  const breakdown = { criterios, criterios_sem_dado };
  if (crise.emCrise) breakdown.alertas_dy = crise.alertas;

  return {
    score,
    segmento,
    cobertura_pct,
    score_breakdown: breakdown,
  };
}

function getAction(score) {
  if (score >= 80) return 'buy';
  if (score >= 60) return 'hold';
  return 'review';
}

// ─── Score por perfil (mantido para compatibilidade) ─────────────────────────

const PESOS_PERFIL = {
  renda:       { dy: 35, pvp: 10, vacancy: 10, div_growth: 25, wault:  5, leverage:  5, properties:  5, liquidity:  5 },
  crescimento: { dy: 10, pvp: 30, vacancy: 15, div_growth: 10, wault: 15, leverage: 10, properties:  5, liquidity:  5 },
  equilibrio:  { dy: 20, pvp: 15, vacancy: 15, div_growth: 15, wault: 10, leverage: 10, properties: 10, liquidity:  5 },
  seguranca:   { dy: 15, pvp: 10, vacancy: 10, div_growth: 10, wault: 20, leverage: 20, properties: 10, liquidity:  5 },
};

function calcularScorePerfil(fii, perfil) {
  const pesos = PESOS_PERFIL[perfil] || PESOS_PERFIL.equilibrio;
  let pts = 0, maxDisponivel = 0;

  function pontuarCriterio(valor, max, fn) {
    if (valor == null) return;
    maxDisponivel += max;
    pts += fn(valor, max);
  }

  pontuarCriterio(fii.dy_12m,     pesos.dy,         (v, m) => pont.dy(v) * m);
  pontuarCriterio(fii.pvp,        pesos.pvp,         (v, m) => pont.pvp(v) * m);
  pontuarCriterio(fii.vacancy,    pesos.vacancy,     (v, m) => pont.vacancy(v) * m);
  pontuarCriterio(fii.div_growth, pesos.div_growth,  (v, m) => pont.growth(v) * m);
  pontuarCriterio(fii.wault,      pesos.wault,       (v, m) => pont.wault(v) * m);
  pontuarCriterio(fii.leverage,   pesos.leverage,    (v, m) => pont.leverage(v) * m);
  pontuarCriterio(fii.properties, pesos.properties,  (v, m) => pont.properties(v) * m);
  pontuarCriterio(fii.liquidity,  pesos.liquidity,   (v, m) => pont.liq(v) * m);

  if (maxDisponivel === 0) return calcularScore(fii).score;
  return Math.min(Math.round((pts / maxDisponivel) * 100), 100);
}

module.exports = { calcularScore, calcularScorePerfil, getAction, detectarSegmento, detectarCriseDY, PESOS_PERFIL, MODELOS };
