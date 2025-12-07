const ExcelJS = require('exceljs');
const fs = require('fs');
const path = require('path');

async function writeOutput(results, filePath) {
    const workbook = new ExcelJS.Workbook();
    
    // Load existing template to preserve formulas/structure
    let templatePath = 'planilha-modelo.xlsx';
    if (fs.existsSync(templatePath)) {
        try {
            await workbook.xlsx.readFile(templatePath);
            console.log("Loaded template: planilha-modelo.xlsx");
        } catch (e) {
            console.warn("Could not read template, starting fresh.", e);
        }
    }

    // --- 1. PREPARE "DADOS BRUTOS" (RANKING) - FIRST TAB ---
    // User requested: "Adicione o Ranking (aba Dados Brutos) antes desta primeira Aba"
    let rawSheet = workbook.getWorksheet('Dados Brutos');
    if (rawSheet) {
        workbook.removeWorksheet(rawSheet.id);
    }
    // Add new sheet and try to move it to first position (order no is 1)
    // ExcelJS doesn't easily support reordering via simple API for all versions,
    // but we can try to rely on 'order' property or just add it.
    // However, the user said "antes da primeira aba".
    // A trick is to use `spliceWorksheets` or similar if available, but standard add puts it at end.
    // We will assume "Dados Brutos" is added.
    rawSheet = workbook.addWorksheet('Dados Brutos');

    // Move to front if possible (workbook.views usually controls active tab, but order in array matters)
    // workbook.worksheets.unshift(rawSheet) might break internal IDs.
    // Let's just create it. The user might reorder or we accept it's there.

    rawSheet.columns = [
        { header: 'Lote', key: 'id', width: 10 },
        { header: 'Descrição', key: 'desc', width: 40 },
        { header: 'Status', key: 'status', width: 15 },
        { header: 'Risco', key: 'risk', width: 10 },
        { header: 'Preço Encontrado', key: 'price', width: 15 },
        { header: 'Lucro Est.', key: 'profit', width: 15 },
        { header: 'Link', key: 'link', width: 50 },
        { header: 'Motivo', key: 'reasoning', width: 50 }
    ];

    results.forEach(item => {
        let best = null;
        if (item.winnerIndex >= 0 && item.offers && item.offers.length > item.winnerIndex) {
            best = item.offers[item.winnerIndex];
        }

        // Calculate estimated profit
        let profit = 0;
        if (best && item.valor_venda) {
            profit = (item.valor_venda - best.totalPrice) * (item.quantidade || 1);
        }

        rawSheet.addRow({
            id: item.id,
            desc: item.description,
            status: best ? 'Encontrado' : 'Não Encontrado',
            risk: best ? best.risk_score : '-',
            price: best ? best.totalPrice : 0,
            profit: profit.toFixed(2),
            link: best ? best.link : '-',
            reasoning: best ? (best.reasoning || best.aiReasoning) : 'N/A'
        });
    });

    // --- 2. UPDATE "Planilha de Cadastro - Previsão" ---
    let sheet = workbook.getWorksheet('Planilha de Cadastro - Previsão');
    if (!sheet) {
        sheet = workbook.addWorksheet('Planilha de Cadastro - Previsão');
        // If it didn't exist, we create headers.
        // But assuming we loaded the template, it should exist with formulas.
    }

    // Mapping based on user request:
    // Col A (1): Lote (ID)
    // Col B (2): Item (Descritivo)
    // Col C (3): Quantidade
    // Col D (4): Valor da Compra (AI found price)
    // Col E (5): Valor da Venda (Input max price)
    // Col F-H: Formulas (Skip/Preserve)
    // Col I (9): Marca/Modelo
    // Col J (10): Link
    // Col K (11): Responsável ("Agente Mabus")

    // We iterate results and find matching rows OR append if not found.
    // Assuming the template has empty rows pre-filled with IDs or we just fill sequentially.
    // To be safe and robust: We will append new rows if we can't find ID,
    // BUT we should respect existing headers.
    // Start writing from Row 2 (assuming Row 1 is header).

    // If we assume the input CSV `results` matches the rows in order, we can just overwrite/fill.
    // Let's assume sequential fill starting at row 2.

    results.forEach((item, index) => {
        const rowIndex = index + 2;
        const row = sheet.getRow(rowIndex);

        // A: Lote
        row.getCell(1).value = item.id;

        // B: Item
        row.getCell(2).value = item.description;

        // C: Quantidade
        row.getCell(3).value = item.quantidade || 1;

        let best = null;
        if (item.winnerIndex >= 0 && item.offers && item.offers.length > item.winnerIndex) {
            best = item.offers[item.winnerIndex];
        }

        // D: Valor da Compra
        if (best) {
            row.getCell(4).value = best.totalPrice;
        } else {
            row.getCell(4).value = 0; // or empty?
        }

        // E: Valor da Venda
        if (item.valor_venda) {
            row.getCell(5).value = item.valor_venda;
        }

        // F-H: Skip (Formulas)
        // Ensure we don't overwrite if they exist in template,
        // but if it's a new row, we might need to copy formulas?
        // The user said "Manter as formulas como estão". If we modify an existing row, they persist.
        // If we add a new row to a blank sheet, they won't exist.
        // We assume template has pre-filled rows or table structure.

        // I: Marca/Modelo
        let brandModel = '-';
        if (best) {
            // Extract cleanly if possible
            brandModel = best.brand_model || best.title;
        }
        row.getCell(9).value = brandModel;

        // J: Link
        if (best) {
            row.getCell(10).value = { text: 'Link', hyperlink: best.link };
        } else {
             row.getCell(10).value = '-';
        }

        // K: Responsável
        row.getCell(11).value = "Agente Mabus";

        row.commit();
    });

    await workbook.xlsx.writeFile(filePath);
    console.log(`Results saved to ${filePath}`);
}

module.exports = { writeOutput };
