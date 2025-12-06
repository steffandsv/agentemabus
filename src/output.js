const ExcelJS = require('exceljs');

async function writeOutput(data, filePath) {
    const workbook = new ExcelJS.Workbook();
    
    // --- Sheet 1: Dados Brutos ---
    const sheet1 = workbook.addWorksheet('Dados Brutos');
    
    sheet1.columns = [
        { header: 'ID Item', key: 'ItemID', width: 10 },
        { header: 'Descrição Original', key: 'OriginalDescription', width: 40 },
        { header: 'Rank (Risco)', key: 'Rank', width: 10 },
        { header: 'Título Oferta', key: 'OfferTitle', width: 40 },
        { header: 'Marca/Modelo', key: 'BrandModel', width: 25 },
        { header: 'Preço', key: 'Price', width: 15 },
        { header: 'Frete', key: 'Shipping', width: 15 },
        { header: 'Total', key: 'TotalPrice', width: 15 },
        { header: 'Status IA', key: 'AI_Match', width: 15 },
        { header: 'Risco (0-10)', key: 'RiskScore', width: 12 },
        { header: 'Motivo IA', key: 'AI_Reasoning', width: 50 },
        { header: 'Link', key: 'Link', width: 50 }
    ];

    data.forEach(item => {
        if (!item.offers || item.offers.length === 0) {
            sheet1.addRow({
                ItemID: item.id,
                OriginalDescription: item.description,
                Rank: '-',
                OfferTitle: 'Nenhuma oferta encontrada',
                BrandModel: '-',
                Price: 0,
                Shipping: 0,
                TotalPrice: 0,
                AI_Match: 'N/A',
                RiskScore: '-',
                AI_Reasoning: 'Busca sem resultados.',
                Link: '-'
            });
        } else {
            // Sort by Risk Score for the raw data sheet presentation
            const sortedOffers = [...item.offers].sort((a, b) => (a.risk_score || 10) - (b.risk_score || 10));
            
            sortedOffers.forEach((offer, index) => {
                sheet1.addRow({
                    ItemID: item.id,
                    OriginalDescription: item.description,
                    Rank: index + 1,
                    OfferTitle: offer.title,
                    BrandModel: offer.brand_model || '-',
                    Price: offer.price,
                    Shipping: offer.shippingCost,
                    TotalPrice: offer.totalPrice,
                    AI_Match: offer.aiMatch || 'Pendente',
                    RiskScore: offer.risk_score !== undefined ? offer.risk_score : 10,
                    AI_Reasoning: offer.aiReasoning || '',
                    Link: offer.link
                });
            });
        }
    });

    // --- Sheet 2: Resumo ---
    const sheet2 = workbook.addWorksheet('Resumo');
    sheet2.columns = [
        { header: 'Lote', key: 'Lote', width: 10 }, 
        { header: 'Item', key: 'Item', width: 40 }, 
        { header: 'Valor Total Compra', key: 'Valor', width: 20 },
        { header: 'Marca/Modelo', key: 'MarcaModelo', width: 30 },
        { header: 'Status IA', key: 'StatusIA', width: 20 },
        { header: 'Classificação de Risco', key: 'Risco', width: 20 },
        { header: 'Link', key: 'Link', width: 50 }
    ];

    data.forEach(item => {
        let best = null;
        if (item.offers && item.offers.length > 0) {
            if (typeof item.winnerIndex === 'number' && item.offers[item.winnerIndex]) {
                best = item.offers[item.winnerIndex];
            } else {
                // Fallback: pick the lowest risk one
                best = item.offers.reduce((prev, curr) => (prev.risk_score < curr.risk_score) ? prev : curr);
            }
        }
        
        sheet2.addRow({
            Lote: item.id,
            Item: item.description,
            Valor: best ? best.totalPrice : 0,
            MarcaModelo: best ? (best.brand_model || best.title) : 'N/A',
            StatusIA: best ? best.aiMatch : 'N/A',
            Risco: best ? (best.risk_score + '/10') : '-',
            Link: best ? best.link : 'N/A'
        });
    });

    await workbook.xlsx.writeFile(filePath);
}

module.exports = { writeOutput };
