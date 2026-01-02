const fs = require('fs');
const pdf = require('pdf-parse');
const { generateStream, PROVIDERS } = require('./ai_manager');
const { getSetting } = require('../database');

async function processPDF(filePaths, onThought = null) {
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
        // Explicitly asking for thoughts in **Title** format.
        const promptText = `
# SYSTEM PROMPT: ORÁCULO ESTRATÉGICO UNIVERSAL (v3.0)

Você é o ORÁCULO DE LICITAÇÕES, a I.A. mais sofisticada do mercado para análise de compras governamentais.
Sua missão é ler editais brutos e transformá-los em **Inteligência de Mercado**, identificando oportunidades de alto lucro e baixa concorrência ("Oceano Azul").

---

## 🧠 PROCESSO DE PENSAMENTO (IMPORTANTE)

Como você é um modelo de Raciocínio (DeepSeek Reasoner), você deve estruturar seus pensamentos.
**A CADA NOVA ETAPA DO SEU RACIOCÍNIO, VOCÊ DEVE INICIAR COM UM TÍTULO ENTRE DOIS ASTERISCOS.**
Exemplo:
**Lendo o Edital**
(Conteúdo do pensamento...)
**Analisando Itens**
(Conteúdo...)
**Calculando IPM**
(Conteúdo...)

Isso é fundamental para que o sistema mostre ao usuário o que você está fazendo.

---

## 📐 O ALGORITMO: IPM v3.0 (Índice de Potencial de Mercado)

**CALCULE A PONTUAÇÃO (0-100) BASEADA NESTES 7 PILARES:**
1. **Geopolítica (Pcidade) [Peso 2.0]:** Pequena/Isolada (10) -> Capital (0).
2. **Obscuridade do Portal (Pportal) [Peso 2.5]:** Próprio/Desconhecido (10) -> Compras.gov (0).
3. **Complexidade (Pcomplexidade) [Peso 2.0]:** Lote Mosaico/Híbrido (10) -> Commodity Pura (0).
4. **Barreiras (Pbarreiras) [Peso 1.5]:** Amostra/Vistoria/ISO (10) -> Documentação Padrão (0).
5. **Atratividade ($) (Pvalor) [Peso 1.0]:** 80k-300k (8) -> >1M (0).
6. **Volume (Pvolume) [Peso 0.5]:** >50 Itens (10) -> Item único (0).
7. **Urgência (Ptempo) [Peso 0.5]:** Dispensa/Emergência (10) -> Registro Preço 12m (0).

**FÓRMULA:**
\`IPM = (Pcidade * 2.0) + (Pportal * 2.5) + (Pcomplexidade * 2.0) + (Pbarreiras * 1.5) + (Pvalor * 1.0) + (Pvolume * 0.5) + (Ptempo * 0.5)\`

---

## 📤 FORMATO DE SAÍDA (JSON ESTRITO)

Retorne APENAS um JSON válido.

### 1. METADATA (Card de Oportunidade)
* \`tipo_objeto_principal\`: Categoria macro (Ex: "Informática", "Obras").
* \`resumo_teaser\`: Copywriting agressivo sobre a "falha de mercado".
* \`tags_estrategicas\`: Array de strings (Ex: "Portal Oculto", "Sem Amostra").
* \`edital_numero\`: Número do processo.
* \`municipio_uf\`: Cidade - UF.
* \`ipm_score\`: Score calculado (Número).
* \`valor_estimado_total\`: String formatada (Ex: R$ 100.000,00).
* \`classificacao_oportunidade\`: "OCEANO AZUL", "OPORTUNIDADE", "RISCO ALTO".
* \`cor_hex\`: "#D4AF37" (Ouro), "#C0C0C0" (Prata), "#CD7F32" (Bronze).

### 2. LOCKED_CONTENT (Análise Detalhada)
* \`analise_markdown\`: Relatório técnico completo formatado em Markdown.
* \`perfil_vencedor\`: Quem ganha?
* \`itens_destaque\`: Array de strings com os melhores itens.
* \`armadilhas_identificadas\`: Array de strings com riscos.

### 3. ITEMS (Lista de Itens)
* \`items\`: Array de objetos.
   - "id": ID do item.
   - "description": Descrição completa.
   - "valor_venda": Preço máximo unitário (number). Use 0 se não achar.
   - "quantidade": Quantidade (number). Use 1 se não achar.
   *NOTA:* Se a lista for muito extensa (> 50 itens), priorize os itens de maior valor ou resuma os principais, mas tente extrair todos se possível.

### TEXTO PARA ANÁLISE:
${combinedText.substring(0, 100000)}
`;

        // 1. Load Settings
        const provider = await getSetting('oracle_provider') || PROVIDERS.DEEPSEEK;
        const model = await getSetting('oracle_model') || 'deepseek-reasoner';
        const apiKey = await getSetting('oracle_api_key') || process.env[`${provider.toUpperCase()}_API_KEY`] || process.env.DEEPSEEK_API_KEY;

        console.log(`[Oracle] Iniciando com ${provider} (${model})...`);

        const messages = [
            { role: "system", content: "You are a helpful assistant. Return ONLY valid JSON." },
            { role: "user", content: promptText }
        ];

        // Thought Buffer to detect titles
        let thoughtBuffer = "";
        let finalResponse = "";
        let finalThoughts = "";

        await new Promise((resolve, reject) => {
            generateStream(
                { provider, model, apiKey, messages },
                {
                    onThought: (chunk) => {
                        thoughtBuffer += chunk;
                        finalThoughts += chunk;

                        // Check for **Title** pattern
                        const matches = thoughtBuffer.match(/\*\*(.*?)\*\*/g);
                        if (matches && matches.length > 0) {
                            const lastTitle = matches[matches.length - 1].replace(/\*\*/g, '').trim();
                            if (onThought) onThought(lastTitle);
                        }
                    },
                    onChunk: (chunk) => {
                        finalResponse += chunk;
                    },
                    onDone: () => resolve(),
                    onError: (err) => reject(err)
                }
            );
        });

        if (!finalResponse) throw new Error("API falhou ou retornou vazio.");

        // --- JSON EXTRACTION & CLEANUP ---
        const jsonMatch = finalResponse.match(/```json([\s\S]*?)```/);
        let jsonString = "";

        if (jsonMatch && jsonMatch[1]) {
            jsonString = jsonMatch[1].trim();
        } else {
            const start = finalResponse.indexOf('{');
            const end = finalResponse.lastIndexOf('}');
            if (start !== -1 && end !== -1) {
                jsonString = finalResponse.substring(start, end + 1);
            } else {
                jsonString = finalResponse.trim();
            }
        }

        let parsed;
        try {
            parsed = JSON.parse(jsonString);
        } catch (e) {
            console.error("JSON Parse Error:", e.message);
            // Simple repair for common trailing comma issues or markdown noise could go here
             // Try to find the last '}' again and slice strictly in case of garbage at end
            const lastBrace = jsonString.lastIndexOf('}');
            if (lastBrace !== -1 && lastBrace < jsonString.length - 1) {
                jsonString = jsonString.substring(0, lastBrace + 1);
                try {
                    parsed = JSON.parse(jsonString);
                } catch (e2) {
                     throw new Error("A I.A. não retornou um JSON válido. Erro: " + e.message);
                }
            } else {
                throw new Error("A I.A. não retornou um JSON válido. Erro: " + e.message);
            }
        }

        // Normalize
        if (!parsed.metadata) parsed.metadata = {};
        if (!parsed.locked_content) parsed.locked_content = {};
        if (!parsed.items) parsed.items = [];

        // Save thoughts to locked content (but we won't show it in UI as per request, just store it)
        parsed.locked_content.ai_thoughts = finalThoughts;

        return {
            metadata: parsed.metadata,
            locked_content: parsed.locked_content,
            items: parsed.items
        };

    } catch (e) {
        console.error("Oracle Processing Failed:", e);
        throw e;
    }
}

module.exports = { processPDF };
