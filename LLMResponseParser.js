/*
 * LLMResponseParser.js
 * ---------------------------------------------------------------------------
 * Every tracker (Scene, World's 4 tiers, Relationship) asks its model for
 * strict JSON back, and every one of them has to defend against the same
 * things going wrong: a stray markdown fence, a reasoning/CoT block the
 * model wasn't supposed to include, or trailing prose after an otherwise
 * clean object. This was duplicated as free functions sitting outside any
 * module in index.js — moved here since it's genuinely pure (string in,
 * data out, no ST/chat/storage dependency) and every *Agent module's raw
 * response needs to pass through it before validation.
 * ---------------------------------------------------------------------------
 */

/**
 * cleanAndParseJSON(rawStr)
 * Strips common CoT/thought-tag wrappers and markdown code fences, then parses.
 * Falls back to extractFirstBalancedObject() if a direct parse fails (handles
 * trailing prose after the JSON, or extra text before it). Returns null (never
 * throws) if nothing parseable is found.
 */
export function cleanAndParseJSON(rawStr) {
    if (!rawStr || typeof rawStr !== "string") return null;
    var str = rawStr.trim();

    // Remove custom CoT structures (e.g. <|channel>thought ... <channel|>)
    str = str.replace(/<\|channel>thought[\s\S]*?<channel\|>/gi, "");
    str = str.replace(/<channel[\s\S]*?channel>/gi, "");
    str = str.replace(/<[^>]+thought[\s\S]*?>[\s\S]*?<\/[^>]+>/gi, "");

    // Strip standard markdown blocks
    str = str.replace(/```json\s*([\s\S]*?)\s*```/gi, "$1");
    str = str.replace(/```\s*([\s\S]*?)\s*```/gi, "$1");

    try {
        return JSON.parse(str.trim());
    } catch (e) {
        // Fall back to extracting the first BALANCED {...} object rather than a naive
        // first-'{'-to-last-'}' greedy match — the old regex swallowed any trailing
        // text after valid JSON that happened to contain its own stray '}' (a
        // footnote, an aside, a second malformed object), which made an otherwise
        // clean response fail to parse.
        var extracted = extractFirstBalancedObject(str);
        if (extracted) {
            try {
                return JSON.parse(extracted);
            } catch (ex) {
                return null;
            }
        }
    }
    return null;
}

/**
 * extractFirstBalancedObject(str)
 * Scans for the first top-level '{' and returns the substring up to its matching
 * '}', tracking brace depth while respecting string literals/escapes so braces
 * inside quoted JSON string values don't throw off the count. Returns null if no
 * balanced object is found (e.g. a truncated response).
 */
export function extractFirstBalancedObject(str) {
    var start = str.indexOf("{");
    if (start === -1) return null;
    var depth = 0, inString = false, escape = false;
    for (var i = start; i < str.length; i++) {
        var ch = str[i];
        if (inString) {
            if (escape) { escape = false; }
            else if (ch === "\\") { escape = true; }
            else if (ch === '"') { inString = false; }
            continue;
        }
        if (ch === '"') { inString = true; continue; }
        if (ch === "{") { depth++; }
        else if (ch === "}") {
            depth--;
            if (depth === 0) return str.slice(start, i + 1);
        }
    }
    return null; // never closed — unbalanced/truncated response
}
