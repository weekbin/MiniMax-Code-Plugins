/**
 * Redaction and bounding for content that may leave the local process.
 *
 * The Studio serves to 127.0.0.1 only, but tool arguments and results routinely
 * carry credentials, so any `full` detail payload is scrubbed and length-bounded
 * before it is returned over MCP or written into the HTML page.
 */

const SECRET_PATTERNS = [
  // key: value pairs with credential-ish names
  /\b([A-Za-z0-9_.-]*(?:api[_-]?key|apikey|secret|token|passwd|password|credential|authorization|auth[_-]?token|private[_-]?key|access[_-]?key)[A-Za-z0-9_.-]*)\s*[:=]\s*("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|[^\s,;'"`)\]}]+)/gi,
  // authorization headers and bearer tokens
  /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi,
  // provider-style API keys
  /\b(sk|pk|ghp|gho|ghs|ghr|glpat|xox[baprs])[-_][A-Za-z0-9_-]{12,}/g,
  // AWS access key ids
  /\b(AKIA|ASIA)[A-Z0-9]{12,}\b/g,
  // private key blocks
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  // connection strings with inline credentials
  /\b([a-z][a-z0-9+.-]*:\/\/)[^/\s:@]+:[^/\s@]+@/gi,
];

const SECRET_KEY_NAMES = /^(?:api[_-]?key|apikey|secret|token|passwd|password|credential|authorization|private[_-]?key|access[_-]?key|cookie|session[_-]?id)$/i;

export function redactText(value, { maxLength = 4000 } = {}) {
  if (typeof value !== 'string') return value;
  let text = value;
  for (const pattern of SECRET_PATTERNS) {
    text = text.replace(pattern, (match, prefix) => {
      if (typeof prefix === 'string' && match.startsWith(prefix) && /[:=]/.test(match.slice(prefix.length))) {
        return `${prefix}=[redacted]`;
      }
      if (typeof prefix === 'string' && match.startsWith(prefix) && match.startsWith('Bearer')) {
        return `${prefix} [redacted]`;
      }
      return '[redacted]';
    });
  }
  if (text.length > maxLength) {
    const omitted = text.length - maxLength;
    text = `${text.slice(0, maxLength)}\n… [truncated ${omitted} chars]`;
  }
  return text;
}

/** Recursively scrub a JSON-ish value, bounding depth, breadth and string length. */
export function redactValue(value, options = {}, depth = 0) {
  const { maxLength = 4000, maxDepth = 12, maxEntries = 200 } = options;
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redactText(value, { maxLength });
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (depth >= maxDepth) return '[depth limit]';
  if (Array.isArray(value)) {
    const head = value.slice(0, maxEntries).map((item) => redactValue(item, options, depth + 1));
    if (value.length > maxEntries) head.push(`… [${value.length - maxEntries} more items]`);
    return head;
  }
  if (typeof value === 'object') {
    const out = {};
    let seen = 0;
    for (const [key, item] of Object.entries(value)) {
      if (seen >= maxEntries) {
        out['…'] = `${Object.keys(value).length - maxEntries} more keys`;
        break;
      }
      seen += 1;
      out[key] = SECRET_KEY_NAMES.test(key) ? '[redacted]' : redactValue(item, options, depth + 1);
    }
    return out;
  }
  return String(value);
}

/** Redact an MCP event payload in `full` mode. */
export function redactEvent(event, options = {}) {
  if (!event || typeof event !== 'object') return event;
  const out = { ...event };
  if (typeof out.content === 'string') out.content = redactText(out.content, options);
  if (typeof out.thinking === 'string') out.thinking = redactText(out.thinking, options);
  if (Array.isArray(out.toolCalls)) {
    out.toolCalls = out.toolCalls.map((call) => ({
      ...call,
      args: call.args === undefined ? undefined : redactValue(call.args, options),
      result: call.result === undefined ? undefined : redactValue(call.result, options),
    }));
  }
  if (out.metadata) out.metadata = redactValue(out.metadata, options);
  return out;
}

/** Home-directory prefixes are stripped so paths do not leave the machine verbatim. */
export function redactPath(value, { homeDir } = {}) {
  if (typeof value !== 'string') return value;
  if (homeDir && value.startsWith(homeDir)) return `~${value.slice(homeDir.length)}`;
  return value;
}
