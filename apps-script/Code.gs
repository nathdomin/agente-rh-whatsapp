// Painel do RH na planilha Google.
// Em Configurações do projeto > Propriedades do script, defina API_URL e SHEETS_SECRET.

const TABS = {
  desligados: { name: 'Desligados', header: ['Telefone (com DDI e DDD)'] },
  fila: { name: 'Fila', header: ['id', 'Telefone', 'Motivo', 'Pergunta', 'Recebida em', 'Resposta do RH'] },
  sugestoes: { name: 'Sugestões', header: ['id', 'Pergunta', 'Resposta'] },
  cota: { name: 'Cota', header: ['Indicador', 'Valor'] },
};

const REASONS = {
  sensivel: 'Tema sensível',
  anexo: 'Anexo ou áudio',
  dado_individual: 'Dado individual',
  sem_resposta: 'Sem resposta nos documentos',
  falha_llm: 'IA indisponível',
  sem_cota: 'Cota esgotada',
};

function onOpen() {
  SpreadsheetApp.getUi().createMenu('Assistente de RH')
    .addItem('Atualizar agora', 'refresh')
    .addSeparator()
    .addItem('Enviar lista de desligados', 'syncDismissed')
    .addSeparator()
    .addItem('Aprender com a linha selecionada (Fila)', 'learnSelected')
    .addItem('Retomar a IA na linha selecionada (Fila)', 'resumeSelected')
    .addSeparator()
    .addItem('Aprovar a linha selecionada (Sugestões)', 'approveSelected')
    .addItem('Rejeitar a linha selecionada (Sugestões)', 'rejectSelected')
    .addSeparator()
    .addItem('Simular cota esgotada', 'simulateExhausted')
    .addItem('Restaurar cota', 'restoreQuota')
    .addToUi();
}

function setup() {
  const book = SpreadsheetApp.getActive();
  Object.values(TABS).forEach((tab) => {
    const sheet = book.getSheetByName(tab.name) || book.insertSheet(tab.name);
    sheet.getRange(1, 1, 1, tab.header.length).setValues([tab.header]).setFontWeight('bold');
    sheet.setFrozenRows(1);
  });
  // Mantém as colunas de identificação fora da vista do RH.
  book.getSheetByName(TABS.fila.name).hideColumns(1);
  book.getSheetByName(TABS.sugestoes.name).hideColumns(1);
  // O telefone precisa ficar como texto para não perder dígitos.
  book.getSheetByName(TABS.desligados.name).getRange('A:A').setNumberFormat('@');
  ScriptApp.getProjectTriggers().forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('refresh').timeBased().everyMinutes(1).create();
  refresh();
}

function api(payload) {
  const props = PropertiesService.getScriptProperties();
  const response = UrlFetchApp.fetch(props.getProperty('API_URL'), {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-sheets-secret': props.getProperty('SHEETS_SECRET') },
    payload: JSON.stringify(payload),
    muteHttpExceptions: true,
  });
  const body = JSON.parse(response.getContentText());
  if (response.getResponseCode() !== 200) throw new Error(body.error || 'Falha na integração');
  return body;
}

function selectedRow(tab) {
  const sheet = SpreadsheetApp.getActiveSheet();
  const row = sheet.getActiveRange().getRow();
  if (sheet.getName() !== tab.name || row < 2) {
    throw new Error('Selecione uma linha na aba ' + tab.name + '.');
  }
  return sheet.getRange(row, 1, 1, tab.header.length).getValues()[0];
}

function replaceRows(tab, rows) {
  const sheet = SpreadsheetApp.getActive().getSheetByName(tab.name);
  const lastRow = sheet.getLastRow();
  if (lastRow > 1) sheet.getRange(2, 1, lastRow - 1, tab.header.length).clearContent();
  if (rows.length === 0) return;
  sheet.getRange(2, 1, rows.length, tab.header.length).setValues(rows);
}

function currentValues(tab, column) {
  const sheet = SpreadsheetApp.getActive().getSheetByName(tab.name);
  const lastRow = sheet.getLastRow();
  const map = {};
  if (lastRow < 2) return map;
  sheet.getRange(2, 1, lastRow - 1, tab.header.length).getValues().forEach((row) => {
    map[row[0]] = row[column];
  });
  return map;
}

function refresh() {
  const lock = LockService.getDocumentLock();
  if (!lock.tryLock(5000)) return;
  try {
    const data = api({ action: 'pull' });
    // Preserva o que o RH já digitou e as edições das sugestões.
    const typedAnswers = currentValues(TABS.fila, 5);
    const editedQuestions = currentValues(TABS.sugestoes, 1);
    const editedAnswers = currentValues(TABS.sugestoes, 2);

    replaceRows(TABS.fila, data.handoffs.map((h) => [
      h.id,
      h.phone,
      REASONS[h.reason] || h.reason,
      h.question,
      new Date(h.created_at),
      typedAnswers[h.id] || '',
    ]));
    replaceRows(TABS.sugestoes, data.suggestions.map((s) => [
      s.id,
      editedQuestions[s.id] || s.question,
      editedAnswers[s.id] || s.answer,
    ]));
    replaceRows(TABS.cota, [
      ['Mês', "'" + data.quota.month],
      ['Teto mensal', data.quota.cap],
      ['Usadas no mês', data.quota.used],
      ['Entregues no mês', data.quota.delivered],
      ['Usadas hoje', data.quota.today],
      ['Saldo', Math.max(0, data.quota.cap - data.quota.used)],
      ['Simulação de cota esgotada', data.quota.simulated_exhausted ? 'Ligada' : 'Desligada'],
    ]);
  } finally {
    lock.releaseLock();
  }
}

function notify(message) {
  SpreadsheetApp.getActive().toast(message, 'Assistente de RH', 6);
}

function syncDismissed() {
  const sheet = SpreadsheetApp.getActive().getSheetByName(TABS.desligados.name);
  const lastRow = sheet.getLastRow();
  const phones = lastRow < 2 ? [] : sheet.getRange(2, 1, lastRow - 1, 1).getDisplayValues().flat().filter(String);
  const result = api({ action: 'sync_desligados', phones: phones });
  notify(result.total + ' telefone(s) na lista de desligados.');
}

function learnSelected() {
  const row = selectedRow(TABS.fila);
  if (!String(row[5]).trim()) throw new Error('Preencha a coluna "Resposta do RH" antes de aprender.');
  api({ action: 'learn', handoff_id: row[0], answer: String(row[5]) });
  refresh();
  notify('Sugestão criada. Revise na aba Sugestões e aprove.');
}

function resumeSelected() {
  api({ action: 'resume', handoff_id: selectedRow(TABS.fila)[0] });
  refresh();
  notify('A IA voltou a responder essa conversa.');
}

function approveSelected() {
  const row = selectedRow(TABS.sugestoes);
  api({ action: 'approve', suggestion_id: row[0], question: String(row[1]), answer: String(row[2]) });
  refresh();
  notify('Aprovado. A IA já pode usar essa resposta.');
}

function rejectSelected() {
  api({ action: 'reject', suggestion_id: selectedRow(TABS.sugestoes)[0] });
  refresh();
  notify('Sugestão rejeitada.');
}

function simulateExhausted() {
  api({ action: 'simulate_quota', exhausted: true });
  refresh();
  notify('Simulação ligada: a IA parou de responder.');
}

function restoreQuota() {
  api({ action: 'simulate_quota', exhausted: false });
  refresh();
  notify('Simulação desligada.');
}
