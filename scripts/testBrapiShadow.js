require('dotenv').config();
const {
  fetchFiisBrapi,
  normalizarFii,
  upsertBrapiCache,
  getConsumoMes,
  getCoberturaComparativa,
} = require('../src/services/brapiService');

const TICKERS_TESTE = ['HGLG11', 'RZTR11', 'SNCI11', 'KNCR11', 'RZAK11'];

async function main() {
  console.log('=== Teste Brapi Shadow Table ===\n');
  console.log('1. Buscando dados Brapi para:', TICKERS_TESTE.join(', '));

  const rawData = await fetchFiisBrapi(TICKERS_TESTE);
  console.log(`   → ${rawData.length} tickers retornados\n`);

  if (!rawData.length) {
    console.log('   ⚠️  Nenhum dado retornado. Verifique o BRAPI_TOKEN.');
    process.exit(1);
  }

  const normalized = rawData.map(normalizarFii);

  console.log('2. Preview do primeiro FII normalizado:');
  const preview = normalized[0];
  if (preview) {
    console.log(`   Ticker:             ${preview.ticker}`);
    console.log(`   Preço:              R$ ${preview.preco}`);
    console.log(`   P/VP:               ${preview.pvp}`);
    console.log(`   DY 12m:             ${preview.dy_12m != null ? (preview.dy_12m * 100).toFixed(1) + '%' : 'AUSENTE ⚠️'}`);
    console.log(`   Vacância:           ${preview.vacancia_fisica ?? 'AUSENTE ⚠️'}`);
    console.log(`   Liquidez diária:    ${preview.liquidez_diaria}`);
    console.log(`   Dividendos (hist):  ${preview.dividendos_historico.length} meses`);
    console.log(`   Campos preenchidos: ${preview.campos_preenchidos}`);
    console.log(`   Campos ausentes:    ${preview.campos_ausentes.join(', ') || 'nenhum'}`);
  }

  console.log('\n3. Salvando em brapi_fii_cache...');
  await upsertBrapiCache(normalized);
  console.log('   → Upsert concluído\n');

  console.log('4. Consumo do mês:');
  const consumo = await getConsumoMes();
  console.log(`   Chamadas:           ${consumo.total_chamadas}`);
  console.log(`   Tickers chamados:   ${consumo.total_tickers}`);
  console.log(`   Requisições rest.:  ${consumo.requisicoes_restantes}`);
  console.log(`   % consumido:        ${consumo.pct_consumido}%`);

  console.log('\n5. Cobertura de campos:');
  const cobertura = await getCoberturaComparativa();
  console.log(`   Total FIIs:         ${cobertura.total_fiis}`);
  console.log(`   Com PVP:            ${cobertura.com_pvp}`);
  console.log(`   Com DY:             ${cobertura.com_dy}`);
  console.log(`   Com vacância:       ${cobertura.com_vacancia}`);
  console.log(`   Com dividendos:     ${cobertura.com_dividendos_historico}`);
  console.log(`   Média campos:       ${cobertura.media_campos_preenchidos}`);

  process.exit(0);
}

main().catch(err => {
  console.error('Erro:', err.message);
  process.exit(1);
});
