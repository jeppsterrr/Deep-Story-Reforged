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
 *
 * WHY THE REPAIR LADDER: strict JSON.parse alone fails intermittently on
 * real model output, and this extension's payloads are unusually prone to it
 * — the tracker prompts ask for narrative summaries (recent_events, NPC
 * changes, relationship notes), so the string VALUES routinely contain
 * dialogue quotes and line breaks. The three dominant real-world failures:
 *
 *   1. Unescaped inner quotes:  "recent_events": "He shouted "run!" and fled"
 *   2. Raw control chars in strings (a literal newline inside a summary)
 *   3. Trailing commas before } or ]
 *
 * ...plus truncated output when a response hits the token ceiling. None of
 * those are recoverable by JSON.parse, but all are mechanically repairable,
 * so cleanAndParseJSON() now escalates through progressively more aggressive
 * strategies instead of giving up after the first failure. Already-valid JSON
 * still parses on the very first attempt — the repair work only runs on the
 * failure path, so the common case costs nothing.
 * ---------------------------------------------------------------------------
 */

/**
 * cleanAndParseJSON(rawStr)
 *
 * Escalating ladder — the first strategy that yields valid JSON wins:
 *   1. strip CoT/reasoning wrappers + markdown fences, parse as-is
 *   2. parse each balanced {...} candidate in order (handles prose around it,
 *      and reasoning text that itself contains braces)
 *   3. repair common LLM JSON damage (see repairLooseJson), then retry 1 & 2
 *   4. salvage a truncated response by closing what's still open
 * Returns null (never throws) if nothing parseable is found, and logs a short
 * diagnostic preview so an intermittent failure is actually debuggable.
 */
export function cleanAndParseJSON(rawStr) {
    if (!rawStr || typeof rawStr !== "string") return null;

    var cleaned = stripWrappers(rawStr);
    var parsed = tryParseCandidates(cleaned);
    if (parsed !== undefined) return parsed;

    // Repair pass — fixes unescaped inner quotes, raw control characters inside
    // strings, invalid backslash escapes, and trailing commas.
    var repaired = repairLooseJson(cleaned);
    if (repaired !== cleaned) {
        parsed = tryParseCandidates(repaired);
        if (parsed !== undefined) return parsed;
    }

    // Truncated (hit the token ceiling mid-object): close what's still open.
    parsed = tryParseTruncated(repaired);
    if (parsed !== undefined) return parsed;

    try {
        console.warn(
            "[Story Tracker] Could not parse the model's JSON response after cleanup, repair, and truncation salvage. " +
            "Length: " + rawStr.length + " chars. First 300:\n" + rawStr.slice(0, 300) +
            (rawStr.length > 300 ? "\n…\nLast 200:\n" + rawStr.slice(-200) : "")
        );
    } catch (e) { /* logging must never break the caller */ }
    return null;
}

/**
 * stripWrappers(str)
 * Removes reasoning/CoT blocks and markdown code fences. Reasoning models emit
 * several shapes of these; note <think> is NOT covered by a "thought" pattern,
 * which is why each family is listed explicitly.
 */
function stripWrappers(rawStr) {
    var str = String(rawStr).replace(/^﻿/, "").trim();

    // Custom channel-style CoT (e.g. <|channel>thought ... <channel|>)
    str = str.replace(/<\|channel\|?>[\s\S]*?<\|?channel\|>/gi, "");
    str = str.replace(/<\|channel>thought[\s\S]*?<channel\|>/gi, "");
    str = str.replace(/<channel[\s\S]*?channel>/gi, "");
    // Tag-style reasoning blocks: <think>, <thinking>, <thought>, <reasoning>,
    // <reflection>, <scratchpad>. Closed form first.
    str = str.replace(/<(think|thinking|thought|thoughts|reasoning|reflection|scratchpad)\b[^>]*>[\s\S]*?<\/\1>/gi, "");
    // Unclosed opener (the closing tag got truncated away) — drop the opener and
    // everything up to it; whatever follows still goes through candidate scanning.
    str = str.replace(/^[\s\S]*?<\/(think|thinking|thought|thoughts|reasoning|reflection|scratchpad)>/i, "");
    str = str.replace(/<(think|thinking|thought|thoughts|reasoning|reflection|scratchpad)\b[^>]*>/gi, "");
    // Generic "<something thought ...>...</something>" fallback (pre-existing behavior)
    str = str.replace(/<[^>]+thought[\s\S]*?>[\s\S]*?<\/[^>]+>/gi, "");

    // Markdown fences
    str = str.replace(/```json\s*([\s\S]*?)\s*```/gi, "$1");
    str = str.replace(/```\s*([\s\S]*?)\s*```/gi, "$1");
    str = str.replace(/```json\s*/gi, "");   // unclosed opening fence
    str = str.replace(/```/g, "");

    return str.trim();
}

