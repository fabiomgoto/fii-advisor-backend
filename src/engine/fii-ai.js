const axios = require('axios');

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

module.exports = { gerarSintese };
