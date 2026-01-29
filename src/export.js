const ExcelJS = require('exceljs');
const { getTaskFullResults } = require('./database');

// ============================================
// SMART CANDIDATE SELECTION - Phase 6D
// Rich Excel Formatting
// ============================================

/**
 * Format reasoning text for Excel with emojis and line breaks
 * @param {string} reasoning - The AI reasoning text (may contain emojis)
 * @returns {string} Formatted text with line breaks
 */
function formatReasoningForExcel(reasoning) {
    if (!reasoning || reasoning === '-') return '-';

    let formatted = reasoning
        // Add line breaks after key punctuation
        .replace(/\. /g, '.\n')
        .replace(/! /g, '!\n')
        .replace(/: /g, ':\n')
        // Add line breaks before emojis for better readability
        .replace(/(✅|⚠️|🔶|🔴|❌|✓|✗|📌|🎯|💡)/g, '\n$1')
        // Remove duplicate line breaks
        .replace(/\n\n+/g, '\n')
        // Trim leading line break
        .replace(/^\n/, '');

    return formatted;
}

async function generateExcelBuffer(taskId) {
    const results = await getTaskFullResults(taskId);
    if (!results || results.length === 0) return null;

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
        { header: 'Motivo / Obs', key: 'reasoning', width: 80 }  // WIDENED
    ];

    // Enable text wrapping for reasoning column
    rawSheet.getColumn('reasoning').alignment = { wrapText: true, vertical: 'top' };

    results.forEach(item => {
        // FILTER: Only unlocked items
        if (!item.is_unlocked) return;

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
                    reasoning: formatReasoningForExcel(offer.aiReasoning || '-')
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

    summarySheet.columns = [
        { header: 'ID', key: 'id', width: 10 },
        { header: 'Descrição Original', key: 'desc', width: 40 },
        { header: 'Marca/Modelo Escolhido', key: 'model', width: 25 },
        { header: 'Valor Unitário Compra', key: 'buy_price', width: 15 },
        { header: 'Valor Unitário Venda', key: 'sell_price', width: 15 },
        { header: 'Quantidade', key: 'qty', width: 10 },
        { header: 'Lucro Total Previsto', key: 'profit', width: 15 },
        { header: 'Link', key: 'link', width: 50 },
        { header: 'Risco', key: 'risk', width: 10 },
        { header: 'Motivo', key: 'reasoning', width: 80 }  // WIDENED
    ];

    // Enable text wrapping for reasoning column
    summarySheet.getColumn('reasoning').alignment = { wrapText: true, vertical: 'top' };

    results.forEach(item => {
        // FILTER: Only unlocked items
        if (!item.is_unlocked) return;

        let best = null;
        if (item.winnerIndex >= 0 && item.offers && item.offers.length > item.winnerIndex) {
            best = item.offers[item.winnerIndex];
        }

        let profit = 0;
        if (best && item.valor_venda) {
            profit = (item.valor_venda - best.totalPrice) * (item.quantidade || 1);
        }

        summarySheet.addRow({
            id: item.id,
            desc: item.description,
            model: best ? (best.brand_model || best.title) : 'N/A',
            buy_price: best ? best.totalPrice : 0,
            sell_price: item.valor_venda || 0,
            qty: item.quantidade || 1,
            profit: profit.toFixed(2),
            link: best ? best.link : '-',
            risk: best ? best.risk_score : '-',
            reasoning: formatReasoningForExcel(best ? best.aiReasoning : '-')
        });
    });

    return await workbook.xlsx.writeBuffer();
}

async function generateItemExcelBuffer(taskId, itemDbId) {
    const results = await getTaskFullResults(taskId);
    if (!results || results.length === 0) return null;

    // Filter for specific item
    // Need to convert itemDbId to integer for comparison
    const item = results.find(i => i.db_id == itemDbId);

    if (!item) return null;
    if (!item.is_unlocked) return null; // Security check

    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('Item ' + item.id);

    sheet.columns = [
        { header: 'Descrição', key: 'desc', width: 40 },
        { header: 'Candidato', key: 'title', width: 40 },
        { header: 'Preço', key: 'price', width: 15 },
        { header: 'Link', key: 'link', width: 50 },
        { header: 'Loja', key: 'store', width: 20 },
        { header: 'Risco', key: 'risk', width: 10 },
        { header: 'Raciocínio IA', key: 'reasoning', width: 80 }  // WIDENED
    ];

    // Enable text wrapping for reasoning column
    sheet.getColumn('reasoning').alignment = { wrapText: true, vertical: 'top' };

    if (item.offers && item.offers.length > 0) {
        item.offers.forEach(offer => {
            sheet.addRow({
                desc: item.description,
                title: offer.title,
                price: offer.totalPrice,
                link: offer.link,
                store: offer.store,
                risk: offer.risk_score,
                reasoning: formatReasoningForExcel(offer.aiReasoning)
            });
        });
    } else {
        sheet.addRow({ desc: 'Nenhum candidato encontrado.' });
    }

    return await workbook.xlsx.writeBuffer();
}

module.exports = { generateExcelBuffer, generateItemExcelBuffer, formatReasoningForExcel };
