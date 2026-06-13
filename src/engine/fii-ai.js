const axios = require('axios');

const MODEL  = 'claude-haiku-4-5-20251001';
const APIKEY = () => process.env.ANTHROPIC_API_KEY;

async function callClaude(prompt, maxTokens = 300) {
  const { data } = await axios.post(
    'https://api.anthropic.com/v1/messages',
    { model: MODEL, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] },
    {
      headers: { 'x-api-key': APIKEY(), 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      timeout: 30000,
    }
  );
  return data.content[0].text;
}

/**
 * Gera explicações personalizadas para todos os FIIs de uma recomendação.
 * Uma única chamada LLM — retorna { ticker: "explicacao", ... }
 */
async function gerarExplicacoesRecomendacao(perfil, score, wizardData, fiis) {
  if (!APIKEY()) return null;

  const fiisList = fiis.map(f =>
    `${f.ticker}: DY=${f.dy_12m?.toFixed(1) ?? 'N/D'}% PVP=${f.pvp?.toFixed(2) ?? 'N/D'} Segmento=${f.segmento ?? 'N/D'}`
  ).join('\n');

  const contextoUsuario = [
    `Perfil: ${perfil} (score ${score}/100)`,
    wizardData?.step4?.objectives?.length ? `Objetivos: ${wizardData.step4.objectives.join(', ')}` : '',
    wizardData?.step5?.horizon ? `Horizonte: ${wizardData.step5.horizon}` : '',
    wizardData?.step8?.needs_income_now ? 'Precisa de renda agora' : '',
    wizardData?.step9?.preferred_segments?.length ? `Segmentos preferidos: ${wizardData.step9.preferred_segments.join(', ')}` : '',
  ].filter(Boolean).join(' | ');

  const prompt = `Analista de FIIs brasileiros. Responda em JSON puro, sem markdown.

Investidor: ${contextoUsuario}

FIIs selecionados:
${fiisList}

Para cada ticker, escreva 1 frase curta (max 20 palavras) explicando por que faz sentido para ESTE investidor.
Formato: {"TICKER1":"frase","TICKER2":"frase",...}`;

  try {
    const text = await callClaude(prompt, 250);
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    return jsonMatch ? JSON.parse(jsonMatch[0]) : null;
  } catch (e) {
    console.warn('[fii-ai] gerarExplicacoes falhou:', e.message);
    return null;
  }
}

async function gerarSintese(top10, macroCtx = {}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    console.warn('[fii-ai] ANTHROPIC_API_KEY não configurada — síntese ignorada');
    return null;
  }

  const selic = macroCtx.selic ?? 'N/D';
  const ifix30d = macroCtx.ifix_30d ?? 'N/D';

  const { data } = await axios.post(
    'https://api.anthropic.com/v1/messages',
    {
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: `Você é um analista especialista em FIIs brasileiros.
Gere uma síntese estratégica de 3 a 5 frases orientando onde aportar este mês. Foco em recomendação de alocação, não análise individual.
Retorne APENAS o texto, sem markdown.

Cenário: Selic ${selic}% | IFIX 30d: ${ifix30d}%
Top 10: ${JSON.stringify(top10)}

Seja direto: "Os melhores FIIs para aportar agora são X, Y e Z porque..."`,
      }],
    },
    {
      headers: {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json',
      },
      timeout: 30000,
    }
  );

  return data.content[0].text;
}

// ── Síntese personalizada por perfil × momento ───────────────────────────────

