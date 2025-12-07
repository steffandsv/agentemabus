const fs = require('fs');
const csv = require('csv-parser');

function readInput(filePath) {
  return new Promise((resolve, reject) => {
    const results = [];
    fs.createReadStream(filePath)
      .pipe(csv({ separator: ';' })) // Attempt semicolon first, or auto-detect? Standard CSV usually comma.
      // But Brazilian CSVs are often semicolons. Let's try comma first as per default csv-parser behavior?
      // Actually, csv-parser auto-detects or defaults to comma.
      // Let's stick to default but add mapping logic below.
      .on('data', (data) => {
          // Normalize keys
          const normalized = {};
          for (const key in data) {
              const lower = key.toLowerCase().trim();
              if (lower === 'id' || lower === 'lote' || lower === 'item') normalized.id = data[key];
              else if (lower === 'descricao' || lower === 'descrição' || lower === 'description') normalized.description = data[key];
              else if (lower === 'valor_venda' || lower === 'valor maximo' || lower === 'valor referência') normalized.valor_venda = data[key];
              else if (lower === 'quantidade' || lower === 'qtd') normalized.quantidade = data[key];
          }

          // Parse numbers
          if (normalized.valor_venda) {
              normalized.valor_venda = parseFloat(normalized.valor_venda.replace('R$', '').replace('.', '').replace(',', '.'));
          }
          if (normalized.quantidade) {
              normalized.quantidade = parseInt(normalized.quantidade);
          }

          if (normalized.id && normalized.description) {
              results.push(normalized);
          }
      })
      .on('end', () => {
        resolve(results);
      })
      .on('error', (err) => {
        reject(err);
      });
  });
}

module.exports = { readInput };
