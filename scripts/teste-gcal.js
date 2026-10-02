import { criarEventoMeet, apagarEventoMeet } from '../lib/gcal.js';
const amanha = new Date(Date.now() + 86400000).toISOString().slice(0,10);
const ev = await criarEventoMeet('matheus', amanha + 'T12:00', { resumo: 'TESTE Facilita SDR (pode ignorar, vou apagar)', descricao: 'teste automatico' });
if (!ev) { console.log('FALHOU: evento nao criado'); process.exit(1); }
console.log('EVENTO CRIADO. Meet automatico:', ev.meet);
const del = await apagarEventoMeet('matheus', ev.eventId);
console.log(del ? 'evento de teste APAGADO' : 'nao consegui apagar (apaga manual)');