const PERFIL_MOMENTO_CTX = {
  conservador_saudavel:  'investidor conservador com finanças sólidas (reserva formada, renda disponível). Prioriza estabilidade e previsibilidade de renda. Exposição máxima sugerida: 30% do patrimônio.',
  conservador_cauteloso: 'investidor conservador em momento financeiro de atenção (algumas dívidas ou reserva incompleta). Aportes pequenos, apenas em ativos de menor risco.',
  conservador_restrito:  'investidor conservador com momento financeiro restritivo. NÃO recomende novos aportes em FIIs — oriente a priorizar reserva de emergência e quitação de dívidas.',
  moderado_saudavel:     'investidor moderado com finanças equilibradas. Busca equilíbrio entre renda passiva e crescimento de cota. Pode alocar até 50% do patrimônio.',
  moderado_cauteloso:    'investidor moderado em momento de cautela financeira. Aportes reduzidos, foco em segurança. Exposição máxima: 35%.',
  moderado_restrito:     'investidor moderado com momento financeiro restritivo. Aportes mínimos apenas em recebíveis de baixíssimo risco. Exposição máxima: 10%.',
  arrojado_saudavel:     'investidor arrojado com excelente momento financeiro. Tolera volatilidade, horizonte longo, busca valorização de cota além do DY. Pode alocar até 70%.',
  arrojado_cauteloso:    'investidor arrojado mas em momento financeiro de cautela. Reduz risco de segmento temporariamente. Exposição máxima: 40%.',
  arrojado_restrito:     'investidor arrojado com momento financeiro restritivo. Manter posições existentes, sem novos aportes relevantes.',
  sofisticado_saudavel:  'investidor sofisticado com finanças muito sólidas. Alta tolerância a risco, horizonte muito longo, pode explorar qualquer segmento. Exposição até 90%.',
  sofisticado_cauteloso: 'investidor sofisticado em momento de cautela. Foco em fundos geradores de caixa sólidos. Exposição máxima: 50%.',
  sofisticado_restrito:  'investidor sofisticado com momento restritivo. Gestão defensiva do portfólio existente, evitar novos aportes.',
};

async function gerarSintesePersonalizada(perfil, momento, fiis, macroCtx = {}) {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) return null;

  const chave = `${perfil}_${momento}`;
  const ctx   = PERFIL_MOMENTO_CTX[chave] || PERFIL_MOMENTO_CTX.moderado_saudavel;
  const selic   = macroCtx.selic   ?? 'N/D';
  const ifix30d = macroCtx.ifix_30d ?? 'N/D';

  const pausar = momento === 'restrito' && perfil === 'conservador';

  if (pausar) {
    return 'Seu momento financeiro atual recomenda pausar novos aportes em FIIs. Priorize a reserva de emergência e a quitação de dívidas com juros acima de 12% ao ano. Quando estiver em momento saudável, os FIIs de recebíveis são a porta de entrada ideal para seu perfil.';
  }

  const fiisList = fiis.slice(0, 10).map(f =>
    `${f.ticker}(DY=${f.dy_12m?.toFixed(1) ?? 'N/D'}% PVP=${f.pvp?.toFixed(2) ?? 'N/D'} Score=${f.score ?? 'N/D'})`
  ).join(', ');

  const prompt = `Você é analista sênior de FIIs brasileiros. Responda em português, texto corrido, sem markdown.

Perfil do investidor: ${ctx}
Cenário macro: Selic ${selic}% | IFIX 30d: ${ifix30d}%
FIIs elegíveis para este perfil (já filtrados por segmento e critérios de risco): ${fiisList}

Gere uma síntese de 3 a 5 frases orientando onde aportar este mês. Mencione 2-3 tickers específicos com justificativa breve. Inclua a exposição máxima recomendada para o perfil. Seja direto e prático.`;

  try {
    const { data } = await axios.post(
      'https://api.anthropic.com/v1/messages',
      { model: MODEL, max_tokens: 350, messages: [{ role: 'user', content: prompt }] },
      { headers: { 'x-api-key': apiKey, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' }, timeout: 30000 }
    );
    return data.content[0].text;
  } catch (e) {
    console.warn('[fii-ai] gerarSintesePersonalizada falhou:', e.message);
    return null;
  }
}

module.exports = { gerarSintese, gerarExplicacoesRecomendacao, gerarSintesePersonalizada };
