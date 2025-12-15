const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');

async function writeOutput(results, filePath) {
    const workbook = new ExcelJS.Workbook();
    
    // --- SHEET 1: DADOS BRUTOS (RANKING) ---
    const rawSheet = workbook.addWorksheet('Dados Brutos');

    rawSheet.columns = [
        { header: 'Lote', key: 'id', width: 10 },
        { header: 'Descrição', key: 'desc', width: 40 },
        { header: 'Status', key: 'status', width: 15 },
        { header: 'Risco', key: 'risk', width: 10 },
        { header: 'Preço Encontrado', key: 'price', width: 15 },
        { header: 'Preço Venda (Max)', key: 'sell_price', width: 15 },
        { header: 'Qtd', key: 'qtd', width: 8 },
        { header: 'Lucro Est. (Total)', key: 'profit', width: 15 },
        { header: 'Link', key: 'link', width: 50 },
        { header: 'Motivo / Obs', key: 'reasoning', width: 50 }
    ];

    results.forEach(item => {
        if (item.offers && item.offers.length > 0) {
            item.offers.forEach((offer, idx) => {
                let profit = 0;
                if (item.valor_venda) {
                    profit = (item.valor_venda - offer.totalPrice) * (item.quantidade || 1);
                }

                rawSheet.addRow({
                    id: item.id,
                    desc: item.description,
                    status: (idx === item.winnerIndex) ? 'VENCEDOR' : 'Candidato',
                    risk: offer.risk_score,
                    price: offer.totalPrice,
                    sell_price: item.valor_venda || 0,
                    qtd: item.quantidade || 1,
                    profit: profit.toFixed(2),
                    link: offer.link,
                    reasoning: offer.aiReasoning || offer.reasoning || '-'
                });
            });
        } else {
            rawSheet.addRow({
                id: item.id,
                desc: item.description,
                status: 'Não Encontrado',
                risk: '-',
                price: 0,
                sell_price: item.valor_venda || 0,
                qtd: item.quantidade || 1,
                profit: 0,
                link: '-',
                reasoning: 'Nenhum item compatível encontrado.'
            });
        }
    });

    // --- SHEET 2: RESUMO (CONSOLIDADO) ---
    const summarySheet = workbook.addWorksheet('Resumo');

    // Order: ID, Descrição Original, Quantidade, Valor de Compra, Valor de venda, Marca/Modelo, Link
    summarySheet.columns = [
        { header: 'ID', key: 'id', width: 10 },
        { header: 'Descrição Original', key: 'desc', width: 40 },
        { header: 'Quantidade', key: 'qty', width: 10 },
        { header: 'Valor de Compra', key: 'buy_price', width: 15 },
        { header: 'Valor de venda', key: 'sell_price', width: 15 },
        { header: 'Marca/Modelo', key: 'model', width: 25 },
        { header: 'Link', key: 'link', width: 50 },
        { header: 'Risco', key: 'risk', width: 10 },
        { header: 'Motivo', key: 'reasoning', width: 50 }
    ];

    results.forEach(item => {
        let best = null;
        if (item.winnerIndex >= 0 && item.offers && item.offers.length > item.winnerIndex) {
            best = item.offers[item.winnerIndex];
        }

        summarySheet.addRow({
            id: item.id,
            desc: item.description,
            qty: item.quantidade || 1,
            buy_price: best ? best.totalPrice : 0,
            sell_price: item.valor_venda || 0,
            model: best ? (best.brand_model || best.title) : 'N/A',
            link: best ? best.link : '-',
            risk: best ? best.risk_score : '-',
            reasoning: best ? best.aiReasoning : '-'
        });
    });

    await workbook.xlsx.writeFile(filePath);
    console.log(`Results saved to ${filePath}`);
}

module.exports = { writeOutput };
