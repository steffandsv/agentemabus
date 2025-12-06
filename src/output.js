const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');

async function writeOutput(results, filePath) {
    const workbook = new ExcelJS.Workbook();
    
    // Check if the original file exists to preserve structure
    // If we were editing the original file in place, we would load it.
    // However, the task says "transformamos os itens... na primeira aba chamada 'Planilha de Cadastro - Previsão'".
    // It's safer to create a new file based on the template logic or just overwrite if that's the intention.
    // Let's assume we are writing to a new file 'cotacao_final.xlsx' or updating 'planilha-modelo.xlsx' copy.
    // The user said "gera no arquivo final...". I will stick to creating/overwriting the target file with the correct tabs.
    
    // But wait, the user said "na primeira aba chamada 'Planilha de Cadastro - Previsão', as demais abas servirão para outras etapas".
    // This implies I should ideally load the 'planilha-modelo.xlsx' if it exists and fill it.

    let templatePath = 'planilha-modelo.xlsx';
    if (fs.existsSync(templatePath)) {
        try {
            await workbook.xlsx.readFile(templatePath);
        } catch (e) {
            console.warn("Could not read template, starting fresh.", e);
        }
    }

    // 1. Get or Create "Planilha de Cadastro - Previsão"
    let sheet = workbook.getWorksheet('Planilha de Cadastro - Previsão');
    if (!sheet) {
        sheet = workbook.addWorksheet('Planilha de Cadastro - Previsão');
    }

    // Define columns if they don't exist (or just assume they do and append? Better to be safe)
    // Based on user desc: "valor de compra, marca e modelo".
    // I will try to map to standard headers if I can find them, or set them.
    // Let's set a standard header row at row 1 if empty.
    if (sheet.rowCount < 1) {
        sheet.columns = [
            { header: 'ID', key: 'id', width: 10 },
            { header: 'Descrição', key: 'desc', width: 40 },
            { header: 'Marca', key: 'brand', width: 20 },
            { header: 'Modelo', key: 'model', width: 20 },
            { header: 'Valor Unitário', key: 'price', width: 15 },
            { header: 'Link', key: 'link', width: 50 },
            { header: 'Risco IA', key: 'risk', width: 10 },
            { header: 'Obs', key: 'obs', width: 30 }
        ];
    } else {
        // If sheet exists, I'll just append rows at the end or try to match IDs?
        // Simpler: Just clear and rewrite or append?
        // User: "preenchendo na planilha o valor de compra...".
        // Implies updating. But without complex logic, I will append results for now.
        // Or better: Iterate results and add them.
    }

    // Clear data rows (keep header) if we want a fresh start for this run
    // sheet.spliceRows(2, sheet.rowCount - 1);

    results.forEach(item => {
        const best = item.result;

        // Extract Brand/Model from AI string "Brand - Model" or similar
        let brand = '';
        let model = '';
        if (best && best.brand_model) {
            const parts = best.brand_model.split('-');
            if (parts.length > 1) {
                brand = parts[0].trim();
                model = parts.slice(1).join('-').trim();
            } else {
                model = best.brand_model;
            }
        }

        sheet.addRow({
            id: item.id,
            desc: item.description,
            brand: brand || (best ? 'Genérica' : '-'),
            model: model || (best ? best.title : '-'),
            price: best ? best.totalPrice : 0,
            link: best ? best.link : '-',
            risk: best ? best.risk_score : '10',
            obs: best ? best.reasoning : 'Não encontrado'
        });
    });

    // 2. Create "Dados Brutos" tab for debugging/logging
    let rawSheet = workbook.getWorksheet('Dados Brutos');
    if (rawSheet) {
        workbook.removeWorksheet(rawSheet.id);
    }
    rawSheet = workbook.addWorksheet('Dados Brutos');

    rawSheet.columns = [
        { header: 'ID', key: 'id' },
        { header: 'Desc', key: 'desc' },
        { header: 'Modelos Tentados', key: 'tried' },
        { header: 'Melhor Link', key: 'link' },
        { header: 'Score', key: 'score' }
    ];

    results.forEach(item => {
        rawSheet.addRow({
            id: item.id,
            desc: item.description,
            tried: item.models_tried ? item.models_tried.join(', ') : '',
            link: item.result ? item.result.link : 'N/A',
            score: item.result ? item.result.risk_score : 'N/A'
        });
    });

    await workbook.xlsx.writeFile(filePath);
    console.log(`Results saved to ${filePath}`);
}

module.exports = { writeOutput };
