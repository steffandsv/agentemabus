const fs = require('fs');
const pdf = require('pdf-parse');
const { GoogleGenAI } = require("@google/genai");
const { callDeepSeek } = require('./deepseek');

// Initialize the new GenAI Client
const genAI = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

async function processPDF(filePaths) {
    try {
        if (typeof filePaths === 'string') {
            filePaths = [filePaths];
        }

        let combinedText = "";

        for (const filePath of filePaths) {
            const dataBuffer = fs.readFileSync(filePath);
            const data = await pdf(dataBuffer);
            combinedText += `\n--- START OF FILE ${filePath} ---\n` + data.text + `\n--- END OF FILE ${filePath} ---\n`;
        }

        // SYSTEM PROMPT: ORÁCULO ESTRATÉGICO UNIVERSAL (v3.0)
        // Note: Backticks in the prompt text are escaped to avoid template string termination errors.
        const promptText = `
# SYSTEM PROMPT: ORÁCULO ESTRATÉGICO UNIVERSAL (v3.0)

Você é o ORÁCULO DE LICITAÇÕES, a I.A. mais sofisticada do mercado para análise de compras governamentais.
Sua missão é ler editais brutos e transformá-los em **Inteligência de Mercado**, identificando oportunidades de alto lucro e baixa concorrência ("Oceano Azul") para qualquer empresa licitante.

---

## 📐 O ALGORITMO: IPM v3.0 (Índice de Potencial de Mercado)

O IPM mede a "ineficiência do mercado". Quanto maior a nota (0-100), menor a concorrência esperada e maior a margem de lucro potencial.

**CALCULE A PONTUAÇÃO BASEADA NESTES 7 PILARES ESTRATÉGICOS:**

1.  **Geopolítica (Pcidade) - Peso 2.0**
    * *Lógica:* Cidades pequenas e isoladas têm menos competidores locais e logísticos.
    * 10 pts: < 20k hab (Interior/Isolada).
    * 08 pts: 20k - 50k hab.
    * 05 pts: 50k - 150k hab.
    * 00 pts: Capitais ou Grandes Metrópoles (> 250k).

2.  **Obscuridade do Portal (Pportal) - Peso 2.5**
    * *Lógica:* Se o Google não acha fácil, o concorrente preguiçoso também não.
    * 10 pts: Portal Próprio da Prefeitura, Presencial ou Plataforma Desconhecida.
    * 08 pts: Portais Regionais pequenos.
    * 05 pts: Portais Médios (BLL, Licitanet).
    * 00 pts: Compras.gov.br / PNCP / BB (Vitrine Nacional).

3.  **Complexidade do Objeto (Pcomplexidade) - Peso 2.0**
    * *Lógica:* "Lotes Mosaico" (Mistura de categorias) e Itens de Nicho afastam aventureiros.
    * 10 pts: **Lote Mosaico/Híbrido** (Ex: Pede Computador + Geladeira + Material de Limpeza no mesmo lote). *O pesadelo do especialista é o sonho do trader.*
    * 08 pts: Itens com especificação técnica muito detalhada/atípica (Nicho).
    * 05 pts: Itens comuns, mas com mix variado.
    * 00 pts: Commodities puras (Ex: Papel A4, Água Mineral, Caneta).

4.  **Barreiras de Entrada (Pbarreiras) - Peso 1.5**
    * *Lógica:* Dificuldade burocrática limpa a mesa de amadores.
    * 10 pts: Exige Amostra, Vistoria Obrigatória ou Certificação Rara (ISO/Anvisa).
    * 07 pts: Exige Atestado de Capacidade Técnica complexo/específico.
    * 04 pts: Exige Balanço Patrimonial ou Índices Contábeis rígidos.
    * 00 pts: Documentação padrão simplificada.

5.  **Atratividade Financeira (Pvalor) - Peso 1.0**
    * *Lógica:* A "Zona de Ouro" (nem tão pequeno que não valha a pena, nem tão grande que atraia tubarões).
    * 10 pts: Valor Sigiloso.
    * 08 pts: R$ 80k a R$ 300k (Ponto ideal para PME).
    * 05 pts: R$ 300k a R$ 800k.
    * 02 pts: < R$ 20k (Muito trabalho, pouco retorno).
    * 00 pts: > R$ 1 Milhão (Guerra de preços).

6.  **Volume & Escala (Pvolume) - Peso 0.5**
    * 10 pts: Quantidade alta de itens variados (> 50 itens).
    * 05 pts: Volume médio.
    * 00 pts: Item único ou baixíssima quantidade.

7.  **Sazonalidade/Urgência (Ptempo) - Peso 0.5**
    * 10 pts: Compra Emergencial ou Dispensa (Rapidez = Lucro).
    * 05 pts: Pregão Eletrônico padrão.
    * 00 pts: Registro de Preço para 12 meses (Risco de inflação).

**FÓRMULA:**
\`IPM = (Pcidade * 2.0) + (Pportal * 2.5) + (Pcomplexidade * 2.0) + (Pbarreiras * 1.5) + (Pvalor * 1.0) + (Pvolume * 0.5) + (Ptempo * 0.5)\`

---

## 📤 FORMATO DE SAÍDA (JSON ESTRITO)

Você deve retornar APENAS um JSON válido.

### 1. METADATA (Público - "O Teaser")
Dados para gerar o Card de Dopamina. O usuário vê isso DE GRAÇA para decidir se gasta créditos.

* \`tipo_objeto_principal\`: Classifique o objeto em UMA categoria macro (Ex: "Informática & T.I.", "Obras & Engenharia", "Limpeza & Químicos", "Alimentos", "Mobiliário", "Veículos", "Serviços Gerais", "Hospitalar", "Mix/Variedades").
* \`resumo_teaser\`: Copywriting agressivo. Venda a oportunidade sem entregar o ouro. Fale sobre a "falha de mercado" encontrada.
* \`tags_estrategicas\`: Palavras-chave que ativam a ganância (Ex: "Lote Mosaico", "Portal Oculto", "Sem Amostra").
* \`edital_numero\`: O numero do edital ou processo.
* \`municipio_uf\`: Municipio e UF (Ex: São Paulo - SP).
* \`ipm_score\`: O score calculado.
* \`valor_estimado_total\`: Valor total estimado formatado (Ex: R$ 100.000,00) ou "Sigiloso".
* \`classificacao_oportunidade\`: "OCEANO AZUL", "OPORTUNIDADE", "RISCO ALTO".
* \`cor_hex\`: "#D4AF37" (Ouro/Bom), "#C0C0C0" (Prata/Médio), "#CD7F32" (Bronze/Comum).

### 2. LOCKED_CONTENT (Pago - "O Ouro")
A análise técnica completa.

* \`analise_markdown\`: Relatório formatado com detalhes dos pilares do IPM, pontos fortes e fracos.
* \`perfil_vencedor\`: Quem ganha isso? (Ex: "Trader Generalista", "Fabricante Local", "Engenharia de Pequeno Porte").
* \`itens_destaque\`: Array de strings com itens bons.
* \`armadilhas_identificadas\`: Array de strings com riscos.

### 3. ITEMS (Extraction for Sniper)
* \`items\`: An array of objects to populate the bidding grid. Each object must have:
   - "id": Item number.
   - "description": Full description of the item.
   - "valor_venda": Maximum unit price (numeric, no currency symbols). Use 0 if not found.
   - "quantidade": Quantity (numeric). Use 1 if not found.

### EXEMPLO DE OUTPUT:

\`\`\`json
{
  "metadata": {
    "edital_numero": "PE 042/2025",
    "municipio_uf": "São Tomé das Letras - MG",
    "tipo_objeto_principal": "Mix/Variedades (Eletrônicos + Mobiliário)",
    "ipm_score": 92,
    "classificacao_oportunidade": "OCEANO AZUL",
    "cor_hex": "#D4AF37",
    "valor_estimado_total": "R$ 145.000,00",
    "tags_estrategicas": [
      "Lote Mosaico",
      "Alta Barreira Técnica",
      "Cidade Pequena"
    ],
    "resumo_teaser": "Detectamos um 'Lote Mosaico' perfeito em município de difícil acesso logístico. A mistura de Eletrônicos com Mobiliário no mesmo lote elimina 95% dos concorrentes especializados. Margem estimada acima da média."
  },
  "locked_content": {
    "perfil_vencedor": "Empresa Comercial Generalista (Trader) com capacidade logística.",
    "itens_destaque": [
      "Item 01: Smart TV 65 (Alta liquidez)",
      "Item 14: Cadeira Gamer (Item de nicho)"
    ],
    "armadilhas_identificadas": [
      "Exigência de garantia on-site (local)",
      "Prazo de entrega curto (10 dias)"
    ],
    "analise_markdown": "# 🔮 Análise Oráculo | PE 042/2025\\n\\n**IPM SCORE: 92/100**\\n\\n## A OPORTUNIDADE\\nEste edital é um clássico 'Mosaico'..."
  },
  "items": [
      { "id": "1", "description": "Item 1 desc...", "valor_venda": 100.00, "quantidade": 10 }
  ]
}
\`\`\`

        Text to analyze:
        ${combinedText.substring(0, 100000)}
        `;

        // FALLBACK LOGIC
        // Order: gemini-2.5-pro -> deepseek-reasoner -> gemini-2.5-flash -> deepseek-chat
        const models = [
            { provider: 'google', model: 'gemini-2.5-pro' },
            { provider: 'deepseek', model: 'deepseek-reasoner' },
            { provider: 'google', model: 'gemini-2.5-flash' },
            { provider: 'deepseek', model: 'deepseek-chat' }
        ];

        let lastError = null;
        let finalResponse = null;
        let finalThoughts = null;

        for (const config of models) {
            console.log(`[Oracle] Tentando modelo: ${config.model} (${config.provider})...`);
            try {
                if (config.provider === 'google') {
                    const response = await genAI.models.generateContent({
                        model: config.model,
                        contents: promptText,
                        config: {
                            thinkingConfig: { includeThoughts: true }
                        }
                    });

                    // Extract content from Google response
                    let text = "";
                    let thoughts = "";
                    if (response.candidates && response.candidates.length > 0) {
                        const candidate = response.candidates[0];
                        if (candidate.content && candidate.content.parts) {
                            for (const part of candidate.content.parts) {
                                if (part.text) {
                                    if (part.thought) thoughts += part.text + "\n";
                                    else text += part.text;
                                }
                            }
                        }
                    }
                    if (!text) throw new Error("Google API retornou resposta vazia.");
                    finalResponse = text;
                    finalThoughts = thoughts;
                    break; // Success

                } else if (config.provider === 'deepseek') {
                    // Adapt prompt for DeepSeek (Chat format)
                    const messages = [
                        { role: "system", content: "You are a helpful assistant. Return ONLY valid JSON." },
                        { role: "user", content: promptText }
                    ];

                    const result = await callDeepSeek(messages, config.model);
                    if (!result || !result.content) throw new Error("DeepSeek API falhou ou retornou vazio.");

                    finalResponse = result.content;
                    finalThoughts = result.reasoning_content || "";
                    break; // Success
                }

            } catch (e) {
                console.error(`[Oracle] Erro com ${config.model}:`, e.message);
                lastError = e;
                // Only continue if error is 429 (Resource Exhausted) or similar transient error
                // Check if message contains 429 or "RESOURCE_EXHAUSTED" or "quota"
                const isQuotaError = e.message.includes("429") || e.message.includes("RESOURCE_EXHAUSTED") || e.message.includes("quota");

                if (!isQuotaError) {
                    // If it's a logic error (not quota), maybe we should stop?
                    // But user said "Esta lógica deve ser acionada APENAS no caso de erro código 429."
                    // So if it is NOT a quota error, we throw immediately.
                    throw e;
                }
                // If it IS a quota error, continue loop
            }
        }

        if (!finalResponse) {
            throw new Error("Todos os modelos falharam. Último erro: " + (lastError ? lastError.message : "Desconhecido"));
        }

        // --- ROBUST JSON EXTRACTION ---
        // 1. Regex for JSON block
        const jsonMatch = finalResponse.match(/```json([\s\S]*?)```/);
        let jsonString = "";

        if (jsonMatch && jsonMatch[1]) {
            jsonString = jsonMatch[1].trim();
        } else {
            // 2. Fallback: Find { and }
            const start = finalResponse.indexOf('{');
            const end = finalResponse.lastIndexOf('}');
            if (start !== -1 && end !== -1) {
                jsonString = finalResponse.substring(start, end + 1);
            } else {
                jsonString = finalResponse.trim();
            }
        }

        // 3. SANITIZATION (Fix for "Unexpected token c" etc.)
        // Remove potentially dangerous control characters, but keep newlines
        // Sometimes "thoughts" leak into the text without delimiters if the model is bad.
        // We hope the extraction above worked.
        // We can try to strip trailing characters if parsing fails.

        let parsed;
        try {
            parsed = JSON.parse(jsonString);
        } catch (e) {
            console.error("JSON Parse Error (Attempt 1):", e.message);
            // Attempt to clean trailing commas or bad chars?
            // "Unexpected token c" at the end suggests garbage.
            // Try to look for the last '}' again and slice strictly
            const lastBrace = jsonString.lastIndexOf('}');
            if (lastBrace !== -1 && lastBrace < jsonString.length - 1) {
                jsonString = jsonString.substring(0, lastBrace + 1);
                try {
                    parsed = JSON.parse(jsonString);
                } catch (e2) {
                    console.error("JSON Parse Error (Attempt 2):", e2.message);
                    console.error("Raw Text Response:", finalResponse);
                    throw new Error("A I.A. não retornou um JSON válido. Erro: " + e.message);
                }
            } else {
                throw new Error("A I.A. não retornou um JSON válido. Erro: " + e.message);
            }
        }

        // Normalize structure
        if (!parsed.global_info) parsed.global_info = {};
        if (!parsed.metadata) parsed.metadata = {};
        if (!parsed.locked_content) parsed.locked_content = {};
        if (!parsed.items) parsed.items = [];

        // Inject Thoughts
        if (finalThoughts) {
            parsed.locked_content.ai_thoughts = finalThoughts.trim();
            parsed.locked_content.analise_markdown += `\n\n---\n\n### 🧠 Pensamentos da I.A. (Bastidores)\n\n${finalThoughts.trim()}`;
        }

        return {
            metadata: parsed.metadata,
            locked_content: parsed.locked_content,
            items: parsed.items
        };

    } catch (e) {
        console.error("AI TR Processing Failed:", e);
        throw new Error("Falha ao processar PDF com IA: " + e.message);
    }
}

module.exports = { processPDF };
