// Basic parser to extract attributes from description
// In a real scenario, this could use NLP or more complex Regex

function parseDescription(description) {
    const keywords = [];
    const normalized = description.toLowerCase();
    
    // Extract potential attributes (just a simple tokenizer for now)
    // We remove common stop words if necessary, but for now we keep it simple
    // splitting by space
    const tokens = normalized.split(/\s+/);
    
    // Simple logic: pass the whole description as the search query
    // and use tokens as "required attributes" for scoring/filtering later
    
    return {
        original: description,
        query: description, // Use the full description for search
        attributes: tokens.filter(t => t.length > 1) // Filter out single chars
    };
}

module.exports = { parseDescription };
