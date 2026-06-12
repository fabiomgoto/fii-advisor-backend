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

module.exports = { gerarSintese, gerarExplicacoesRecomendacao };
