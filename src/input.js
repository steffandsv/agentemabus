const fs = require('fs');
const csv = require('csv-parser');

function readInput(filePath) {
  return new Promise((resolve, reject) => {
    const results = [];
    let headersFound = [];
    let separatorUsed = 'unknown';

    // Helper to try parsing with specific separator if auto-detect fails logic is implied
    // But csv-parser is stream based.
    // We will stick to ';' as default since we enforced it in template,
    // BUT we should be flexible.
    // However, the `csv-parser` lib doesn't auto-detect separator well if not configured.
    // We will try `separator: ';'` as the primary since user locale is BR.

    fs.createReadStream(filePath)
      .pipe(csv({ separator: ';' }))
      .on('headers', (headers) => {
          headersFound = headers;
          console.log(`[Input] Headers found (using ';'): ${headers.join(', ')}`);
      })
      .on('data', (data) => {
          // Normalize keys
          const normalized = {};
          const keys = Object.keys(data);

          for (const key of keys) {
              const lower = key.toLowerCase().trim();
              if (lower === 'id' || lower === 'lote' || lower === 'item') normalized.id = data[key];
              else if (lower === 'descricao' || lower === 'descrição' || lower === 'description') normalized.description = data[key];
              else if (lower === 'valor_venda' || lower === 'valor maximo' || lower === 'valor referência' || lower === 'valor_maximo') normalized.valor_venda = data[key];
              else if (lower === 'quantidade' || lower === 'qtd') normalized.quantidade = data[key];
          }

          // Parse numbers
          if (normalized.valor_venda) {
              // Handle "R$ 1.200,50" -> 1200.50
              let v = normalized.valor_venda;
              if (typeof v === 'string') {
                  v = v.replace('R$', '').trim();
                  // Check format: 1.000,00 vs 1,000.00
                  if (v.includes(',') && v.includes('.')) {
                      v = v.replace(/\./g, '').replace(',', '.');
                  } else if (v.includes(',')) {
                      v = v.replace(',', '.');
                  }
                  normalized.valor_venda = parseFloat(v);
              }
          }
          if (normalized.quantidade) {
              normalized.quantidade = parseInt(normalized.quantidade);
          }

          if (normalized.id && normalized.description) {
              results.push(normalized);
          }
      })
      .on('end', () => {
        if (results.length === 0) {
             console.warn(`[Input] Warning: 0 items loaded. Headers seen: ${headersFound.join(' | ')}. Check if separator is ';'`);
        }
        resolve(results);
      })
      .on('error', (err) => {
        console.error('[Input] Error reading CSV:', err);
        reject(err);
      });
  });
}

module.exports = { readInput };
