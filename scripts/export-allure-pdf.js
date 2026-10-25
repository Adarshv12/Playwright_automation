const fs = require('node:fs/promises');
const path = require('node:path');
const { chromium } = require('@playwright/test');

const resultsDirectory = path.resolve(process.argv[2] || 'allure-results');
const outputFile = path.resolve(process.argv[3] || 'allure-report.pdf');

function escapeHtml(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function duration(result) {
  if (typeof result.start !== 'number' || typeof result.stop !== 'number') {
    return '';
  }

  return `${((result.stop - result.start) / 1000).toFixed(2)} s`;
}

function statusClass(status) {
  return ['passed', 'failed', 'broken', 'skipped', 'unknown'].includes(status)
    ? status
    : 'unknown';
}

function isWithinDirectory(directory, file) {
  const relative = path.relative(directory, file);
  return relative !== '' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function attachmentContent(attachment) {
  if (!attachment.source) {
    return '';
  }

  const file = path.resolve(resultsDirectory, attachment.source);
  if (!isWithinDirectory(resultsDirectory, file)) {
    throw new Error(`Attachment path is outside the results directory: ${attachment.source}`);
  }

  const content = await fs.readFile(file);
  const type = attachment.type || 'application/octet-stream';

  if (/^image\/(png|jpeg|gif|webp)$/i.test(type)) {
    return `<img class="attachment-image" src="data:${escapeHtml(type)};base64,${content.toString('base64')}" alt="${escapeHtml(attachment.name)}">`;
  }

  if (/^(text\/(plain|markdown)|application\/json)$/i.test(type)) {
    return `<pre class="attachment-text">${escapeHtml(content.toString('utf8'))}</pre>`;
  }

  return '';
}

async function renderAttachments(attachments = []) {
  if (attachments.length === 0) {
    return '';
  }

  const rendered = await Promise.all(attachments.map(async (attachment) => {
    const content = await attachmentContent(attachment);
    return `<div class="attachment"><strong>${escapeHtml(attachment.name || 'Attachment')}</strong><span>${escapeHtml(attachment.type || '')}</span>${content}</div>`;
  }));

  return `<div class="attachments"><h4>Attachments</h4>${rendered.join('')}</div>`;
}

async function renderSteps(steps = [], level = 0) {
  if (steps.length === 0) {
    return '';
  }

  const rendered = await Promise.all(steps.map(async (step) => {
    const nested = await renderSteps(step.steps, level + 1);
    const attachments = await renderAttachments(step.attachments);
    const stepStatus = step.status
      ? `<span class="status ${statusClass(step.status)}">${escapeHtml(step.status)}</span>`
      : '';
    const stepDuration = duration(step);

    return `<li class="step level-${Math.min(level, 4)}"><div class="step-heading">${stepStatus}<strong>${escapeHtml(step.name || 'Step')}</strong><span class="duration">${escapeHtml(stepDuration)}</span></div>${step.statusDetails?.message ? `<pre class="failure">${escapeHtml(step.statusDetails.message)}</pre>` : ''}${attachments}${nested}</li>`;
  }));

  return `<ol class="steps">${rendered.join('')}</ol>`;
}

async function renderTest(result, attemptIndex, attemptCount) {
  const labels = (result.labels || [])
    .map((label) => `<span class="label">${escapeHtml(label.name)}: ${escapeHtml(label.value)}</span>`)
    .join('');
  const parameters = (result.parameters || [])
    .map((parameter) => `<li><strong>${escapeHtml(parameter.name)}:</strong> ${escapeHtml(parameter.value)}</li>`)
    .join('');
  const steps = await renderSteps(result.steps);
  const attachments = await renderAttachments(result.attachments);
  const failure = result.statusDetails?.message || result.statusDetails?.trace;
  const attempt = attemptCount > 1 ? `<p class="attempt">Attempt ${attemptIndex + 1} of ${attemptCount}</p>` : '';

  return `<section class="test-case">
    <div class="test-heading"><span class="status ${statusClass(result.status)}">${escapeHtml(result.status || 'unknown')}</span><h2>${escapeHtml(result.name || 'Unnamed test')}</h2><span class="duration">${escapeHtml(duration(result))}</span></div>
    ${attempt}
    ${result.fullName ? `<p class="full-name">${escapeHtml(result.fullName)}</p>` : ''}
    ${labels ? `<div class="labels">${labels}</div>` : ''}
    ${parameters ? `<h3>Parameters</h3><ul class="parameters">${parameters}</ul>` : ''}
    ${failure ? `<h3>Failure details</h3><pre class="failure">${escapeHtml(failure)}</pre>` : ''}
    ${steps ? `<h3>Steps</h3>${steps}` : ''}
    ${attachments}
  </section>`;
}

async function main() {
  let entries;
  try {
    entries = await fs.readdir(resultsDirectory, { withFileTypes: true });
  } catch (error) {
    throw new Error(`Cannot read Allure results directory "${resultsDirectory}": ${error.message}`);
  }

  const resultFiles = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('-result.json'))
    .map((entry) => path.join(resultsDirectory, entry.name))
    .sort();

  if (resultFiles.length === 0) {
    throw new Error(`No Allure test result files found in "${resultsDirectory}". Run the Playwright tests first.`);
  }

  const results = await Promise.all(resultFiles.map(async (file) => {
    try {
      return JSON.parse(await fs.readFile(file, 'utf8'));
    } catch (error) {
      throw new Error(`Cannot parse Allure result "${file}": ${error.message}`);
    }
  }));

  const groupedResults = new Map();
  for (const result of results) {
    const project = result.parameters?.find((parameter) => parameter.name === 'Project')?.value || '';
    const identity = result.testCaseId || result.historyId || result.name || 'unknown';
    const key = `${identity}::${project}`;
    const group = groupedResults.get(key) || [];
    group.push(result);
    groupedResults.set(key, group);
  }

  const testGroups = [...groupedResults.values()]
    .map((group) => group.sort((left, right) => (left.start || 0) - (right.start || 0)));
  const counts = testGroups.reduce((summary, group) => {
    const status = statusClass(group[group.length - 1].status);
    summary[status] = (summary[status] || 0) + 1;
    return summary;
  }, {});
  const tests = await Promise.all(testGroups.map(async (group) => (
    Promise.all(group.map((result, index) => renderTest(result, index, group.length)))
  )));
  const generatedAt = new Date().toLocaleString();
  const html = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <title>Allure Test Report</title>
  <style>
    @page { size: A4; margin: 16mm 14mm 18mm; }
    * { box-sizing: border-box; }
    body { color: #202124; font: 10pt Arial, sans-serif; line-height: 1.45; }
    h1 { margin: 0; font-size: 24pt; }
    h2 { margin: 0; font-size: 15pt; }
    h3 { margin: 14px 0 6px; font-size: 11pt; }
    h4 { margin: 10px 0 6px; font-size: 10pt; }
    .generated { color: #5f6368; margin: 4px 0 18px; }
    .summary { display: flex; gap: 10px; margin: 16px 0 24px; }
    .summary-card { border: 1px solid #dadce0; border-radius: 5px; padding: 9px 12px; min-width: 80px; }
    .summary-card strong { display: block; font-size: 16pt; }
    .test-case { border-top: 2px solid #dadce0; margin-top: 22px; padding-top: 12px; break-inside: auto; }
    .test-heading, .step-heading { align-items: center; display: flex; gap: 8px; }
    .test-heading h2 { flex: 1; }
    .status { border-radius: 3px; color: white; display: inline-block; font-size: 8pt; font-weight: bold; padding: 3px 6px; text-transform: uppercase; }
    .passed { background: #188038; } .failed, .broken { background: #d93025; }
    .skipped { background: #80868b; } .unknown { background: #5f6368; }
    .duration, .full-name, .attempt { color: #5f6368; }
    .full-name { overflow-wrap: anywhere; }
    .labels { display: flex; flex-wrap: wrap; gap: 4px; margin: 8px 0; }
    .label { background: #f1f3f4; border-radius: 3px; font-size: 8pt; padding: 2px 5px; }
    .parameters { margin: 0; padding-left: 20px; }
    .steps { list-style: none; margin: 0; padding: 0; }
    .step { border-left: 2px solid #dadce0; margin: 7px 0; padding: 3px 0 3px 9px; break-inside: avoid; }
    .step-heading strong { flex: 1; }
    .level-1 { margin-left: 12px; } .level-2 { margin-left: 24px; }
    .level-3 { margin-left: 36px; } .level-4 { margin-left: 48px; }
    .failure, .attachment-text { background: #f8f9fa; border: 1px solid #dadce0; border-radius: 4px; overflow-wrap: anywhere; padding: 8px; white-space: pre-wrap; }
    .attachments { margin: 10px 0; }
    .attachment { margin: 8px 0; }
    .attachment > span { color: #5f6368; font-size: 8pt; margin-left: 8px; }
    .attachment-image { display: block; max-height: 230mm; max-width: 100%; object-fit: contain; }
    .attachment-text { max-height: none; }
    footer { color: #5f6368; font-size: 8pt; }
  </style>
</head>
<body>
  <h1>Allure Test Report</h1>
  <p class="generated">Generated ${escapeHtml(generatedAt)} · ${testGroups.length} test${testGroups.length === 1 ? '' : 's'} · ${results.length} attempt${results.length === 1 ? '' : 's'}</p>
  <div class="summary">${['passed', 'failed', 'broken', 'skipped', 'unknown'].map((status) => `<div class="summary-card"><strong>${counts[status] || 0}</strong>${status}</div>`).join('')}</div>
  ${tests.flat().join('')}
</body>
</html>`;

  await fs.mkdir(path.dirname(outputFile), { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    const page = await browser.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    await page.pdf({
      path: outputFile,
      format: 'A4',
      printBackground: true,
      displayHeaderFooter: true,
      headerTemplate: '<span></span>',
      footerTemplate: '<div style="font: 8px Arial; color: #5f6368; width: 100%; text-align: center;"><span class="pageNumber"></span> / <span class="totalPages"></span></div>',
      margin: { top: '16mm', right: '14mm', bottom: '18mm', left: '14mm' },
    });
  } finally {
    await browser.close();
  }

  console.log(`Created PDF report: ${outputFile}`);
}

main().catch((error) => {
  console.error(`Allure PDF export failed: ${error.message}`);
  process.exitCode = 1;
});
