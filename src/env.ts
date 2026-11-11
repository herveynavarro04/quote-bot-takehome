import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

function parse(content: string): Record<string, string> {
  const env: Record<string, string> = {};
  const lines = content.split(/\r?\n/);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (!line || /^\s*#/.test(line)) { i++; continue; }
    const eq = line.indexOf("=");
    if (eq === -1) { i++; continue; }
    const key = line.slice(0, eq).trim();
    const raw = line.slice(eq + 1);

    const heredoc = raw.match(/^\s*<<([A-Za-z_][A-Za-z0-9_]*)\s*$/);
    if (heredoc) {
      const delim = heredoc[1];
      const collected: string[] = [];
      i++;
      while (i < lines.length && lines[i] !== delim) {
        collected.push(lines[i]);
        i++;
      }
      env[key] = collected.join("\n");
      i++;
      continue;
    }

    const trimmed = raw.trim();
    if ((trimmed.startsWith('"') && trimmed.endsWith('"') && trimmed.length >= 2) ||
        (trimmed.startsWith("'") && trimmed.endsWith("'") && trimmed.length >= 2)) {
      env[key] = trimmed.slice(1, -1);
    } else {
      env[key] = trimmed;
    }
    i++;
  }
  return env;
}

let loaded = false;
export function loadEnv(path = ".env"): void {
  if (loaded) return;
  loaded = true;
  const full = resolve(process.cwd(), path);
  if (!existsSync(full)) return;
  const parsed = parse(readFileSync(full, "utf8"));
  for (const [k, v] of Object.entries(parsed)) {
    if (process.env[k] === undefined) process.env[k] = v;
  }
}

loadEnv();
