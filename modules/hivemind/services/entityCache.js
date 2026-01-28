/**
 * Entity Cache Service
 * 
 * Long-term memory for discovered entities.
 * If the system discovers that "Tok Escola III" = "72 músicas",
 * it caches this for future searches.
 */

const { getPool } = require('../../../src/database');
const crypto = require('crypto');

/**
 * Generate a hash for a set of specs/description
 */
function hashSpecs(description) {
    // Normalize: lowercase, remove extra spaces, sort words
    const normalized = description
        .toLowerCase()
        .replace(/[^\w\s]/g, '')
        .split(/\s+/)
        .filter(w => w.length > 2)
        .sort()
        .join(' ');
    
    return crypto
        .createHash('sha256')
        .update(normalized)
        .digest('hex')
        .substring(0, 32);
}

/**
 * Get cached entity for a description
 * @param {string} description - Tender item description
 * @returns {object|null} - Cached entity or null
 */
async function getCachedEntity(description) {
    try {
        const pool = await getPool();
        if (!pool) return null;
        
        const hash = hashSpecs(description);
        
        // Look for cache within last 30 days
        const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000)
            .toISOString()
            .slice(0, 19)
            .replace('T', ' ');
        
        const [rows] = await pool.query(
            `SELECT * FROM entity_cache 
             WHERE specs_hash = ? AND validation_date > ?
             ORDER BY validation_date DESC LIMIT 1`,
            [hash, thirtyDaysAgo]
        );
        
        if (rows && rows.length > 0) {
            console.log(`[EntityCache] Cache HIT for hash ${hash}`);
            return rows[0];
        }
        
        console.log(`[EntityCache] Cache MISS for hash ${hash}`);
        return null;
        
    } catch (err) {
        // Table might not exist yet - that's ok
        if (err.code === 'ER_NO_SUCH_TABLE') {
            console.log('[EntityCache] Table not found - cache disabled');
            return null;
        }
        console.warn(`[EntityCache] Query error: ${err.message}`);
        return null;
    }
}

/**
 * Cache a discovered entity
 * @param {string} description - Original tender description
 * @param {object} entity - Entity to cache
 */
async function cacheEntity(description, entity) {
    try {
        const pool = await getPool();
        if (!pool) return false;
        
        const hash = hashSpecs(description);
        
        await pool.query(
            `INSERT INTO entity_cache 
             (specs_hash, entity_name, manufacturer, model_number, specs_json, search_queries, source_urls)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON DUPLICATE KEY UPDATE
             entity_name = VALUES(entity_name),
             manufacturer = VALUES(manufacturer),
             specs_json = VALUES(specs_json),
             search_queries = VALUES(search_queries),
             validation_date = CURRENT_TIMESTAMP`,
            [
                hash,
                entity.name,
                entity.manufacturer || null,
                entity.model_number || null,
                JSON.stringify(entity.validatedSpecs || {}),
                JSON.stringify(entity.searchQueries || []),
                JSON.stringify([entity.sourceUrl].filter(Boolean))
            ]
        );
        
        console.log(`[EntityCache] Cached entity: ${entity.name}`);
        return true;
        
    } catch (err) {
        console.warn(`[EntityCache] Insert error: ${err.message}`);
        return false;
    }
}

/**
 * Log agent activity
 * @param {string} taskId - Task ID
 * @param {string} itemId - Item ID
 * @param {string} agentName - Agent name (PERITO, DETETIVE, etc)
 * @param {string} action - Action performed
 * @param {object} input - Input data
 * @param {object} output - Output data
 * @param {number} durationMs - Duration in milliseconds
 */
async function logAgentActivity(taskId, itemId, agentName, action, input, output, durationMs) {
    try {
        const pool = await getPool();
        if (!pool) return;
        
        await pool.query(
            `INSERT INTO agent_logs 
             (task_id, item_id, agent_name, action, input_json, output_json, duration_ms)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
            [taskId, itemId, agentName, action, JSON.stringify(input), JSON.stringify(output), durationMs]
        );
        
    } catch (err) {
        // Silently fail - logging is non-critical
        if (err.code !== 'ER_NO_SUCH_TABLE') {
            console.warn(`[EntityCache] Log error: ${err.message}`);
        }
    }
}

module.exports = { getCachedEntity, cacheEntity, logAgentActivity, hashSpecs };
