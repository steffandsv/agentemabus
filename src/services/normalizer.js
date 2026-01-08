
const unitMultipliers = {
    'kg': 1000, 'g': 1, 'gramas': 1,
    'l': 1000, 'ml': 1, 'litros': 1000,
    'cv': 735.5, 'hp': 745.7, 'w': 1, 'kw': 1000,
    'm': 100, 'cm': 1, 'mm': 0.1,
    'pol': 2.54, 'inch': 2.54, '"': 2.54
};

function normalizeUnit(value) {
    if (typeof value !== 'string') return value;
    value = value.toLowerCase().trim();

    // Extract number and unit
    const match = value.match(/^([\d.,]+)\s*([a-z"']+)$/);
    if (!match) return value;

    let num = parseFloat(match[1].replace(',', '.'));
    const unit = match[2];

    if (unitMultipliers[unit]) {
        return num * unitMultipliers[unit]; // Convert to base unit
    }
    return value;
}

function cleanKey(key) {
    key = key.toLowerCase().trim();
    const map = {
        'tensão': 'voltage', 'voltagem': 'voltage', 'alimentação': 'voltage',
        'peso': 'weight', 'massa': 'weight',
        'potência': 'power', 'potencia': 'power',
        'dimensões': 'dimensions', 'medidas': 'dimensions',
        'cor': 'color',
        'material': 'material'
    };
    return map[key] || key;
}

function checkHardExclusions(tenderItem, candidateItem) {
    const reasons = [];
    const tenderDesc = (tenderItem.description || "").toLowerCase();
    const itemTitle = (candidateItem.title || "").toLowerCase();
    const itemCondition = (candidateItem.condition || "").toLowerCase();

    // 1. Condition Check
    // If tender strictly says "novo" (usually implied but if explicit)
    // Or if we default to new unless specified.
    // The previous test failed because tenderDesc "Parafusadeira 220V nova" contains "nova".
    // But `itemCondition` "Used" should match.
    // Ah, `itemCondition` was "Used" in test. `toLowerCase()` makes it "used".
    // "used" includes "used".
    // Why did it return excluded: false?
    // Maybe `tenderDesc.includes("novo")` is failing? "nova" vs "novo".
    if ((tenderDesc.includes("novo") || tenderDesc.includes("nova") || tenderDesc.includes("lacrado")) &&
        (itemCondition.includes("usado") || itemCondition.includes("recondicionado") || itemCondition.includes("used") || itemCondition.includes("seminovo"))) {
        return { excluded: true, reason: "Item is used/reconditioned, tender requires new." };
    }

    // 2. Voltage Check
    // Handle "Bivolt" (accepts anything) or specific voltages
    const isBivolt = (text) => text.toLowerCase().includes('bivolt') || text.includes('100v-240v') || text.includes('110v-220v');

    const tenderVoltage = tenderDesc.match(/\b(110|220|127)\s*[vV]/);
    const itemVoltage = itemTitle.match(/\b(110|220|127)\s*[vV]/);

    const tenderIsBivolt = isBivolt(tenderDesc);
    const itemIsBivolt = isBivolt(itemTitle);

    // If Item is Bivolt, it fits any Tender voltage requirement.
    if (itemIsBivolt) {
        return { excluded: false };
    }

    // If Tender is Bivolt, Item MUST be Bivolt (usually).
    // Or does "Tender Bivolt" mean "I can accept either"? Usually means "I need a device that works on both".
    // So if Tender=Bivolt and Item=220V, it's a mismatch (item won't work in 110V area).
    if (tenderIsBivolt && !itemIsBivolt) {
        return { excluded: true, reason: "Tender requires Bivolt, item is specific voltage." };
    }

    // Normalize 127 to 110 for comparison
    const normVolt = (v) => (v === '127' ? '110' : v);

    if (tenderVoltage && itemVoltage) {
        const tV = normVolt(tenderVoltage[1]);
        const iV = normVolt(itemVoltage[1]);
        if (tV !== iV) {
             return { excluded: true, reason: `Voltage mismatch: Tender ${tV}V vs Item ${iV}V` };
        }
    }

    // 3. Price Check (Soft flag)
    // Assuming tenderItem might have an estimated price or we use the max_price as a proxy,
    // but the prompt said "average estimated". Since we don't have average here easily,
    // we might skip or use max_price if available.
    // Logic says: "Se Preço < 10% da média estimada".
    // We'll skip this here as it requires context of other items or historical data.

    return { excluded: false };
}

module.exports = {
    normalizeUnit,
    cleanKey,
    checkHardExclusions
};
