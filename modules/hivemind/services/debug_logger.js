/**
 * HIVE-MIND Debug Logger
 * 
 * Comprehensive logging service for debugging AI agent decisions.
 * Creates downloadable .log files with complete reasoning chains.
 * 
 * Features:
 * - Logs AI prompts and raw responses
 * - Logs ProductDNA comparisons
 * - Logs scoring breakdowns
 * - Exports downloadable debug files
 */

const fs = require('fs');
const path = require('path');

class DebugLogger {
    constructor(taskId, itemId) {
        this.taskId = taskId;
        this.itemId = itemId;
        this.entries = [];
        this.startTime = new Date();

        // Create logs directory if it doesn't exist
        this.logsDir = path.join(__dirname, '../../../logs/hivemind');
        if (!fs.existsSync(this.logsDir)) {
            fs.mkdirSync(this.logsDir, { recursive: true });
        }

        this.logFile = path.join(this.logsDir, `task_${taskId}_item_${itemId}_${Date.now()}.log`);

        this._write('='.repeat(60));
        this._write(`HIVE-MIND DEBUG LOG`);
        this._write(`Task ID: ${taskId}`);
        this._write(`Item ID: ${itemId}`);
        this._write(`Started: ${this.startTime.toISOString()}`);
        this._write('='.repeat(60));
        this._write('');
    }

    /**
     * Internal write to both memory and file
     */
    _write(line) {
        const entry = line;
        this.entries.push(entry);

        try {
            fs.appendFileSync(this.logFile, entry + '\n');
        } catch (e) {
            console.error(`[DebugLogger] Failed to write to file: ${e.message}`);
        }
    }

    /**
     * Log a section header
     */
    section(title) {
        this._write('');
        this._write('-'.repeat(50));
        this._write(`[${new Date().toISOString()}] ${title}`);
        this._write('-'.repeat(50));
    }

    /**
     * Log agent input (description, specs, etc.) - FULL content, no truncation
     */
    agentInput(agentName, data) {
        this.section(`${agentName} - INPUT`);

        if (typeof data === 'string') {
            // GOLDEN PATH: Log FULL input, no truncation (user requested)
            this._write(data);
        } else {
            this._write(JSON.stringify(data, null, 2));
        }
    }

    /**
     * Log AI prompt sent - FULL content, no truncation
     */
    aiPrompt(agentName, prompt) {
        this.section(`${agentName} - AI PROMPT SENT`);
        // GOLDEN PATH: Log FULL prompt, no truncation (user requested)
        this._write(prompt);
    }

    /**
     * Log AI raw response
     */
    aiResponse(agentName, response) {
        this.section(`${agentName} - AI RAW RESPONSE`);
        const truncated = response.length > 5000 ? response.substring(0, 5000) + '...[TRUNCATED]' : response;
        this._write(truncated);
    }

    /**
     * Log AI reasoning/thinking (if available)
     */
    aiReasoning(agentName, reasoning) {
        if (!reasoning) return;
        this.section(`${agentName} - AI REASONING`);
        this._write(reasoning);
    }

    /**
     * Log validation results (kill-specs, anchors, etc.)
     */
    validation(agentName, validations) {
        this.section(`${agentName} - VALIDATION`);

        for (const v of validations) {
            const icon = v.valid ? '✓' : '✗';
            this._write(`${icon} ${v.field}: ${v.value} → ${v.result || (v.valid ? 'OK' : 'REJECTED')}`);
            if (v.reason) {
                this._write(`  Reason: ${v.reason}`);
            }
        }
    }

    /**
     * Log parsed output from an agent
     */
    agentOutput(agentName, data) {
        this.section(`${agentName} - OUTPUT`);
        this._write(JSON.stringify(data, null, 2));
    }

    /**
     * Log candidate ProductDNA for comparison
     */
    candidateDNA(index, title, productDNA) {
        this.section(`CANDIDATE ${index}: ${title.substring(0, 60)}...`);

        if (!productDNA) {
            this._write('⚠ NO ProductDNA AVAILABLE');
            return;
        }

        this._write(`Title: ${productDNA.title || 'N/A'}`);
        this._write(`Specs Text: ${(productDNA.specsText || '').substring(0, 500)}`);
        this._write(`Full Text Length: ${(productDNA.fullText || '').length} chars`);
        this._write('');
        this._write('Full Text Sample (first 1000 chars):');
        this._write((productDNA.fullText || '').substring(0, 1000));
    }

    /**
     * Log spec matching attempts
     */
    specMatching(candidateIndex, spec, found, context = null) {
        const icon = found ? '✓' : '✗';
        let line = `  ${icon} Searching "${spec}" → ${found ? 'FOUND' : 'NOT FOUND'}`;
        if (context) {
            line += ` (context: "${context.substring(0, 50)}...")`;
        }
        this._write(line);
    }

