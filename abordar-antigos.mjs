// Aborda os decisores ANTIGOS: 1 por execucao (cron a cada 10min), max 10/dia,
// janela 09:00-17:50 SP. Auto-remove o cron quando a fila esvazia.
// IMPORTANTE: carrega o .env ANTES dos imports (senao a uazapi entra em modo DEMO).
import { readFileSync } from "node:fs";
for (const linha of readFileSync("/root/facilita-sdr/.env", "utf8").split("\n")) {
  const m = linha.match(/^([A-Z0-9_]+)=(.*)$/);
  if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2];
}
const { db, agoraSP } = await import("./lib/db.js");
const { abordarDecisor } = await import("./lib/agente.js");
const { alertar } = await import("./lib/telegram.js");
const { execSync } = await import("node:child_process");

const { hora, data } = agoraSP();
if (hora < "09:00" || hora > "17:50") { console.log(data, hora, "fora da janela"); process.exit(0); }

const hoje = db.prepare(`SELECT COUNT(*) c FROM eventos WHERE tipo='decisor_abordado' AND date(criado_em,'-3 hours') = ?`).get(data).c;
if (hoje >= 10) { console.log(data, hora, "limite do dia (10) batido"); process.exit(0); }

const cand = db.prepare(`SELECT l.* FROM leads l
  WHERE l.status='decisor' AND l.telefone_decisor IS NOT NULL AND l.telefone_decisor <> '' AND l.eh_teste=0
    AND substr(replace(l.telefone_decisor,' ',''),-8) <> substr(l.telefone,-8) AND length(replace(l.telefone_decisor,' ','')) >= 10
    AND NOT EXISTS (SELECT 1 FROM eventos e WHERE e.lead_id = l.id AND e.tipo IN ('decisor_abordado','decisor_abordagem_pulada'))
    AND NOT EXISTS (SELECT 1 FROM threads t WHERE t.lead_id = l.id AND substr(t.telefone,-8) <> substr(l.telefone,-8))
  ORDER BY l.id LIMIT 1`).get();

if (!cand) {
  console.log(data, hora, "FILA VAZIA — removendo o cron");
  try { execSync(`crontab -l | grep -v abordar-antigos | crontab -`); } catch {}
  await alertar("✅ Abordagem dos decisores antigos concluída — fila vazia, rotina desligada.");
  process.exit(0);
}
const tok = db.prepare("SELECT uazapi_token FROM instancias WHERE id = ? AND status='conectado'").get(cand.instancia_id || 0)?.uazapi_token
  || db.prepare("SELECT uazapi_token FROM instancias WHERE status='conectado' ORDER BY id LIMIT 1").get()?.uazapi_token;
if (!tok) { console.log("sem chip conectado, tento no proximo tick"); process.exit(0); }
console.log(data, hora, "abordando:", cand.nome_clinica, cand.telefone_decisor);
await abordarDecisor(cand.id, cand.telefone_decisor, cand.nome_decisor || cand.nome_contato || null, tok);
process.exit(0);