/**
 * tryParseCandidates(str)
 * Parses `str` whole, then each balanced {...} candidate in order. Returns the
 * parsed value, or `undefined` to mean "nothing here parsed" (distinct from a
 * legitimately-parsed null).
 */
function tryParseCandidates(str) {
    var trimmed = String(str).trim();
    if (!trimmed) return undefined;
    try {
        var direct = JSON.parse(trimmed);
        if (direct && typeof direct === "object") return direct;
    } catch (e) { /* fall through to candidate scanning */ }

    var candidates = extractBalancedObjects(trimmed, 5);
    for (var i = 0; i < candidates.length; i++) {
        try {
            var obj = JSON.parse(candidates[i]);
            // Ignore `{}` from a stray brace pair in prose — keep looking for a real one.
            if (obj && typeof obj === "object" && Object.keys(obj).length > 0) return obj;
        } catch (e2) { /* try the next candidate */ }
    }
    return undefined;
}

/**
 * extractBalancedObjects(str, limit)
 * Every top-level balanced {...} span, in order. Brace depth is tracked while
 * respecting string literals/escapes so braces inside quoted values don't throw
 * off the count. Scanning ALL candidates (not just the first) is what lets a
 * response whose reasoning contains its own braces still reach the real object.
 */
export function extractBalancedObjects(str, limit) {
    limit = limit || 5;
    var found = [];
    var from = 0;
    while (found.length < limit) {
        var start = str.indexOf("{", from);
        if (start === -1) break;
        var depth = 0, inString = false, escape = false, closed = -1;
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
                if (depth === 0) { closed = i; break; }
            }
        }
        if (closed === -1) break; // never closed — truncated; nothing further to find
        found.push(str.slice(start, closed + 1));
        from = closed + 1;
    }
    return found;
}

/**
 * extractFirstBalancedObject(str)
 * The first balanced {...} span, or null. Retained as the original single-result
 * entry point; extractBalancedObjects() does the actual work.
 */
export function extractFirstBalancedObject(str) {
    var all = extractBalancedObjects(str, 1);
    return all.length > 0 ? all[0] : null;
}

/**
 * repairLooseJson(str)
 *
 * One character-scanning pass that fixes the damage models actually produce.
 * Inside a string value it:
 *   - escapes a stray `"` that isn't really closing the string. A quote only
 *     TERMINATES a string when the next non-whitespace character is structural
 *     (`:` `,` `}` `]` or end-of-input); anything else means the model left an
 *     inner dialogue quote unescaped, so it gets escaped instead. This is what
 *     rescues narrative values like: "He shouted "run!" and fled"
 *   - converts raw newlines/tabs to their escape sequences and drops other
 *     control characters (strict JSON forbids them unescaped in strings)
 *   - escapes a backslash that doesn't begin a valid JSON escape
 * Outside a string it drops trailing commas before `}` / `]`. Doing this in the
 * same scanner (rather than a regex) is what keeps a comma inside a string
 * value from being mistaken for a trailing one.
 */
