export function redact(value:unknown,secrets:readonly string[]=[]):unknown {
  if(typeof value==='string') {
    let text=value.replace(/\bBearer\s+[^\s"\\]+/gi,'Bearer [redacted]')
      .replace(/\b(?:gsk_|sk-)[A-Za-z0-9_-]{12,}/g,'[redacted]')
      .replace(/\b(?:password|api[_-]?key|token|secret)\s*[=:]\s*[^\s,;"\\]+/gi,'[redacted credential]')
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi,'[redacted email]')
      .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g,'[redacted IP]')
      .replace(/\b(?:postgres(?:ql)?|redis):\/\/[^\s"\\]+/gi,'[redacted connection]');
    for(const secret of secrets)if(secret.length>=8)text=text.replaceAll(secret,'[redacted]');
    return text;
  }
  if(Array.isArray(value))return value.map(item=>redact(item,secrets));
  if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).map(([key,item])=>[key,/^(authorization|password|api_key|access_token|secret)$/i.test(key)?'[redacted]':redact(item,secrets)]));
  return value;
}