    /**
     * Log kill-word detection
     */
    killWordCheck(candidateIndex, killWord, found) {
        if (found) {
            this._write(`  ⛔ KILL-WORD "${killWord}" DETECTED → CANDIDATE REJECTED`);
        }
    }

    /**
     * Log scoring breakdown
     */
    scoringBreakdown(candidateIndex, breakdown) {
        this.section(`CANDIDATE ${candidateIndex} - SCORING`);

        for (const item of breakdown) {
            this._write(`  ${item}`);
        }
    }

    /**
     * Log final ranking
     */
    finalRanking(candidates) {
        this.section('FINAL RANKING');

        this._write('Rank | Risk  | Score | Price     | Title');
        this._write('-'.repeat(70));

        candidates.forEach((c, i) => {
            const risk = (c.risk_score || 10).toFixed(1).padStart(4);
            const score = String(c.adherenceScore || 0).padStart(5);
            const price = `R$ ${(c.price || 0).toFixed(2)}`.padStart(10);
            const title = (c.title || '').substring(0, 35);
            this._write(`${String(i + 1).padStart(4)} | ${risk} | ${score} | ${price} | ${title}...`);
        });
    }

    /**
     * Log winner selection
     */
    winner(candidate, reason) {
        this.section('WINNER SELECTED');
        this._write(`Title: ${candidate.title}`);
        this._write(`Price: R$ ${candidate.price}`);
        this._write(`Risk Score: ${candidate.risk_score}`);
        this._write(`Adherence Score: ${candidate.adherenceScore}`);
        this._write(`Link: ${candidate.link}`);
        this._write('');
        this._write(`Reason: ${reason}`);
    }

    /**
     * Log an error
     */
    error(agentName, errorMessage, stack = null) {
        this.section(`${agentName} - ERROR`);
        this._write(`Error: ${errorMessage}`);
        if (stack) {
            this._write('Stack Trace:');
            this._write(stack);
        }
    }

    /**
     * Log original description for reference
     */
    originalDescription(description) {
        this.section('ORIGINAL TENDER DESCRIPTION');
        this._write(description);
    }

    /**
     * Log specs extracted directly from description (for validation)
     */
    extractedSpecs(specs) {
        this.section('SPECS EXTRACTED FROM ORIGINAL DESCRIPTION');
        for (const spec of specs) {
            this._write(`  • ${spec}`);
        }
    }

    /**
     * Finalize and return log file path
     */
    finalize() {
        const endTime = new Date();
        const duration = (endTime - this.startTime) / 1000;

        this._write('');
        this._write('='.repeat(60));
        this._write(`END OF DEBUG LOG`);
        this._write(`Finished: ${endTime.toISOString()}`);
        this._write(`Duration: ${duration.toFixed(2)} seconds`);
        this._write(`Log File: ${this.logFile}`);
        this._write('='.repeat(60));

        console.log(`[DebugLogger] Log saved to: ${this.logFile}`);

        return this.logFile;
    }

    /**
     * Get all entries as string
     */
    toString() {
        return this.entries.join('\n');
    }

    // ============================================
    // GOLDEN PATH: Enhanced Debug Methods
    // ============================================

    /**
     * Log AI call details with full tracing (Raio-X)
     */
    aiCallDetails(agentName, details) {
        this.section(`${agentName} - AI CALL DETAILS (RAIO-X)`);
        this._write(`Provider: ${details.provider || 'N/A'}`);
        this._write(`Model: ${details.model || 'N/A'}`);
        this._write(`Endpoint: ${details.endpoint || 'N/A'}`);
        if (details.apiKeyLast4) {
            this._write(`API Key (últimos 4 chars): ...${details.apiKeyLast4}`);
        }
        this._write(`Tokens estimados: ${details.estimatedTokens || 'N/A'}`);
        this._write(`Latência: ${details.latencyMs ? details.latencyMs + 'ms' : 'N/A'}`);
    }

    /**
     * Log enrichment attempt and result
     */
    enrichmentResult(candidateIndex, productTitle, source, specs, confidence) {
        this.section(`CANDIDATE ${candidateIndex} - ENRICHMENT RESULT`);
        this._write(`Product: ${productTitle.substring(0, 50)}...`);
        this._write(`Source: ${source}`);
        this._write(`Confidence: ${(confidence * 100).toFixed(0)}%`);
        this._write('Specs verified:');
        for (const [spec, value] of Object.entries(specs)) {
            const icon = value === true ? '✓' : value === false ? '✗' : '?';
            this._write(`  ${icon} ${spec}: ${typeof value === 'boolean' ? (value ? 'CONFIRMED' : 'DENIED') : 'UNKNOWN'}`);
        }
    }

