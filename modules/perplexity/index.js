const { askPerplexity } = require('./client');
const { scrapeGeneric } = require('./scraper');
const { callDeepSeek } = require('../../src/services/deepseek');
const { initBrowser } = require('../gemini_meli/scraper');
const { validateBatchWithDeepSeek, selectBestCandidate } = require('../gemini_meli/ai');

// Extract JSON from markdown code block or raw string
function extractJson(text) {
    if (!text) return [];
    const jsonMatch = text.match(/```json\s*([\s\S]*?)\s*```/);
    if (jsonMatch) return JSON.parse(jsonMatch[1]);
    const start = text.indexOf('[');
    const end = text.lastIndexOf(']');
    if (start !== -1 && end !== -1) {
         try {
             return JSON.parse(text.substring(start, end + 1));
         } catch (e) {
             return [];
         }
    }
    return [];
}

async function execute(job, dependencies) {
    const { id, description, maxPrice, quantity, browser, logger } = job;
    let page = null;

    try {
        // Construct the initial aggressive prompt
        const initialPrompt = `
Encontre na internet o produto MAIS BARATO POSSÍVEL que case com TODAS essas especificações MÍNIMAS: "${description}".
Quero o LINK DE COMPRA DIRETO e não uma busca genérica.
Realize você mesmo a busca, compare e me traga os melhores.
O preço máximo aceitável é R$ ${maxPrice}.
Retorne APENAS um JSON array com objetos: { "title": "...", "price": 123.45, "link": "...", "source": "Store Name" }.
Certifique-se que o link leva diretamente ao produto.
`.trim();

        let messages = [
            { role: 'system', content: 'You are a helpful shopping assistant. You MUST provide DIRECT PRODUCT LINKS. Search thoroughly. Return ONLY JSON.' },
            { role: 'user', content: initialPrompt }
        ];

        let bestCandidates = [];
        let attempts = 0;
        const maxAttempts = 3;

        while (attempts < maxAttempts) {
            attempts++;
            logger.log(`🤖 [Item ${id}] Perplexity: Tentativa ${attempts}/${maxAttempts}...`);
            logger.thought(id, 'discovery', `Perplexity Search Attempt ${attempts}`);

            const perplexityRaw = await askPerplexity(messages);
            if (!perplexityRaw) {
                logger.log(`⚠️ [Item ${id}] Perplexity não retornou nada.`);
                break;
            }

            // Append assistant response to history
            messages.push({ role: 'assistant', content: perplexityRaw });

            let candidates = [];
            try {
                candidates = extractJson(perplexityRaw);
            } catch (e) {
                logger.log(`⚠️ [Item ${id}] Falha ao ler JSON do Perplexity.`);
            }

            logger.log(`🔍 [Item ${id}] Encontrados ${candidates.length} links.`);

            if (candidates.length === 0) {
                // If no candidates, ask why or retry with softer constraints?
                // For now, break or simple retry.
                 messages.push({ role: 'user', content: "Você não retornou nenhum candidato válido no formato JSON. Tente novamente, encontrando produtos similares." });
                 continue;
            }

            // Scrape & Validate
            page = await browser.newPage();
            const currentBatchValid = [];
            const rejectionReasons = [];

            for (const cand of candidates) {
                if (!cand.link) continue;

                logger.log(`📡 [Item ${id}] Acessando: ${cand.link}`);
                const scraped = await scrapeGeneric(page, cand.link);

                // Update candidate with scraped data
                cand.description = scraped.description || scraped.text; // Prefer combined desc
                cand.attributes = {};
                if (!cand.price && scraped.price) cand.price = scraped.price;
                cand.totalPrice = cand.price;

                // Validate
                const batchResult = await validateBatchWithDeepSeek(description, [cand]);
                const res = batchResult[0] || { status: 'Erro', risk_score: 10, reasoning: "Validation Error" };

                cand.risk_score = res.risk_score;
                cand.aiReasoning = res.reasoning;
                cand.brand_model = res.brand_model;

                logger.thought(id, 'validation', {
                    title: cand.title,
                    risk: cand.risk_score,
                    reasoning: cand.aiReasoning,
                    link: cand.link
                });

                if (cand.risk_score < 8) { // Good candidate threshold
                    currentBatchValid.push(cand);
                } else {
                    rejectionReasons.push(`- Link: ${cand.link}\n  Reason: ${cand.aiReasoning}`);
                }
            }

            await page.close();
            page = null;

            if (currentBatchValid.length > 0) {
                // We found at least one good candidate!
                // We can add them to our bestCandidates pile.
                bestCandidates = bestCandidates.concat(currentBatchValid);

                // If we have enough good candidates, we can stop early, or verify if we want to beat the price.
                // The user said "MAIS BARATO POSSÍVEL".
                // If we found a match, maybe we are happy.
                // Let's assume if we have a low risk candidate, we are good.
                logger.log(`✅ [Item ${id}] Encontrados ${currentBatchValid.length} candidatos válidos nesta rodada.`);
                break;
            } else {
                // All rejected. Feedback loop.
                logger.log(`❌ [Item ${id}] Todos os candidatos foram rejeitados. Enviando feedback ao Perplexity...`);

                const feedbackMsg = `
Os produtos sugeridos foram REJEITADOS pelo validador.
Motivos:
${rejectionReasons.join('\n')}

Por favor, procure novamente. Encontre produtos que atendam EXATAMENTE a descrição: "${description}".
Certifique-se das especificações.
Tente outras lojas se necessário.
`.trim();

                messages.push({ role: 'user', content: feedbackMsg });
                // Loop continues
            }
        }

        // Final Selection
        // Use bestCandidates found across loops (though currently we break on first success)
        // If loop finished without success, bestCandidates is empty.

        if (bestCandidates.length === 0) {
             logger.log(`😞 [Item ${id}] Nenhum candidato válido encontrado após ${attempts} tentativas.`);
             return { id, description, valor_venda: maxPrice, quantidade: quantity, offers: [], winnerIndex: -1 };
        }

        const viable = bestCandidates.filter(c => c.risk_score < 10);
        let winnerIndex = -1;
        if (viable.length > 0) {
             const selectionResult = await selectBestCandidate(description, viable, maxPrice, quantity);
             logger.thought(id, 'selection', selectionResult);

             // Map back to original index in the final list
             // Note: viable is a subset. We need to find the winner in bestCandidates.
             const winnerObj = viable[selectionResult.winner_index];
             // selectBestCandidate returns index relative to 'viable' array passed to it.

             if (winnerObj) {
                 winnerIndex = bestCandidates.indexOf(winnerObj);
                 logger.log(`🏆 [Item ${id}] VENCEDOR: ${winnerObj.title}`);
             }
        }

        return { id, description, valor_venda: maxPrice, quantidade: quantity, offers: bestCandidates, winnerIndex };

    } catch (e) {
        logger.log(`💥 [Item ${id}] Erro Perplexity: ${e.message}`);
        console.error(e);
        return { id, description, offers: [] };
    } finally {
        if (page) await page.close();
    }
}

async function setCEP(page, cep) {
    // Optional implementation
    return;
}

module.exports = { execute, initBrowser, setCEP };