export function repairLooseJson(str) {
    var out = "";
    var inString = false;

    for (var i = 0; i < str.length; i++) {
        var ch = str[i];

        if (ch === "\\") {
            if (!inString) { out += ch; continue; }
            var next = str[i + 1];
            if (next !== undefined && "\"\\/bfnrtu".indexOf(next) !== -1) { out += ch + next; i++; continue; }
            out += "\\\\"; // lone/invalid backslash — escape it so JSON stays valid
            continue;
        }

        if (!inString) {
            if (ch === '"') { inString = true; out += ch; continue; }
            if (ch === ",") {
                var k = i + 1;
                while (k < str.length && isWs(str[k])) k++;
                if (str[k] === "}" || str[k] === "]") continue; // trailing comma — drop
            }
            out += ch;
            continue;
        }

        // --- inside a string value ---
        if (ch === '"') {
            var j = i + 1;
            while (j < str.length && isWs(str[j])) j++;
            var nx = str[j];
            if (nx === undefined || nx === ":" || nx === "," || nx === "}" || nx === "]") {
                inString = false;
                out += ch;
            } else {
                out += '\\"'; // stray inner quote
            }
            continue;
        }
        if (ch === "\n") { out += "\\n"; continue; }
        if (ch === "\r") { out += "\\r"; continue; }
        if (ch === "\t") { out += "\\t"; continue; }
        if (ch < " ") continue; // other control characters: drop
        out += ch;
    }
    return out;
}

function isWs(ch) {
    return ch === " " || ch === "\t" || ch === "\n" || ch === "\r";
}

/**
 * tryParseTruncated(str)
 * Last resort for a response cut off mid-object (token ceiling). Closes any
 * unterminated string and still-open brackets and retries; if that fails, walks
 * backwards trimming at successive structural commas — dropping the incomplete
 * trailing property — and retries each time. Whatever fields DID come through
 * are worth keeping, since every consumer validates field-by-field anyway.
 * Returns the parsed value or `undefined`.
 */
function tryParseTruncated(str) {
    var start = str.indexOf("{");
    if (start === -1) return undefined;
    var body = str.slice(start);

    var closed = closeOpenStructures(body);
    if (closed) {
        try {
            var obj = JSON.parse(closed);
            if (obj && typeof obj === "object" && Object.keys(obj).length > 0) return obj;
        } catch (e) { /* fall through to comma-trimming */ }
    }

    var commas = structuralCommas(body);
    for (var n = commas.length - 1, tries = 0; n >= 0 && tries < 8; n--, tries++) {
        var cut = body.slice(0, commas[n]);
        var closedCut = closeOpenStructures(cut);
        if (!closedCut) continue;
        try {
            var partial = JSON.parse(closedCut);
            if (partial && typeof partial === "object" && Object.keys(partial).length > 0) return partial;
        } catch (e2) { /* keep trimming */ }
    }
    return undefined;
}

/** Closes an unterminated string and any open {/[ , in reverse order. Null if nothing was open. */
function closeOpenStructures(str) {
    var stack = [], inString = false;
    for (var i = 0; i < str.length; i++) {
        var ch = str[i];
        if (inString) {
            if (ch === "\\") { i++; continue; }
            if (ch === '"') inString = false;
            continue;
        }
        if (ch === '"') { inString = true; continue; }
        if (ch === "{" || ch === "[") stack.push(ch);
        else if (ch === "}" || ch === "]") stack.pop();
    }
    if (!inString && stack.length === 0) return null;
    var out = str;
    if (inString) out += '"';
    for (var s = stack.length - 1; s >= 0; s--) out += (stack[s] === "{" ? "}" : "]");
    return out;
}

/** Indices of commas that sit outside string literals (i.e. real separators). */
function structuralCommas(str) {
    var idx = [], inString = false;
    for (var i = 0; i < str.length; i++) {
        var ch = str[i];
        if (inString) {
            if (ch === "\\") { i++; continue; }
            if (ch === '"') inString = false;
            continue;
        }
        if (ch === '"') { inString = true; continue; }
        if (ch === ",") idx.push(i);
    }
    return idx;
}