    /**
     * Log search strategy progression
     */
    strategyProgression(strategies, successfulStrategy, candidatesPerStrategy) {
        this.section('SEARCH STRATEGY PROGRESSION');
        this._write('');

        for (let i = 0; i < strategies.length; i++) {
            const s = strategies[i];
            const count = candidatesPerStrategy?.[s.type] || 0;
            const isSuccessful = successfulStrategy && s.type === successfulStrategy.type;
            const isTried = candidatesPerStrategy && s.type in candidatesPerStrategy;

            let icon;
            if (isSuccessful) {
                icon = '✓';
            } else if (isTried) {
                icon = '○';
            } else {
                icon = '·';
            }

            this._write(`${icon} [${i + 1}] ${s.type}: "${s.query}" → ${count} candidates`);
            if (s.description) {
                this._write(`      ${s.description}`);
            }
        }
    }

    /**
     * Log a decision point with reasoning
     */
    decisionPoint(agentName, decision, reason, alternatives = []) {
        this.section(`${agentName} - DECISION POINT`);
        this._write(`Decision: ${decision}`);
        this._write(`Reason: ${reason}`);
        if (alternatives.length > 0) {
            this._write('Alternatives considered:');
            alternatives.forEach((alt, i) => {
                this._write(`  ${i + 1}. ${alt}`);
            });
        }
    }
}

/**
 * Extract numeric specs directly from description text
 * This is used as a ground-truth reference for validation
 */
function extractSpecsFromDescription(description) {
    const specs = [];

    // Patterns for numeric specs
    const patterns = [
        { regex: /(\d+)\s*músicas?/gi, format: (m) => `${m[1]} músicas` },
        { regex: /(\d+)\s*anos?(?:\s+de\s+garantia)?/gi, format: (m) => `${m[1]} ano${m[1] > 1 ? 's' : ''}` },
        { regex: /(\d+)\s*programaç(?:ão|ões)/gi, format: (m) => `${m[1]} programações` },
        { regex: /(\d+)\s*níveis?\s+de\s+volume/gi, format: (m) => `${m[1]} níveis de volume` },
        { regex: /(\d+)\s*horários?/gi, format: (m) => `${m[1]} horários` },
        { regex: /(\d+)\s*cornetas?/gi, format: (m) => `${m[1]} cornetas` },
        { regex: /(\d+)\s*litros?/gi, format: (m) => `${m[1]} litros` },
        { regex: /(\d+)\s*polegadas?/gi, format: (m) => `${m[1]} polegadas` },
        { regex: /(\d+)\s*lumens?/gi, format: (m) => `${m[1]} lumens` },
        { regex: /(\d+)\s*gb/gi, format: (m) => `${m[1]}GB` },
        { regex: /(\d+)\s*mb/gi, format: (m) => `${m[1]}MB` },
        { regex: /(\d+)\s*watts?/gi, format: (m) => `${m[1]}W` },
        { regex: /usb/gi, format: () => 'USB' },
        { regex: /cartão\s+sd/gi, format: () => 'cartão SD' },
        { regex: /bateria\s+(?:de\s+)?contingência/gi, format: () => 'bateria de contingência' },
        { regex: /display\s+led/gi, format: () => 'display LED' },
        { regex: /bivolt/gi, format: () => 'bivolt' },
    ];

    for (const pattern of patterns) {
        let match;
        const regex = new RegExp(pattern.regex);
        while ((match = regex.exec(description)) !== null) {
            const spec = pattern.format(match);
            if (!specs.includes(spec.toLowerCase())) {
                specs.push(spec.toLowerCase());
            }
        }
    }

    return specs;
}

/**
 * Validate a kill-spec is not abbreviated
 * Returns { valid, reason, corrected }
 */
function validateKillSpec(spec, originalDescription) {
    if (!spec || typeof spec !== 'string') {
        return { valid: false, reason: 'Empty or invalid spec' };
    }

    const clean = spec.trim();

    // Check for abbreviated patterns like "72 m", "1 a", "500 g"
    if (/^\d+\s*[a-záéíóú]{1,2}$/i.test(clean)) {
        // Try to find the full version in the original description
        const numberMatch = clean.match(/(\d+)/);
        if (numberMatch) {
            const number = numberMatch[1];
            // Look for this number followed by a full word in the description
            const fullPattern = new RegExp(`${number}\\s*([a-záéíóúàâãêô]{3,})`, 'gi');
            const fullMatch = fullPattern.exec(originalDescription);

            if (fullMatch) {
                const corrected = `${number} ${fullMatch[1].toLowerCase()}`;
                return {
                    valid: false,
                    reason: `Abbreviated spec detected: "${clean}"`,
                    corrected
                };
            }
        }

        return { valid: false, reason: `Abbreviated spec: "${clean}" (too short)` };
    }

    // Check minimum length
    if (clean.length < 3) {
        return { valid: false, reason: `Spec too short: "${clean}"` };
    }

    return { valid: true };
}

module.exports = {
    DebugLogger,
    extractSpecsFromDescription,
    validateKillSpec
};
