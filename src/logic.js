function filterAndRank(itemDescription, results, requiredAttributes) {
    // itemDescription: object from parser { original, query, attributes }
    // results: array of scraped items
    
    // 1. Basic Filtering
    // Remove international items if desired (often take too long)
    // Remove items that clearly don't match (simple keyword check)
    
    const candidates = results.filter(item => {
        // Exclude international if needed
        if (item.isInternational) return false;
        
        // Check for essential keywords in title
        const titleLower = item.title.toLowerCase();
        
        // Ensure all significant attributes from the description are present in the title
        // We filter out very short words to avoid false negatives on "de", "com", etc.
        if (requiredAttributes && requiredAttributes.length > 0) {
            const missingAttributes = requiredAttributes.filter(attr => {
                // Ignore small connecting words if they ended up in attributes
                if (attr.length <= 2) return false; 
                return !titleLower.includes(attr);
            });

            // If more than 20% of attributes are missing, discard
            // This is a heuristic. For strict matching, we'd require 0 missing.
            // But search results often vary in wording (e.g. "240gb" vs "240 gb")
            // A safer approach is to check if *most* key terms are there.
            
            // For now, let's enforce that at least 70% of keywords match
            const matchRatio = (requiredAttributes.length - missingAttributes.length) / requiredAttributes.length;
            if (matchRatio < 0.7) {
                return false;
            }
        }
        
        return true;
    });

    // 2. Calculate Total Price
    // Note: 'shippingCost' is not yet in 'results' at this stage usually, 
    // we fetch it for the top candidates only to save bandwidth, 
    // OR we fetched it for all. 
    // The plan says: "For each compatible ad... Calculate freight".
    // So we assume we have the price.
    
    candidates.forEach(item => {
        item.totalPrice = item.price + (item.shippingCost || 0);
    });

    // 3. Rank
    // Sort by Total Price ascending
    candidates.sort((a, b) => a.totalPrice - b.totalPrice);

    // 4. Return top 5
    return candidates.slice(0, 5);
}

module.exports = { filterAndRank };
